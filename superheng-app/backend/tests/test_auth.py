"""Tests for `auth.py` and the entitlement gate on `/api/predict/premium`.

Two levels, deliberately kept apart:

* **Pure unit tests** of the functions in `auth.py`. No client, no database, no
  network — `auth.py` takes every value it needs as an argument precisely so this
  is possible.
* **HTTP tests** through the ASGI app with the *real* dependency chain
  (`require_user` -> `verify_access_token` -> `read_profile` -> `require_premium`).
  Only the two Supabase calls are faked, at the `auth` module boundary. Everything
  that decides 401 vs 402 vs 403 vs 503 is genuinely executed, so these fail if the
  wiring or the status mapping regresses — which a test that overrode
  `require_premium_user` could not detect.

The single most important test here is
`test_a_dependency_failure_is_never_reported_as_not_entitled`. The worst bug this
design can have is telling a *paying* subscriber they have no subscription because
the database was briefly unreachable; that must be a 503 and must never be a 403.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

import auth
import main

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
USER_ID = "11111111-1111-4111-8111-111111111111"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
class _FakeClaims:
    """The shape ``client.auth.get_claims`` **actually** returns.

    `supabase_auth.types.ClaimsResponse` is a TypedDict, so at runtime the value is
    a plain `dict` — `{"claims": ..., "headers": ..., "signature": ...}`.

    This fake used to expose `.claims` as an *attribute*, a shape the library never
    produces. Reading it that way returns `None` silently instead of raising, so
    `verify_access_token` refused every genuine token while this suite stayed green.
    Modelling the real return value is the whole point: it is what makes that class
    of bug fail here rather than in front of a paying customer.
    """

    def __new__(cls, claims: dict) -> dict:
        return {
            "claims": claims,
            "headers": {"alg": "ES256", "kid": "test-key"},
            "signature": b"",
        }


class _AttributeStyleClaims:
    """The attribute form, which the type name suggests even though it is not what
    this release returns. Kept as a test so the tolerant branch stays tested."""

    def __init__(self, claims: dict) -> None:
        self.claims = claims


class _FakeAuth:
    """A `client.auth` whose `get_claims` returns ``claims`` or raises ``error``."""

    def __init__(self, claims: dict | None = None, error: Exception | None = None) -> None:
        self._claims = claims
        self._error = error
        self.calls: list[str] = []

    def get_claims(self, token: str):
        self.calls.append(token)
        if self._error is not None:
            raise self._error
        return _FakeClaims(self._claims) if self._claims is not None else None


class _FakeClient:
    def __init__(self, auth_client: _FakeAuth) -> None:
        self.auth = auth_client


def claims_for(sub: str = USER_ID, email: str = "premium@example.test") -> dict:
    return {
        "sub": sub,
        "email": email,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int((NOW + timedelta(hours=1)).timestamp()),
    }


def profile_for(
    tier: str = "premium",
    expiry: str | None = None,
    provider: str | None = "manual",
    user_id: str = USER_ID,
    email: str = "premium@example.test",
) -> dict:
    return {
        "id": user_id,
        "email": email,
        "subscription_tier": tier,
        "subscription_expiry": expiry,
        "subscription_provider": provider,
    }


@pytest.fixture()
def gated(monkeypatch: pytest.MonkeyPatch):
    """Stub only the two Supabase calls, leaving every decision real.

    Returns a small setter so a test can change what the profile read yields
    *between* requests — which is how the 503-vs-403 distinction gets tested.
    """

    class Harness:
        def __init__(self) -> None:
            self.profile: dict | list | Exception | None = profile_for()
            self.token_calls: list[str] = []

        def sign_in(self, claims: dict | None = None, error: Exception | None = None) -> None:
            self.claims = claims
            fake = _FakeAuth(self.claims, error)
            monkeypatch.setattr(main, "get_supabase", lambda: _FakeClient(fake))
            self.auth = fake

        def serve_profile(self, value) -> None:
            self.profile = value

        def read_profile(self, base_url, api_key, token, user_id):
            self.token_calls.append((token, user_id))
            if isinstance(self.profile, Exception):
                raise self.profile
            return self.profile

    harness = Harness()
    harness.sign_in(claims_for())
    # Only `read_profile` is replaced. `verify_access_token` is left real: the fake
    # client mimics `get_claims` including how it raises, so the genuine exception
    # mapping (everything -> 401) is what runs, not a stub of it.
    monkeypatch.setattr(auth, "read_profile", harness.read_profile)
    return harness


# ---------------------------------------------------------------------------
# Pure: parse_bearer_token
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "   ",
        "Bearer",
        "Bearer ",
        "Basic dXNlcjpwYXNz",
        "Token abc.def.ghi",
        # The scheme is required. `Authorization: <token>` is a common mistake and
        # has to be refused like any other, not accepted leniently.
        "eyJhbGciOiJIUzI1NiJ9.abc.def",
        "bearer",
    ],
)
def test_a_malformed_authorization_header_is_a_401(header):
    with pytest.raises(auth.HTTPException) as raised:
        auth.parse_bearer_token(header)

    assert raised.value.status_code == 401
    # Advertised so a client knows which scheme to use, per RFC 9110.
    assert raised.value.headers["WWW-Authenticate"] == "Bearer"


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER", "BeArEr"])
def test_the_scheme_is_matched_case_insensitively(scheme):
    """HTTP auth schemes are case-insensitive; refusing `bearer` would be a bug."""
    assert auth.parse_bearer_token(f"{scheme} abc.def.ghi") == "abc.def.ghi"


def test_surrounding_whitespace_is_tolerated():
    assert auth.parse_bearer_token("  Bearer   abc.def.ghi  ") == "abc.def.ghi"


def test_the_token_is_returned_verbatim():
    """A JWT contains dots and hyphens; nothing may be trimmed or split off it."""
    token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-ature_here"
    assert auth.parse_bearer_token(f"Bearer {token}") == token


# ---------------------------------------------------------------------------
# Pure: verify_access_token
# ---------------------------------------------------------------------------
def test_a_token_supabase_rejects_is_a_401():
    client = _FakeClient(_FakeAuth(error=RuntimeError("invalid JWT")))

    with pytest.raises(auth.HTTPException) as raised:
        auth.verify_access_token(client, "forged")

    assert raised.value.status_code == 401


def test_an_expired_token_is_a_401_not_a_500():
    """The library raises for an expired token; that is the caller's problem, not ours."""
    client = _FakeClient(_FakeAuth(error=ValueError("token has expired")))

    with pytest.raises(auth.HTTPException) as raised:
        auth.verify_access_token(client, "expired")

    assert raised.value.status_code == 401


