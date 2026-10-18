"""Tests for `POST /api/create-portal-session`.

The endpoint has one job — mint a URL — and four ways to get it wrong, so those are
what is pinned here:

1. **Whose billing page is it.** The customer id comes from the caller's own
   profile row (or a lookup on the caller's own email), never from the request. A
   body carrying `customer_id` is asserted to change nothing: that field is how one
   account would otherwise open another's billing page, cancel somebody else's
   subscription, and have the webhook revoke *their* access.
2. **Where they come back to.** `return_url` is built from the validated origin, so
   a hostile `return_origin` is refused before Stripe is called at all.
3. **An account with no billing.** A manually granted entitlement has no Stripe
   customer; that is a 404 with an explanation, not a 500 and not a portal for
   somebody else.
4. **Stripe's own refusals.** A portal never configured in live mode answers with a
   message about "configuration", which reads like an API fault and is a dashboard
   setting — so the advice is asserted, not just the status code.

The transport is faked at `payments._client`, the single function that builds a
Stripe client. Everything else runs for real, including the parameter assembly and
the return-URL construction, which is what makes the captured parameters worth
asserting on.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
import stripe
from fastapi.testclient import TestClient

import auth
import main
import payments

USER_ID = "11111111-1111-4111-8111-111111111111"
CUSTOMER_ID = "cus_test_recorded_1"
EMAIL_CUSTOMER_ID = "cus_test_by_email_1"
ORIGIN = "http://localhost:8081"


class _FakeClaims:
    """`get_claims` returns a TypedDict, i.e. a plain dict at runtime."""

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
    """A signed-in caller whose profile row the test can edit in place.

    Carries the recorded Customer by default, because that is the ordinary state of
    an account that has paid once — the tests that care about the fallback clear it.
    """
    profile: dict = {
        "id": USER_ID,
        "email": "buyer@example.test",
        "subscription_tier": "premium",
        "subscription_expiry": "2099-01-01T00:00:00+00:00",
        "subscription_provider": "stripe",
        "stripe_customer_id": CUSTOMER_ID,
    }
    monkeypatch.setattr(main, "get_supabase", _FakeClient)
    monkeypatch.setattr(auth, "read_profile", lambda *_args, **_kwargs: dict(profile))
    return profile


class _FakePortalSessions:
    def __init__(self) -> None:
        self.calls: list = []
        self.outcome = None

    def create(self, params):
        self.calls.append(params)
        if isinstance(self.outcome, Exception):
            raise self.outcome
        if self.outcome is not None:
            return self.outcome
        return SimpleNamespace(url="https://billing.stripe.com/p/session/test_portal_1")


class _FakeCustomers:
    def __init__(self) -> None:
        self.calls: list = []
        self.records: list = []

    def list(self, params):
        self.calls.append(params)
        return SimpleNamespace(data=list(self.records))


class _FakeGateway:
    def __init__(self) -> None:
        self.sessions = _FakePortalSessions()
        self.customers = _FakeCustomers()


@pytest.fixture()
def gateway(monkeypatch: pytest.MonkeyPatch) -> _FakeGateway:
    """A configured build whose Stripe transport is captured rather than reached."""
    monkeypatch.setenv(payments.SECRET_KEY_ENV, "sk_test_fake_for_the_suite")
    fake = _FakeGateway()
    monkeypatch.setattr(
        payments,
        "_client",
        lambda: SimpleNamespace(
            v1=SimpleNamespace(
                billing_portal=SimpleNamespace(sessions=fake.sessions),
                customers=fake.customers,
            )
        ),
    )
    return fake


def open_portal(body: dict | None = None, token: str = "Bearer good-token", **extra):
    return TestClient(main.app).post(
        "/api/create-portal-session",
        json={**(body or {}), **extra},
        headers={"Authorization": token},
    )


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------
def test_no_token_is_a_401(gateway):
    """Signed out is signed out. The endpoint is not a public convenience: it opens
    the billing page of whichever account the token names."""
    assert open_portal({"return_origin": ORIGIN}, token="").status_code == 401


# ---------------------------------------------------------------------------
# Whose billing page
# ---------------------------------------------------------------------------
def test_the_recorded_customer_opens_the_portal(signed_in, gateway):
    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "created"
    assert payload["provider"] == "stripe"
    assert payload["portal_url"] == "https://billing.stripe.com/p/session/test_portal_1"

    assert gateway.sessions.calls == [
        {"customer": CUSTOMER_ID, "return_url": f"{ORIGIN}/premium"}
    ]


def test_the_portal_is_not_cached(signed_in, gateway):
    """A billing URL is specific to one account and short-lived. A shared cache
    holding it is a link to somebody's card details."""
    response = open_portal(return_origin=ORIGIN)

    assert response.headers["Cache-Control"] == "private, no-store"


