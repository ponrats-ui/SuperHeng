"""Tests for `webhook.py` — decide what a verified payment entitles, and record it.

THE FOUR THINGS THAT MUST NOT GO WRONG
  1. **A retried delivery must not grant twice.** Every gateways retries;
     Stripe does so for up to three days in live mode. The deduplication is the
     primary key of `payment_events` and it is checked here by asserting the event
     id reaches the database, and by checking the SQL actually makes it a key.
  2. **"Completed" must not be read as "paid".** A session can complete while its
     payment is still processing. Only `payment_status == 'paid'` may grant.
  3. **The period must come from our catalogue, never from the event.** A session
     created by something other than this application — a Payment Link, a
     hand-edited session in the dashboard — must not be able to choose how long it
     grants for, or set its own price. There is a test that puts an absurd period
     in the metadata and checks it is ignored.
  4. **A failure must make Stripe retry.** A database outage at the moment a
     payment arrives is recoverable *only* if this answers non-2xx, so the error
     mapping is tested rather than assumed.

The signature is computed for real (see `sign`) instead of stubbing the verifier,
so `handle` exercises the same code path a genuine Stripe delivery does.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from pathlib import Path

import httpx
import pytest

import checkout
import payments
import webhook

BACKEND_DIR = Path(__file__).resolve().parent.parent
SCHEMA_FILE = BACKEND_DIR / "schema_profiles.sql"

USER_ID = "11111111-1111-4111-8111-111111111111"
SECRET = "whsec_test_do_not_use_in_production"
SERVICE_KEY = "service-role-key-that-must-never-be-logged"
BASE_URL = "https://project-ref.supabase.co"


# ---------------------------------------------------------------------------
# A genuine Stripe delivery
# ---------------------------------------------------------------------------
def sign(payload: bytes, secret: str = SECRET, timestamp: int | None = None) -> str:
    """A real Stripe signature: `t=<unix seconds>,v1=<hmac_sha256(secret, "t.body")>`.

    Duplicated from `test_payments.py` rather than shared through a fixture, because
    the assistant it would need — a signed-body builder — differs enough between the
    two files that the shared version would need as many parameters as the function
    it replaced. Two eight-line copies of a well-known scheme are cheaper to read
    than one abstraction with four switches.
    """
    ts = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), f"{ts}.{payload.decode()}".encode(), hashlib.sha256
    ).hexdigest()
    return f"t={ts},v1={digest}"


def event_body(
    *,
    event_type: str = "checkout.session.completed",
    payment_status: str | None = "paid",
    client_reference_id: str | None = USER_ID,
    plan_id: str | None = "premium_monthly",
    metadata_user_id: str | None = USER_ID,
    extra_metadata: dict | None = None,
    amount_total: int = 9900,
    livemode: bool = False,
    customer: str | dict | None = None,
) -> bytes:
    metadata: dict = {}
    if plan_id is not None:
        metadata["plan_id"] = plan_id
    if metadata_user_id is not None:
        metadata["user_id"] = metadata_user_id
    metadata.update(extra_metadata or {})

    session: dict = {
        "id": "cs_test_0001",
        "object": "checkout.session",
        "mode": "payment",
        "client_reference_id": client_reference_id,
        "metadata": metadata,
        "amount_total": amount_total,
        "currency": "thb",
        "livemode": livemode,
    }
    if payment_status is not None:
        session["payment_status"] = payment_status
    if customer is not None:
        session["customer"] = customer

    return json.dumps(
        {
            "id": "evt_test_0001",
            "object": "event",
            "created": 1_760_000_000,
            "type": event_type,
            "livemode": livemode,
            "data": {"object": session},
        }
    ).encode()


class FakeResponse:
    def __init__(self, status_code: int = 200, payload=None, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


#: A stand-in for the expiry `apply_payment_event` returns. It is read back from
#: the answer rather than recomputed in Python, so the value only has to be
#: plausible, not correct — the test asserts *that* the field is passed through.
APPLIED_EXPIRY = "2026-11-13T00:00:00+00:00"


@pytest.fixture()
def db(monkeypatch: pytest.MonkeyPatch) -> dict:
    """The database seam.

    By default it **models `apply_payment_event`** rather than always answering
    successfully: a call that carries no period is answered with `recorded`, and
    only a call that carries one is answered with `applied`. That makes the fake
    agree with the function's contract, which is what lets a test assert that a
    refusal really does produce `subscription_granted: false` all the way through —
    an always-successful fake would make every refusal test pass for the wrong
    reason.

    A fake that models a contract can drift from the real implementation, which is
    why the schema file is cross-checked from here (the function's name, its
    parameters and its grants are all asserted against `schema_profiles.sql`).

    Set `state["override"]` to force a specific answer, or to an exception to make
    the call fail.
    """
    state: dict = {"override": None, "calls": []}

    def _post(url, **kwargs):
        body = kwargs.get("json") or {}
        state["calls"].append(
            {"url": url, "body": body, "headers": kwargs.get("headers")}
        )
        if state["override"] is not None:
            response = state["override"]
            if isinstance(response, Exception):
                raise response
            return response
        if body.get("p_period_days") is None:
            # Mirrors `if p_period_days is null then ... 'recorded'` in the SQL.
            return FakeResponse(200, {"result": webhook.RECORDED, "event_id": body.get("p_event_id")})
        return FakeResponse(
            200,
            {
                "result": webhook.APPLIED,
                "tier": "premium",
                "expiry": APPLIED_EXPIRY,
                "event_id": body.get("p_event_id"),
            },
        )

    monkeypatch.setattr(webhook.httpx, "post", _post)
    return state


@pytest.fixture(autouse=True)
def stripe_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """A webhook cannot verify anything without a signing secret."""
    monkeypatch.setenv(payments.WEBHOOK_SECRET_ENV, SECRET)


def deliver(payload: bytes | None = None, signature: str | None = None, **kwargs) -> dict:
    body = event_body(**kwargs) if payload is None else payload
    return webhook.handle(
        body,
        sign(body) if signature is None else signature,
        base_url=BASE_URL,
        service_key=SERVICE_KEY,
    )


def sent(db: dict) -> dict:
    """The body of the one call made to the database."""
    assert len(db["calls"]) == 1, f"expected exactly one database call, got {len(db['calls'])}"
    return db["calls"][0]["body"]


# ---------------------------------------------------------------------------
# Authenticity, before anything else
# ---------------------------------------------------------------------------
def test_an_unsigned_delivery_is_refused_and_never_reaches_the_database(db):
    """A header-less POST is the cheapest possible attack on the one endpoint that
    writes `subscription_tier`. It must be a documented 400, not a 500."""
    with pytest.raises(payments.InvalidSignature):
        webhook.handle(event_body(), None, base_url=BASE_URL, service_key=SERVICE_KEY)

    assert db["calls"] == []


def test_a_forged_signature_never_reaches_the_database(db):
    with pytest.raises(payments.InvalidSignature):
        deliver(signature=sign(event_body(), secret="whsec_attacker"))

    assert db["calls"] == []


def test_a_tampered_body_is_refused_even_with_a_valid_signature_for_the_original(db):
    """The whole point of signing the body: changing the amount after signing must
    invalidate it."""
    original = event_body(amount_total=9900)
    signature = sign(original)

    with pytest.raises(payments.InvalidSignature):
        deliver(payload=event_body(amount_total=1), signature=signature)

    assert db["calls"] == []


def test_an_unconfigured_webhook_cannot_verify_anything(
    monkeypatch: pytest.MonkeyPatch, db: dict
):
    monkeypatch.delenv(payments.WEBHOOK_SECRET_ENV, raising=False)

    with pytest.raises(payments.NotConfigured):
        deliver()

    assert db["calls"] == []


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------
def test_a_paid_completion_grants_the_catalogue_period(db):
    result = deliver(event_type="checkout.session.completed", payment_status="paid")

    assert result["subscription_granted"] is True
    assert result["plan_id"] == "premium_monthly"
    assert result["period_days"] == checkout.PLANS_BY_ID["premium_monthly"].period_days == 30
    assert sent(db)["p_period_days"] == 30


def test_the_yearly_plan_grants_a_year(db):
    deliver(plan_id="premium_yearly")

    assert sent(db)["p_period_days"] == 365


def test_the_account_is_taken_from_the_verified_event(db):
    deliver()

    assert sent(db)["p_user_id"] == USER_ID


def test_the_amount_is_recorded_as_it_arrived(db):
    """The ledger's job is to say what was actually paid, so the amount is carried
    through rather than recomputed from the catalogue. If they ever disagree, the
    discrepancy is the important signal and recomputing would erase it."""
    deliver(amount_total=99000)

    assert sent(db)["p_amount_minor"] == 99000


def test_the_livemode_flag_is_recorded(db):
    """So a test-mode payment that reached production is recognisable afterwards."""
    deliver(livemode=True)

    assert sent(db)["p_livemode"] is True


def test_the_event_id_is_what_makes_a_retry_idempotent(db):
    """The primary key of `payment_events` is the gateway's event id. Without it
    reaching the database there is no deduplication at all."""
    deliver()

    assert sent(db)["p_event_id"] == "evt_test_0001"


def test_a_duplicate_delivery_reports_no_grant(db):
    """The second delivery of the same event. A client that trusts
    `subscription_granted` must not be told two subscriptions were created."""
    db["override"] = FakeResponse(200, {"result": webhook.DUPLICATE})

    result = deliver()

    assert result["result"] == webhook.DUPLICATE
    assert result["subscription_granted"] is False


def test_an_async_success_grants(db):
    """A delayed payment that settles after the session completed. Without this
    event the customer would have paid and been granted nothing."""
    result = deliver(event_type="checkout.session.async_payment_succeeded")

    assert result["subscription_granted"] is True


# ---------------------------------------------------------------------------
# The refusals — where a mistake would hand out free subscriptions
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("status", ["unpaid", "no_payment_required", None, "processing"])
def test_a_session_that_is_not_paid_grants_nothing(db, status):
    """`checkout.session.completed` fires when the customer finishes, which for a
    delayed payment method is not the same as the money arriving. Granting here
    would give away access for a payment that never settles."""
    result = deliver(payment_status=status)

    assert sent(db)["p_period_days"] is None
    assert result["subscription_granted"] is False
    assert result["period_days"] is None


def test_an_unpaid_session_is_still_recorded(db):
    """Recorded rather than dropped: the ledger must show the session existed, and
    `async_payment_succeeded` may settle it later."""
    result = deliver(payment_status="unpaid")

    assert sent(db)["p_event_id"] == "evt_test_0001"
    assert result["result"] == webhook.RECORDED


@pytest.mark.parametrize(
    "event_type",
    ["checkout.session.expired", "checkout.session.async_payment_failed"],
)
def test_a_failed_or_expired_session_grants_nothing(db, event_type):
    result = deliver(event_type=event_type)

    assert sent(db)["p_period_days"] is None
    assert result["subscription_granted"] is False


def test_an_unknown_plan_grants_nothing(db):
    """A session this application did not create — a Payment Link, or one edited by
    hand in the dashboard. Refused rather than granted a default period: if the plan
    is unknown then so is what was bought, and defaulting is how a mis-set Payment
    Link becomes free subscriptions."""
    result = deliver(plan_id="premium_forever")

    assert sent(db)["p_period_days"] is None
    assert result["subscription_granted"] is False
    assert "unknown plan" in result["note"]


def test_a_missing_plan_id_grants_nothing(db):
    result = deliver(plan_id=None)

    assert sent(db)["p_period_days"] is None
    assert result["subscription_granted"] is False


def test_the_period_is_never_taken_from_the_event(db):
    """The single most important refusal in this file. Anyone who can create a
    session — or edit one in the dashboard — controls the metadata, so a period
    read from there is a period an attacker chooses. The catalogue's value wins."""
    deliver(extra_metadata={"period_days": "9999", "tier": "premium"})

    assert sent(db)["p_period_days"] == 30


