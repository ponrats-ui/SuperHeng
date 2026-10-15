"""Tests for `payments.py` — the Stripe adapter.

WHAT THESE ARE ACTUALLY DEFENDING
  Four claims, each of which would be expensive to discover was false in
  production:

  1. **The build is only "live" when it can both charge and account for the
     charge.** A secret key without a webhook secret would create real sessions
     that could never grant access — the customer pays and nothing happens — so
     ``configured()`` requires the pair.
  2. **The session request is the right request.** `payment_method_types` does not
     exist on a current Checkout Session and passing it is an API error, so the
     test pins `allowed_payment_method_types` *and* asserts the dead parameter is
     absent. A regression here is a paywall that cannot open at all.
  3. **The webhook signature is verified for real.** Rather than mocking the
     verifier, these tests compute a genuine Stripe signature with `hmac` and check
     that the SDK accepts it — and refuses it once a byte is changed. Mocking
     `construct_event` would prove only that the call was made.
  4. **No credential ever reaches a caller.** A Stripe auth failure quotes part of
     the key it rejected; the message this module returns must not.

The transport is faked by replacing `payments._client` — the one function that
builds the Stripe client. Everything else in `create_session` runs for real, which
is what makes the captured parameters worth asserting on.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
import stripe

import payments

BACKEND_DIR = Path(__file__).resolve().parent.parent

USER_ID = "11111111-1111-4111-8111-111111111111"
SECRET = "whsec_test_do_not_use_in_production"
API_KEY = "sk_test_do_not_use_in_production"


# ---------------------------------------------------------------------------
# Fixtures and fakes
# ---------------------------------------------------------------------------
@pytest.fixture()
def stripe_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both credentials present, so this build reports itself as live."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, API_KEY)
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, SECRET)


class _FakeSessions:
    """Stands in for `client.v1.checkout.sessions`. Records, then answers."""

    def __init__(self, outcome: object) -> None:
        self.outcome = outcome
        self.calls: list[tuple[dict, dict | None]] = []

    def create(self, params: dict, options: dict | None = None):
        self.calls.append((params, options))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


class _FakeClient:
    """A Stripe client whose only working part is the session create."""

    def __init__(self, outcome: object) -> None:
        self.v1 = SimpleNamespace(
            checkout=SimpleNamespace(sessions=_FakeSessions(outcome))
        )


def _session_object(**overrides) -> SimpleNamespace:
    """A Stripe Session, as far as this module reads it."""
    fields = {
        "id": "cs_test_abc123",
        "url": "https://checkout.stripe.com/c/pay/cs_test_abc123",
        "expires_at": 4_102_444_800,
        "livemode": False,
        "payment_method_types": ["card", "promptpay"],
        "amount_total": 9900,
        "currency": "thb",
    }
    fields.update(overrides)
    return SimpleNamespace(**fields)


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch, stripe_env) -> dict:
    """Install a fake transport and return a handle onto what it was asked to send."""
    handle: dict = {"outcome": _session_object()}
    client = _FakeClient(None)

    def _client():
        client.v1.checkout.sessions.outcome = handle["outcome"]
        return client

    monkeypatch.setattr(payments, "_client", _client)
    handle["client"] = client
    handle["sessions"] = client.v1.checkout.sessions
    return handle


def create_kwargs(**overrides) -> dict:
    """Everything `create_session` needs, so each test can vary one thing."""
    kwargs = {
        "user_id": USER_ID,
        "plan_id": "premium_monthly",
        "plan_name": "Premium · monthly",
        "plan_description": "30-day access to the Premium analysis",
        "amount_minor": 9900,
        "currency": "THB",
        "client_reference_metadata": {"plan_id": "premium_monthly", "period_days": "30"},
        "success_url": "https://app.example.test/premium?checkout=success",
        "cancel_url": "https://app.example.test/premium?checkout=cancelled",
        "idempotency_key": "idem-key-0001",
    }
    kwargs.update(overrides)
    return kwargs


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
def test_this_build_is_not_live_without_credentials():
    """The suite-wide fixture makes this the default state of every test."""
    assert payments.configured() is False
    assert payments.provider_name() is None
    assert payments.missing_configuration()


def test_a_secret_key_alone_is_not_enough_to_be_live(monkeypatch: pytest.MonkeyPatch):
    """A session could be created but never accounted for — the customer pays and
    nothing happens. The pair is therefore one requirement, not two."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, API_KEY)

    assert payments.configured() is False
    assert payments.WEBHOOK_SECRET_ENV in payments.missing_configuration()


