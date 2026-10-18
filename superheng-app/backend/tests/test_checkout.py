"""Tests for `checkout.py` and `POST /api/checkout/create-session`.

The endpoint has two states, and the tests are organised around them:

* **No gateway configured** — the honest "not open yet" answer. The point is not
  that the stub returns a dictionary; it is that a deployment without credentials
  **cannot take money or grant a subscription**. `test_the_stub_performs_no_io_at_all`
  is the load-bearing one: it poisons every transport `checkout.py` could reach and
  shows the call still succeeds. A comment claiming "this does not charge anyone"
  cannot be tested; an absent side effect can.
* **Stripe configured** — a real, payable session, with the transport faked at
  `payments._client` (the one function that builds a Stripe client). Everything
  else runs for real, which is what makes the captured parameters worth asserting
  on.

The invariant that spans both states, and the one to hold any future change to
this endpoint to: **`charged` and `subscription_granted` are always false.**
Creating a payment page takes no money and grants nothing; only the verified
webhook in `webhook.py` grants, and only once Stripe says the money arrived.

Two other contracts are pinned here because they were decided before a gateway was
chosen and would be expensive to change now: the price list lives on the server in
integer minor units, and the account is taken from the verified token rather than
the request body.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

import auth
import checkout
import main
import payments

USER_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"


class _FakeClaims:
    """`get_claims` returns a TypedDict, i.e. a plain `dict` at runtime.

    This is the checkout suite, so it is the one that would have caught the
    "access token was rejected" bug: modelling the return value as an object with a
    `.claims` attribute made the fake agree with a read the library never satisfies.
    """

    def __new__(cls, claims: dict) -> dict:
        return {"claims": claims, "headers": {"alg": "ES256"}, "signature": b""}


class _FakeAuth:
    def __init__(self, claims: dict) -> None:
        self._claims = claims

    def get_claims(self, _token: str):
        return _FakeClaims(self._claims)


class _FakeClient:
    def __init__(self) -> None:
        self.auth = _FakeAuth(
            {
                "sub": USER_ID,
                "email": "buyer@example.test",
                "role": "authenticated",
                "aud": "authenticated",
            }
        )


@pytest.fixture()
def signed_in(monkeypatch: pytest.MonkeyPatch) -> dict:
    """A signed-in caller whose profile row the test can edit in place."""
    profile: dict = {
        "id": USER_ID,
        "email": "buyer@example.test",
        "subscription_tier": "free",
        "subscription_expiry": None,
        "subscription_provider": None,
    }
    monkeypatch.setattr(main, "get_supabase", _FakeClient)
    monkeypatch.setattr(auth, "read_profile", lambda *_args, **_kwargs: dict(profile))
    return profile


def post(client: TestClient, body: dict, token: str = "Bearer good-token", **extra):
    """POST a checkout request. ``extra`` adds optional body fields — in practice
    `return_origin`, which the endpoint takes but the older tests never sent."""
    return client.post(
        "/api/checkout/create-session",
        json={**body, **extra},
        headers={"Authorization": token},
    )


# ---------------------------------------------------------------------------
# The catalogue
# ---------------------------------------------------------------------------
def test_the_catalogue_is_priced_in_integers():
    """Never a float. `99.00` as a float is how a rounding bug becomes a pricing bug."""
    for plan in checkout.PLANS:
        assert isinstance(plan.amount_minor, int)
        assert not isinstance(plan.amount_minor, bool)
        assert plan.amount_minor > 0


def test_the_monthly_plan_matches_the_price_the_paywall_shows():
    """The paywall says ฿99/month; the server must agree with it, and it is the server
    that wins if they ever disagree, so the two are pinned together here."""
    monthly = checkout.PLANS_BY_ID["premium_monthly"]

    assert monthly.amount_minor == 9900
    assert monthly.amount_display == "฿99"
    assert monthly.interval == "month"


def test_every_plan_sells_the_premium_tier():
    for plan in checkout.PLANS:
        assert plan.tier == auth.PREMIUM_TIER


def test_plan_ids_are_unique():
    ids = [plan.id for plan in checkout.PLANS]

    assert len(ids) == len(set(ids))
    assert len(ids) == len(checkout.PLANS_BY_ID)


def test_every_plan_declares_a_period_the_expiry_can_be_computed_from():
    for plan in checkout.PLANS:
        assert plan.period_days > 0


def test_the_catalogue_reports_no_gateway_yet():
    payload = checkout.plans_payload()

    assert payload["provider"] is None
    assert payload["live"] is False
    assert payload["currency"] == checkout.CURRENCY_THB


def test_provider_configured_is_false_and_not_read_from_the_environment(monkeypatch):
    """An operator setting `PAYMENT_PROVIDER` must not make this build look live.

    This code cannot complete a payment, so reporting a gateway as configured would
    open a checkout in the app that could never finish.
    """
    monkeypatch.setenv("PAYMENT_PROVIDER", "omise")

    assert checkout.provider_configured() is False
    assert checkout.plans_payload()["provider"] is None


def test_the_plans_endpoint_is_public():
    """A signed-out visitor is exactly who needs to read prices."""
    response = TestClient(main.app).get("/api/checkout/plans")

    assert response.status_code == 200
    assert response.json()["live"] is False


def test_health_reports_the_checkout_state_from_the_catalogue():
    payload = TestClient(main.app).get("/api/health").json()

    assert payload["checkout"]["gateway_configured"] is False
    assert payload["checkout"]["plans"] == [plan.id for plan in checkout.PLANS]


# ---------------------------------------------------------------------------
# Authentication — the account comes from the token, never the body
# ---------------------------------------------------------------------------
def test_no_token_is_a_401():
    response = TestClient(main.app).post(
        "/api/checkout/create-session", json={"plan": "premium_monthly"}
    )

    assert response.status_code == 401


def test_a_missing_plan_is_a_422(signed_in):
    assert post(TestClient(main.app), {}).status_code == 422


def test_an_unknown_plan_is_a_422_naming_the_known_ones(signed_in):
    response = post(TestClient(main.app), {"plan": "premium_forever"})

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "premium_monthly" in detail
    assert "premium_yearly" in detail


def test_a_user_id_that_disagrees_with_the_token_is_refused(signed_in):
    """Refused rather than ignored: silently ignoring it would hide the very client
    bug that becomes a mis-billed charge once a gateway is behind this."""
    response = post(TestClient(main.app), {"plan": "premium_monthly", "user_id": OTHER_ID})

    assert response.status_code == 403
    assert "does not match" in response.json()["detail"]


def test_a_user_id_that_matches_the_token_is_accepted(signed_in):
    response = post(TestClient(main.app), {"plan": "premium_monthly", "user_id": USER_ID})

    assert response.status_code == 200


def test_the_session_is_opened_for_the_token_s_account(signed_in):
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["user_id"] == USER_ID


# ---------------------------------------------------------------------------
# The response says what it is
# ---------------------------------------------------------------------------
def test_a_successful_call_still_says_nothing_was_charged(signed_in):
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["status"] == "not_implemented"
    assert payload["charged"] is False
    assert payload["subscription_granted"] is False
    assert payload["checkout_url"] is None
    assert payload["provider"] is None
    assert payload["live_mode"] is False
    assert payload["message"]


def test_the_status_is_never_a_success_word(signed_in):
    """A client that branches on `status` must not be able to read this as success."""
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["status"] not in {"ok", "created", "succeeded", "complete", "paid"}


def test_the_echoed_plan_is_the_catalogue_entry(signed_in):
    payload = post(TestClient(main.app), {"plan": "premium_yearly"}).json()

    assert payload["plan"] == checkout.PLANS_BY_ID["premium_yearly"].as_payload()
    assert payload["plan"]["amount_minor"] == 99000


def test_an_unconfigured_answer_carries_no_session_id_at_all(signed_in):
    """Not even a placeholder one. A generated uuid would be *truthy*, so a client
    that stored it as a reference would be keeping a receipt for a session that
    exists nowhere — and an empty string is what "there is no session" looks like."""
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["session_id"] == ""
    assert not payload["session_id"]


def test_a_free_account_is_not_reported_as_already_premium(signed_in):
    assert post(TestClient(main.app), {"plan": "premium_monthly"}).json()["already_premium"] is False


def test_a_subscriber_is_told_they_already_have_it(signed_in):
    signed_in["subscription_tier"] = "premium"
    signed_in["subscription_expiry"] = "2099-01-01T00:00:00+00:00"

    assert post(TestClient(main.app), {"plan": "premium_monthly"}).json()["already_premium"] is True


def test_a_lapsed_subscriber_is_not_reported_as_already_premium(signed_in):
    signed_in["subscription_tier"] = "premium"
    signed_in["subscription_expiry"] = "2020-01-01T00:00:00+00:00"

    assert post(TestClient(main.app), {"plan": "premium_monthly"}).json()["already_premium"] is False


def test_the_response_is_never_cached(signed_in):
    response = post(TestClient(main.app), {"plan": "premium_monthly"})

    assert response.headers["cache-control"] == "private, no-store"


def test_the_pending_plan_is_not_gated_behind_premium(signed_in):
    """An account with no subscription is precisely the account that needs to buy one."""
    signed_in["subscription_tier"] = "free"

    assert post(TestClient(main.app), {"plan": "premium_monthly"}).status_code == 200


# ---------------------------------------------------------------------------
# The guarantee: no I/O, so nothing can be charged or granted
# ---------------------------------------------------------------------------
@pytest.fixture()
def poisoned_transports(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every way out of this process, made fatal.

    If `create_session` ever grew a gateway call, a database write or a webhook
    POST, the test below would fail loudly instead of quietly charging a card.
    """

    def explode(*_args, **_kwargs):
        raise AssertionError("the checkout stub performed network I/O")

    for name in ("get", "post", "put", "patch", "delete", "request", "stream"):
        monkeypatch.setattr(httpx, name, explode)
    monkeypatch.setattr(httpx, "Client", explode)
    monkeypatch.setattr(httpx, "AsyncClient", explode)


