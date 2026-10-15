"""The Stripe webhook — what a verified payment *entitles* someone to.

WHY THIS IS A SEPARATE MODULE FROM `payments.py`
  `payments.py` holds the Stripe secret and proves who sent a request. This module
  decides what a payment grants, and it is the only code in this project with the
  authority to write `subscription_tier`. Keeping them apart means the credential
  and the authority never live in the same file: a flaw in the gateway plumbing
  cannot by itself hand out a subscription, and a mistake in the entitlement
  rules cannot be made from outside the process.

THE PROBLEM THIS MODULE IS ACTUALLY SOLVING
  Three things make a payment webhook harder than it looks, and each has a wrong
  answer that works right up until it matters:

  1. **Every gateway retries.** Stripe retries a failed delivery for up to three
     days in live mode, and can deliver the same event more than once even when
     nothing failed. A handler that grants "+30 days" per delivery turns one
     payment into an arbitrary number of months. The deduplication therefore has
     to be *durable and atomic*, not a set in memory that dies with the process —
     see `apply_payment_event` in `schema_profiles.sql`, which claims the event id
     as its primary key and does the grant in the same transaction.
  2. **"Completed" is not "paid".** For a delayed payment method the session can
     complete while the payment is still processing, and Stripe's own guidance is
     to check the session's `payment_status` before fulfilling. This module grants
     only on `payment_status == 'paid'`; anything else is recorded and left for
     `checkout.session.async_payment_succeeded` to settle later.
  3. **The entitlement columns are not writable by a user, on purpose.** The
     column-level grant in `schema_profiles.sql` denies `subscription_tier` to
     `authenticated`, and `auth.py` reads the profile with the caller's own token.
     So this module cannot use that token: it needs `SUPABASE_SERVICE_KEY`, which
     bypasses row-level security. That is a different credential with a different
     blast radius, it is read only here, and it is never sent to a client.

WHY THE WRITE GOES THROUGH A DATABASE FUNCTION
  It would be shorter to call PostgREST twice — insert the event, then update the
  profile. That version has a race: two concurrent deliveries of the same event
  both read "not seen", both insert, and one gets a duplicate-key error *after*
  the other has already extended the subscription, or worse, both extend it. The
  function does both halves inside one statement, so the primary key
  is the lock. It also keeps the entitlement arithmetic next to the columns it
  writes, where it can be reviewed against the schema in one place.

WHAT THIS MODULE TRUSTS
  Only fields this server wrote, and only after the signature verified:
  `client_reference_id` (the user id) and `metadata.plan_id`. The *period* is not
  taken from the event at all — it is looked up in `checkout.PLANS_BY_ID`, so a
  session created by something other than this application (a Payment Link, a
  hand-edited session in the dashboard) cannot choose how long it grants for. The
  database refuses to update a profile that does not exist, so an event naming a
  deleted account cannot create one.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

import checkout
import payments

log = logging.getLogger("superheng.webhook")

#: PostgREST endpoint of the entitlement function. Named once, and asserted
#: against the schema file by the tests, so the two cannot drift apart.
APPLY_FUNCTION = "apply_payment_event"

#: How long to wait for the database. Short on purpose: Stripe's own retry budget
#: is generous, and a request that hangs holds a worker for as long as it hangs.
#: A failure here is recoverable — Stripe will deliver the event again.
RPC_TIMEOUT_SECONDS = 10.0

#: The results `apply_payment_event` can return, as a set so an unexpected value
#: can be recognised rather than silently treated as success.
APPLIED = "applied"
DUPLICATE = "duplicate"
UNKNOWN_USER = "unknown_user"
RECORDED = "recorded"
KNOWN_RESULTS = frozenset({APPLIED, DUPLICATE, UNKNOWN_USER, RECORDED})

#: The event types that mean "the payment failed or lapsed". Recorded so the
#: ledger shows what happened, and never granted.
NON_GRANTING_EVENTS = frozenset(
    {"checkout.session.async_payment_failed", "checkout.session.expired"}
)


class WebhookProblem(RuntimeError):
    """A failure the route maps onto a response.

    Carries `status_code` and `detail` for the same reason `payments.PaymentError`
    does: one place decides, so the mapping cannot drift.
    """

    status_code = 500

    def __init__(self, detail: str, status_code: int | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        if status_code is not None:
            self.status_code = status_code


def _database_problem_detail(response: httpx.Response) -> str:
    """A short, safe sentence for a PostgREST failure.

    PostgREST reports problems as a JSON body with a `message`; the raw text is
    used only when there is nothing structured to read, and it is truncated
    because a validation error can echo an entire row.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        message = body.get("message") or body.get("hint") or body.get("details")
        if isinstance(message, str) and message.strip():
            return message.strip()[:300]
    return (response.text or "").strip()[:300] or f"HTTP {response.status_code}"