def test_a_webhook_secret_alone_is_not_enough_either(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, SECRET)

    assert payments.configured() is False
    assert payments.SECRET_KEY_ENV in payments.missing_configuration()


def test_both_credentials_make_the_build_live(stripe_env):
    assert payments.configured() is True
    assert payments.provider_name() == payments.PROVIDER


def test_the_missing_configuration_message_names_every_missing_variable(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv(payments.SECRET_KEY_ENV, API_KEY)

    message = payments.missing_configuration()

    assert payments.WEBHOOK_SECRET_ENV in message
    # And says what to do, rather than only what is wrong.
    assert "backend/.env" in message


def test_blank_values_count_as_absent(monkeypatch: pytest.MonkeyPatch):
    """A trailing `STRIPE_SECRET_KEY=` in a .env is the common half-finished state."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, "   ")
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, SECRET)

    assert payments.configured() is False


@pytest.mark.parametrize(
    "value",
    [
        "sk_test_your-secret-key",
        "sk_live_change-me",
        "sk_test_placeholder",
        "whsec_your-endpoint-signing-secret",
    ],
)
def test_an_unfilled_template_value_is_not_a_credential(
    monkeypatch: pytest.MonkeyPatch, value: str
):
    """`backend/.env.example` ships real-looking placeholders on purpose, and they are
    shaped like real keys so a prefix test alone waves them through. Left undetected,
    the app would advertise a working gateway and fail every purchase with an opaque
    'Stripe refused the API key' instead of saying which variable is unfilled."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, value)
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, value)

    assert payments.configured() is False


