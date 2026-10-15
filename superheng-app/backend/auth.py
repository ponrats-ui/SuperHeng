"""Premium entitlement: verify who is calling, then decide what they may see.

This module is the server-side half of the paywall. It replaces the client-side
password gate that used to sit in front of the Premium panel, which was
documented there as "a beta door, not a lock" — the credentials shipped inside
the static web bundle and `/api/predict/premium` answered anyone who asked. Both
halves of that are now closed: the endpoint requires a token, and the entitlement
lives in a table the client cannot write.

THE THREE QUESTIONS, IN ORDER
  1. *Who is this?*  `verify_access_token` validates the caller's Supabase access
     token and returns its claims.
  2. *What are they entitled to?*  `read_profile` reads their own row from
     `user_profiles`, **through RLS, using the caller's own token**.
  3. *May they see this?*  `resolve_entitlement` turns those two into an
     `AuthenticatedUser`; `is_premium` is the yes/no.

WHY THE PROFILE READ CARRIES THE USER'S TOKEN RATHER THAN A SECRET KEY
  A secret key (service_role) bypasses RLS, so correct scoping would rest
  entirely on this file remembering to filter by the right user id — one bug away
  from serving another customer's entitlement. Passing the caller's own token
  instead means the database enforces the filter too (`schema_profiles.sql`
  defines `user_profiles_select_own`), and the backend needs to hold **no
  privileged credential at all**. A wrong user id here returns zero rows rather
  than someone else's subscription.

  The cost is that the read cannot be done through the shared `supabase-py`
  client: `client.postgrest.auth(token)` sets the token on that client's default
  headers, and the client is a process-wide singleton shared by every concurrent
  request — two interleaved requests would race and one caller's token would
  authenticate the other's query. A per-request `httpx` call keeps the identity
  scoped to the call, which is why the request is written out by hand below
  rather than going through the client wrapper.

WHY TOKEN VALIDATION GOES THROUGH THE AUTH SERVER
  `get_claims(token)` is Supabase's documented preference: it validates `exp`,
  then verifies the signature against the project's JWKS when the project signs
  with an asymmetric key, and transparently falls back to asking the Auth server
  (`/auth/v1/user`) when the project still signs with the shared symmetric secret.
  The client behind that call is `supabase-py`, and the fallback is in its own
  source, not in this file — so both key types are covered by one call. What this
  module must never do is decode the payload and trust it: an unsigned claim is a
  string the caller chose.

STATUS CODES — the client branches on these, so they are part of the contract
  401  no token, a malformed one, or one Supabase rejects.
  402  a valid token whose subscription has expired. Payment Required is the
       literal meaning, and it lets the app say "renew" rather than "subscribe".
  403  a valid token from an account with no premium entitlement.
  503  the entitlement could not be *read* — Supabase unreachable, or the
       `user_profiles` table missing. A dependency problem, not a verdict about
       the caller, so it must never be reported as 403: telling a paying
       subscriber they are not entitled because our database hiccuped is worse
       than telling them to try again.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Mapping

import httpx
from fastapi import HTTPException

log = logging.getLogger("superheng.auth")

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------
PROFILES_TABLE = "user_profiles"
PROFILE_COLUMNS = (
    "id,email,subscription_tier,subscription_expiry,subscription_provider,stripe_customer_id"
)

PREMIUM_TIER = "premium"
FREE_TIER = "free"

#: How long the profile read may take before the request is abandoned. Short on
#: purpose: this sits in front of a prediction that already takes seconds, and a
#: hanging entitlement check is a paid user staring at a spinner.
PROFILE_TIMEOUT_SECONDS = 8.0

#: The one accepted authorization scheme, compared case-insensitively.
AUTH_SCHEME = "bearer"

#: Advertised on a 401, per RFC 9110 — it tells a client which scheme to use.
#: Note this is a *header* a browser client cannot read back without CORS
#: `expose_headers`, so the app branches on the status code, not on this.
BEARER_CHALLENGE = {"WWW-Authenticate": "Bearer"}

NOT_AUTHENTICATED = (
    "This endpoint requires a signed-in Supabase account. Sign in and retry with "
    "the access token in an `Authorization: Bearer <token>` header."
)
INVALID_TOKEN = (
    "The access token was rejected by Supabase. It may have expired or been "
    "revoked — sign in again to get a fresh one."
)
PREMIUM_REQUIRED = (
    "This account is signed in but has no active premium subscription. Open "
    "Premium in the app to subscribe."
)
SUBSCRIPTION_EXPIRED = (
    "This account's premium subscription has expired. Renew it to reopen the "
    "positional analysis."
)


# ---------------------------------------------------------------------------
# The result of the three questions
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class AuthenticatedUser:
    """A verified caller and what their subscription currently allows.

    Deliberately carries the *raw* entitlement rather than only a boolean, so an
    endpoint can report why access was granted or refused without re-reading the
    profile — and so a test can assert on the reason instead of on a flag.

    ``claims`` keeps the whole validated token payload. It is not load-bearing for
    authorization (everything decided from it is copied onto named fields here),
    but a future endpoint may need `role` or `aal`, and discarding a verified
    payload to fetch it again would be silly.
    """

    user_id: str
    email: str | None
    tier: str
    subscription_expiry: datetime | None
    subscription_provider: str | None
    claims: Mapping[str, Any]

    #: The Stripe Customer this account pays as, or None before a first purchase.
    #: Carried here rather than re-read inside the checkout route so the value comes
    #: from the same RLS-scoped read as the entitlement: it is the caller's own row,
    #: fetched with the caller's own token.
    stripe_customer_id: str | None = None

    #: True when the token is valid but the profile row was not found. That is a
    #: real state — an account created before `schema_profiles.sql` was applied, or
    #: a trigger that failed — and it is not the same as "this user is on the free
    #: tier". Both are refused, but only one of them is a bug on our side worth
    #: logging, so they are kept apart.
    profile_missing: bool = False

    @property
    def claims_role(self) -> str | None:
        role = self.claims.get("role")
        return role if isinstance(role, str) else None

    def is_premium(self, now: datetime | None = None) -> bool:
        """Whether the positional analysis may be served to this caller."""
        if self.tier != PREMIUM_TIER:
            return False
        if self.subscription_expiry is None:
            # No expiry on record: a manual or lifetime grant. `schema_profiles.sql`
            # records why this is active rather than expired.
            return True
        return self.subscription_expiry > (now or _utcnow())

    def refusal_status(self, now: datetime | None = None) -> int | None:
        """402 when lapsed, 403 when never entitled, None when entitled.

        Separate from `is_premium` so the endpoint and its tests share one
        definition of *why* a caller was turned away, rather than each re-deriving
        it and disagreeing at the edges.
        """
        if self.is_premium(now):
            return None
        if self.tier == PREMIUM_TIER and self.subscription_expiry is not None:
            return 402
        return 403

    def as_payload(self) -> dict[str, Any]:
        """The JSON shape ``GET /api/me`` returns.

        Dates are emitted as ISO-8601 with an explicit offset, matching how the
        rest of the API reports days (`draw_date`, `date_range`), so a client
        parses one date format, not two.
        """
        return {
            "authenticated": True,
            "user_id": self.user_id,
            "email": self.email,
            "subscription_tier": self.tier,
            "subscription_expiry": (
                self.subscription_expiry.isoformat() if self.subscription_expiry else None
            ),
            "subscription_provider": self.subscription_provider,
            "is_premium": self.is_premium(),
            "profile_missing": self.profile_missing,
            "refusal_status": self.refusal_status(),
        }


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# 1. Who is this?
# ---------------------------------------------------------------------------
def parse_bearer_token(header: str | None) -> str:
    """Pull the token out of an ``Authorization`` header, or raise 401.

    Written by hand rather than with a library because the shape is three lines
    and every deviation has to produce the *same* 401: a missing header, a
    different scheme, an empty token, or the once-common `Authorization: <token>`
    with no scheme at all. A client that gets 500 for one of those and 401 for the
    next cannot write one error path.
    """
    if not header or not header.strip():
        raise HTTPException(status_code=401, detail=NOT_AUTHENTICATED, headers=BEARER_CHALLENGE)

    scheme, _, token = header.strip().partition(" ")
    token = token.strip()
    if scheme.lower() != AUTH_SCHEME or not token:
        raise HTTPException(status_code=401, detail=NOT_AUTHENTICATED, headers=BEARER_CHALLENGE)

    return token


def verified_claims(response: Any) -> Mapping[str, Any] | None:
    """The verified claim set inside whatever ``get_claims`` returned.

    supabase-py types this return value as ``ClaimsResponse``, and that type is a
    **TypedDict** — which is an ordinary `dict` at runtime, with the three keys
    `claims`, `headers` and `signature`. The payload therefore has to be read as
    ``response["claims"]``.

    Reading it as an attribute (``response.claims``) does not raise: a `dict` has
    no such attribute, so `getattr` quietly returns None and the caller is left
    holding nothing. That is how **every valid token** came to be refused as
    "carrying no subject claim" — a genuine ES256 token was fetched, verified
    against the project's JWKS, and then thrown away by the lookup that read the
    claims, which the suite could not see because its fake exposed the attribute
    the library never produces.

    The attribute form is still accepted: it is what the type name suggests, and if
    a future release returns a model object instead this keeps working. One branch
    is cheaper than rediscovering this in production twice.
    """
    if response is None:
        return None

    claims = (
        response.get("claims")
        if isinstance(response, Mapping)
        else getattr(response, "claims", None)
    )
    return claims if isinstance(claims, Mapping) else None


def verify_access_token(client: Any, token: str) -> Mapping[str, Any]:
    """Validate ``token`` with Supabase Auth and return its verified claims.

    Raises 401 for anything Supabase refuses. **Every** failure maps to 401 and
    none to 500, including the ones that look internal: an expired token raises
    inside the library, a malformed one raises while decoding, and a signed-by-
    nobody one raises during signature verification. From the caller's side all
    three mean "this credential does not work", and the detailed exception text is
    logged rather than returned, so a probe cannot use the error message to learn
    whether a token was malformed or merely revoked.
    """
    try:
        response = client.auth.get_claims(token)
    except Exception as exc:  # noqa: BLE001 - every auth failure is a 401 to the caller
        log.info("Access token rejected: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=401, detail=INVALID_TOKEN, headers=BEARER_CHALLENGE) from exc

    claims = verified_claims(response)
    if claims is None or not claims.get("sub"):
        # The response type is logged because the two ways to get here look
        # identical from outside and have completely different fixes: a token with
        # no subject means Supabase issued something unusable, while an unexpected
        # response type means this module is reading the library wrongly. The
        # second is not hypothetical — it is what this line used to hide.
        log.info(
            "Access token verified but carried no usable subject claim "
            "(response type %s).",
            type(response).__name__,
        )
        raise HTTPException(status_code=401, detail=INVALID_TOKEN, headers=BEARER_CHALLENGE)

    return dict(claims)


# ---------------------------------------------------------------------------
# 2. What are they entitled to?
# ---------------------------------------------------------------------------
def parse_expiry(value: Any) -> datetime | None:
    """Read a ``subscription_expiry`` into an aware UTC datetime.

    PostgREST renders ``timestamptz`` as a string (`2026-11-14T00:00:00+00:00`) and
    older output uses a `Z` suffix, which `fromisoformat` only learned to accept in
    Python 3.11; both are handled so the parse does not depend on the interpreter.

    A naive value is treated as UTC rather than rejected: every timestamp in this
    schema is written by Postgres in UTC, so a bare one is a serialisation detail,
    never a local time. An unparseable value returns None — the caller decides
    whether that means "no expiry" or "refuse", and `subscription_is_active` is
    where that call is made, deliberately in one place.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None

    text = value.strip()
    if text.endswith(("Z", "z")):
        text = f"{text[:-1]}+00:00"

    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        log.warning("Could not parse a subscription_expiry value; treating it as unset.")
        return None

    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def subscription_is_active(profile: Mapping[str, Any], now: datetime | None = None) -> bool:
    """Whether ``profile`` describes a premium subscription that is still valid.

    Two independent conditions, and both are required: the tier must be premium
    *and* the period must not have lapsed. A row left at `premium` by a webhook
    that failed to record the lapse would otherwise entitle the account forever,
    which is the failure that costs money rather than the one that annoys a user.

    ``now`` is injectable so the expiry boundary is testable at, before and after
    the instant instead of only "in the past".
    """
    tier = profile.get("subscription_tier")
    if not isinstance(tier, str) or tier.strip().lower() != PREMIUM_TIER:
        return False

    expiry = parse_expiry(profile.get("subscription_expiry"))
    if expiry is None:
        return True

    return expiry > (now or _utcnow())