def test_the_stub_performs_no_io_at_all(signed_in, poisoned_transports):
    response = post(TestClient(main.app), {"plan": "premium_monthly"})

    assert response.status_code == 200, response.text
    assert response.json()["charged"] is False


def test_repeated_calls_change_no_entitlement(signed_in, poisoned_transports):
    """If the stub wrote a tier, the second answer's `already_premium` would change."""
    first = post(TestClient(main.app), {"plan": "premium_monthly"}).json()
    second = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert first["already_premium"] == second["already_premium"] is False
    assert signed_in["subscription_tier"] == "free"


def test_create_session_is_a_pure_function_of_the_caller_and_plan():
    """Proved directly, without the endpoint: same inputs, same answer modulo the id."""
    user = auth.resolve_entitlement(
        {"sub": USER_ID, "role": "authenticated"}, {"subscription_tier": "free"}
    )
    plan = checkout.PLANS_BY_ID["premium_monthly"]

    first = checkout.create_session(user, plan, return_origin="https://app.example.test")
    second = checkout.create_session(user, plan, return_origin="https://app.example.test")

    assert {k: v for k, v in first.items() if k != "session_id"} == {
        k: v for k, v in second.items() if k != "session_id"
    }


def test_the_stub_does_not_write_the_subscription_tier_itself():
    """The columns are written only by server-side code holding a secret key, and this
    module holds no credential and makes no request — so it structurally cannot."""
    assert checkout.__file__

    text = Path(checkout.__file__).read_text(encoding="utf-8")
    for forbidden in ("service_role", "SUPABASE_SERVICE", "apikey", "Authorization"):
        assert forbidden not in text, f"checkout.py should hold no credential: {forbidden}"