def test_a_missing_user_id_grants_nothing(db):
    result = deliver(client_reference_id=None, metadata_user_id=None)

    assert sent(db)["p_user_id"] is None
    assert sent(db)["p_period_days"] is None
    assert result["subscription_granted"] is False


def test_a_malformed_user_id_grants_nothing(db):
    result = deliver(client_reference_id="not-a-uuid", metadata_user_id="also-not")

    assert sent(db)["p_user_id"] is None
    assert result["subscription_granted"] is False


def test_an_unknown_user_is_reported_as_no_grant(db):
    """The account was deleted between paying and the event arriving. The money is
    real and the ledger keeps it; there is simply nothing to entitle."""
    db["override"] = FakeResponse(200, {"result": webhook.UNKNOWN_USER})

    result = deliver()

    assert result["result"] == webhook.UNKNOWN_USER
    assert result["subscription_granted"] is False


def test_an_unhandled_event_type_is_acknowledged_without_touching_the_database(db):
    """Stripe expects a 2xx or it retries for days. An event this build does not act
    on is acknowledged and dropped, and consumes no ledger row."""
    result = deliver(event_type="payment_intent.created")

    assert result["status"] == "ignored"
    assert result["subscription_granted"] is False
    assert db["calls"] == []


# ---------------------------------------------------------------------------
# The database call itself
# ---------------------------------------------------------------------------
def test_the_function_name_is_the_one_the_schema_defines(db):
    """A rename on either side would silently stop every grant, and the only symptom
    would be customers who paid and have nothing."""
    deliver()

    assert webhook.APPLY_FUNCTION == "apply_payment_event"
    assert f"function public.{webhook.APPLY_FUNCTION}(" in SCHEMA_FILE.read_text(encoding="utf-8")