def read_profile(
    base_url: str,
    api_key: str,
    token: str,
    user_id: str,
) -> dict[str, Any] | None:
    """Read ``user_id``'s own row from ``user_profiles``, or None if there is none.

    The request carries the caller's token, so the row it returns is the one RLS
    permits — see the module docstring for why that matters more than convenience.

    ``id=eq.<user_id>`` is not redundant with RLS: it keeps the query a single-row
    primary-key lookup instead of "every row I may see, take the first". They
    agree today; the filter is what makes the safety property explicit rather than
    inherited from whatever the policy happens to say.

    Failure mapping, in the order the checks run:
      * transport failure  -> 503, because nothing was learned about the caller.
      * 401/403            -> 401, the token stopped being acceptable to PostgREST.
      * 404                -> 503 naming `schema_profiles.sql`. This is the error
                              that a half-applied deployment produces, and the
                              message says which file to run rather than leaving
                              "relation does not exist" to be decoded.
      * any other 4xx/5xx  -> 503 with PostgREST's own short message.
      * non-list JSON      -> 503.
    A Response whose JSON is an empty list is a legitimate "no profile row" and
    returns None.
    """
    url = f"{base_url.rstrip('/')}/rest/v1/{PROFILES_TABLE}"
    params = {"id": f"eq.{user_id}", "select": PROFILE_COLUMNS, "limit": "1"}
    headers = {
        "apikey": api_key,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }

    try:
        response = httpx.get(url, params=params, headers=headers, timeout=PROFILE_TIMEOUT_SECONDS)
    except httpx.HTTPError as exc:
        log.warning("Profile read failed at the transport level: %s: %s", type(exc).__name__, exc)
        raise HTTPException(
            status_code=503,
            detail=(
                "Could not read the subscription profile: Supabase did not answer. "
                "This is a service problem, not an entitlement decision — retry."
            ),
        ) from exc

    if response.status_code in (401, 403):
        log.info("Supabase refused the profile read with %d.", response.status_code)
        raise HTTPException(status_code=401, detail=INVALID_TOKEN, headers=BEARER_CHALLENGE)

    if response.status_code == 404:
        raise HTTPException(
            status_code=503,
            detail=(
                f"The '{PROFILES_TABLE}' table is not readable, so no subscription "
                "can be checked. Run backend/schema_profiles.sql against the "
                "Supabase project to create it."
            ),
        )

    if response.status_code >= 400:
        # PostgREST explains itself in `message`/`details`. Both are schema-level
        # text with no credentials in them, so they are safe to surface and are
        # the difference between a debuggable 503 and a mystery.
        detail = _postgrest_message(response)
        log.warning("Profile read returned HTTP %d: %s", response.status_code, detail)
        raise HTTPException(
            status_code=503,
            detail=f"Could not read the subscription profile (HTTP {response.status_code}): {detail}",
        )

    try:
        rows = response.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=503,
            detail="The subscription profile response was not valid JSON.",
        ) from exc

    if not isinstance(rows, list):
        raise HTTPException(
            status_code=503,
            detail="The subscription profile response was not the expected list of rows.",
        )

    return rows[0] if rows and isinstance(rows[0], dict) else None