def apply_payment(
    *,
    base_url: str,
    service_key: str,
    event_id: str,
    event_type: str,
    user_id: str | None,
    session_id: str | None,
    plan_id: str | None,
    period_days: int | None,
    amount_minor: int | None,
    currency: str | None,
    live_mode: bool | None,
    stripe_customer_id: str | None,
    note: str,
) -> dict[str, Any]:
    """Record the event and, when `period_days` is given, grant the entitlement.

    ``period_days`` of None means *record without granting*: the caller has already
    decided this event does not entitle anyone to anything, and the ledger still
    needs to show that the event arrived. Doing it in one call keeps the row and
    the grant in one transaction.

    Returns the function's own JSON answer, so the caller reports what the database
    actually did rather than what it hoped it did.
    """
    url = f"{base_url.rstrip('/')}/rest/v1/rpc/{APPLY_FUNCTION}"
    headers = {
        # The service key is sent as both `apikey` and the bearer token. PostgREST
        # reads the token to choose the role, so omitting either produces a 401
        # that looks like a wrong key rather than a wrong header.
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    body = {
        "p_event_id": event_id,
        "p_event_type": event_type,
        "p_user_id": user_id,
        "p_session_id": session_id,
        "p_plan_id": plan_id,
        "p_period_days": period_days,
        "p_amount_minor": amount_minor,
        "p_currency": currency,
        "p_livemode": live_mode,
        # Sent on every call, granting or not. The function only writes it inside
        # the grant, so a non-granting event cannot store it, and sending it always
        # means a future granting path does not have to remember to add it.
        "p_stripe_customer_id": stripe_customer_id,
        "p_note": note,
    }

    try:
        response = httpx.post(url, json=body, headers=headers, timeout=RPC_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        log.warning("Entitlement write failed at the transport level: %s: %s", type(exc).__name__, exc)
        # 503 because nothing was learned: Stripe will retry, and the retry is
        # supposed to succeed. Answering 200 here would silently drop a payment.
        raise WebhookProblem(
            "Could not record the payment: the database did not answer. Stripe will "
            "retry this event.",
            503,
        ) from exc

    if response.status_code == 404:
        # The signature was valid, so this is not an attack: it is a half-applied
        # deployment, which is what a missing function looks like. Named file, for
        # the same reason `auth.read_profile` names it.
        raise WebhookProblem(
            f"The database function {APPLY_FUNCTION} does not exist. Apply "
            "backend/schema_profiles.sql in the Supabase SQL editor, then have "
            "Stripe redeliver this event.",
            503,
        )
    if response.status_code in (401, 403):
        log.error("Supabase refused the entitlement write with %d.", response.status_code)
        raise WebhookProblem(
            "Supabase refused the entitlement write. This is a server-side "
            "credential problem: SUPABASE_SERVICE_KEY is missing, wrong, or is an "
            "anon key rather than a service/secret key.",
            503,
        )
    if response.status_code >= 400:
        detail = _database_problem_detail(response)
        log.error("Entitlement write failed with %d: %s", response.status_code, detail)
        raise WebhookProblem(
            f"Could not record the payment ({response.status_code}): {detail}",
            503,
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise WebhookProblem("The database returned a response that was not JSON.", 503) from exc

    # A scalar-returning function answers with the value itself; wrapping in a list
    # is what PostgREST does for a set-returning one. Both are accepted so the
    # function's declaration can change without silently breaking this.
    if isinstance(payload, list):
        payload = payload[0] if payload else {}
    if not isinstance(payload, dict):
        raise WebhookProblem("The database returned an unexpected answer shape.", 503)

    result = payload.get("result")
    if result not in KNOWN_RESULTS:
        # An unrecognised answer means the function and this module disagree. It is
        # reported as a failure rather than logged and ignored, because the only
        # safe reading of "I do not understand what the database did" is that the
        # payment may not have been applied.
        raise WebhookProblem(
            f"The database returned an unrecognised result: {result!r}.", 503
        )
    return payload


def handle(
    raw_body: bytes,
    signature: str | None,
    *,
    base_url: str,
    service_key: str,
) -> dict[str, Any]:
    """Verify, decide, and apply. The whole webhook path, in one function.

    ``raw_body`` must be the exact bytes Stripe sent — see
    `payments.verify_event`. Nothing else in the request is read: Stripe's
    signature covers the body, and a header other than `Stripe-Signature` is not
    part of the protocol.

    Raises `payments.PaymentError` for a bad signature or a malformed body, and
    `WebhookProblem` for a database failure. Both carry the status to answer with.
    """
    event = payments.verify_event(raw_body, signature)
    facts = payments.facts_from_event(event)

    if not facts.event_id:
        raise payments.MalformedEvent("The verified event carried no id.")

    if facts.event_type not in payments.HANDLED_EVENTS:
        # Not subscribed-to as far as this application is concerned, so it is
        # acknowledged and dropped without consuming a ledger row.
        log.info("Ignoring an unhandled Stripe event type %s (%s).", facts.event_type, facts.event_id)
        return {
            "status": "ignored",
            "event_id": facts.event_id,
            "event_type": facts.event_type,
            "result": None,
            "subscription_granted": False,
        }

    # --- Decide, before touching the database -----------------------------
    # The order matters: the cheapest and most certain refusals first, so the
    # reason recorded in the ledger is the most specific true one.
    period_days: int | None = None
    note: str
    plan_id = facts.plan_id
    user_id = facts.user_id

    if facts.event_type in NON_GRANTING_EVENTS:
        note = f"{facts.event_type}: no entitlement"
    elif not facts.grantable:
        note = f"{facts.event_type}: not a granting event"
    elif facts.payment_status != "paid":
        # The important one. A session that completed but is not paid - a delayed
        # method still processing, or a payment that failed after completion - must
        # not grant. It is recorded so the ledger shows the session existed, and
        # `checkout.session.async_payment_succeeded` grants it later if it settles.
        note = f"payment_status={facts.payment_status!r}: recorded, not granted"
    elif user_id is None:
        note = "no usable user id in client_reference_id or metadata"
    else:
        plan = checkout.PLANS_BY_ID.get(plan_id or "")
        if plan is None:
            # A session this application did not create. Refused rather than
            # granted for some default period: if the plan is unknown then so is
            # what was bought, and granting 30 days to an unrecognised session is
            # how a mis-set Payment Link becomes free subscriptions.
            note = f"unknown plan {plan_id!r}: recorded, not granted"
        else:
            period_days = plan.period_days
            note = f"granted {plan.period_days}d for plan {plan.id}"

    payload = apply_payment(
        base_url=base_url,
        service_key=service_key,
        event_id=facts.event_id,
        event_type=facts.event_type,
        user_id=user_id,
        session_id=facts.session_id,
        plan_id=plan_id,
        period_days=period_days,
        amount_minor=facts.amount_minor,
        currency=facts.currency,
        live_mode=facts.live_mode,
        stripe_customer_id=facts.stripe_customer_id,
        note=note,
    )

    result = payload.get("result")
    granted = result == APPLIED

    log.info(
        "Stripe webhook: event=%s type=%s result=%s user=%s session=%s note=%s",
        facts.event_id,
        facts.event_type,
        result,
        user_id,
        facts.session_id,
        note,
    )

    return {
        "status": "ok" if granted else result,
        "event_id": facts.event_id,
        "event_type": facts.event_type,
        "result": result,
        "subscription_granted": granted,
        "user_id": user_id,
        "plan_id": plan_id,
        "period_days": period_days,
        # The expiry the database computed, present only when it granted. Read from
        # the answer rather than recomputed here, so the two cannot disagree.
        "subscription_expiry": payload.get("expiry"),
        "tier": payload.get("tier"),
        "note": note,
    }
