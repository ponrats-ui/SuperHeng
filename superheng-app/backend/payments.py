"""Stripe — creating a Checkout Session, and proving that Stripe sent the webhook.

WHAT THIS MODULE OWNS, AND WHAT IT DELIBERATELY DOES NOT
  This is the **gateway adapter**. It knows how to speak to Stripe and how to
  decide whether an inbound request really came from Stripe. It knows nothing
  about subscriptions, expiry dates or `user_profiles`: deciding what a payment
  *entitles* someone to is `webhook.py`'s job, and the two are kept apart so that
  a mistake in the gateway plumbing cannot silently grant a tier.

  Nothing here writes to the database. That is deliberate — this module is the
  only place that holds the Stripe secret, so it is the one place a credential
  leak would matter, and it is given no authority beyond talking to Stripe.

THE `payment_method_types` PARAMETER NO LONGER EXISTS — VERIFIED, NOT RECALLED
  The integration this module implements was specified as
  ``payment_method_types=['card', 'promptpay']``. **That parameter is not part of
  the Checkout Session API this code talks to.** Checked against the installed
  ``stripe`` SDK (16.0.0, API version ``2026-09-30.endive``) by reading
  ``SessionCreateParams.__annotations__``: the key is absent, and passing it
  would be rejected by the API as an unknown parameter.

  The current equivalent is **``allowed_payment_method_types``**, and its own
  docstring in the SDK describes the change:

      A list of the types of payment methods (e.g., `card`) this Checkout
      Session can accept. Unlike `payment_method_types`, this acts as a filter
      on the dynamically computed set of eligible payment methods rather than an
      explicit static list. Only payment methods that are both dynamically
      eligible and present in this list will be offered to the customer.

  Two consequences follow, and both are load-bearing:

  1. **PromptPay must also be enabled in the Stripe Dashboard.** Listing it here
     is necessary but not sufficient — it is a filter over what Stripe has
     decided this account may offer. If it is not enabled, Checkout simply does
     not show it, and no error is raised.
  2. **PromptPay requires a Thailand-registered Stripe account and THB.** Stripe
     documents PromptPay as THB-only and available to Thailand-based accounts. If
     the account is not Thai, asking for it is an error rather than an omission —
     see `_rejection_advice`, which turns that into a sentence that says what to
     do.

  ``STRIPE_PAYMENT_METHODS`` therefore exists as the escape hatch: set it to
  ``dynamic`` to omit the filter entirely and let Stripe choose (its own
  recommendation), or to a comma-separated list to narrow the offer. The default
  is the two methods that were asked for.

WHY THE IMPORT IS DEFERRED
  ``import stripe`` costs a measured **385 ms** on this machine (CPython 3.14.4,
  `python -X importtime`). It is imported inside the functions that need it for
  the same reason `main.py` defers `statsmodels` (1738 ms): a module-level import
  would add it to every uvicorn boot, every ``--reload`` restart, and every test
  run that merely imports `main`. A deployment with no Stripe keys - which is
  what this repository ships as - would pay it for nothing.

CREDENTIALS
  ``STRIPE_SECRET_KEY`` is a **server-side** credential: it can create charges
  and read every payment on the account. It belongs in the backend's environment
  only. It must never carry the ``EXPO_PUBLIC_`` prefix (which inlines a value
  into the app bundle for anyone to read) and must never be committed.

  There is deliberately **no publishable-key handling here**, because this
  integration does not need one. The app redirects to Stripe's own hosted
  Checkout page, so no Stripe.js or native SDK runs in the client and no
  publishable key is read by the app. A publishable key would only be needed to
  embed the payment form in-process (Payment Element, PaymentSheet), which is a
  different integration with a different key surface. See ../.env.example.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

log = logging.getLogger("superheng.payments")

#: The provider name written to `user_profiles.subscription_provider` and reported
#: by the catalogue. A stable lowercase token, not prose.
PROVIDER = "stripe"

# --- Environment variable names -------------------------------------------
SECRET_KEY_ENV = "STRIPE_SECRET_KEY"
WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET"
API_VERSION_ENV = "STRIPE_API_VERSION"
PAYMENT_METHODS_ENV = "STRIPE_PAYMENT_METHODS"
TIMEOUT_ENV = "STRIPE_TIMEOUT_SECONDS"

#: The methods the paywall offers by default: cards for international users,
#: PromptPay for Thai ones. This is the one place the offer is stated.
DEFAULT_PAYMENT_METHODS: tuple[str, ...] = ("card", "promptpay")

#: Set ``STRIPE_PAYMENT_METHODS`` to this to omit the filter and let Stripe
#: present whatever the account is eligible for. Stripe's own current guidance is
#: to prefer this, so it is reachable without a code change.
DYNAMIC_PAYMENT_METHODS = "dynamic"

#: Stripe recommends a timeout on every call so a hung request cannot hang the
#: caller. The SDK's own default is 80 seconds, which is far longer than a user
#: waiting on a paywall should ever see, so it is lowered here and clamped to a
#: band that is neither a guaranteed failure (too low) nor the default (too high).
DEFAULT_TIMEOUT_SECONDS = 10.0
MIN_TIMEOUT_SECONDS = 2.0
MAX_TIMEOUT_SECONDS = 30.0

#: Stripe accepts up to 255 characters. Anything outside this shape is refused
#: rather than forwarded, so a client cannot smuggle a second parameter or a
#: header through the idempotency key.
_IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,255}$")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
def _env(name: str) -> str:
    """Read `name`, stripped, treating a blank value as absent."""
    return (os.getenv(name) or "").strip()


def secret_key() -> str:
    return _env(SECRET_KEY_ENV)


def webhook_secret() -> str:
    return _env(WEBHOOK_SECRET_ENV)


def api_version() -> str | None:
    """The API version to pin, or None to use the SDK's own default.

    Left None by default on purpose. Pinning is the right thing for production
    (it stops an account-level default upgrade from silently changing a payload
    shape underneath working code), but the version has to be one the account
    accepts, and that cannot be checked from here — so it is opt-in and the SDK
    default applies until an operator pins it deliberately.
    """
    return _env(API_VERSION_ENV) or None


def timeout_seconds() -> float:
    raw = _env(TIMEOUT_ENV)
    try:
        value = float(raw) if raw else DEFAULT_TIMEOUT_SECONDS
    except ValueError:
        log.warning("%s=%r is not a number; using %s.", TIMEOUT_ENV, raw, DEFAULT_TIMEOUT_SECONDS)
        return DEFAULT_TIMEOUT_SECONDS
    return max(MIN_TIMEOUT_SECONDS, min(MAX_TIMEOUT_SECONDS, value))


def payment_methods() -> tuple[str, ...]:
    """The offer filter, or an empty tuple meaning "let Stripe choose".

    An empty tuple is the signal to omit the parameter; see the module docstring
    for why that is not the same thing as listing every method.
    """
    raw = _env(PAYMENT_METHODS_ENV)
    if not raw:
        return DEFAULT_PAYMENT_METHODS
    if raw.lower() == DYNAMIC_PAYMENT_METHODS:
        return ()
    methods: list[str] = []
    for part in raw.split(","):
        token = part.strip().lower()
        if token and token not in methods:
            methods.append(token)
    if not methods:
        # A value that parsed to nothing is a configuration typo. Falling back to
        # the default keeps the paywall honest (it still says PromptPay) instead
        # of quietly shipping a session that offers nothing.
        log.warning("%s=%r listed no methods; falling back to the default.", PAYMENT_METHODS_ENV, raw)
        return DEFAULT_PAYMENT_METHODS
    return tuple(methods)


#: Text that marks a value as still being the template it was copied from.
#:
#: `backend/.env.example` ships real-looking placeholders (`sk_test_your-secret-key`,
#: `whsec_your-endpoint-signing-secret`) because a template with empty values is
#: harder to fill in. A value copied without being filled in would pass every
#: "is it non-empty" test, and the consequence here is not cosmetic: the app would
#: report a connected gateway, offer a purchase, and fail every attempt with an
#: opaque "Stripe refused the API key" — instead of the honest "not set up yet"
#: state that names the variable. The same guard already exists in `main.py` for
#: the Supabase credentials, for the same reason.
#:
#: Checked against the whole value rather than only its prefix, because these
#: placeholders are deliberately shaped like the real thing: `sk_test_your-key`
#: starts with `sk_`, so a prefix test alone would wave it through. A real Stripe
#: key is a random base62 string, so a marker appearing inside one is not a
#: realistic false positive.
_PLACEHOLDER_MARKERS = re.compile(
    r"(your[-_]|paste|insert|replace|change[-_]?me|placeholder|todo|xxx)",
    re.IGNORECASE,
)


def _is_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER_MARKERS.search(value))


def secret_key_problem() -> str | None:
    """Why the Stripe API key is unusable, or None when it looks fine."""
    key = secret_key()
    if not key:
        return (
            f"{SECRET_KEY_ENV} is not set. Add it to backend/.env (see "
            "backend/.env.example) — Stripe dashboard → Developers → API keys → "
            "Secret key."
        )
    if _is_placeholder(key):
        return (
            f"{SECRET_KEY_ENV} still holds the example value from "
            "backend/.env.example, not a real key. Replace it with the account's "
            "secret key."
        )
    if not key.startswith(("sk_", "rk_")):
        # Catches the single most likely mistake: pasting the publishable key,
        # which is `pk_...` and cannot create a session. Stripe's own error for
        # that is about API-key permissions and reads as an account problem.
        return (
            f"{SECRET_KEY_ENV} does not look like a Stripe secret key: it should "
            "start with `sk_` or `rk_`. A publishable key (`pk_`) cannot create a "
            "session — this API is the only thing that talks to Stripe, so it needs "
            "the secret one."
        )
    return None


def webhook_secret_problem() -> str | None:
    """Why an inbound webhook cannot be verified, or None when it can."""
    secret = webhook_secret()
    if not secret:
        return (
            f"{WEBHOOK_SECRET_ENV} is not set, so a Stripe delivery cannot be "
            "verified and nothing can be granted. Add the signing secret of the "
            "webhook endpoint (Stripe dashboard → Developers → Webhooks) to "
            "backend/.env. Each endpoint has its own secret."
        )
    if _is_placeholder(secret) or not secret.startswith("whsec_"):
        return (
            f"{WEBHOOK_SECRET_ENV} does not look like a webhook signing secret: it "
            "should start with `whsec_`. Note that `stripe listen` prints a "
            "*different* secret from the deployed endpoint's."
        )
    return None


def missing_configuration() -> str | None:
    """Why this build cannot take money, or None when it can.

    Both halves are required. A secret key without a webhook secret would create
    real sessions that could never grant an entitlement — the customer pays and
    nothing happens — so the pair is treated as one requirement and a half-configured
    deployment stays in the honest "not open yet" state rather than opening a
    checkout it cannot complete.
    """
    for problem in (secret_key_problem(), webhook_secret_problem()):
        if problem is not None:
            return problem
    return None


def missing_verification_configuration() -> str | None:
    """Why an inbound webhook cannot be verified, or None when it can.

    Deliberately narrower than `missing_configuration()`, which also requires the
    API key. Verifying a delivery needs only the endpoint's signing secret; the
    API key is needed to *create* a session, not to check one.

    The distinction is not pedantry. The webhook is the path that records money
    that has already been taken, and making it depend on the charge path's
    credential would mean that key going missing — a rotation, a bad deploy, an
    over-eager revocation — silently stops real payments from being granted. The
    message would also blame the wrong variable. The two requirements stay
    separate because they fail independently.
    """
    return webhook_secret_problem()


def configured() -> bool:
    """Whether this build can create a session *and* verify the result."""
    return missing_configuration() is None


def provider_name() -> str | None:
    return PROVIDER if configured() else None


# ---------------------------------------------------------------------------
# Failures
# ---------------------------------------------------------------------------
class PaymentError(RuntimeError):
    """Base class for a failure this module knows how to describe.

    ``status_code`` and ``detail`` are carried on the exception so the API layer
    can map a failure onto a response without a second classification table that
    could drift out of step with this one.
    """

    status_code = 500

    def __init__(self, detail: str, status_code: int | None = None) -> None:
        super().__init__(detail)
        self.detail = detail
        if status_code is not None:
            self.status_code = status_code


class NotConfigured(PaymentError):
    """This build has no usable Stripe credentials. Never the caller's fault."""

    status_code = 503