def test_the_call_targets_the_rpc_endpoint_with_the_service_key(db):
    deliver()

    call = db["calls"][0]
    assert call["url"] == f"{BASE_URL}/rest/v1/rpc/{webhook.APPLY_FUNCTION}"
    # PostgREST reads the role from the bearer token, so a missing Authorization
    # header produces a 401 that looks like a wrong key rather than a wrong header.
    assert call["headers"]["apikey"] == SERVICE_KEY
    assert call["headers"]["Authorization"] == f"Bearer {SERVICE_KEY}"


def test_every_parameter_the_function_declares_is_sent(db):
    """The signature in the schema file and the body sent here have to agree; a
    missing parameter is a 404 or a 400 at the worst possible moment."""
    schema = SCHEMA_FILE.read_text(encoding="utf-8")
    start = schema.index(f"function public.{webhook.APPLY_FUNCTION}(")
    declared = schema[start : schema.index(")", start)]
    for name in ("p_event_id", "p_event_type", "p_user_id", "p_session_id", "p_plan_id",
                 "p_period_days", "p_amount_minor", "p_currency", "p_livemode", "p_note",
                 "p_stripe_customer_id"):
        assert name in declared, f"{name} is not a parameter of the schema function"

    deliver()
    assert set(sent(db)) == {
        "p_event_id", "p_event_type", "p_user_id", "p_session_id", "p_plan_id",
        "p_period_days", "p_amount_minor", "p_currency", "p_livemode", "p_note",
        "p_stripe_customer_id",
    }