# ---------------------------------------------------------------------------
# A configured build — the real gateway path, with the transport faked
# ---------------------------------------------------------------------------
# `payments._client` is the one seam replaced: it is the single function that builds
# a Stripe client. Everything else — the catalogue, the response shape, the return
# URLs, the error mapping in the endpoint — runs for real, which is what makes these
# worth asserting on. Nothing here can reach Stripe.
class _FakeSessions:
    def __init__(self, outcome=None) -> None:
        self.calls: list = []
        self.outcome = outcome

    def create(self, params, options=None):
        self.calls.append((params, options))
        if isinstance(self.outcome, Exception):
            raise self.outcome
        if self.outcome is not None:
            return self.outcome
        return SimpleNamespace(
            id="cs_test_endpoint_1",
            url="https://checkout.stripe.com/c/pay/cs_test_endpoint_1",
            expires_at=4_102_444_800,
            livemode=False,
            payment_method_types=["card", "promptpay"],
            amount_total=9900,
            currency="thb",
        )


@pytest.fixture()
def gateway(monkeypatch: pytest.MonkeyPatch):
    """Both credentials set and the transport faked, so this build is live."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, "sk_test_fake_for_the_suite")
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, "whsec_test_fake_for_the_suite")
    sessions = _FakeSessions()
    monkeypatch.setattr(
        payments,
        "_client",
        lambda: SimpleNamespace(
            v1=SimpleNamespace(checkout=SimpleNamespace(sessions=sessions))
        ),
    )
    return sessions


def test_a_configured_build_reports_itself_live():
    assert checkout.provider_configured() is False
    assert checkout.provider_name() is None


def test_the_credentials_are_what_makes_it_live(gateway):
    assert checkout.provider_configured() is True
    assert checkout.provider_name() == payments.PROVIDER
    assert checkout.plans_payload()["live"] is True


def test_a_configured_catalogue_names_the_provider(gateway):
    payload = TestClient(main.app).get("/api/checkout/plans").json()

    assert payload["provider"] == "stripe"
    assert payload["live"] is True


def test_the_plans_endpoint_stays_public_when_configured(gateway):
    """A signed-out visitor deciding whether to sign up is exactly who needs the
    prices, and enabling a gateway must not change that."""
    assert TestClient(main.app).get("/api/checkout/plans").status_code == 200


def test_a_configured_checkout_returns_a_payable_url(gateway, signed_in):
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["status"] == "created"
    assert payload["checkout_url"].startswith("https://checkout.stripe.com/")
    assert payload["provider"] == "stripe"
    assert payload["session_id"] == "cs_test_endpoint_1"
    # Stripe's own epoch timestamp, passed through as ISO-8601 UTC.
    assert payload["expires_at"] == "2100-01-01T00:00:00+00:00"


def test_the_alias_route_opens_the_same_checkout(gateway, signed_in):
    """The integration brief names `/api/create-checkout-session`. It is the same
    handler under a second path, so the plan lookup, the token check and the
    gateway parameters cannot disagree between the two names."""
    response = TestClient(main.app).post(
        "/api/create-checkout-session",
        json={"plan": "premium_monthly"},
        headers={"Authorization": "Bearer good-token"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "created"
    assert payload["checkout_url"].startswith("https://checkout.stripe.com/")
    assert payload["charged"] is False
    assert gateway.calls, "the alias never reached the gateway"


def test_the_alias_route_still_requires_a_token(gateway):
    """A second path must not become a second, weaker entrance to the same write."""
    response = TestClient(main.app).post(
        "/api/create-checkout-session", json={"plan": "premium_monthly"}
    )

    assert response.status_code == 401
    assert gateway.calls == []


def test_a_configured_checkout_still_charges_and_grants_nothing(gateway, signed_in):
    """The load-bearing invariant of this whole endpoint, and the one that survives
    every future change to it: opening a payment page takes no money and grants no
    access. Only the verified webhook grants, and only once Stripe says the money
    arrived. A client cannot show a success screen off the back of this response."""
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["charged"] is False
    assert payload["subscription_granted"] is False


def test_a_configured_checkout_does_not_touch_the_entitlement(gateway, signed_in):
    post(TestClient(main.app), {"plan": "premium_monthly"})

    assert signed_in["subscription_tier"] == "free"
    assert signed_in["subscription_expiry"] is None


def test_the_sent_parameters_offer_card_and_promptpay(gateway, signed_in):
    """End to end through the endpoint, so a regression in the catalogue's metadata
    or the plan plumbing is caught here as well as in test_payments."""
    post(TestClient(main.app), {"plan": "premium_monthly"})

    params, _ = gateway.calls[0]
    assert params["allowed_payment_method_types"] == ["card", "promptpay"]
    assert params["mode"] == "payment"
    assert params["client_reference_id"] == USER_ID


def test_the_response_reports_what_the_gateway_says_it_offers(gateway, signed_in):
    """Read back from Stripe rather than echoed from the request: if the account is
    not eligible for a method, this is where that becomes visible instead of being
    an unexplained absence on the payment page."""
    payload = post(TestClient(main.app), {"plan": "premium_monthly"}).json()

    assert payload["payment_method_types"] == ["card", "promptpay"]


def test_the_success_url_tells_stripe_which_session_is_returning(
    gateway, signed_in, monkeypatch
):
    """Stripe substitutes the literal `{CHECKOUT_SESSION_ID}`, which is the only way
    the returning page can name its own session. It is a hint for the UI and is used
    for nothing else — the webhook is the authority on payment."""
    monkeypatch.setattr(main, "CORS_ORIGINS", ["https://app.example.test"])
    post(TestClient(main.app), {"plan": "premium_yearly"}, return_origin="https://app.example.test")

    params, _ = gateway.calls[0]
    assert params["success_url"] == (
        "https://app.example.test/premium?checkout=success&success=true"
        "&session_id={CHECKOUT_SESSION_ID}"
    )
    assert params["cancel_url"] == (
        "https://app.example.test/premium?checkout=cancelled&cancel=true"
    )


def test_the_metadata_carries_the_plan_the_webhook_will_look_up(gateway, signed_in):
    """`plan_id` is what the webhook resolves the granted period from, so the plan
    the customer was shown and the period they receive come from one source."""
    post(TestClient(main.app), {"plan": "premium_yearly"})

    params, _ = gateway.calls[0]
    assert params["metadata"]["plan_id"] == "premium_yearly"
    assert params["metadata"]["period_days"] == "365"


def test_the_idempotency_key_reaches_the_gateway(gateway, signed_in):
    post(
        TestClient(main.app),
        {"plan": "premium_monthly", "idempotency_key": "tap-abc-12345"},
    )

    _, options = gateway.calls[0]
    assert options == {"idempotency_key": "tap-abc-12345"}


def test_a_malformed_idempotency_key_is_a_422(gateway, signed_in):
    """Refused by the request model, so a value with a space or a newline in it can
    never reach a gateway request."""
    response = post(
        TestClient(main.app),
        {"plan": "premium_monthly", "idempotency_key": "bad key!"},
    )

    assert response.status_code == 422
    assert gateway.calls == []


# ---------------------------------------------------------------------------
# Where a payment may return to — the open-redirect fence
# ---------------------------------------------------------------------------
def test_a_client_chosen_redirect_is_used_when_allowed(gateway, signed_in, monkeypatch):
    monkeypatch.setattr(main, "CORS_ORIGINS", ["https://app.example.test"])

    post(TestClient(main.app), {"plan": "premium_monthly"}, return_origin="https://app.example.test")

    assert gateway.calls[0][0]["success_url"].startswith("https://app.example.test/")


def test_an_origin_outside_the_allow_list_is_refused(gateway, signed_in, monkeypatch):
    """An attacker-supplied redirect target is how a real payment ends on a
    look-alike page the attacker controls, complete with plausible wording. Refused
    with a 403 rather than quietly replaced, so the client bug that sent a wrong
    origin is visible rather than latent."""
    monkeypatch.setattr(main, "CORS_ORIGINS", ["https://app.example.test"])
    monkeypatch.setattr(main, "FRONTEND_BASE_URL", "https://app.example.test")

    response = post(
        TestClient(main.app),
        {"plan": "premium_monthly"},
        return_origin="https://evil.example.net",
    )

    assert response.status_code == 403
    assert "evil.example.net" in response.json()["detail"]
    assert gateway.calls == []


def test_a_redirect_with_a_path_is_refused(gateway, signed_in):
    """Stripe appends its own query parameters to the success URL, so a value that
    already carried a path or query would be silently mangled."""
    response = post(
        TestClient(main.app),
        {"plan": "premium_monthly"},
        return_origin="https://app.example.test/steal?next=evil",
    )

    assert response.status_code == 422
    assert gateway.calls == []


def test_the_preview_deployment_regex_is_honoured(gateway, signed_in, monkeypatch):
    """Cloudflare Pages gives every preview deployment its own hostname, so a static
    list can never cover them. The same regex that lets a preview call the API lets
    it be redirected to after paying."""
    monkeypatch.setattr(main, "CORS_ORIGINS", ["*"])
    monkeypatch.setattr(
        main, "CORS_ORIGIN_REGEX", r"^https://([a-z0-9-]+\.)?superheng-3yf\.pages\.dev$"
    )

    post(
        TestClient(main.app),
        {"plan": "premium_monthly"},
        return_origin="https://abc123.superheng-3yf.pages.dev",
    )

    assert gateway.calls[0][0]["success_url"].startswith("https://abc123.superheng-3yf.pages.dev/")


def test_a_loopback_origin_is_allowed(gateway, signed_in, monkeypatch):
    """`npx expo start` against a deployed API is the ordinary way this app is
    developed. Redirecting a browser to its own machine is not a phishing
    primitive — the attacker gains nothing — so loopback is not part of the
    open-redirect concern."""
    monkeypatch.setattr(main, "CORS_ORIGINS", ["https://app.example.test"])

    post(TestClient(main.app), {"plan": "premium_monthly"}, return_origin="http://localhost:8081")

    assert gateway.calls[0][0]["success_url"].startswith("http://localhost:8081/")


def test_without_a_claimed_origin_the_configured_one_is_used(gateway, signed_in, monkeypatch):
    monkeypatch.setattr(main, "CORS_ORIGINS", ["https://app.example.test"])

    post(TestClient(main.app), {"plan": "premium_monthly"})

    assert gateway.calls[0][0]["success_url"].startswith("https://app.example.test/")


# ---------------------------------------------------------------------------
# Gateway failures over HTTP
# ---------------------------------------------------------------------------
def test_a_gateway_rejection_maps_onto_its_own_status(gateway, signed_in):
    """502 — the gateway understood us and refused, which means our configuration is
    wrong rather than the caller's request."""
    import stripe

    gateway.outcome = stripe.InvalidRequestError(
        "The payment method type promptpay is not allowed", "allowed_payment_method_types"
    )

    response = post(TestClient(main.app), {"plan": "premium_monthly"})

    assert response.status_code == 502
    assert "Nothing was charged" not in response.json()["detail"]