@pytest.mark.parametrize(
    "claims",
    [
        {},  # no subject at all
        {"sub": ""},  # empty subject
        {"sub": None},  # null subject
        {"email": "nobody@example.test"},  # subject missing entirely
    ],
)
def test_claims_without_a_subject_are_refused(claims):
    """An identity with no id must not be constructible from a token."""
    client = _FakeClient(_FakeAuth(claims=claims))

    with pytest.raises(auth.HTTPException) as raised:
        auth.verify_access_token(client, "token")

    assert raised.value.status_code == 401


def test_a_null_response_is_a_401():
    client = _FakeClient(_FakeAuth(claims=None))

    with pytest.raises(auth.HTTPException) as raised:
        auth.verify_access_token(client, "token")

    assert raised.value.status_code == 401


def test_verified_claims_are_returned():
    client = _FakeClient(_FakeAuth(claims=claims_for()))

    assert auth.verify_access_token(client, "token")["sub"] == USER_ID


def test_the_claims_are_read_from_the_dict_the_library_returns():
    """**The regression test for the outage.**

    `get_claims` returns a TypedDict, which is a `dict` at runtime. Reading
    `response.claims` as an attribute yields None without raising, so this asserts
    the key that the real return value actually has — and the whole rest of the
    suite now runs through the same shape, so any return to the attribute read
    fails here rather than 401ing every signed-in user.
    """
    response = _FakeClaims(claims_for())
    assert isinstance(response, dict), "the fake must model the real dict return value"

    assert auth.verified_claims(response)["sub"] == USER_ID
    # And the assertion that the old code was making, spelled out: the attribute
    # lookup is not merely inefficient, it is empty.
    assert getattr(response, "claims", None) is None


