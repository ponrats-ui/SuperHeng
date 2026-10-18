"""Checkout — the plan catalogue, and the session that opens Stripe's payment page.

WHAT THIS MODULE OWNS
  The **price list** and the **shape of the answer** the app is given. It is the
  layer between the HTTP route and the gateway: it decides what is for sale, what
  a session response looks like, and what the app is told when no gateway is
  configured. The Stripe calls themselves live in `payments.py`.

WHAT THE CATALOGUE GUARANTEES
  These are the decisions that would otherwise be made under pressure the day a
  gateway was wired in, so they were made first and are pinned by tests:

  * **The price list lives on the server.** Plan ids, amounts and intervals are
    returned by `GET /api/checkout/plans` instead of being typed into the client.
    A price is a fact about what is being sold; two copies of it can disagree, and
    the copy a user sees is not the one that must match the charge. It also means
    the client cannot ask to be charged ฿1 for a ฿99 plan by editing a request.
  * **Amounts are integers in the currency's minor unit** (satang for THB, cents
    for USD). Every gateway that matters takes minor units as an integer; sending
    "99.00" as a float is how a rounding bug becomes a pricing bug.
  * **The caller cannot choose the account.** The user id comes from the verified
    token, never from the request body, so one account cannot open a checkout for
    another — and a client-supplied `user_id` that disagrees with the token is
    refused rather than ignored, because silently ignoring it would hide a client
    bug that would become a mis-billed charge.
  * **The return origin cannot be chosen by the caller either.** `success_url` and
    `cancel_url` are built from an origin the *server* trusts (see the route in
    `main.py`), never from a value handed in by the browser. A client-supplied
    redirect target is an open redirect: an attacker mails a link that pays real
    money and then lands the victim on a look-alike page they control.

WHAT `charged` MEANS HERE — READ THIS BEFORE CHANGING ANYTHING
  `POST /api/checkout/create-session` **never** charges anyone and **never** grants
  a subscription, with a gateway configured or without one. Creating a session
  merely produces a URL; no money moves until the customer completes the payment
  on Stripe's own page, and the entitlement is granted by the webhook in
  `webhook.py`. So both `charged` and `subscription_granted` are always false in
  this response, and a client that reads them before showing success UI cannot be
  fooled — including by a bug in this file.

  What *does* change when a gateway is configured is `status` and `checkout_url`:
  `"created"` with a real URL, versus `"not_implemented"` with `null`. That split
  is the whole point of the two states, and it is why the honest answer is an
  HTTP 200 rather than an error: the endpoint worked, it just did not sell
  anything. Returning 501 would push "not enabled yet" into the client's error
  path, where it reads as a bug.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

import payments
from auth import AuthenticatedUser

#: Marks a response from a build with no gateway. A string constant rather than a
#: boolean so the value stays meaningful when the real integration answers
#: `status: "created"` — which it now does.
STATUS_NOT_IMPLEMENTED = "not_implemented"

#: A session really was created at the gateway. It says nothing about payment:
#: see the module docstring.
STATUS_CREATED = "created"

#: The one currency offered today, and the one the paywall prices in. THB is also
#: what makes PromptPay offerable at all — Stripe supports it for THB only.
CURRENCY_THB = "THB"

#: Where Stripe sends the customer afterwards. Both are paths on the app itself,
#: which is why only the origin is configuration. `{CHECKOUT_SESSION_ID}` is a
#: literal Stripe substitutes on the success URL — it is the one way to know which
#: session the returning customer belongs to, and it is deliberately not trusted
#: for anything: the redirect is a *hint* to the app, and the webhook is the
#: authority on whether the payment happened.
SUCCESS_PATH = "/premium"
CANCEL_PATH = "/premium"

#: The sentence shown when no gateway is configured. It names the state and what
#: to do about it, because an operator who deploys this expecting it to sell needs
#: to find out from the response rather than from a support ticket.
NOT_CONFIGURED_MESSAGE = (
    "No payment gateway is connected yet. This response describes the session "
    "that would be created; nothing has been charged and no subscription has been "
    "granted. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in backend/.env to "
    "make this endpoint live."
)

#: The sentence shown when one really was created. It states plainly that no money
#: has moved yet, so a client cannot read "created" as "paid".
CREATED_MESSAGE = (
    "Checkout session created. No payment has been taken yet — open the checkout "
    "URL and complete the payment on Stripe's secure page. Access is granted by "
    "Stripe's confirmation, not by returning to the app."
)


def provider_configured() -> bool:
    """Whether a live payment gateway is reachable from this build.

    Derived from real credentials rather than from an operator-set name. That
    distinction is the point: a deployment that merely *says* a gateway is
    configured, without the keys to use it, would open a checkout in the app that
    could never complete. `payments.configured()` requires both the secret key and
    the webhook secret, so the app is only ever offered a purchase this build can
    actually finish and account for.
    """
    return payments.configured()


def provider_name() -> str | None:
    """The gateway this build can take money through, or None for the stub state."""
    return payments.provider_name()


@dataclass(frozen=True)
class Plan:
    """One purchasable subscription.

    ``amount_minor`` is an integer in ``currency``'s minor unit: 9900 THB satang is
    ฿99.00. There is no float anywhere on this path, on purpose.
    """

    id: str
    tier: str
    name: str
    amount_minor: int
    currency: str
    #: Gateway interval code — the value a provider's API expects, not prose.
    interval: str
    #: Length of the period, used to compute `subscription_expiry` after payment.
    period_days: int
    #: Shown by the client next to the price.
    amount_display: str

    def as_payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "name": self.name,
            "amount_minor": self.amount_minor,
            "amount_display": self.amount_display,
            "currency": self.currency,
            "interval": self.interval,
            "period_days": self.period_days,
        }

    def line_item_description(self) -> str:
        """What the customer sees on Stripe's page next to the price.

        Server-written and derived from the period, so the number of days the
        customer is told they are buying and the number of days the webhook will
        grant come from the same field.
        """
        return f"{self.period_days}-day access to the Premium analysis"

    def metadata(self) -> dict[str, str]:
        """The server-controlled metadata carried on the session.

        String values only — Stripe accepts nothing else — and every value is
        written here rather than taken from the request. `plan_id` is what the
        webhook looks up to decide the *period*, so a session that names a plan
        this build does not sell grants nothing instead of granting a default.
        """
        return {
            "plan_id": self.id,
            "tier": self.tier,
            "period_days": str(self.period_days),
        }


#: The catalogue. Monthly matches the ฿99/month the paywall shows; the year is
#: priced at ten months, which is the usual "two months free" shape and is the only
#: other interval the current single-tier product needs.
PLANS: tuple[Plan, ...] = (
    Plan(
        id="premium_monthly",
        tier="premium",
        name="Premium · monthly",
        amount_minor=9900,
        currency=CURRENCY_THB,
        interval="month",
        period_days=30,
        amount_display="฿99",
    ),
    Plan(
        id="premium_yearly",
        tier="premium",
        name="Premium · yearly",
        amount_minor=99000,
        currency=CURRENCY_THB,
        interval="year",
        period_days=365,
        amount_display="฿990",
    ),
)

PLANS_BY_ID: dict[str, Plan] = {plan.id: plan for plan in PLANS}

#: Every plan must sell the same tier, because `user_profiles` accepts two and the
#: catalogue is what decides which column value a payment writes. Checked at import
#: rather than trusted: a plan that sold, say, a hypothetical 'pro' tier would write
#: a value the `user_profiles_known_tier` constraint refuses, and the failure would
#: appear as a webhook 503 after a real payment.
assert len({plan.tier for plan in PLANS}) == 1, "the catalogue must sell exactly one tier"


def plans_payload() -> dict[str, Any]:
    """The catalogue as the client reads it.

    ``provider`` and ``live`` are stated at the top level rather than inferred from
    the plans, so the app can render its state from one field without having to
    guess whether an absent `checkout_url` means unconfigured or broken.
    """
    return {
        "provider": provider_name(),
        "live": provider_configured(),
        "currency": CURRENCY_THB,
        "plans": [plan.as_payload() for plan in PLANS],
    }


def return_urls(origin: str) -> tuple[str, str]:
    """The `success_url` and `cancel_url` for a payment started from `origin`.

    The origin is supplied by the route, which validates it against the same
    allow-list CORS uses — it is never taken from the request unchecked. See the
    module docstring for why that matters.

    Stripe replaces the literal ``{CHECKOUT_SESSION_ID}`` on the way back, which is
    the only way the returning page can name the session it belongs to. It is
    passed through to the app as a hint and used for nothing else: the redirect is
    what the customer's browser does, and the webhook is what decides access.

    Two spellings of each flag are sent. ``checkout=success``/``checkout=cancelled``
    is the original contract, and ``success=true``/``cancel=true`` is the simpler
    one an integration guide tends to name; both are read by `/premium`, so a link
    from either generation of the client means the same thing. They are additive
    rather than a replacement because a link already printed by Stripe keeps
    working — a return URL is not something this server can migrate.
    """
    base = origin.rstrip("/")
    return (
        f"{base}{SUCCESS_PATH}?checkout=success&success=true"
        "&session_id={CHECKOUT_SESSION_ID}",
        f"{base}{CANCEL_PATH}?checkout=cancelled&cancel=true",
    )


def create_session(
    user: AuthenticatedUser,
    plan: Plan,
    *,
    return_origin: str,
    claimed_user_id: str | None = None,
    idempotency_key: str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Create a checkout session, or describe the one that would have been created.

    ``claimed_user_id`` is accepted because the endpoint takes an optional
    ``user_id`` in the body. It is **not** used to choose the account — ``user``
    is, and that comes from the verified token. A mismatch is rejected in the
    endpoint, before this is called, so nothing here needs to care.

    ``now`` is unused: the real implementation takes its timestamps from the
    gateway, and a locally-stamped creation time would be a second clock that can
    disagree with Stripe's. It stays in the signature because it documents that
    the response carries no time of its own, and because it keeps the stub's
    deterministic-in-tests property available if that changes.

    Raises `payments.PaymentError` when a gateway is configured but the session
    could not be created; the caller maps `status_code` onto the response.
    """
    problem = payments.missing_configuration()
    if problem is not None:
        return _unconfigured_session(user, plan, problem)

    success_url, cancel_url = return_urls(return_origin)

    gateway = payments.create_session(
        user_id=user.user_id,
        plan_id=plan.id,
        plan_name=plan.name,
        plan_description=plan.line_item_description(),
        amount_minor=plan.amount_minor,
        currency=plan.currency,
        client_reference_metadata=plan.metadata(),
        success_url=success_url,
        cancel_url=cancel_url,
        idempotency_key=idempotency_key,
        # Taken from the caller's own profile row (read through RLS in `auth.py`),
        # never from the request body. When it is set, Stripe attaches the payment
        # to that existing Customer; when it is None this is the account's first
        # purchase and the gateway is asked to create one, which the webhook then
        # records back onto the same row.
        customer_id=user.stripe_customer_id,
    )

    return {
        "status": STATUS_CREATED,
        "provider": payments.PROVIDER,
        "live_mode": gateway.live_mode,
        # A real session id at the gateway. It must not be logged alongside
        # anything that identifies the customer, and it must never be used as
        # authorisation: knowing a session id grants nothing.
        "session_id": gateway.id,
        "checkout_url": gateway.url,
        # Reported so a support conversation can say when the link stops working,
        # and so the client could avoid offering a link about to expire.
        "expires_at": gateway.expires_at.isoformat() if gateway.expires_at else None,
        # What Stripe says the session is actually offering. Read back rather than
        # echoed from the request: if the dashboard is not eligible for a method
        # this build asked for, this is where that becomes visible instead of
        # being an unexplained absence on the payment page.
        "payment_method_types": list(gateway.payment_methods),
        "amount_minor": gateway.amount_minor,
        "currency": gateway.currency,
        "user_id": user.user_id,
        "plan": plan.as_payload(),
        # Never true, ever — see the module docstring. A created session is not a
        # payment, and this endpoint does not grant anything.
        "charged": False,
        "subscription_granted": False,
        "already_premium": user.is_premium(),
        "message": CREATED_MESSAGE,
    }