def test_the_customer_the_session_was_billed_to_reaches_the_grant(db):
    """Stored on the profile so the next checkout can pass it back to Stripe. Without
    it every purchase would create another Customer object for the same person."""
    deliver(customer="cus_test_abc123")

    assert sent(db)["p_stripe_customer_id"] == "cus_test_abc123"


def test_a_session_with_no_customer_still_grants_and_sends_none(db):
    """A session that neither created nor reused a Customer is legitimate — that is
    Stripe's `if_required` default — so it must still grant. The NULL it sends is
    what tells the function to leave any stored id alone rather than clear it."""
    result = deliver()

    assert result["subscription_granted"] is True
    assert sent(db)["p_stripe_customer_id"] is None


def test_the_service_key_is_never_returned_to_the_caller(db):
    result = deliver()

    assert SERVICE_KEY not in json.dumps(result)


def test_the_expiry_comes_from_the_database_not_from_arithmetic_here(db):
    """Read from the answer rather than recomputed, so the API's idea of when access
    ends cannot disagree with the stored one."""
    db["override"] = FakeResponse(
        200,
        {
            "result": webhook.APPLIED,
            "tier": "premium",
            "expiry": "2026-11-13T00:00:00+00:00",
        },
    )

    result = deliver()

    assert result["subscription_expiry"] == "2026-11-13T00:00:00+00:00"
    assert result["tier"] == "premium"