def test_an_attribute_style_response_is_still_accepted():
    """Tolerated because the type name suggests it and a future release could return
    a model object; the dict form above is the one that must work today."""
    response = _AttributeStyleClaims(claims_for())

    assert auth.verified_claims(response)["sub"] == USER_ID


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        {"claims": None},
        {"claims": "not-a-mapping"},
        {"headers": {}, "signature": b""},  # no `claims` key at all
        "a token that is not a response",
    ],
)
def test_a_response_with_no_claim_mapping_yields_nothing(response):
    """Not a claim set, so the caller must refuse rather than guess."""
    assert auth.verified_claims(response) is None


def test_the_token_reaches_supabase_unaltered():
    """Whatever the caller sent is what is validated — no normalisation in between."""
    fake = _FakeAuth(claims=claims_for())
    auth.verify_access_token(_FakeClient(fake), "a.b.c")

    assert fake.calls == ["a.b.c"]


def test_the_rejection_detail_does_not_echo_the_exception():
    """A probe must not learn from the response whether a token was revoked or malformed."""
    client = _FakeClient(_FakeAuth(error=RuntimeError("signature is invalid: kid=abc")))

    with pytest.raises(auth.HTTPException) as raised:
        auth.verify_access_token(client, "forged")

    assert "kid" not in raised.value.detail
    assert "signature is invalid" not in raised.value.detail


# ---------------------------------------------------------------------------
# Pure: parse_expiry
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "value, expected",
    [
        (None, None),
        ("", None),
        ("   ", None),
        ("not a date", None),
        # PostgREST's current shape for a timestamptz.
        ("2026-11-14T00:00:00+00:00", datetime(2026, 11, 14, tzinfo=timezone.utc)),
        # The older `Z` variant, which `fromisoformat` only accepts from Python 3.11.
        ("2026-11-14T00:00:00Z", datetime(2026, 11, 14, tzinfo=timezone.utc)),
        ("2026-11-14T00:00:00z", datetime(2026, 11, 14, tzinfo=timezone.utc)),
        # A non-UTC offset is honoured rather than assumed to be UTC.
        ("2026-11-14T07:00:00+07:00", datetime(2026, 11, 14, tzinfo=timezone.utc)),
        # A bare timestamp is read as UTC: every value in this schema is written by
        # Postgres in UTC, so a naive one is a serialisation detail, not a local time.
        ("2026-11-14T00:00:00", datetime(2026, 11, 14, tzinfo=timezone.utc)),
        ("2026-11-14", datetime(2026, 11, 14, tzinfo=timezone.utc)),
    ],
)
def test_parse_expiry_reads_every_shape_postgrest_can_send(value, expected):
    assert auth.parse_expiry(value) == expected


def test_parse_expiry_treats_a_naive_datetime_as_utc():
    assert auth.parse_expiry(datetime(2026, 11, 14)) == datetime(2026, 11, 14, tzinfo=timezone.utc)


def test_parse_expiry_keeps_an_aware_datetime_as_it_is():
    aware = datetime(2026, 11, 14, tzinfo=timezone(timedelta(hours=7)))
    assert auth.parse_expiry(aware) == aware


@pytest.mark.parametrize("value", [True, False, 0, 123, [], {}])
def test_parse_expiry_refuses_a_non_date_without_raising(value):
    """A wrong-typed column must be 'no expiry on record', not a crash."""
    assert auth.parse_expiry(value) is None


def test_parse_expiry_returns_an_aware_datetime():
    """Comparing a naive value with an aware `now` raises `TypeError`; this prevents it."""
    parsed = auth.parse_expiry("2026-11-14T00:00:00")

    assert parsed is not None
    assert parsed.tzinfo is not None


# ---------------------------------------------------------------------------
# Pure: subscription_is_active
# ---------------------------------------------------------------------------
def test_a_premium_tier_with_no_expiry_is_active():
    """A manual or lifetime grant. `schema_profiles.sql` documents why."""
    assert auth.subscription_is_active({"subscription_tier": "premium"}, NOW) is True


@pytest.mark.parametrize("tier", ["free", "FREE", "none", "", None, 7, ["premium"]])
def test_only_the_premium_tier_is_active(tier):
    assert auth.subscription_is_active({"subscription_tier": tier}, NOW) is False