def test_a_customer_id_in_the_body_is_ignored(signed_in, gateway):
    """The one field that would make this an endpoint for cancelling *other
    people's* subscriptions. It is not on the request model, and a body carrying it
    must not reach Stripe."""
    open_portal({"customer_id": "cus_somebody_else"}, return_origin=ORIGIN)

    assert gateway.sessions.calls[0]["customer"] == CUSTOMER_ID


def test_the_email_lookup_is_skipped_when_the_profile_has_a_customer(signed_in, gateway):
    """The ordinary path must not pay for the fallback: `customers.list` is a
    network call, and a refund-then-repurchase account has its id recorded."""
    open_portal(return_origin=ORIGIN)

    assert gateway.customers.calls == []


def test_an_account_without_a_recorded_customer_is_looked_up_by_its_email(
    signed_in, gateway
):
    """A manually granted premium, or a profile written before the column existed.
    Without this they are told they have no billing while Stripe holds the receipt."""
    signed_in["stripe_customer_id"] = None
    gateway.customers.records = [SimpleNamespace(id=EMAIL_CUSTOMER_ID)]

    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 200
    assert gateway.customers.calls == [{"email": "buyer@example.test", "limit": 1}]
    assert gateway.sessions.calls[0]["customer"] == EMAIL_CUSTOMER_ID


def test_an_account_with_no_customer_anywhere_is_a_404(signed_in, gateway):
    """Access issued by hand has no Stripe subscription to cancel. Saying so is
    better than a 500, and much better than opening an empty portal."""
    signed_in["stripe_customer_id"] = None

    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 404
    assert "no billing to manage" in response.json()["detail"]
    # Stripe was asked, found nothing, and was not asked to open a portal for nobody.
    assert gateway.sessions.calls == []


# ---------------------------------------------------------------------------
# Where the customer comes back to
# ---------------------------------------------------------------------------
def test_the_return_url_is_the_premium_page_on_the_validated_origin(signed_in, gateway):
    open_portal(return_origin=ORIGIN)

    assert gateway.sessions.calls[0]["return_url"] == f"{ORIGIN}/premium"


def test_a_hostile_return_origin_is_refused_before_stripe_is_called(signed_in, gateway):
    """An open redirect that lands on a billing page is worth refusing loudly. The
    refusal happens before the gateway is touched, so a bad client cannot mint a
    portal session nobody is returned from."""
    response = open_portal(return_origin="https://evil.example.com")

    assert response.status_code == 403
    assert gateway.sessions.calls == []


def test_a_path_in_the_return_origin_is_refused(signed_in, gateway):
    response = open_portal(return_origin="http://localhost:8081/premium")

    assert response.status_code == 422
    assert gateway.sessions.calls == []


# ---------------------------------------------------------------------------
# Stripe's own refusals
# ---------------------------------------------------------------------------
def test_an_unconfigured_build_names_the_missing_variable(signed_in):
    """No `gateway` fixture here: the default state of a test build is unconfigured,
    and the message must say which variable is missing rather than 'error'."""
    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 503
    assert payments.SECRET_KEY_ENV in response.json()["detail"]


def test_a_portal_that_was_never_configured_explains_where_to_configure_it(
    signed_in, gateway
):
    """Stripe's message for this says 'configuration', which reads like an API fault
    and is in fact a dashboard setting — and one kept separately per mode, so a
    portal that works in test mode fails in live mode until it is set up there too."""
    gateway.sessions.outcome = stripe.InvalidRequestError(
        "You have not activated the customer portal. Please activate it in the "
        "Dashboard before using this API.",
        None,
    )

    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 502
    detail = response.json()["detail"]
    assert "Billing" in detail
    assert "test" in detail and "live" in detail


def test_a_portal_session_without_a_url_is_a_failure(signed_in, gateway):
    """Nothing the client can fall back to, so it is reported rather than passed on
    as a 200 with a null url the app would try to open."""
    gateway.sessions.outcome = SimpleNamespace(url=None)

    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 503
    assert "no URL" in response.json()["detail"]


def test_a_stripe_failure_never_returns_the_secret_key(signed_in, gateway):
    leaked = "sk_test_do_not_leak_this_value"
    gateway.sessions.outcome = stripe.AuthenticationError(
        f"Invalid API Key provided: {leaked}"
    )

    response = open_portal(return_origin=ORIGIN)

    assert response.status_code == 503
    assert leaked not in response.text


def test_opening_the_portal_changes_no_entitlement(signed_in, gateway):
    """The load-bearing invariant, and the reason this endpoint needs no ledger row:
    the portal is a page, and a cancellation only becomes real when the webhook
    hears about it. A response claiming otherwise would be a second grant path."""
    payload = open_portal(return_origin=ORIGIN).json()

    assert "subscription_granted" not in payload
    assert "subscription_revoked" not in payload
    assert "is_premium" not in payload