def _postgrest_message(response: httpx.Response) -> str:
    """Best-effort human text from a PostgREST error body, never raising."""
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:200] or "no detail returned"
    if isinstance(body, dict):
        for key in ("message", "details", "hint", "error"):
            value = body.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return "no detail returned"


# ---------------------------------------------------------------------------
# 3. May they see this?
# ---------------------------------------------------------------------------
def resolve_entitlement(
    claims: Mapping[str, Any],
    profile: Mapping[str, Any] | None,
) -> AuthenticatedUser:
    """Combine verified claims and a profile row into the caller's entitlement.

    Never raises for a *free* user: signing in without a subscription is a
    perfectly ordinary state, and an endpoint like ``GET /api/me`` has to report it
    rather than fail on it. Refusing access is `require_premium`'s job, which is
    why the two are separate functions.

    Values are read with an explicit type check each. The row comes from an HTTP
    response, so "it is a dict" says nothing about what is inside it, and a
    non-string tier must not reach `subscription_is_active` as an `int`.
    """
    user_id = claims.get("sub")
    if not isinstance(user_id, str) or not user_id:
        # Unreachable via `verify_access_token`, which refuses a token with no
        # subject. Kept because this is the function that turns claims into an
        # identity, and an identity with no id must not be constructible.
        raise HTTPException(status_code=401, detail=INVALID_TOKEN, headers=BEARER_CHALLENGE)

    row = profile or {}
    tier = row.get("subscription_tier")
    email = row.get("email") if isinstance(row.get("email"), str) else None
    if email is None:
        claim_email = claims.get("email")
        email = claim_email if isinstance(claim_email, str) else None

    provider = row.get("subscription_provider")
    customer_id = row.get("stripe_customer_id")

    return AuthenticatedUser(
        user_id=user_id,
        email=email,
        tier=tier.strip().lower() if isinstance(tier, str) and tier.strip() else FREE_TIER,
        subscription_expiry=parse_expiry(row.get("subscription_expiry")),
        subscription_provider=provider if isinstance(provider, str) else None,
        stripe_customer_id=customer_id if isinstance(customer_id, str) and customer_id else None,
        claims=claims,
        profile_missing=profile is None,
    )


def require_premium(user: AuthenticatedUser, now: datetime | None = None) -> AuthenticatedUser:
    """Return ``user`` if their subscription is active, else raise 402/403.

    The status comes from `AuthenticatedUser.refusal_status` so the endpoint, the
    refusal it raises, and the tests all read one definition. `now` is threaded
    through rather than read here, so a test can pin the boundary instant.
    """
    status = user.refusal_status(now)
    if status is None:
        return user

    detail = SUBSCRIPTION_EXPIRED if status == 402 else PREMIUM_REQUIRED
    log.info(
        "Premium refused: user=%s tier=%s status=%d profile_missing=%s",
        user.user_id,
        user.tier,
        status,
        user.profile_missing,
    )
    raise HTTPException(status_code=status, detail=detail)