@pytest.mark.parametrize("tier", ["premium", "PREMIUM", "Premium", "  premium  "])
def test_the_premium_tier_is_read_case_insensitively_and_untrimmed(tier):
    assert auth.subscription_is_active({"subscription_tier": tier}, NOW) is True


def test_a_future_expiry_is_active():
    profile = profile_for(expiry=(NOW + timedelta(days=1)).isoformat())
    assert auth.subscription_is_active(profile, NOW) is True


def test_a_past_expiry_is_not_active():
    profile = profile_for(expiry=(NOW - timedelta(seconds=1)).isoformat())
    assert auth.subscription_is_active(profile, NOW) is False


def test_the_expiry_boundary_is_exclusive():
    """Exactly at the expiry instant the subscription has ended, not 'still valid'."""
    profile = profile_for(expiry=NOW.isoformat())
    assert auth.subscription_is_active(profile, NOW) is False


def test_an_unparseable_expiry_does_not_grant_access_on_its_own():
    """The tier still gates it: a broken date must not be the *only* reason to refuse."""
    assert auth.subscription_is_active({"subscription_tier": "free"}, NOW) is False
    assert auth.subscription_is_active(
        {"subscription_tier": "premium", "subscription_expiry": "not a date"}, NOW
    ) is True


# ---------------------------------------------------------------------------
# Pure: resolve_entitlement
# ---------------------------------------------------------------------------
def test_resolve_reads_tier_expiry_and_provider():
    user = auth.resolve_entitlement(
        claims_for(), profile_for(expiry="2026-11-14T00:00:00+00:00")
    )

    assert user.user_id == USER_ID
    assert user.tier == "premium"
    assert user.subscription_expiry == datetime(2026, 11, 14, tzinfo=timezone.utc)
    assert user.subscription_provider == "manual"
    assert user.profile_missing is False


def test_resolve_falls_back_to_the_token_email_when_the_profile_has_none():
    """A profile row created by the signup trigger can carry a null email."""
    user = auth.resolve_entitlement(claims_for(), profile_for(email=None))

    assert user.email == "premium@example.test"


def test_resolve_marks_a_missing_profile_rather_than_inventing_one():
    user = auth.resolve_entitlement(claims_for(), None)

    assert user.profile_missing is True
    assert user.tier == auth.FREE_TIER
    assert user.is_premium() is False


@pytest.mark.parametrize("tier", [None, "", "   ", 42, ["premium"], {"a": 1}])
def test_a_non_string_or_empty_tier_falls_back_to_free(tier):
    user = auth.resolve_entitlement(claims_for(), {"subscription_tier": tier})

    assert user.tier == auth.FREE_TIER
    assert user.is_premium() is False


def test_resolve_normalises_the_tier_to_lowercase():
    assert auth.resolve_entitlement(claims_for(), profile_for(tier="  PREMIUM ")).tier == "premium"


def test_resolve_refuses_claims_with_no_subject():
    with pytest.raises(auth.HTTPException) as raised:
        auth.resolve_entitlement({"email": "x@y.z"}, profile_for())

    assert raised.value.status_code == 401


def test_resolve_keeps_the_whole_verified_claim_set():
    user = auth.resolve_entitlement(claims_for(), profile_for())

    assert user.claims["role"] == "authenticated"
    assert user.claims_role == "authenticated"


# ---------------------------------------------------------------------------
# Pure: the refusal decision, and require_premium
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "profile, expected",
    [
        (profile_for(tier="premium"), None),  # active, no expiry
        (profile_for(tier="premium", expiry="2026-12-01T00:00:00+00:00"), None),
        # Lapsed: 402, so the app can say "renew" rather than "subscribe".
        (profile_for(tier="premium", expiry="2026-01-01T00:00:00+00:00"), 402),
        (profile_for(tier="free"), 403),
        (None, 403),  # no profile row at all
        (profile_for(tier="free", expiry="2026-01-01T00:00:00+00:00"), 403),
    ],
)
def test_refusal_status_distinguishes_lapsed_from_never_subscribed(profile, expected):
    user = auth.resolve_entitlement(claims_for(), profile)

    assert user.refusal_status(NOW) == expected


def test_require_premium_passes_an_entitled_caller_through():
    user = auth.resolve_entitlement(claims_for(), profile_for())

    assert auth.require_premium(user, NOW) is user