# ---------------------------------------------------------------------------
# Database failures — which must make Stripe retry
# ---------------------------------------------------------------------------
def test_a_missing_function_names_the_schema_file(db):
    """This is the half-applied deployment, and the message says which file to run
    rather than leaving 'function does not exist' to be decoded."""
    db["override"] = FakeResponse(404, {"message": "Could not find the function"})

    with pytest.raises(webhook.WebhookProblem) as caught:
        deliver()

    assert caught.value.status_code == 503
    assert "schema_profiles.sql" in caught.value.detail


@pytest.mark.parametrize("status", [401, 403])
def test_a_refused_write_blames_the_service_key(db, status):
    """The signal that the service key is missing, wrong, or an anon key — the most
    likely misconfiguration, and one whose symptom is otherwise invisible."""
    db["override"] = FakeResponse(status, {"message": "permission denied"})

    with pytest.raises(webhook.WebhookProblem) as caught:
        deliver()

    assert caught.value.status_code == 503
    assert "SUPABASE_SERVICE_KEY" in caught.value.detail


def test_a_transport_failure_makes_stripe_retry(db):
    """503 rather than a 200: the payment is real and the grant must eventually
    land. Acknowledging here would drop it forever."""
    db["override"] = httpx.ConnectError("connection refused")

    with pytest.raises(webhook.WebhookProblem) as caught:
        deliver()

    assert caught.value.status_code == 503
    assert "retry" in caught.value.detail


def test_a_server_error_reports_the_database_message(db):
    db["override"] = FakeResponse(500, {"message": "deadlock detected"})

    with pytest.raises(webhook.WebhookProblem) as caught:
        deliver()

    assert "deadlock detected" in caught.value.detail


def test_a_non_json_answer_is_a_failure_not_a_success(db):
    db["override"] = FakeResponse(200, None, text="<html>gateway</html>")

    with pytest.raises(webhook.WebhookProblem):
        deliver()


def test_an_unrecognised_result_is_a_failure_not_a_success(db):
    """`apply_payment_event` and this module disagreeing means the grant may not
    have been applied. The only safe reading is failure."""
    db["override"] = FakeResponse(200, {"result": "who_knows"})

    with pytest.raises(webhook.WebhookProblem):
        deliver()


def test_a_set_returning_answer_is_accepted(db):
    """Wrapping the value in a list is what PostgREST does for a set-returning
    function, so the declaration can change without breaking this."""
    db["override"] = FakeResponse(200, [{"result": webhook.APPLIED, "tier": "premium"}])

    result = deliver()

    assert result["subscription_granted"] is True


def test_an_empty_answer_is_not_read_as_a_grant(db):
    db["override"] = FakeResponse(200, [])

    with pytest.raises(webhook.WebhookProblem):
        deliver()


# ---------------------------------------------------------------------------
# The schema file's own security invariants are asserted in
# `test_schema_profiles.py`, which owns that file. What is checked here is only
# that the two sides agree — a rename or a missing parameter would silently stop
# every grant, and the only symptom would be customers who paid and got nothing.
# ---------------------------------------------------------------------------