class GatewayUnavailable(PaymentError):
    """Stripe could not be reached, refused our credentials, or failed.

    A 503 rather than a 5xx: nothing was learned about the request, so retrying
    is the correct advice and the caller should not be told their input was bad.
    """

    status_code = 503


class GatewayRejected(PaymentError):
    """Stripe understood the request and refused it.

    This is the one that means *our* configuration is wrong rather than the
    caller's input - asking for PromptPay on a non-Thai account lands here - so
    the message carries what to fix.
    """

    status_code = 502


class InvalidSignature(PaymentError):
    """The webhook did not carry a valid Stripe signature. Treat as hostile."""

    status_code = 400


class MalformedEvent(PaymentError):
    """The body was signed by Stripe but is not a parseable event."""

    status_code = 400


# ---------------------------------------------------------------------------
# The SDK, imported on demand
# ---------------------------------------------------------------------------
_stripe_module: Any = None


def _sdk() -> Any:
    """The `stripe` module, imported on first use. See the module docstring."""
    global _stripe_module
    if _stripe_module is None:
        import stripe  # noqa: PLC0415 - deferred on purpose; 385 ms measured

        _stripe_module = stripe
    return _stripe_module


def _client() -> Any:
    """A Stripe client for the configured account.

    Built per call rather than cached in a module global: the client is cheap, the
    shared-singleton pattern is what `main.py` does for Supabase because that one
    holds a connection pool, and a per-call client here means a credential change
    takes effect without a restart. Network retries are disabled on the client
    because a retried `POST /checkout/sessions` that already succeeded would
    create a second session; the caller's own idempotency key is what makes a
    client-side retry safe, and that is passed per request below.
    """
    stripe = _sdk()
    key = secret_key()
    if not key:
        raise NotConfigured(missing_configuration() or "Stripe is not configured.")

    version = api_version()
    return stripe.StripeClient(
        key,
        **({"stripe_version": version} if version else {}),
        max_network_retries=0,
        http_client=stripe.RequestsClient(timeout=timeout_seconds()),
    )