@pytest.mark.parametrize("profile, status", [(profile_for(tier="free"), 403), (None, 403)])
def test_require_premium_raises_403_for_an_account_that_never_subscribed(profile, status):
    user = auth.resolve_entitlement(claims_for(), profile)

    with pytest.raises(auth.HTTPException) as raised:
        auth.require_premium(user, NOW)

    assert raised.value.status_code == status
    assert "no active premium subscription" in raised.value.detail


def test_require_premium_raises_402_when_the_subscription_lapsed():
    user = auth.resolve_entitlement(claims_for(), profile_for(expiry="2026-01-01T00:00:00+00:00"))

    with pytest.raises(auth.HTTPException) as raised:
        auth.require_premium(user, NOW)

    assert raised.value.status_code == 402
    assert "expired" in raised.value.detail


# ---------------------------------------------------------------------------
# read_profile — the real HTTP request, with only the transport faked
# ---------------------------------------------------------------------------
class _Transport:
    """Captures the request `read_profile` would send and replays a canned response."""

    def __init__(self, status_code: int = 200, body=None, text: str = "") -> None:
        self.status_code = status_code
        self.body = body
        self.text = text
        self.requests: list[dict] = []

    def __call__(self, url, *, params=None, headers=None, timeout=None):
        self.requests.append({"url": url, "params": params, "headers": headers, "timeout": timeout})
        request = httpx.Request("GET", url)
        if self.body is None:
            return httpx.Response(self.status_code, text=self.text, request=request)
        return httpx.Response(self.status_code, json=self.body, request=request)


@pytest.fixture()
def transport(monkeypatch: pytest.MonkeyPatch) -> _Transport:
    fake = _Transport(body=[profile_for()])
    monkeypatch.setattr(auth.httpx, "get", fake)
    return fake


def test_read_profile_sends_the_callers_own_token_not_the_api_key(transport):
    """The whole security argument rests on this line."""
    auth.read_profile("https://project.supabase.co", "anon-key", "USER-TOKEN", USER_ID)

    sent = transport.requests[0]["headers"]
    assert sent["Authorization"] == "Bearer USER-TOKEN"
    assert sent["apikey"] == "anon-key"


def test_read_profile_filters_by_the_verified_user_id(transport):
    """RLS already restricts the row; the filter makes the intent explicit."""
    auth.read_profile("https://project.supabase.co", "anon-key", "token", USER_ID)

    assert transport.requests[0]["params"]["id"] == f"eq.{USER_ID}"


def test_read_profile_asks_only_for_the_columns_it_needs(transport):
    auth.read_profile("https://project.supabase.co", "anon-key", "token", USER_ID)

    selected = transport.requests[0]["params"]["select"]
    assert "subscription_tier" in selected
    assert "subscription_expiry" in selected


def test_read_profile_targets_the_documented_table(transport):
    auth.read_profile("https://project.supabase.co", "anon-key", "token", USER_ID)

    assert transport.requests[0]["url"] == f"https://project.supabase.co/rest/v1/{auth.PROFILES_TABLE}"


def test_read_profile_tolerates_a_trailing_slash_on_the_base_url(transport):
    auth.read_profile("https://project.supabase.co/", "anon-key", "token", USER_ID)

    assert "//rest" not in transport.requests[0]["url"]


def test_read_profile_returns_none_for_an_empty_result(monkeypatch: pytest.MonkeyPatch):
    """No row is a real state — the account predates the schema — not an error."""
    monkeypatch.setattr(auth.httpx, "get", _Transport(body=[]))

    assert auth.read_profile("https://p.supabase.co", "k", "t", USER_ID) is None


@pytest.mark.parametrize("status", [401, 403])
def test_a_token_postgrest_refuses_is_a_401(monkeypatch: pytest.MonkeyPatch, status):
    monkeypatch.setattr(auth.httpx, "get", _Transport(status_code=status, body={"message": "no"}))

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 401


def test_a_missing_table_names_the_file_to_run(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth.httpx, "get", _Transport(status_code=404, body={"message": "nope"}))

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 503
    assert "schema_profiles.sql" in raised.value.detail