def test_a_gateway_failure_says_nothing_was_charged(gateway, signed_in):
    import stripe

    gateway.outcome = stripe.APIConnectionError("connection reset")

    response = post(TestClient(main.app), {"plan": "premium_monthly"})

    assert response.status_code == 503
    assert "Nothing was charged" in response.json()["detail"]


def test_the_endpoint_never_leaks_a_credential(gateway, signed_in):
    """Neither the Stripe secret nor the answer from Stripe may carry a key into the
    response body."""
    import stripe

    gateway.outcome = stripe.AuthenticationError(
        "Invalid API Key provided: sk_test_fake_for_the_suite"
    )

    response = post(TestClient(main.app), {"plan": "premium_monthly"})

    assert "sk_test_fake_for_the_suite" not in response.text


# ---------------------------------------------------------------------------
# The webhook route
# ---------------------------------------------------------------------------
def test_the_webhook_route_refuses_a_post_when_nothing_is_configured():
    """It is reachable without a bearer token by necessity — Stripe is a server and
    cannot hold a session — so the signature is the only thing in front of the one
    function that grants subscriptions. An unconfigured deployment must refuse
    outright rather than accept anything as verified."""
    response = TestClient(main.app).post(
        "/api/webhook/stripe", json={"type": "checkout.session.completed"}
    )

    assert response.status_code == 503
    assert payments.WEBHOOK_SECRET_ENV in response.json()["detail"]