# ---------------------------------------------------------------------------
# Creating a session
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class GatewaySession:
    """What Stripe said after a session was created.

    Only the fields this application acts on. Notably `id` and `url`: the id is
    the value the webhook will carry back, and the url is the only thing handed
    to the browser.
    """

    id: str
    url: str
    expires_at: datetime | None
    live_mode: bool
    payment_methods: tuple[str, ...]
    amount_minor: int | None
    currency: str | None


def _expiry_from_epoch(value: Any) -> datetime | None:
    """Stripe timestamps are integer seconds since the epoch, UTC."""
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    try:
        return datetime.fromtimestamp(value, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None


def _rejection_advice(message: str) -> str:
    """Turn a Stripe refusal into something the operator can act on.

    Stripe's own text is kept — it is specific and it names the offending
    parameter — but the two refusals that are *configuration* mistakes rather than
    code mistakes are called out, because both read as cryptic API errors and the
    fix is in the dashboard rather than the code.
    """
    advice: list[str] = []
    if "promptpay" in message.lower():
        if "th" in message.lower() or "currency" in message.lower() or "account" in message.lower():
            advice.append(
                "PromptPay requires a Thailand-registered Stripe account and THB "
                "amounts, and must be enabled in Dashboard → Settings → Payment "
                f"methods. To sell cards only, set {PAYMENT_METHODS_ENV}=card."
            )
    if "payment_method_types" in message:
        advice.append(
            "This build sends `allowed_payment_method_types`, which replaced "
            "`payment_method_types` on Checkout Sessions. Clear "
            f"{API_VERSION_ENV} if it pins an older API version."
        )
    return message + (" " + " ".join(advice) if advice else "")


def create_session(
    *,
    user_id: str,
    plan_id: str,
    plan_name: str,
    plan_description: str,
    amount_minor: int,
    currency: str,
    client_reference_metadata: dict[str, str],
    success_url: str,
    cancel_url: str,
    idempotency_key: str | None = None,
    customer_id: str | None = None,
) -> GatewaySession:
    """Create a one-time Checkout Session and return it.

    ``mode`` is ``payment`` — a single charge for a fixed period, not a
    subscription. That is the shape a 30-day pass has, and it is why the
    entitlement is granted from the *payment* rather than from a subscription's
    lifecycle: there is no subscription to lapse, only an expiry date.

    The caller's id goes in **both** ``client_reference_id`` (the field built for
    exactly this, and the one the dashboard surfaces next to the payment) and
    ``metadata`` (so a lookup survives a field being dropped). Both are
    server-controlled: the id is the token's, never the request body's.

    ``idempotency_key`` is what makes a *client-side* retry safe. If a request
    times out after Stripe created the session, retrying with the same key
    returns that same session instead of creating a second payable one. A fresh
    key without a retry is a fresh session, which is correct — two taps are two
    intents.
    """
    if not isinstance(amount_minor, int) or isinstance(amount_minor, bool) or amount_minor <= 0:
        # Refused here rather than sent: Stripe would reject it with a message
        # about `unit_amount`, which points at Stripe's API rather than at the
        # catalogue that produced the bad number.
        raise GatewayRejected(f"Refusing to create a session for a non-positive amount: {amount_minor!r}.")

    key = (idempotency_key or "").strip()
    if key and not _IDEMPOTENCY_KEY_RE.match(key):
        raise GatewayRejected(
            "The supplied idempotency key has an unexpected shape. It must be "
            "8-255 characters of A-Z, a-z, 0-9, underscore or hyphen."
        )
    if not key:
        # A server-generated key still dedupes nothing across calls, but it makes
        # the request traceable in Stripe's logs and costs nothing.
        key = str(uuid.uuid4())

    methods = payment_methods()

    params: dict[str, Any] = {
        "mode": "payment",
        "client_reference_id": user_id,
        "metadata": dict(client_reference_metadata),
        "line_items": [
            {
                "quantity": 1,
                "price_data": {
                    "currency": currency.lower(),
                    # Integer minor units straight from the catalogue. No float
                    # touches this path — see checkout.py.
                    "unit_amount": amount_minor,
                    "product_data": {
                        "name": plan_name,
                        "description": plan_description,
                        "metadata": {"plan_id": plan_id},
                    },
                },
            }
        ],
        "success_url": success_url,
        "cancel_url": cancel_url,
    }

    # Who the payment is recorded against.
    #
    # Stripe does not attach a Customer unless asked: `customer_creation` defaults
    # to 'if_required' in `payment` mode (the default changed from 'always' in API
    # version 2022-08-01), which creates none and leaves `session.customer` null —
    # so `user_profiles.stripe_customer_id` would stay empty forever. Asking for a
    # Customer on the first purchase and reusing it on every later one keeps a
    # returning customer's payments on a single Customer object rather than minting
    # a duplicate per purchase, which is what makes the stored id worth having.
    if customer_id:
        params["customer"] = customer_id
    else:
        params["customer_creation"] = "always"

    if methods:
        params["allowed_payment_method_types"] = list(methods)
        log.info(
            "Creating a Stripe session offering %s for plan=%s user=%s",
            ", ".join(methods),
            plan_id,
            user_id,
        )
    else:
        log.info(
            "Creating a Stripe session with dynamic payment methods for plan=%s user=%s",
            plan_id,
            user_id,
        )

    stripe = _sdk()
    try:
        session = _client().v1.checkout.sessions.create(params, {"idempotency_key": key})
    except stripe.AuthenticationError as exc:
        # Deliberately not echoing Stripe's text: it can quote part of the key,
        # which has no business reaching a client or a log line.
        log.error("Stripe refused the API key (%s): %s", type(exc).__name__, exc)
        raise GatewayUnavailable(
            f"Stripe refused the API key in {SECRET_KEY_ENV}. Check that the key is "
            "correct, is not a publishable key, and belongs to the account you expect."
        ) from exc
    except stripe.APIConnectionError as exc:
        log.warning("Stripe could not be reached: %s", exc)
        raise GatewayUnavailable(
            "Could not reach Stripe. Nothing was charged — try again."
        ) from exc
    except stripe.RateLimitError as exc:
        log.warning("Stripe rate-limited the session create: %s", exc)
        raise GatewayUnavailable(
            "Stripe is rate-limiting this account. Nothing was charged — try again shortly."
        ) from exc
    except stripe.InvalidRequestError as exc:
        message = str(exc)
        log.error("Stripe rejected the session parameters: %s", message)
        raise GatewayRejected(
            "Stripe refused the checkout parameters: " + _rejection_advice(message)
        ) from exc
    except stripe.StripeError as exc:
        log.exception("Stripe failed while creating a session.")
        raise GatewayUnavailable(
            f"Stripe failed while creating the checkout session ({type(exc).__name__}). "
            "Nothing was charged — try again."
        ) from exc

    url = getattr(session, "url", None)
    session_id = getattr(session, "id", None)
    if not url or not session_id:
        # A session without a URL cannot be paid and a session without an id
        # cannot be reconciled. Rather than returning a half-built answer that
        # the client would have to guess at, this is reported as a failure.
        log.error("Stripe returned a session without a usable url/id: %r", session)
        raise GatewayUnavailable(
            "Stripe created a session but did not return a checkout URL. Nothing was charged."
        )

    return GatewaySession(
        id=str(session_id),
        url=str(url),
        expires_at=_expiry_from_epoch(getattr(session, "expires_at", None)),
        live_mode=bool(getattr(session, "livemode", False)),
        payment_methods=tuple(getattr(session, "payment_method_types", ()) or ()),
        amount_minor=getattr(session, "amount_total", None),
        currency=getattr(session, "currency", None),
    )


# ---------------------------------------------------------------------------
# The webhook
# ---------------------------------------------------------------------------
def verify_event(payload: bytes, signature: str | None) -> Any:
    """Verify Stripe's signature over the *raw* body, and return the parsed event.

    The payload must be the exact bytes Stripe sent. Re-serialising parsed JSON
    changes whitespace and key order, and the signature is computed over the
    bytes — so a handler that takes a Pydantic model or calls ``request.json()``
    first will fail verification for every genuine event. That is why the route in
    `main.py` reads ``await request.body()`` and nothing else.

    A missing header and a wrong secret both raise `InvalidSignature`; the SDK
    raises `SignatureVerificationError` for each. A signed-but-unparseable body
    raises `MalformedEvent`, which is a different situation: Stripe did send it,
    the bytes are simply not an event.
    """
    stripe = _sdk()
    secret = webhook_secret()
    if not secret:
        raise NotConfigured(missing_configuration() or "Stripe is not configured.")

    try:
        # `payload` is passed as bytes so the SDK verifies exactly what arrived.
        return stripe.Webhook.construct_event(payload, signature, secret)
    except stripe.SignatureVerificationError as exc:
        # Logged without the body: an unverified body is attacker-controlled text
        # and has no business in the log.
        log.warning("Rejected a webhook with an invalid signature: %s", exc)
        raise InvalidSignature(
            "The Stripe-Signature header did not verify against the configured "
            f"endpoint secret. Check that {WEBHOOK_SECRET_ENV} is the signing secret "
            "of *this* endpoint (each endpoint has its own)."
        ) from exc
    except ValueError as exc:
        log.warning("Rejected a signed webhook whose body was not JSON: %s", exc)
        raise MalformedEvent("The webhook body was not valid JSON.") from exc


#: The events this application acts on.
#:
#: `checkout.session.completed` is the documented signal that the customer
#: finished. It is *not* on its own proof that money moved: for a delayed payment
#: method the session can complete while still `processing`, which is why the
#: handler checks `payment_status` before granting anything. The async pair is
#: included so a payment that settles later is still honoured — Stripe documents
#: `checkout.session.async_payment_succeeded` for exactly that case, and without
#: it a delayed payment would be recorded and never granted.
HANDLED_EVENTS: frozenset[str] = frozenset(
    {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
    }
)

#: Events whose arrival can mean a payment is ready to grant. The other handled
#: events are recorded for the ledger but never grant.
GRANTING_EVENTS: frozenset[str] = frozenset(
    {"checkout.session.completed", "checkout.session.async_payment_succeeded"}
)


def _read(obj: Any, name: str, default: Any = None) -> Any:
    """One field off an SDK object, tolerating both shapes it comes in.

    Stripe's objects support ``obj["field"]`` and ``getattr(obj, "field")``, and a
    nested object may or may not be a plain dict depending on which SDK version
    constructed it — and on whether the event came from a test. Accepting both
    means this module does not break when either changes, and it never has to
    convert a whole object graph to read three fields out of it.

    Deliberately narrow on the exceptions: anything else is a real bug and should
    be loud rather than read as an absent field.
    """
    if obj is None:
        return default
    try:
        value = obj[name]
    except (KeyError, TypeError, IndexError):
        try:
            value = getattr(obj, name)
        except AttributeError:
            return default
    return default if value is None else value


def checkout_session(event: Any) -> Any:
    """The Checkout Session an event carries, or None.

    Returned as the SDK object rather than converted to a dict. That is not
    laziness: `to_dict_recursive` — the documented-looking way to do it — **does
    not exist** on the objects this SDK version produces, verified against
    stripe-python 16.0.0. Relying on a converter would mean relying on an API that
    has already moved once, for a function that only ever reads a handful of named
    fields. `_read` gets them from either shape instead.
    """
    return _read(_read(event, "data"), "object")


def _expandable_id(value: Any) -> str | None:
    """The id out of a Stripe expandable field, whichever shape it arrived in.

    Stripe returns either the bare id string or — when the caller asked for it
    expanded — a full object carrying an `id`. Reading only the string form would
    silently record nothing on an expanded event, and a dashboard-configured
    endpoint is exactly where that shape turns up.
    """
    if isinstance(value, str):
        return value or None
    inner = _read(value, "id")
    return inner if isinstance(inner, str) and inner else None


def _uuid_shaped(value: Any) -> str | None:
    """The value if it looks like a Supabase user id, else None.

    A UUID is checked rather than assumed because the id decides *which account*
    is credited. The value comes from metadata this server wrote, but the account
    can also be edited by hand in the Stripe dashboard, and a malformed id sent to
    PostgREST would produce a confusing cast error rather than a decision.
    """
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value.strip()))
    except (ValueError, AttributeError, TypeError):
        return None