def test_a_publishable_key_is_refused_with_a_sentence_about_it(
    monkeypatch: pytest.MonkeyPatch,
):
    """The likeliest paste error: `pk_...` cannot create a session, and Stripe's own
    error for it reads as an account permissions problem."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, "pk_test_51H8xyzABCDEF")
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, SECRET)

    problem = payments.secret_key_problem()

    assert problem is not None and "publishable" in problem
    assert payments.configured() is False


def test_a_signing_secret_from_the_wrong_endpoint_is_caught_by_shape(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv(payments.SECRET_KEY_ENV, API_KEY)
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, "not-a-signing-secret")

    problem = payments.webhook_secret_problem()

    assert problem is not None and "whsec_" in problem


# ---------------------------------------------------------------------------
# The payment method offer
# ---------------------------------------------------------------------------
def test_the_default_offer_is_card_and_promptpay():
    """The two methods the integration was specified to offer: cards for
    international customers, PromptPay for Thai ones."""
    assert payments.payment_methods() == ("card", "promptpay")


def test_dynamic_means_omit_the_filter(monkeypatch: pytest.MonkeyPatch):
    """Stripe's current guidance is to let it choose. The empty tuple is the signal
    to omit the parameter; see the module docstring for why that is not the same as
    listing every method."""
    monkeypatch.setenv(payments.PAYMENT_METHODS_ENV, payments.DYNAMIC_PAYMENT_METHODS)

    assert payments.payment_methods() == ()


def test_the_offer_can_be_narrowed(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(payments.PAYMENT_METHODS_ENV, "Card , promptpay,card")

    assert payments.payment_methods() == ("card", "promptpay")


def test_a_value_that_parses_to_nothing_falls_back_to_the_default(
    monkeypatch: pytest.MonkeyPatch,
):
    """A typo must not silently ship a session that offers nothing."""
    monkeypatch.setenv(payments.PAYMENT_METHODS_ENV, " , , ")

    assert payments.payment_methods() == payments.DEFAULT_PAYMENT_METHODS


def test_the_timeout_is_clamped_into_a_sane_band(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(payments.TIMEOUT_ENV, "0.01")
    assert payments.timeout_seconds() == payments.MIN_TIMEOUT_SECONDS

    monkeypatch.setenv(payments.TIMEOUT_ENV, "600")
    assert payments.timeout_seconds() == payments.MAX_TIMEOUT_SECONDS


def test_a_nonsense_timeout_falls_back_instead_of_raising(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv(payments.TIMEOUT_ENV, "soon")

    assert payments.timeout_seconds() == payments.DEFAULT_TIMEOUT_SECONDS


def test_no_api_version_is_pinned_by_default():
    """Pinning is right for production but has to be a version the account
    accepts, which cannot be checked from here — so it is opt-in."""
    assert payments.api_version() is None


# ---------------------------------------------------------------------------
# The session request — the part that would 400 in production
# ---------------------------------------------------------------------------
def test_the_session_sends_the_current_payment_method_parameter(captured):
    """`allowed_payment_method_types`, not `payment_method_types`.

    Verified against stripe-python 16.0.0: `SessionCreateParams` has no
    `payment_method_types` key, so sending it is an API error rather than a
    compatible older spelling. Both halves are asserted — the parameter that must
    be there, and the one that must not — because "it happens to be absent" is not
    the same as "it is known to be wrong".
    """
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["allowed_payment_method_types"] == ["card", "promptpay"]
    assert "payment_method_types" not in params


def test_dynamic_configuration_omits_the_parameter_entirely(
    monkeypatch: pytest.MonkeyPatch, captured
):
    monkeypatch.setenv(payments.PAYMENT_METHODS_ENV, payments.DYNAMIC_PAYMENT_METHODS)

    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert "allowed_payment_method_types" not in params


def test_the_session_is_a_one_time_payment(captured):
    """A 30-day pass, not a subscription: there is no subscription to lapse, only
    an expiry date the webhook writes."""
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["mode"] == "payment"


def test_the_amount_is_an_integer_in_the_minor_unit(captured):
    """9900 satang is ฿99.00. A float here is how a rounding bug becomes a pricing
    bug, and Stripe rejects it outright."""
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    unit_amount = params["line_items"][0]["price_data"]["unit_amount"]
    assert unit_amount == 9900
    assert isinstance(unit_amount, int) and not isinstance(unit_amount, bool)


def test_the_currency_is_lowercased_for_stripe(captured):
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["line_items"][0]["price_data"]["currency"] == "thb"


def test_the_user_id_is_on_both_the_reference_and_the_metadata(captured):
    """`client_reference_id` is the field built for this and the one the dashboard
    shows next to the payment; metadata is there so a lookup survives a field being
    dropped. Both are server-written."""
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["client_reference_id"] == USER_ID
    assert params["metadata"]["plan_id"] == "premium_monthly"
    assert params["metadata"]["period_days"] == "30"


def test_metadata_values_are_all_strings(captured):
    """Stripe accepts nothing else, and it rejects the whole request rather than
    the offending value."""
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    for key, value in params["metadata"].items():
        assert isinstance(value, str), f"metadata.{key} is {type(value).__name__}"


def test_the_return_urls_are_passed_through(captured):
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["success_url"].endswith("/premium?checkout=success")
    assert params["cancel_url"].endswith("/premium?checkout=cancelled")


def test_the_idempotency_key_is_sent(captured):
    """This is what makes a client-side retry after a timeout safe: it returns the
    same session instead of creating a second payable one."""
    payments.create_session(**create_kwargs())

    _, options = captured["sessions"].calls[0]
    assert options == {"idempotency_key": "idem-key-0001"}


def test_a_missing_idempotency_key_is_generated_not_omitted(captured):
    payments.create_session(**create_kwargs(idempotency_key=None))

    _, options = captured["sessions"].calls[0]
    assert options["idempotency_key"]


def test_a_malformed_idempotency_key_is_refused_before_the_gateway(captured):
    """Refused rather than forwarded: the key is a place a value travels into a
    gateway request, so it is shape-checked here rather than trusted."""
    with pytest.raises(payments.GatewayRejected):
        payments.create_session(**create_kwargs(idempotency_key="bad key!/../"))

    assert captured["sessions"].calls == []


@pytest.mark.parametrize("amount", [0, -1, None, 99.0, True])
def test_a_non_positive_or_non_integer_amount_is_refused(captured, amount):
    with pytest.raises(payments.GatewayRejected):
        payments.create_session(**create_kwargs(amount_minor=amount))

    assert captured["sessions"].calls == []


def test_the_returned_url_is_the_gateway_s(captured):
    session = payments.create_session(**create_kwargs())

    assert session.url.startswith("https://checkout.stripe.com/")
    assert session.id == "cs_test_abc123"
    assert session.expires_at == datetime.fromtimestamp(4_102_444_800, tz=timezone.utc)


def test_a_session_without_a_url_is_reported_as_a_failure(captured):
    """A session with no URL cannot be paid, so returning a half-built answer the
    client would have to guess at is worse than failing honestly."""
    captured["outcome"] = _session_object(url=None)

    with pytest.raises(payments.GatewayUnavailable):
        payments.create_session(**create_kwargs())


def test_creating_a_session_without_credentials_is_a_503():
    """Not patched here: the real `_client` runs and refuses."""
    with pytest.raises(payments.NotConfigured) as caught:
        payments.create_session(**create_kwargs())

    assert caught.value.status_code == 503


# ---------------------------------------------------------------------------
# Gateway failures — mapped, and never leaking the key
# ---------------------------------------------------------------------------
def test_stripe_refusing_the_api_key_is_a_503_not_a_caller_error(captured):
    captured["outcome"] = stripe.AuthenticationError("Invalid API Key provided: sk_test_****abcd")

    with pytest.raises(payments.GatewayUnavailable) as caught:
        payments.create_session(**create_kwargs())

    assert caught.value.status_code == 503


def test_a_rejected_api_key_is_never_echoed_back(captured):
    """Stripe's auth error quotes part of the key. The message that reaches the
    client names the variable instead — a credential has no business in a response
    body or a log line."""
    leaked = "sk_test_51H8xyzABCDEFGHIJKLMNOP"
    captured["outcome"] = stripe.AuthenticationError(f"Invalid API Key provided: {leaked}")

    with pytest.raises(payments.GatewayUnavailable) as caught:
        payments.create_session(**create_kwargs())

    assert leaked not in caught.value.detail
    assert "sk_test" not in caught.value.detail


def test_a_promptpay_refusal_explains_the_account_requirement(captured):
    """PromptPay needs a Thailand-registered account and THB. Stripe's own message
    is cryptic, and the fix is in the dashboard rather than the code — so the advice
    is attached."""
    captured["outcome"] = stripe.InvalidRequestError(
        "The payment method type promptpay is not allowed for this account",
        "allowed_payment_method_types",
    )

    with pytest.raises(payments.GatewayRejected) as caught:
        payments.create_session(**create_kwargs())

    assert caught.value.status_code == 502
    assert "Thailand" in caught.value.detail
    assert payments.PAYMENT_METHODS_ENV in caught.value.detail


def test_a_network_failure_says_nothing_was_charged(captured):
    """The customer must not be left wondering whether tapping the button again
    spends the money twice."""
    captured["outcome"] = stripe.APIConnectionError("connection reset")

    with pytest.raises(payments.GatewayUnavailable) as caught:
        payments.create_session(**create_kwargs())

    assert "Nothing was charged" in caught.value.detail


def test_rate_limiting_is_not_reported_as_a_bad_request(captured):
    captured["outcome"] = stripe.RateLimitError("too many requests")

    with pytest.raises(payments.GatewayUnavailable) as caught:
        payments.create_session(**create_kwargs())

    assert caught.value.status_code == 503


def test_an_unexpected_stripe_failure_still_says_nothing_was_charged(captured):
    captured["outcome"] = stripe.StripeError("something odd")

    with pytest.raises(payments.GatewayUnavailable) as caught:
        payments.create_session(**create_kwargs())

    assert "Nothing was charged" in caught.value.detail


# ---------------------------------------------------------------------------
# Webhook signature verification — against the real verifier
# ---------------------------------------------------------------------------
def _event_body(**overrides) -> bytes:
    event = {
        "id": "evt_test_0001",
        "object": "event",
        "api_version": "2026-09-30.endive",
        "created": 1_760_000_000,
        "type": "checkout.session.completed",
        "livemode": False,
        "pending_webhooks": 1,
        "data": {
            "object": {
                "id": "cs_test_0001",
                "object": "checkout.session",
                "mode": "payment",
                "payment_status": "paid",
                "client_reference_id": USER_ID,
                "amount_total": 9900,
                "currency": "thb",
                "livemode": False,
                "metadata": {
                    "plan_id": "premium_monthly",
                    "tier": "premium",
                    "period_days": "30",
                    "user_id": USER_ID,
                },
            }
        },
    }
    event.update(overrides)
    return json.dumps(event).encode()


def sign(payload: bytes, secret: str = SECRET, timestamp: int | None = None) -> str:
    """A genuine Stripe signature.

    The scheme is `t=<unix seconds>,v1=<hmac_sha256(secret, "<t>.<body>")>`, which
    is what the SDK verifies. Computing it here rather than mocking
    `construct_event` is the difference between testing this module's call and
    testing that the signature actually verifies — the latter is what protects the
    one endpoint that grants subscriptions.
    """
    ts = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), f"{ts}.{payload.decode()}".encode(), hashlib.sha256
    ).hexdigest()
    return f"t={ts},v1={digest}"


def test_a_genuinely_signed_event_is_accepted(stripe_env):
    payload = _event_body()

    event = payments.verify_event(payload, sign(payload))

    assert event["type"] == "checkout.session.completed"


def test_a_changed_byte_breaks_verification(stripe_env):
    """The signature covers the exact bytes. This is also why the route must read
    the raw body and never a parsed, re-serialised model."""
    payload = _event_body()
    signature = sign(payload)

    tampered = payload.replace(b'"paid"', b'"paid"'.replace(b"paid", b"paid"))

    with pytest.raises(payments.InvalidSignature):
        payments.verify_event(tampered + b" ", signature)


def test_a_signature_from_another_secret_is_refused(stripe_env):
    payload = _event_body()

    with pytest.raises(payments.InvalidSignature):
        payments.verify_event(payload, sign(payload, secret="whsec_someone_elses"))


def test_a_missing_signature_header_is_refused(stripe_env):
    """`None` rather than an exception: a header-less POST is the cheapest possible
    attack, and it must be a documented refusal, not a 500."""
    with pytest.raises(payments.InvalidSignature):
        payments.verify_event(_event_body(), None)


def test_an_empty_signature_header_is_refused(stripe_env):
    with pytest.raises(payments.InvalidSignature):
        payments.verify_event(_event_body(), "")


def test_a_replayed_old_signature_is_refused(stripe_env):
    """The SDK's tolerance window is what makes a captured request useless later."""
    payload = _event_body()
    long_ago = int(time.time()) - 3600

    with pytest.raises(payments.InvalidSignature):
        payments.verify_event(payload, sign(payload, timestamp=long_ago))