def test_an_upstream_error_surfaces_postgrests_own_message(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        auth.httpx,
        "get",
        _Transport(status_code=400, body={"message": "invalid input syntax for uuid"}),
    )

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 503
    assert "invalid input syntax for uuid" in raised.value.detail


def test_a_transport_failure_is_a_503_not_an_entitlement_verdict(monkeypatch: pytest.MonkeyPatch):
    def explode(*_args, **_kwargs):
        raise httpx.ConnectTimeout("supabase did not answer")

    monkeypatch.setattr(auth.httpx, "get", explode)

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 503


def test_a_non_list_body_is_a_503(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth.httpx, "get", _Transport(body={"unexpected": "object"}))

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 503


def test_an_unparseable_body_is_a_503(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(auth.httpx, "get", _Transport(status_code=200, body=None, text="<html>"))

    with pytest.raises(auth.HTTPException) as raised:
        auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert raised.value.status_code == 503


def test_the_profile_read_is_bounded_by_a_timeout(transport):
    auth.read_profile("https://p.supabase.co", "k", "t", USER_ID)

    assert transport.requests[0]["timeout"] == auth.PROFILE_TIMEOUT_SECONDS


# ---------------------------------------------------------------------------
# HTTP — the real gate on /api/predict/premium
# ---------------------------------------------------------------------------
def test_without_a_token_the_premium_endpoint_is_a_401(gated):
    response = TestClient(main.app).get("/api/predict/premium")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"
    # The token check must run *before* the query: an anonymous caller should not
    # be able to make this endpoint touch the draw ledger at all.
    assert gated.token_calls == []


@pytest.mark.parametrize(
    "header",
    ["Basic dXNlcjpwYXNz", "token-without-a-scheme", "Bearer", ""],
)
def test_a_badly_formed_header_never_reaches_supabase(gated, header):
    response = TestClient(main.app).get("/api/predict/premium", headers={"Authorization": header})

    assert response.status_code == 401
    assert gated.token_calls == []


def test_an_account_with_no_subscription_is_a_403(gated):
    gated.serve_profile(profile_for(tier="free"))

    response = TestClient(main.app).get(
        "/api/predict/premium", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 403
    assert "no active premium subscription" in response.json()["detail"]


def test_an_account_with_no_profile_row_at_all_is_a_403(gated):
    gated.serve_profile(None)

    response = TestClient(main.app).get(
        "/api/predict/premium", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 403


def test_a_lapsed_subscription_is_a_402(gated):
    gated.serve_profile(profile_for(expiry="2020-01-01T00:00:00+00:00"))

    response = TestClient(main.app).get(
        "/api/predict/premium", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 402
    assert "expired" in response.json()["detail"]


def test_a_voided_token_is_a_401(gated):
    gated.sign_in(error=RuntimeError("invalid JWT: token signature is invalid"))

    response = TestClient(main.app).get(
        "/api/predict/premium", headers={"Authorization": "Bearer revoked"}
    )

    assert response.status_code == 401


def test_a_dependency_failure_is_never_reported_as_not_entitled(gated):
    """The bug that would cost the most: a paying subscriber told they are not one.

    A 503 means "ask again"; a 403 would tell a subscriber their subscription is
    gone because our database blinked.
    """
    gated.serve_profile(auth.HTTPException(status_code=503, detail="Supabase unreachable"))

    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/predict/premium", headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == 503
    assert response.status_code not in (402, 403)


@pytest.mark.parametrize(
    "params, expected_status",
    [
        ({}, 200),  # an empty ledger is still an empty state
        ({"limit": 1}, 422),  # and parameter validation still runs
        ({"type": "singapore"}, 422),  # and an unknown ledger is still refused
    ],
)
def test_a_subscriber_reaches_the_model_unchanged(gated, monkeypatch, params, expected_status):
    """With the door open the endpoint behaves exactly as it did before the gate.

    The empty ledger is the interesting one: it must stay a 200 with
    `insufficient_data`, because the entitlement check runs *before* the fetch and
    a 200 here proves it did not replace the endpoint's own error handling.
    """
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, _limit, _type=None: [])

    response = TestClient(main.app).get(
        "/api/predict/premium", params=params, headers={"Authorization": "Bearer good-token"}
    )

    assert response.status_code == expected_status, response.text
    if expected_status == 200:
        assert response.json()["status"] == "insufficient_data"


def test_the_token_is_not_echoed_back_in_a_refusal(gated):
    gated.serve_profile(profile_for(tier="free"))

    response = TestClient(main.app).get(
        "/api/predict/premium", headers={"Authorization": "Bearer super-secret-token"}
    )

    assert "super-secret-token" not in response.text


def test_the_profile_is_read_for_the_token_s_subject(gated):
    TestClient(main.app).get("/api/predict/premium", headers={"Authorization": "Bearer good-token"})

    assert gated.token_calls == [("good-token", USER_ID)]


# ---------------------------------------------------------------------------
# HTTP — the endpoints that stay open
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    "path", ["/api/latest-draws", "/api/predict/basic", "/api/backtest", "/api/checkout/plans"]
)
def test_the_free_endpoints_are_unaffected_by_the_gate(gated, path):
    """The free tier is the product; adding auth must not have closed it.

    Asserted as "not a refusal" rather than "200" on purpose: these endpoints need
    a working database to answer, and this fixture deliberately provides a fake
    client that only knows how to validate tokens. What is being pinned is that the
    *gate* does not stand in front of them — whether their own query then succeeds
    is the business of their own suites.
    """
    response = TestClient(main.app, raise_server_exceptions=False).get(path)

    assert response.status_code not in (401, 402, 403)


def test_health_advertises_the_auth_contract():
    payload = TestClient(main.app).get("/api/health").json()

    assert payload["auth"]["status"] == "enforced"
    assert payload["auth"]["scheme"] == "bearer"
    assert payload["auth"]["profiles_table"] == auth.PROFILES_TABLE
    # Equality, not membership, and that is the point: a new endpoint behind the
    # paywall has to be declared here or this fails. It grew from one entry to two
    # when `/api/premium/accuracy-report` was added under the same gate — a paid
    # endpoint that existed but was not listed would be exactly the kind of silent
    # drift this assertion is here to catch.
    assert payload["auth"]["gated_endpoints"] == [
        "/api/predict/premium",
        "/api/premium/accuracy-report",
    ]


# ---------------------------------------------------------------------------
# HTTP — GET /api/me
# ---------------------------------------------------------------------------
def test_me_requires_a_token(gated):
    assert TestClient(main.app).get("/api/me").status_code == 401


def test_me_reports_a_premium_subscriber(gated):
    gated.serve_profile(profile_for(expiry="2026-12-01T00:00:00+00:00"))

    response = TestClient(main.app).get("/api/me", headers={"Authorization": "Bearer t"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["authenticated"] is True
    assert payload["user_id"] == USER_ID
    assert payload["subscription_tier"] == "premium"
    assert payload["is_premium"] is True
    assert payload["subscription_expiry"] == "2026-12-01T00:00:00+00:00"
    assert payload["refusal_status"] is None


def test_me_reports_a_free_account_without_failing(gated):
    """Signing in without a subscription is an ordinary state, not an error."""
    gated.serve_profile(profile_for(tier="free"))

    response = TestClient(main.app).get("/api/me", headers={"Authorization": "Bearer t"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["subscription_tier"] == "free"
    assert payload["is_premium"] is False
    assert payload["refusal_status"] == 403


def test_me_agrees_with_the_gate_it_reports(gated):
    """`/api/me` and the gate read one definition, so they cannot disagree."""
    gated.serve_profile(profile_for(expiry="2020-01-01T00:00:00+00:00"))

    me = TestClient(main.app).get("/api/me", headers={"Authorization": "Bearer t"})
    premium = TestClient(main.app).get("/api/predict/premium", headers={"Authorization": "Bearer t"})

    assert me.json()["refusal_status"] == premium.status_code == 402


def test_me_is_never_cached(gated):
    """A shared cache must not hand one user's subscription state to the next."""
    response = TestClient(main.app).get("/api/me", headers={"Authorization": "Bearer t"})

    assert response.headers["cache-control"] == "private, no-store"


def test_me_flags_a_missing_profile_so_the_gap_is_visible(gated):
    gated.serve_profile(None)

    payload = TestClient(main.app).get("/api/me", headers={"Authorization": "Bearer t"}).json()

    assert payload["profile_missing"] is True