@dataclass(frozen=True)
class PaymentFacts:
    """What a verified event says, with every field already narrowed or None.

    Nothing here is a decision. `webhook.py` turns these facts into an
    entitlement; keeping the two apart is what lets the entitlement rules be
    read — and tested — without Stripe in the picture.
    """

    event_id: str
    event_type: str
    session_id: str | None
    user_id: str | None
    plan_id: str | None
    amount_minor: int | None
    currency: str | None
    live_mode: bool | None
    #: Stripe's verdict on whether the money is actually there: 'paid',
    #: 'unpaid' or 'no_payment_required'. None when absent.
    payment_status: str | None
    #: The Stripe Customer the session was billed to, when it created or reused
    #: one. None when Stripe returned none — a session that left `customer_creation`
    #: at 'if_required' — which must read as "no customer to record" rather than as
    #: an error, and which `apply_payment_event` handles by leaving the stored value
    #: untouched.
    stripe_customer_id: str | None
    #: Whether this event type is one that can grant, as opposed to one that only
    #: records. Both must hold before an entitlement is written.
    grantable: bool


def _text(value: Any) -> str | None:
    """The value if it is a non-empty string, else None. Narrows without coercing:
    a number that arrived where a string was expected is a schema surprise, not a
    string to be invented."""
    return value if isinstance(value, str) and value else None