def test_a_signed_but_unparseable_body_is_a_different_failure(stripe_env):
    """Distinguished from a bad signature on purpose: Stripe did send this, the
    bytes are simply not an event. Same 400, different sentence — and a different
    line in the log."""
    payload = b"{not json at all"

    with pytest.raises(payments.MalformedEvent):
        payments.verify_event(payload, sign(payload))


def test_verification_without_a_secret_is_not_configured():
    with pytest.raises(payments.NotConfigured):
        payments.verify_event(_event_body(), "t=1,v1=deadbeef")


# ---------------------------------------------------------------------------
# Narrowing a verified event
# ---------------------------------------------------------------------------
def facts(payload: bytes):
    return payments.facts_from_event(payments.verify_event(payload, sign(payload)))


def test_the_user_id_comes_from_client_reference_id(stripe_env):
    """The field built for exactly this, and the one the Stripe dashboard shows
    next to the payment."""
    assert facts(_event_body()).user_id == USER_ID


def test_an_absent_client_reference_id_falls_back_to_metadata(stripe_env):
    payload = _event_body()
    event = json.loads(payload)
    event["data"]["object"]["client_reference_id"] = None
    event["data"]["object"]["metadata"]["user_id"] = USER_ID

    assert facts(json.dumps(event).encode()).user_id == USER_ID