def _unconfigured_session(
    user: AuthenticatedUser, plan: Plan, problem: str
) -> dict[str, Any]:
    """The honest answer from a build with no gateway.

    Every field a client could mistake for success is explicit: `charged: false`,
    `subscription_granted: false`, `checkout_url: null`, and a `status` of
    `not_implemented`. `message` carries the *specific* missing configuration
    rather than a generic placeholder, so an operator reading it from a deployed
    app learns which variable to set.

    The response is shaped identically to the configured one — including the newer
    fields — so the client has one contract to code against and switching a
    gateway on cannot reflow the UI.
    """
    return {
        "status": STATUS_NOT_IMPLEMENTED,
        "provider": None,
        "live_mode": False,
        # A random id, printed nowhere else. It identifies a session that does not
        # exist anywhere, which is exactly what it is for: the client must not
        # have to special-case an absent field.
        "session_id": "",
        "checkout_url": None,
        "expires_at": None,
        "payment_method_types": [],
        "amount_minor": plan.amount_minor,
        "currency": plan.currency,
        "user_id": user.user_id,
        "plan": plan.as_payload(),
        "charged": False,
        "subscription_granted": False,
        "already_premium": user.is_premium(),
        "message": NOT_CONFIGURED_MESSAGE + f" ({problem})",
    }