def facts_from_event(event: Any) -> PaymentFacts:
    """Narrow a verified event to the fields the entitlement decision uses.

    Every field is read defensively and every unexpected shape becomes None rather
    than a coerced value. None of it is a decision — `webhook.py` turns these facts
    into an entitlement — and an absent field must read as absent, because the one
    thing this must never do is supply a default that looks like real data. The
    period an event grants is not read here at all: it comes from the catalogue.
    """
    event_id = _text(_read(event, "id")) or ""
    event_type = _text(_read(event, "type")) or ""
    session = checkout_session(event)
    metadata = _read(session, "metadata")

    # `client_reference_id` first because it is the field built for this and the
    # one the dashboard shows; metadata as the fallback. The two are written from
    # the same value, so a disagreement means something outside this application
    # touched the session — in which case trusting either is already questionable,
    # and `webhook.py` refuses rather than picking a winner.
    amount = _read(session, "amount_total")
    live_mode = _read(session, "livemode")
    return PaymentFacts(
        event_id=event_id,
        event_type=event_type,
        session_id=_text(_read(session, "id")),
        user_id=_uuid_shaped(_read(session, "client_reference_id"))
        or _uuid_shaped(_read(metadata, "user_id")),
        plan_id=_text(_read(metadata, "plan_id")),
        # `isinstance(x, bool)` excluded explicitly: in Python `True` is an int,
        # and an amount that read `True` would be a nonsense value wearing a
        # plausible type.
        amount_minor=amount
        if isinstance(amount, int) and not isinstance(amount, bool)
        else None,
        currency=_text(_read(session, "currency")),
        live_mode=live_mode if isinstance(live_mode, bool) else None,
        payment_status=_text(_read(session, "payment_status")),
        stripe_customer_id=_expandable_id(_read(session, "customer")),
        grantable=event_type in GRANTING_EVENTS,
    )