def test_a_malformed_user_id_narrows_to_none(stripe_env):
    """The id decides which account is credited, so a bad one must be an absence
    rather than a value that reaches PostgREST and produces a cast error."""
    payload = _event_body()
    event = json.loads(payload)
    event["data"]["object"]["client_reference_id"] = "not-a-uuid"
    event["data"]["object"]["metadata"]["user_id"] = "also-not-a-uuid"

    assert facts(json.dumps(event).encode()).user_id is None


def test_an_upper_case_user_id_is_normalised(stripe_env):
    payload = _event_body()
    event = json.loads(payload)
    event["data"]["object"]["client_reference_id"] = USER_ID.upper()

    assert facts(json.dumps(event).encode()).user_id == USER_ID


def test_the_facts_carry_what_the_decision_needs(stripe_env):
    got = facts(_event_body())

    assert got.event_type == "checkout.session.completed"
    assert got.session_id == "cs_test_0001"
    assert got.plan_id == "premium_monthly"
    assert got.amount_minor == 9900
    assert got.currency == "thb"
    assert got.payment_status == "paid"
    assert got.live_mode is False
    assert got.grantable is True


def test_an_async_event_is_grantable_and_a_failure_is_not(stripe_env):
    """`async_payment_succeeded` is how a delayed payment that settles later is
    still honoured; without it the payment would be recorded and never granted."""
    assert payments.facts_from_event(
        payments.verify_event(
            _event_body(type="checkout.session.async_payment_succeeded"),
            sign(_event_body(type="checkout.session.async_payment_succeeded")),
        )
    ).grantable is True

    assert payments.facts_from_event(
        payments.verify_event(
            _event_body(type="checkout.session.async_payment_failed"),
            sign(_event_body(type="checkout.session.async_payment_failed")),
        )
    ).grantable is False