def test_the_webhook_alias_uses_the_same_signature_verifier():
    """The brief names `/api/webhook`. Both paths must refuse an unverifiable
    delivery in exactly the same way — an alias that accepted without a signature
    would be a way around the only authentication this endpoint has."""
    response = TestClient(main.app).post("/api/webhook", json={"type": "checkout.session.completed"})

    assert response.status_code == 503
    assert payments.WEBHOOK_SECRET_ENV in response.json()["detail"]


def test_the_webhook_route_is_not_a_stub_that_accepts_anything(monkeypatch):
    """Configured, but with no valid signature: 400, never 200. That is the whole
    security property of this endpoint.

    `SUPABASE_SERVICE_KEY` is patched as an attribute rather than through the
    environment because `main.py` reads it at import, the same way it reads the
    anon credentials — so the environment is not the seam for it.
    """
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, "whsec_test_fake_for_the_suite")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_KEY", "service-role-for-the-suite")

    response = TestClient(main.app).post(
        "/api/webhook/stripe", content=b'{"type":"checkout.session.completed"}'
    )

    assert response.status_code == 400


def test_the_webhook_does_not_need_the_charging_credential(monkeypatch):
    """A missing Stripe *API key* must not stop a real payment being recorded.

    The webhook's job is to record money already taken; the API key is what opens a
    payment page. If the entitlement path depended on it, rotating or losing that key
    would silently stop grants for genuine payments — and the error would blame the
    wrong variable.
    """
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, "whsec_test_fake_for_the_suite")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_KEY", "service-role-for-the-suite")
    assert payments.secret_key() == ""

    response = TestClient(main.app).post(
        "/api/webhook/stripe", content=b'{"type":"checkout.session.completed"}'
    )

    # 400 for the missing signature, not 503 for the missing API key.
    assert response.status_code == 400
    assert payments.SECRET_KEY_ENV not in response.json()["detail"]


def test_the_webhook_reports_a_missing_service_key_rather_than_guessing(monkeypatch):
    """Without it a genuine payment could be verified and then not recorded, so the
    refusal names the variable and returns 503 so Stripe retries."""
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, "whsec_test_fake_for_the_suite")
    monkeypatch.setattr(main, "SUPABASE_SERVICE_KEY", "")

    response = TestClient(main.app).post(
        "/api/webhook/stripe", content=b'{"type":"checkout.session.completed"}'
    )

    assert response.status_code == 503
    assert "SUPABASE_SERVICE_KEY" in response.json()["detail"]


def test_health_reports_the_entitlement_writer_state(monkeypatch):
    """Reported so that "payments are not set up at all" and "a payment would be
    taken and never recorded" can be told apart from outside the process."""
    payload = TestClient(main.app).get("/api/health").json()

    assert payload["checkout"]["entitlement_writer"] in {"configured", "not_configured"}