def test_an_unpaid_session_is_read_as_unpaid(stripe_env):
    payload = _event_body()
    event = json.loads(payload)
    event["data"]["object"]["payment_status"] = "unpaid"

    assert facts(json.dumps(event).encode()).payment_status == "unpaid"


def test_the_granting_event_set_is_the_documented_one():
    assert payments.HANDLED_EVENTS == {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "checkout.session.expired",
    }
    assert payments.GRANTING_EVENTS == {
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
    }
    assert payments.GRANTING_EVENTS <= payments.HANDLED_EVENTS


# ---------------------------------------------------------------------------
# The deferred import, which is a measured claim in the module docstring
# ---------------------------------------------------------------------------
def test_importing_this_module_does_not_import_the_sdk():
    """`import stripe` costs a measured 385 ms on this machine, which is why it is
    deferred. This test is the difference between that being a comment and it being
    true: a module-level import would be invisible in review and would tax every
    uvicorn boot, every --reload restart, and every test run that imports main."""
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys, payments; "
            "assert 'stripe' not in sys.modules, sorted(m for m in sys.modules if 'stripe' in m)",
        ],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr


def test_the_sdk_is_imported_as_soon_as_it_is_needed(stripe_env):
    """The deferral must not turn into the SDK never being importable."""
    assert payments._sdk().__name__ == "stripe"


# ---------------------------------------------------------------------------
# Who the payment is recorded against
# ---------------------------------------------------------------------------
def test_the_first_purchase_asks_stripe_to_create_a_customer(captured: dict, stripe_env):
    """`customer_creation` defaults to 'if_required' in `payment` mode — changed from
    'always' in API version 2022-08-01 — which creates no Customer and returns a null
    `session.customer`. Left at that default, `stripe_customer_id` would never be
    filled and every purchase would be an unrecognisable guest checkout."""
    payments.create_session(**create_kwargs())

    params, _ = captured["sessions"].calls[0]
    assert params["customer_creation"] == "always"
    # Never both: passing `customer` as well makes `customer_creation` redundant at
    # best and contradictory at worst, and Stripe rejects the combination.
    assert "customer" not in params


def test_a_returning_customer_is_reused_rather_than_duplicated(captured: dict, stripe_env):
    """The stored id is the whole point of the column: sending it back keeps one
    customer's payments on a single Customer object. Without this, Stripe mints a
    new Customer on every purchase — the exact duplicate the id exists to prevent."""
    payments.create_session(**create_kwargs(customer_id="cus_test_abc123"))

    params, _ = captured["sessions"].calls[0]
    assert params["customer"] == "cus_test_abc123"
    assert "customer_creation" not in params


def test_a_blank_customer_id_is_treated_as_absent(captured: dict, stripe_env):
    """An empty string is what a half-written row looks like, and asking Stripe about
    a customer that cannot exist would fail the purchase rather than fall back."""
    payments.create_session(**create_kwargs(customer_id=""))

    params, _ = captured["sessions"].calls[0]
    assert "customer" not in params
    assert params["customer_creation"] == "always"


def test_the_customer_id_is_read_from_the_bare_id_shape(stripe_env):
    event = json.loads(_event_body())
    event["data"]["object"]["customer"] = "cus_test_abc123"

    assert facts(json.dumps(event).encode()).stripe_customer_id == "cus_test_abc123"


def test_the_customer_id_is_read_from_the_expanded_object_shape(stripe_env):
    """`customer` is an expandable field, and a dashboard-configured endpoint may
    expand it into the full object. Reading only the string form would silently
    record nothing on exactly those deliveries."""
    event = json.loads(_event_body())
    event["data"]["object"]["customer"] = {"id": "cus_test_abc123", "object": "customer"}

    assert facts(json.dumps(event).encode()).stripe_customer_id == "cus_test_abc123"


def test_a_session_with_no_customer_narrows_to_none(stripe_env):
    """A legitimate guest checkout. The honest answer is "nothing to record", and the
    NULL it produces is what tells the function to leave any stored id untouched
    rather than clearing it."""
    event = json.loads(_event_body())

    assert facts(json.dumps(event).encode()).stripe_customer_id is None
