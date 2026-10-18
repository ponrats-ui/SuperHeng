"""SuperHeng — FastAPI service.

Day 2 scope: boot the service, allow the Expo dev client through CORS, hold a
shared Supabase client, and serve the draw ledger.

Run it (from the ``backend`` directory):

    .venv/Scripts/python -m uvicorn main:app --reload --port 8000   # Windows
    .venv/bin/python     -m uvicorn main:app --reload --port 8000   # macOS / Linux

then open http://127.0.0.1:8000/docs for the OpenAPI UI.

Endpoints
---------
``GET /``                  liveness probe (exact payload, public)
``GET /health``            liveness probe for uptime monitors (no dependency
                          checks — see the note above the handler)
``GET /api/health``        service + dependency status
``GET /api/latest-draws``  the 10 most recent rows from ``lottery_draws``
``GET /api/predict/basic`` Frequency + Markov Chain -> ranked 2-digit picks
``GET /api/predict/advanced`` Frequency + Markov + ARIMA + Monte Carlo -> the
                          weighted ensemble Heng Score
``GET /api/predict/premium`` Bayesian positional posteriors for all six digits
                          of the first prize (Premium tier — requires a bearer
                          token; see auth.py and schema_profiles.sql)
``GET /api/backtest``      walk-forward replay of the recent draws: win rate, ROI
                          and every baseline, with no data leakage
``GET /api/premium/accuracy-report``
                          post-draw accuracy: what the model said about each recent
                          draw before it happened, position by position, against
                          the digits that were actually drawn (Premium tier)
``GET /api/me``            the caller's own account and subscription state
``GET /api/checkout/plans`` the subscription price list (public)
``POST /api/checkout/create-session`` (alias ``/api/create-checkout-session``)
                          open a Stripe Checkout Session (card / PromptPay) for
                          the token's own account. Produces a payable URL; it
                          never charges and never grants.
``POST /api/create-portal-session``
                          open Stripe's self-service Billing Portal for the token's
                          own account: cards, receipts, and cancellation. Never
                          changes an entitlement by itself.
``POST /api/webhook/stripe`` (alias ``/api/webhook``)
                          Stripe's server-to-server events. Signature-verified,
                          idempotent, and the only code path that grants *or
                          revokes* premium.
``GET /api/diagnostics/paywall``
                          which paywall dependency is configured and which is
                          missing, by environment-variable name and never by value

Design notes
------------
* **One Supabase client for the whole process.** ``get_supabase()`` returns a
  module-level singleton, so every endpoint shares one HTTP connection pool
  instead of building a new one per request and leaking the old one.
* The client is built **on first use, not at import time.** Import-time
  construction is the usual way to write this, and it makes the module
  unimportable without credentials — which breaks `--reload`, the OpenAPI
  generation, and any test that merely imports `main`. Lazy creation gives the
  identical shared-global behaviour at request time without that failure mode.
* The service still boots when Supabase is unconfigured: ``/`` and
  ``/api/health`` keep working and ``/api/latest-draws`` answers ``503`` with a
  clear message, so a missing ``.env`` is visible rather than fatal.
* **One endpoint is not public.** ``/api/predict/premium`` requires a Supabase
  bearer token whose account holds an active premium subscription; the
  entitlement logic is in ``auth.py`` and the table and its policies are in
  ``schema_profiles.sql``. Every draw endpoint stays open on purpose — the free
  tier is the product. This replaces the *client-side password* that used to
  guard the premium panel, which was never a server-side control: the bundle
  shipped the digest and the endpoint answered unauthenticated callers, so the
  panel's only real protection was that nobody had bothered to look.
* **The webhook is the market's only authority on who paid.** No endpoint here
  can grant a subscription, and neither can the app: `create-session` returns
  `charged: false` and `subscription_granted: false` even when it has just
  created a real, payable Stripe session. Premium is written in exactly one
  place — `webhook.py`, from a request whose Stripe signature verified — and the
  database enforces the same rule from the other side, by refusing
  `subscription_tier` to every non-service role (`schema_profiles.sql`).
  So the two answers to "is this account premium" cannot disagree, because there
  is only one writer.
* The Day 2 plan also calls for ``X-API-Key`` auth and ``slowapi`` rate
  limiting; those are still not here (see ROADMAP.md, Day 2). Rate limiting is
  now the more pressing of the two: the premium endpoints are the first that
  cost a database round trip before they can be refused.
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path
from typing import Any, AsyncIterator

# `load_dotenv` MUST run before the credential constants below are read.
# Loading backend/.env explicitly (rather than relying on the CWD) matters:
# `load_dotenv()` with no argument silently finds nothing when uvicorn is
# launched from the repository root instead of from backend/.
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402
from supabase import Client, create_client  # noqa: E402

import accuracy  # noqa: E402
import auth  # noqa: E402
import backtest  # noqa: E402
import checkout  # noqa: E402
import payments  # noqa: E402
import webhook  # noqa: E402
from services import DEFAULT_WEIGHTS, analyse_draws  # noqa: E402

# NOTE: `models` (and therefore statsmodels) is imported *inside* the advanced
# endpoint rather than here, because `import statsmodels.tsa.arima.model` costs
# a measured **1738 ms** on this machine. A module-level import would add that to
# every uvicorn boot, every `--reload` restart, and every test run that merely
# imports `main` — for an endpoint most boots never call. The same reasoning as
# the lazy Supabase client above: keep the module cheap to import, pay only when
# the dependency is actually used. Python caches the module afterwards, so only
# the first request to the endpoint pays it.

SERVICE_NAME = "SuperHeng API"
API_VERSION = "1.0"

DRAWS_TABLE = "lottery_draws"
DEFAULT_LIMIT = 10
MAX_LIMIT = 100


class LotteryType(str, Enum):
    """The ledgers ``lottery_draws`` holds, one per country.

    A ``str`` enum so the value is what reaches PostgreSQL and the query string;
    inheriting from ``str`` also keeps it JSON-serialisable without a custom
    encoder. Declaring it as the type of a query parameter (rather than validating
    a free string) is what makes FastAPI reject an unplanned country with a 422 and
    list the valid values in the OpenAPI schema — the ledger only ever holds the
    three values `schema.sql`'s CHECK constraint allows.
    """

    thai = "thai"  # Government Lottery Office (GLO) — the original ledger
    laos = "laos"
    vietnam = "vietnam"  # Hanoi


# How many digits each ledger's first prize has, which is what the premium model
# models. This is a property of the *lottery*, not a setting: Thailand's รางวัลที่ 1
# and Laos's ຫວຍພັດທະນາ first prize are six-digit numbers, and Vietnam's giải đặc
# biệt (the Hanoi special prize) is a five-digit one. The value is passed to the
# model rather than guessed, so a row of the wrong length is reported as a warning
# instead of silently redefining how many positions the country has.
LOTTERY_PRIZE_DIGITS: dict[LotteryType, int] = {
    LotteryType.thai: 6,
    LotteryType.laos: 6,
    LotteryType.vietnam: 5,
}

# One description for the parameter wherever it appears.
LOTTERY_TYPE_DESCRIPTION = (
    "Which country's ledger to analyse: 'thai' (default, the GLO draws), 'laos', "
    "or 'vietnam' (Hanoi). An unseeded ledger is not an error — it answers HTTP "
    "200 with status 'insufficient_data'."
)

LOTTERY_TYPE_QUERY = Query(LotteryType.thai, description=LOTTERY_TYPE_DESCRIPTION)

# Rolling window for the prediction models: how many of the most recent draws they
# are allowed to see. Fixed rather than "everything we have" because the archive is
# not a homogeneous sample — it reaches back to the machine era the models are not
# trying to describe, and an unbounded window turns every model into a cumulative
# average that reacts more slowly with each draw added. 400 draws is roughly the
# last 16 years at 24 draws/year, and comfortably inside PostgREST's 1000-row cap,
# so the window costs one request either way.
ROLLING_WINDOW_DRAWS = 400

# The prediction endpoints take their `limit` from that window: the default is the
# whole window, and the window is also the ceiling — no request can train the models
# on more history than this, whatever it asks for.
DEFAULT_HISTORY_LIMIT = ROLLING_WINDOW_DRAWS
MAX_HISTORY_LIMIT = ROLLING_WINDOW_DRAWS

# One description for all three prediction endpoints, so the published window can
# only change in one place. `limit` below the window is still honoured — that is
# what makes a controlled backtest possible — but never beyond it.
HISTORY_LIMIT_DESCRIPTION = (
    f"How many of the most recent draws to analyse (2-{MAX_HISTORY_LIMIT}; "
    f"default {DEFAULT_HISTORY_LIMIT} = the full rolling window)."
)

# Columns the models need. Selecting them explicitly keeps the payload small and
# makes the contract obvious, rather than shipping the whole table each request.
HISTORY_COLUMNS = "draw_date,first_prize,bottom_two"

# The `limit` parameter of the three prediction endpoints is bounded by the rolling
# window, so it is declared once here rather than repeated in each signature.
HISTORY_LIMIT_QUERY = Query(
    DEFAULT_HISTORY_LIMIT,
    ge=2,
    le=MAX_HISTORY_LIMIT,
    description=HISTORY_LIMIT_DESCRIPTION,
)

log = logging.getLogger("superheng.api")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)

# ---------------------------------------------------------------------------
# Supabase — one client shared by every endpoint
# ---------------------------------------------------------------------------
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip()
SUPABASE_KEY = (os.getenv("SUPABASE_KEY") or "").strip()

# A **second, more powerful** credential, used by exactly one endpoint: the Stripe
# webhook (`webhook.py`). Everything else here reads the database with the caller's
# own token so that row-level security decides what is visible; that is the whole
# design of the premium gate. Granting a subscription cannot be done that way —
# `schema_profiles.sql` deliberately denies `subscription_tier` to `authenticated`,
# which is what stops a user pricing their own subscription at zero — so the
# webhook needs a key that bypasses RLS.
#
# Treat it accordingly. It is a full-access admin credential for the whole
# project: it must live only in the backend's environment, must never be prefixed
# with EXPO_PUBLIC_ (which inlines a value into the app bundle for anyone to
# read), and must never be committed. The single consumer is `webhook.py`, which
# is also the only module allowed to decide an entitlement.
#: The variable is named rather than inlined so `GET /api/diagnostics/paywall` can
#: report *which* one is missing without restating the string. A diagnostic that
#: names a variable nothing reads is worse than no diagnostic at all.
SUPABASE_SERVICE_KEY_ENV = "SUPABASE_SERVICE_KEY"
SUPABASE_SERVICE_KEY = (os.getenv(SUPABASE_SERVICE_KEY_ENV) or "").strip()

# Module-level singleton. None until the first successful initialisation.
supabase_client: Client | None = None


# An unfilled placeholder, not a credential. Anchored on purpose: real Supabase
# keys are long random strings, and an unanchored substring test would reject a
# legitimate key that merely happened to contain a word like "example".
_PLACEHOLDER_PREFIX = re.compile(
    r"^(your[-_]|paste|insert|replace|add[-_]?your|change[-_]?me|"
    r"placeholder|todo|xxx+)",
    re.IGNORECASE,
)


def _looks_like_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER_PREFIX.match(value.strip()))


def _credentials_problem() -> str | None:
    """Return why the credentials are unusable, or None when they look fine.

    Catching an unfilled placeholder here — rather than letting it reach
    Supabase — is what turns a confusing `500 Invalid API key` into an accurate
    `503 you have not configured this yet`.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return (
            "Supabase is not configured: SUPABASE_URL and/or SUPABASE_KEY are "
            "missing. Copy backend/.env.example to backend/.env and fill both in."
        )
    if (
        "your-project-ref" in SUPABASE_URL
        or _looks_like_placeholder(SUPABASE_URL)
        or _looks_like_placeholder(SUPABASE_KEY)
    ):
        return (
            "Supabase credentials still hold placeholders, not real values. "
            "Set SUPABASE_URL and SUPABASE_KEY in backend/.env to your project's "
            "real URL and API key."
        )
    if not SUPABASE_URL.startswith(("http://", "https://")):
        return (
            f"SUPABASE_URL is not a URL: {SUPABASE_URL!r}. It should look like "
            "https://<project-ref>.supabase.co"
        )
    return None


def _service_key_problem() -> str | None:
    """Why the webhook cannot write an entitlement, or None when it can.

    Checked separately from `_credentials_problem` because it is a different
    credential with a different failure: the API works fine without it right up
    until the first customer pays, at which point the only symptom would be a
    webhook that fails forever. Saying which variable is missing, at the moment
    the webhook runs, is what turns that into a fixable message.
    """
    if not SUPABASE_SERVICE_KEY:
        return (
            "SUPABASE_SERVICE_KEY is not set, so a payment cannot be recorded. "
            "This must be the Supabase *service_role* (or a secret) key, not the "
            "anon key: the entitlement columns are not writable by any "
            "signed-in role. Set it in backend/.env — see backend/.env.example."
        )
    if _looks_like_placeholder(SUPABASE_SERVICE_KEY):
        return (
            "SUPABASE_SERVICE_KEY still holds a placeholder, not a real key. Set "
            "it in backend/.env to the project's service_role / secret key."
        )
    return None


def get_supabase() -> Client:
    """Return the process-wide Supabase client, creating it on first use.

    Raises ``HTTPException(503)`` when the service cannot obtain a client —
    unconfigured credentials, or an initialisation failure. That is a
    server-side dependency problem, not a bad request from the caller, so 503 is
    the honest status; the endpoint's own 500 is reserved for a query that was
    actually attempted and failed.
    """
    global supabase_client

    if supabase_client is not None:
        return supabase_client

    problem = _credentials_problem()
    if problem is not None:
        log.warning("%s", problem)
        raise HTTPException(status_code=503, detail=problem)

    try:
        supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as exc:  # noqa: BLE001 - surfaced to the caller as 503
        log.exception("Failed to initialise the Supabase client.")
        raise HTTPException(
            status_code=503,
            detail=f"Could not initialise the Supabase client: {exc}",
        ) from exc

    log.info("Supabase client initialised for %s", SUPABASE_URL)
    return supabase_client


def _close_supabase() -> None:
    """Release the client's HTTP connection pool."""
    global supabase_client

    client, supabase_client = supabase_client, None
    if client is None:
        return

    # Attribute names differ across supabase-py releases, so probe rather than
    # assume the shape.
    for candidate in ("postgrest", "storage", "auth"):
        holder = getattr(client, candidate, None)
        session = getattr(holder, "session", None)
        close = getattr(session, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001 - shutdown must never raise
                log.debug("Ignoring error while closing the %s session.", candidate)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Warm the shared client on startup and release it on shutdown.

    The warm-up is best-effort: a failure is logged and the service starts
    anyway, so a wrong ``.env`` produces clear errors from the endpoint instead
    of a boot loop.
    """
    problem = _credentials_problem()
    if problem:
        log.warning("%s", problem)
    else:
        try:
            get_supabase()
        except HTTPException as exc:
            log.warning("Supabase warm-up failed: %s", exc.detail)

    try:
        yield
    finally:
        _close_supabase()
        log.info("Shutdown complete.")


app = FastAPI(
    title=SERVICE_NAME,
    description="Prediction service for the SuperHeng lottery analytics app.",
    version=API_VERSION,
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------
# Allowed browser origins are read from the environment so one deployment can
# serve local development and the hosted frontend without a code change:
#
#   CORS_ORIGINS       comma-separated exact origins (scheme + host + port)
#   CORS_ORIGIN_REGEX  optional regular expression, matched against the origin
#
# With neither set, the middleware falls back to the permissive `*` that local
# development needs — the Expo web target on :8081 and whichever LAN origin a
# physical phone reports. The beta deployment sets `*` explicitly too; see
# ../render.yaml, which also documents the narrowed allow-list to use before
# launch.
#
# CORS_ORIGIN_REGEX exists because a Pages *preview* deployment gets a fresh
# `<hash>.<project>.pages.dev` host on every build, while the branch alias
# (`<branch>.<project>.pages.dev`) moves between builds. One pattern covers the
# production alias and every preview hash without redeploying the API:
#
#   ^https://([a-z0-9-]+\.)?superheng-3yf\.pages\.dev$
#
# `allow_credentials` is governed by CORS_ALLOW_CREDENTIALS and defaults to
# False. The note below the constants records what actually happens when it is
# turned on, because the widely repeated "a wildcard and credentials cannot
# coexist" rule does not hold for Starlette — it was measured, not assumed.
#
# Two limits worth remembering: CORS is enforced by browsers only — curl, bots
# and the native iOS/Android app are unaffected — so it is not an access
# control and must never be the only thing guarding an endpoint.
def _cors_origins_from_env() -> list[str]:
    """Parse `CORS_ORIGINS`, falling back to the permissive dev default.

    Empty entries and a trailing comma are tolerated because this value is
    pasted by hand into a dashboard, and a trailing slash is stripped because
    an `Origin` header never carries one — a stray slash would silently stop
    matching and show up in the browser only as a CORS failure.
    """
    raw = (os.getenv("CORS_ORIGINS") or "").strip()
    origins = [origin.strip().rstrip("/") for origin in raw.split(",")]
    return [origin for origin in origins if origin] or ["*"]


def _cors_allow_credentials_from_env() -> bool:
    """Parse `CORS_ALLOW_CREDENTIALS`, defaulting to False.

    Read the warning below before turning this on. It is off by default because
    enabling it has a cost and, for this API as it stands, buys nothing.
    """
    raw = (os.getenv("CORS_ALLOW_CREDENTIALS") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


CORS_ORIGINS = _cors_origins_from_env()
CORS_ORIGIN_REGEX = (os.getenv("CORS_ORIGIN_REGEX") or "").strip() or None
CORS_ALLOW_CREDENTIALS = _cors_allow_credentials_from_env()

# ---------------------------------------------------------------------------
# What `allow_credentials=True` actually does here — measured, not assumed
# ---------------------------------------------------------------------------
# The commonly repeated advice is that "*" cannot be combined with credentials
# and that the browser rejects the response. That is a real rule, but Starlette
# does not emit the combination: it measures the wildcard case and reflects the
# requesting origin back instead. Verified on Starlette 1.7.0 with
# `allow_origins=["*"]`:
#
#   allow_credentials=False -> access-control-allow-origin: *
#   allow_credentials=True  -> access-control-allow-origin: <the caller's origin>
#
# So the pairing is not broken, and requests keep working. Understand what it
# means, though: with a wildcard allow-list AND credentials, every origin on the
# internet is reflected and told it may send credentials. The protection the
# wildcard normally provides — browsers refuse to send cookies to "*" — is
# exactly what this switch removes.
#
# For this API the switch is currently inert: it authenticates with a request
# header (the planned X-API-Key), not cookies, so there is nothing for a
# browser to attach. It is therefore left OFF by default and turned on only
# where a beta explicitly asks for it (see ../render.yaml). Turn it back off —
# and prefer CORS_ORIGINS/CORS_ORIGIN_REGEX over a wildcard — before any
# cookie-based session is introduced, or any site will be able to act as a
# logged-in user.
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    # With a wildcard origin every caller is allowed anyway, so the regex is
    # only doing work once CORS_ORIGINS is narrowed to a real allow-list.
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=CORS_ALLOW_CREDENTIALS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# A note on the bearer header and CORS, since the premium endpoints depend on it:
# `allow_headers=["*"]` is NOT emitted as a literal `*` by Starlette — it is a
# mirror. Measured on Starlette 1.7.0, `preflight_response` copies whatever the
# browser asked for in `Access-Control-Request-Headers` straight back into
# `Access-Control-Allow-Headers` when `allow_all_headers` is set. So a preflight
# naming `authorization` and `content-type` is granted both, including under the
# beta's `CORS_ALLOW_CREDENTIALS=true` — where a literal `*` would be treated as a
# header *name* rather than a wildcard, which is the usual way this breaks.
# Verified rather than assumed because the failure mode is a browser CORS error
# that looks nothing like the missing header it is.


# ---------------------------------------------------------------------------
# Where a payment is allowed to send the customer back to
# ---------------------------------------------------------------------------
# Stripe needs a `success_url` and a `cancel_url`, and those are the only part of
# this integration that must name the frontend. They are built from an origin the
# *server* trusts, never from a value the browser hands in unchecked, because a
# client-supplied redirect target is an open redirect: an attacker mails a link
# that takes real money and then lands the victim on a look-alike page they
# control, complete with the same "payment successful" wording.
#
# The allow-list is deliberately the *same* one CORS already uses. Those are
# exactly the origins this API is willing to be called from, so reusing them means
# "can call the API" and "can be redirected to after paying" cannot drift apart,
# and there is one thing to configure rather than two.

#: FRONTEND_BASE_URL, if the operator set it. A bare origin: scheme, host, optional
#: port — no path, query or fragment, which is what an `Origin` header carries.
FRONTEND_BASE_URL_ENV = "FRONTEND_BASE_URL"
FRONTEND_BASE_URL = (os.getenv(FRONTEND_BASE_URL_ENV) or "").strip().rstrip("/")

#: Loopback, in any of the spellings a dev server actually uses. Excluded from the
#: open-redirect concern above on purpose: redirecting a browser to its own machine
#: is not a phishing primitive — the attacker gains nothing by sending a victim to
#: localhost — whereas refusing it would break `npx expo start` against a deployed
#: API, which is the ordinary way this app is developed.
_LOOPBACK_ORIGIN_RE = re.compile(
    r"^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$", re.IGNORECASE
)

#: A bare origin and nothing else. Rejecting a path here rather than passing it to
#: Stripe matters: Stripe appends its own query parameters to `success_url`, so a
#: URL that already carried a query would silently lose or mangle them.
_ORIGIN_SHAPE_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?$")


def _allowed_return_origins() -> tuple[str, ...]:
    """The origins a payment may return to, most specific first."""
    origins: list[str] = []
    if FRONTEND_BASE_URL:
        origins.append(FRONTEND_BASE_URL)
    # A wildcard is not an allow-list, so it contributes nothing here.
    origins.extend(origin for origin in CORS_ORIGINS if origin != "*")
    return tuple(dict.fromkeys(origins))


def _origin_is_allowed(origin: str) -> bool:
    """Whether a payment may be returned to `origin`.

    Mirrors precisely the set of origins the browser API already trusts:
    the configured list, the preview-deployment regex (Cloudflare Pages gives
    every preview its own hostname, so a list alone can never cover them), and
    loopback.
    """
    if origin in _allowed_return_origins():
        return True
    if _LOOPBACK_ORIGIN_RE.match(origin):
        return True
    return bool(CORS_ORIGIN_REGEX and re.match(CORS_ORIGIN_REGEX, origin))


#: The fallback used when neither `FRONTEND_BASE_URL` nor a non-wildcard
#: `CORS_ORIGINS` says where the app is: the Expo web dev server's default port.
#:
#: This cannot be reached in a *working* production deployment, and that is the
#: argument for having it rather than refusing with a 503. A browser can only call
#: this API at all if the app's origin is allowed by CORS, so a deployment that
#: serves the app must already name it in `CORS_ORIGINS` or `CORS_ORIGIN_REGEX` —
#: which means the configured allow-list is non-empty. The only way to reach this
#: constant is the wildcard dev configuration, where there is no wrong answer and
#: refusing would break `curl` and the test suite for no benefit.
#:
#: The alternative — failing the request — was considered and rejected: the return
#: URL decides where a browser lands *after* Stripe has taken the money, and the
#: entitlement is granted by the webhook regardless. Refusing a real sale over a
#: courtesy redirect would be the tail wagging the dog.
DEFAULT_DEV_RETURN_ORIGIN = "http://localhost:8081"


def resolve_return_origin(claimed: str | None) -> str:
    """The origin to send the customer back to, or a refusal explaining why not.

    ``claimed`` is the app's own origin — a browser knows it, and a native build
    passes the web origin it wants the customer to land on. It is a *request*, not
    a decision: anything outside the allow-list is refused with 403 rather than
    quietly replaced with the default. Quietly replacing it would be invisible, and
    the client bug that sent a wrong origin would stay hidden until it redirected a
    paying customer somewhere unintended.
    """
    if claimed:
        candidate = claimed.strip().rstrip("/")
        if not _ORIGIN_SHAPE_RE.match(candidate):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"return_origin must be a bare origin such as "
                    f"\"https://app.example.com\" — got {claimed!r}. Paths, "
                    "queries and fragments are refused because Stripe appends its "
                    "own parameters to the success URL."
                ),
            )
        if not _origin_is_allowed(candidate):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"return_origin {candidate!r} is not an origin this API will "
                    "send a payment back to. Add it to CORS_ORIGINS (or "
                    "FRONTEND_BASE_URL) on the server."
                ),
            )
        return candidate

    allowed = _allowed_return_origins()
    if allowed:
        return allowed[0]

    log.warning(
        "No FRONTEND_BASE_URL and no non-wildcard CORS_ORIGINS: defaulting the "
        "post-payment return to %s. Set FRONTEND_BASE_URL to the app's origin "
        "before taking real payments.",
        DEFAULT_DEV_RETURN_ORIGIN,
    )
    return DEFAULT_DEV_RETURN_ORIGIN


# ---------------------------------------------------------------------------
# Authentication — the dependency every gated endpoint shares
# ---------------------------------------------------------------------------
# Both dependencies live here rather than in `auth.py` because this module owns the
# configuration they need: the Supabase URL, the key, and the one shared client.
# `auth.py` is therefore pure logic over values it is handed, which is what makes
# it testable without a server or a database.
def require_user(
    authorization: str | None = Header(
        None,
        alias="Authorization",
        description=(
            "Supabase access token, as `Bearer <token>`. This identifies the "
            "account. The token is validated with Supabase Auth on every request; "
            "the entitlement it produces is read from `user_profiles`."
        ),
    ),
) -> auth.AuthenticatedUser:
    """Resolve the caller, or refuse with 401.

    Three steps, each of which can only produce a documented status: the header is
    parsed (401), the token is validated (401), and the profile is read (401/503).
    A caller whose token is fine but who has no subscription is **not** refused
    here — that is `require_premium_user`'s decision, and separating them is what
    lets `GET /api/me` answer for a free user.
    """
    token = auth.parse_bearer_token(authorization)
    claims = auth.verify_access_token(get_supabase(), token)
    profile = auth.read_profile(SUPABASE_URL, SUPABASE_KEY, token, str(claims["sub"]))
    return auth.resolve_entitlement(claims, profile)


def require_premium_user(
    user: auth.AuthenticatedUser = Depends(require_user),
) -> auth.AuthenticatedUser:
    """Resolve the caller and require an active premium subscription.

    Returns 403 for an account that never subscribed and 402 for one whose
    subscription has lapsed, so the app can say "subscribe" or "renew" rather than
    showing one message for both. See `auth.AuthenticatedUser.refusal_status`.
    """
    return auth.require_premium(user)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/", tags=["meta"], summary="Health check")
async def root() -> dict[str, str]:
    """Liveness probe. Public — never require an API key to read this."""
    return {"status": "SuperHeng API is running", "version": "1.0"}


# NOTE ON THE NAME: there are three liveness-shaped routes and the split is
# deliberate, not accidental duplication.
#
#   ``/``           the original probe, kept because the app and the deploy notes
#                   already reference it and its payload is asserted by tests.
#   ``/health``     the conventional path an external uptime monitor is pointed at.
#   ``/api/health`` the *diagnostic* one: it reports dependency and model status,
#                   so it reads the configuration and can therefore be affected by
#                   it. A monitor must not use it.
#
# That last distinction is the reason this route exists rather than an extra word
# in the docs. A monitor checks "is this process alive" and treats a non-200 as an
# outage; ``/api/health`` answers 200 while reporting ``supabase: not_configured``,
# and a future change that made it 503 on a degraded dependency would turn every
# monitor into a page-triggering alarm for a condition the service is designed to
# survive. ``/health`` computes nothing, touches no dependency, and cannot fail for
# a reason other than the process being gone — which is exactly the check.
@app.get("/health", tags=["meta"], summary="Liveness probe for uptime monitors")
async def liveness() -> dict[str, str]:
    """Return 200 with no dependency checks. Public, and cheap enough to poll.

    Point an uptime monitor here (every 10 minutes is enough to keep a free
    Render instance from spinning down). Nothing in this handler reads Supabase,
    the models, or the request body, so an unhealthy *dependency* can never make
    it answer non-200.
    """
    return {"status": "ok"}


@app.get("/api/health", tags=["meta"], summary="Service and dependency status")
async def health() -> dict[str, Any]:
    """Report what the service is and what it can currently reach."""
    return {
        "service": SERVICE_NAME,
        "version": API_VERSION,
        "supabase": "configured" if supabase_client is not None else "not_configured",
        # Day 3-5 add the real models. Reported explicitly so the frontend can
        # distinguish "no models yet" from "model service is down".
        "models": {
            "status": "implemented",
            "available": [
                "frequency",
                "markov",
                "timeseries",
                "montecarlo",
                "bayesian_positional",
            ],
            "endpoints": {
                "basic": "/api/predict/basic",
                "advanced": "/api/predict/advanced",
                "premium": "/api/predict/premium",
                "backtest": "/api/backtest",
            },
            # Advertised so a client can find out which ledgers exist without
            # guessing, and so the list lives in exactly one place (`LotteryType`).
            "lottery_types": [kind.value for kind in LotteryType],
        },
        # Reported so the app can tell "this backend does not have auth yet" from
        # "my token was rejected", which look identical from a 401 and lead to
        # opposite conclusions — the first means the deployment is stale, the
        # second means the user must sign in again.
        "auth": {
            "status": "enforced",
            "scheme": "bearer",
            "profiles_table": auth.PROFILES_TABLE,
            # Every endpoint behind the paywall, named in one place so a new one
            # cannot be added without this list going stale — `tests/test_auth.py`
            # asserts this equality rather than a membership, which is what makes
            # that true.
            "gated_endpoints": [
                "/api/predict/premium",
                "/api/premium/accuracy-report",
            ],
            "paid_tiers": [auth.PREMIUM_TIER],
        },
        # `gateway_configured` is the single field the app branches on to decide
        # whether to offer a real purchase or the honest "not open yet" state. It
        # is derived from the plan catalogue rather than hard-coded here, so
        # wiring a provider cannot leave this reporting the wrong thing.
        "checkout": {
            "gateway_configured": checkout.provider_configured(),
            "provider": checkout.provider_name(),
            "currency": checkout.CURRENCY_THB,
            "plans": [plan.id for plan in checkout.PLANS],
            # Reported as configured/not_configured rather than as a boolean, to
            # match the `supabase` field above. This is public and says only
            # whether a server-side credential is present — never its value — but
            # it is the difference between "payments are not set up at all" and
            # "a payment would be taken and never recorded", which are worth being
            # able to distinguish from outside the process.
            "entitlement_writer": (
                "configured" if _service_key_problem() is None else "not_configured"
            ),
        },
    }


# ---------------------------------------------------------------------------
# Paywall diagnostics
# ---------------------------------------------------------------------------
# The paywall can be wrong in four independent ways and, from outside, they look
# identical: the button does something unhelpful and no money moves. Naming which of
# the four is missing — without a dashboard, a log dive, or the Stripe dashboard — is
# the entire purpose of this route, and it exists because of a failure that was
# invisible until a real customer tried to pay: a wildcard `CORS_ORIGINS` with no
# named frontend origin, which refuses *every* browser checkout with a 403 before a
# session is ever created.
#
# PUBLIC ON PURPOSE. It reports whether four *named* environment variables are present
# and shaped like usable credentials — never a value, never a prefix of one. That is
# the same exposure `/api/health` already carries for two of them, and requiring a
# token would withhold the diagnostic in precisely the state it exists for: a
# deployment whose checkout is broken before anybody can sign in.
#
# It answers from presence and shape rather than by calling Stripe. A live probe is
# the honest way to notice a *revoked* key, and it is deliberately absent: this route
# takes no credential, so a live one would let anonymous callers spend this process's
# Stripe rate limit and read account validity from the timing. What it does instead is
# reuse the very predicates the checkout and webhook paths use
# (`payments.secret_key_problem`, `_service_key_problem`), so a diagnostic cannot
# disagree with the code it describes.
DIAGNOSTICS_OK = "ok"
DIAGNOSTICS_DEGRADED = "degraded"
DIAGNOSTICS_NOT_CONFIGURED = "not_configured"


@app.get(
    "/api/diagnostics/paywall",
    tags=["meta"],
    summary="Which paywall dependencies are configured",
    response_description=(
        "One boolean per dependency, plus the names (never the values) of what is "
        "missing"
    ),
)
async def paywall_diagnostics(response: Response) -> dict[str, Any]:
    """Report what the paywall is missing, in the terms an operator can act on.

    `status` is the field to branch on, and it has three values rather than two,
    because "broken" and "not set up yet" need opposite responses:

    * ``ok`` — everything a completed payment needs is configured, including an
      origin a payment may return to.
    * ``not_configured`` — nothing about payments is set up. That is the beta's
      honest "not open yet" state, which the app already renders correctly (the pill
      says coming soon, the button says subscribe, the methods block is hidden), so
      there is nothing for a warning to add and no way for a buyer to lose money.
    * ``degraded`` — *something* is configured and something else is missing. This is
      the dangerous half-state and the one worth shouting about: a gateway with no
      entitlement writer takes real money and records nothing, and a gateway with no
      named return origin refuses every browser checkout while claiming to be open.

    `checks` separates the individual variables from the aggregate on purpose. Two
    answers to "is the gateway configured" is the drift this codebase avoids
    elsewhere. `gateway_configured` is the secret key alone — the thing actually
    named in a bug report — while `checkout_enabled` is
    `checkout.provider_configured()`, the same answer `/api/health` reports as
    `gateway_configured`: a purchase needs the secret key *and* the signing secret, so
    a build with one of the two is `gateway_configured: true`,
    `webhook_configured: false`, `checkout_enabled: false` — a precise description
    rather than a contradiction.

    `missing` holds environment-variable names in the order they should be fixed, and
    `details` holds one sentence per name in that same order. Those sentences are the
    ones the checkout and webhook 503s already carry, so a report and an error cannot
    word the same problem differently.
    """
    # Never cached. This describes process configuration, which only changes across a
    # restart or a redeploy, and a cached `ok` is the single answer that could hide a
    # deployment that has just been broken.
    response.headers["Cache-Control"] = "no-store"

    gateway_problem = payments.secret_key_problem()
    webhook_problem = payments.webhook_secret_problem()
    writer_problem = _service_key_problem()
    return_origins = _allowed_return_origins()
    return_origin_problem = (
        None
        if return_origins
        else (
            f"{FRONTEND_BASE_URL_ENV} is not set and CORS_ORIGINS is a wildcard, so no "
            "origin may be sent a payment back to and every browser checkout is "
            f"refused with a 403. Set {FRONTEND_BASE_URL_ENV} to the app's origin, or "
            "narrow CORS_ORIGINS to it — an origin that may call this API is an "
            "origin a payment may return to."
        )
    )

    checks = {
        "gateway_configured": gateway_problem is None,
        "webhook_configured": webhook_problem is None,
        "entitlement_writer_configured": writer_problem is None,
        # Asked as a configuration question — is the variable named? — and reported
        # beside the question that actually decides a checkout. A narrowed
        # CORS_ORIGINS answers the second without answering this, and calling that
        # deployment broken would be worse than saying nothing.
        "cors_configured": bool(FRONTEND_BASE_URL),
        "return_origin_configured": bool(return_origins),
        # The aggregate the app and `/api/health` both branch on.
        "checkout_enabled": checkout.provider_configured(),
    }

    # The three credentials are listed first because a half-configured deployment
    # usually has one of them wrong, and only then the origin a payment returns to.
    credential_problems = (
        (payments.SECRET_KEY_ENV, gateway_problem),
        (payments.WEBHOOK_SECRET_ENV, webhook_problem),
        (SUPABASE_SERVICE_KEY_ENV, writer_problem),
    )
    entries = credential_problems + ((FRONTEND_BASE_URL_ENV, return_origin_problem),)
    missing = [name for name, problem in entries if problem is not None]
    details = [problem for _, problem in entries if problem is not None]

    if not missing:
        status = DIAGNOSTICS_OK
    elif all(problem is not None for _, problem in credential_problems):
        status = DIAGNOSTICS_NOT_CONFIGURED
    else:
        status = DIAGNOSTICS_DEGRADED

    return {
        "status": status,
        "checks": checks,
        "missing": missing,
        "details": details,
        # Reported from the catalogue rather than restated here, so what an operator
        # reads is what the paywall would actually offer.
        "provider": checkout.provider_name(),
        "plans": [plan.id for plan in checkout.PLANS],
        "currency": checkout.CURRENCY_THB,
    }


def fetch_draw_history(
    client: Client,
    limit: int,
    lottery_type: LotteryType | str = LotteryType.thai,
) -> list[dict[str, Any]]:
    """Fetch at most ``limit`` draws — and never more than the rolling window.

    ``lottery_type`` selects which country's ledger to read. It is filtered in the
    query (a PostgREST ``eq``), not after the fact: filtering in Python would mean
    downloading a window of every country's draws and then discarding most of it,
    and — worse — it would make the ``limit`` mean "the newest N rows of the mixed
    ledger", so a Thai request could come back with a window that is half Lao.
    The default keeps the basic and advanced endpoints Thai, which is what the
    dashboard shows.

    ``limit`` is clamped to :data:`ROLLING_WINDOW_DRAWS` here rather than only at the
    endpoint, so the window is a property of the data feeding the models: an
    endpoint, a script, or a test double all get the same bound, and asking for
    10000 rows cannot quietly widen it. The clamped value is what the query asks
    for, so a 400-draw window is one 400-row request rather than a full-table read
    that the models would then throw away.

    Returned **newest first**, in the table's descending order, because that is how
    the query pages and it keeps the read simple. Ordering is *not* fixed up here:
    each model path re-sorts chronologically in exactly one place —
    ``services.prepare_history`` for the frequency/Markov/ARIMA/ensemble models and
    ``models.bayesian._prepare_prizes`` for the positional one. Both are unit-tested
    against newest-first input, which is why this function stays a plain read and
    "the next draw" stays unambiguous for the Markov step.
    """
    window = min(limit, ROLLING_WINDOW_DRAWS)
    kind = LotteryType(lottery_type).value
    response = (
        client.table(DRAWS_TABLE)
        .select(HISTORY_COLUMNS)
        .eq("lottery_type", kind)
        .order("draw_date", desc=True)
        .limit(window)
        .execute()
    )
    return response.data or []


@app.get(
    "/api/latest-draws",
    tags=["draws"],
    summary="Most recent draw results",
    response_description="Draw rows, newest first",
)
async def latest_draws(
    limit: int = Query(
        DEFAULT_LIMIT,
        ge=1,
        le=MAX_LIMIT,
        description=f"How many draws to return (1-{MAX_LIMIT}, default {DEFAULT_LIMIT}).",
    ),
    type: LotteryType = LOTTERY_TYPE_QUERY,
) -> list[dict[str, Any]]:
    """Return the most recent rows from ``lottery_draws``, newest first.

    Filtered by ``type`` (``thai`` by default) as of the multi-country ledger. The
    filter is not cosmetic: the table's unique key is now
    ``(lottery_type, draw_date)``, so ordering the *whole* table by ``draw_date``
    would interleave countries and the dashboard's "latest draw" could be a Lao
    draw shown under a Thai heading.

    Ordered by ``draw_date`` descending *within* the chosen ledger, where
    ``draw_date`` is unique — so the ordering is total and stable and there is no
    tie to break.

    Errors are split deliberately:

    * **503** — no usable Supabase client (see ``get_supabase``). The request
      never reached the database.
    * **500** — the query itself failed. The exception text is included so the
      failure is debuggable from the client during development.

    ``select("*")`` returns whatever columns the table has, so this keeps
    working if ``schema.sql`` gains columns later. It also means the response
    shape is the table's shape — additive schema changes are safe, renames are
    not.
    """
    client = get_supabase()

    try:
        response = (
            client.table(DRAWS_TABLE)
            .select("*")
            .eq("lottery_type", type.value)
            .order("draw_date", desc=True)
            .limit(limit)
            .execute()
        )
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        # Log with the traceback, then surface a concise message. NOTE: echoing
        # exception text to the client can expose table/column names and
        # upstream detail. That is acceptable while this is a development
        # backend; gate it behind a debug flag before it is public.
        log.exception("Query on %s failed.", DRAWS_TABLE)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch draws from '{DRAWS_TABLE}': {exc}",
        ) from exc

    rows = response.data or []
    log.info("Returned %d row(s) from %s (limit=%d).", len(rows), DRAWS_TABLE, limit)
    return rows


@app.get(
    "/api/predict/basic",
    tags=["predict"],
    summary="Frequency + Markov Chain picks for the 2-digit positions",
    response_description="Ranked picks per channel, each with a Heng Score and its evidence",
)
async def predict_basic(
    limit: int = HISTORY_LIMIT_QUERY,
) -> dict[str, Any]:
    """Day 3 models: frequency analysis and a first-order Markov chain.

    Returns the Top 5 picks for both 2-digit positions — ``top`` (last two digits
    of รางวัลที่ 1) and ``bottom`` (the separately drawn เลขท้าย 2 ตัว) — each with
    a preliminary **Heng Score** (0-100), a signal tone, and a reason assembled
    from the evidence that produced the score.

    The two positions are kept strictly separate: GLO draws its 2-digit prize
    independently of the first prize, so they are different variables and
    pooling them would model the wrong one.

    **Insufficient data is not an error.** A thin or empty history returns HTTP
    200 with ``status`` set to ``limited`` or ``insufficient_data`` and every
    limitation listed in ``warnings``, so the client can render an empty state
    rather than an error page. A 500 here means the computation itself broke.
    """
    client = get_supabase()

    try:
        rows = fetch_draw_history(client, limit)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed.")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch draw history from '{DRAWS_TABLE}': {exc}",
        ) from exc

    try:
        result = analyse_draws(rows, weights=DEFAULT_WEIGHTS)
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Prediction failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute predictions: {exc}",
        ) from exc

    log.info(
        "predict/basic: status=%s draws=%d (limit=%d)",
        result.get("status"),
        result.get("draws_analyzed", 0),
        limit,
    )
    return result


@app.get(
    "/api/predict/advanced",
    tags=["predict"],
    summary="Four-model ensemble (Frequency + Markov + ARIMA + Monte Carlo)",
    response_description=(
        "Ranked picks per channel, each with a Heng Score, a per-draw probability, "
        "the evidence behind both, and a reason"
    ),
)
async def predict_advanced(
    limit: int = HISTORY_LIMIT_QUERY,
    simulations: int = Query(
        100_000,
        # The Day 5 requirement is "at least 10,000 simulated draws", so 10,000 is
        # the floor the *published* contract will accept: no caller can ask this
        # endpoint for fewer than the specification promises. The simulation is
        # not the expensive stage anyway -- measured at 0.33 s per channel for
        # 100,000 draws over a 400-draw ledger, against 1.5 s for ARIMA -- so a
        # lower floor would buy speed nobody needs while breaking the guarantee.
        ge=10_000,
        le=1_000_000,
        description=(
            "Monte Carlo draws per cycle (default 100,000, per VISION §2.3; "
            "minimum 10,000, per the Day 5 requirement)."
        ),
    ),
    seed: int = Query(
        20261001,
        ge=0,
        le=2**32 - 1,
        description=(
            "Simulation seed. The default is fixed, so the published scores are "
            "reproducible for the same data; `same seed + same inputs = same scores`."
        ),
    ),
    top_k: int = Query(
        5,
        ge=1,
        le=100,
        description="Simulated top-K a code must hold to count as a survivor (default 5).",
    ),
) -> dict[str, Any]:
    """Day 5 models: the four-signal ensemble and the final Heng Score.

    Blends Frequency and Markov (Day 3) with ARIMA and Monte Carlo (Day 5) into a
    rank-normalised, weighted **Heng Score** per 2-digit code, for both positions:
    ``top`` (last two digits of รางวัลที่ 1) and ``bottom`` (the separately drawn
    เลขท้าย 2 ตัว).

    Two numbers are returned per pick and they are **different quantities**:

    * ``score`` — model *agreement*, 0-100, rank-based, all four signals.
    * ``probability`` — an estimated **per-draw occurrence rate**, 0-100, where
      1.0% is the uniform baseline across 100 codes. The Monte Carlo survival rate
      is deliberately excluded, because it measures simulated top-K placement
      (~``top_k`` times larger) and averaging it in would overstate every
      candidate by roughly a factor of ``top_k``. See ``models.ensemble``.

    **Insufficient data is not an error** — a thin or empty ledger returns HTTP
    200 with ``status`` set to ``limited``/``insufficient_data`` and every
    limitation in ``warnings``. A 500 means the computation itself broke.

    ``simulations`` is floored at 10,000 so this published contract cannot be
    asked for less than the Day 5 requirement promises; the Python function
    underneath still accepts smaller runs, which is what the unit tests use.

    Note on cost: the ARIMA stage fits one model per candidate code per channel,
    which is the dominant cost (~1.7 s per channel at the default ``max_codes``).
    There is no response cache yet, so results are recomputed per request — see
    ROADMAP.md Day 5 for the outstanding caching task.
    """
    # Imported here, not at module scope: see the note beside the services import.
    from models import DEFAULT_WEIGHTS as ADVANCED_DEFAULT_WEIGHTS
    from models import analyse_draws_advanced

    client = get_supabase()

    try:
        rows = fetch_draw_history(client, limit)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed (advanced).")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch draw history from '{DRAWS_TABLE}': {exc}",
        ) from exc

    try:
        result = analyse_draws_advanced(
            rows,
            weights=ADVANCED_DEFAULT_WEIGHTS,
            simulations=simulations,
            seed=seed,
            top_k=top_k,
        )
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Advanced prediction failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute advanced predictions: {exc}",
        ) from exc

    log.info(
        "predict/advanced: status=%s draws=%d sims=%d seed=%d top_k=%d",
        result.get("status"),
        result.get("draws_analyzed", 0),
        simulations,
        seed,
        top_k,
    )
    return result


@app.get(
    "/api/predict/premium",
    tags=["predict"],
    summary="Bayesian positional posteriors for every digit of a first prize",
    response_description=(
        "Top 3 digits per position (hundred_thousands to units for a six-digit "
        "first prize; ten_thousands to units for Vietnam's five-digit one), each "
        "with a posterior probability (0.0-1.0) and a math-derived reason"
    ),
)
async def predict_premium(
    limit: int = HISTORY_LIMIT_QUERY,
    type: LotteryType = LOTTERY_TYPE_QUERY,
    user: auth.AuthenticatedUser = Depends(require_premium_user),
) -> dict[str, Any]:
    """Premium tier: a per-position Bayesian model of a first prize.

    **This endpoint requires an active premium subscription.** The caller must
    send `Authorization: Bearer <supabase access token>`; the token is validated
    against Supabase Auth and the account's `user_profiles` row is read through
    RLS with that same token. No token is 401, an account that never subscribed is
    403, and a lapsed subscription is 402 — see `auth.py` for why those are
    distinguished. Every *draw* endpoint stays open; this is the one that is sold.

    ``type`` chooses the ledger (``thai`` by default, or ``laos`` / ``vietnam``),
    and everything below the fetch is unchanged: the same marginal-vs-conditional
    model, the same layout. The country is a property of the *data*, not of the
    maths — which is why this is a filter on the query and not a second model.

    The number of positions follows the ledger's prize: **six** for Thailand's
    รางวัลที่ 1 and Laos's first prize, **five** for Vietnam's giải đặc biệt, which
    is a five-digit number. ``prize_digits`` in the response states which, and the
    positions present are exactly the digits the prize has — a five-digit prize is
    never padded to six, because a padding zero would publish a 100% posterior at
    a position that does not exist.

    For each modelled position — ``hundred_thousands`` through ``units`` for a
    six-digit prize, ``ten_thousands`` through ``units`` for a five-digit one (read
    left to right) — this returns the **top 3** digits with their posterior
    probability (0.0-1.0) and a reason assembled from the computed counts.

    Two probabilities drive each pick, and the difference between them is the
    Premium feature:

    * the **marginal** ``P(digit | position)`` — the historical occurrence
      probability, under a uniform Dirichlet prior;
    * the **conditional** ``P(digit | position, higher-digit = x)`` given the
      latest draw's adjacent higher digit, shrinking each row toward the marginal.
      A position ranks on the conditional when that state has enough support, and
      falls back to the marginal (saying so) when it does not.

    The leading digit — ``hundred_thousands``, or ``ten_thousands`` when the prize
    is five digits — has no higher neighbour, so it is the one position that always
    ranks on its marginal: it reports ``conditioned_on`` as ``null`` and ``basis``
    as ``"marginal"``, and is not marked unusable for it.

    The response also carries ``distribution`` — the full posterior it ranked on,
    all ten digits — so the client can draw the whole bar rather than only the top
    three.

    **Insufficient data is not an error.** An empty or thin ledger returns HTTP 200
    with ``status`` set to ``limited`` or ``insufficient_data`` and every
    limitation in ``warnings``; a 500 means the computation itself broke.

    The model is intentionally pure over its inputs: the rows are fetched here, by
    the endpoint, from the one shared Supabase client, exactly as the basic and
    advanced endpoints do — so the model stays unit-testable without a database.
    """
    # Imported here, not at module scope, so importing `main` never pulls in the
    # model stack — the same reasoning as the advanced endpoint's lazy import.
    from models.bayesian import analyse_positions

    client = get_supabase()
    lottery_type = type.value

    try:
        rows = fetch_draw_history(client, limit, type)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed (premium, type=%s).", lottery_type)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to fetch {lottery_type} draw history from '{DRAWS_TABLE}': {exc}"
            ),
        ) from exc

    try:
        result = analyse_positions(rows, length=LOTTERY_PRIZE_DIGITS[type])
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Premium prediction failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute premium predictions: {exc}",
        ) from exc

    # Echo which ledger produced these numbers. The panel refetches whenever the
    # country changes, so a response that arrives after the user has moved on can
    # be discarded by comparing this field against the selected tab instead of
    # rendering one country's posterior under another country's heading.
    result["lottery_type"] = lottery_type

    log.info(
        "predict/premium: status=%s type=%s draws=%d (limit=%d) user=%s",
        result.get("status"),
        lottery_type,
        result.get("draws_analyzed", 0),
        limit,
        user.user_id,
    )
    return result


@app.get(
    "/api/premium/accuracy-report",
    tags=["premium"],
    summary="Post-draw accuracy: the model against the completed draws",
    response_description=(
        "For each of the most recent draws, the digits the positional model ranked "
        "before that draw beside the digits actually drawn — per position, with the "
        "actual digit's rank among the model's top three — plus the hit rate, "
        "baseline and p-value for the positions and the two 2-digit channels"
    ),
)
async def premium_accuracy_report(
    type: LotteryType = LOTTERY_TYPE_QUERY,
    draws: int = Query(
        accuracy.DEFAULT_DRAWS,
        ge=accuracy.MIN_DRAWS,
        le=accuracy.MAX_DRAWS,
        description=(
            f"How many of the most recent draws to compare against what the model "
            f"said about them ({accuracy.MIN_DRAWS}-{accuracy.MAX_DRAWS}, default "
            f"{accuracy.DEFAULT_DRAWS}). Cost is roughly linear — about 70 ms per "
            "draw — so the ceiling is a request budget rather than a statistical "
            "one. The most recent draw is the first entry either way."
        ),
    ),
    user: auth.AuthenticatedUser = Depends(require_premium_user),
) -> dict[str, Any]:
    """Premium tier: the model's own homework, marked against the real results.

    **This endpoint requires an active premium subscription**, on the same terms as
    `/api/predict/premium`: no token is 401, an account that never subscribed is
    403, a lapsed subscription is 402.

    One thing about this report has to be stated before any of its numbers are
    read. **No prediction is stored anywhere in this service** — there is no
    predictions table, and `services.py` ships the ranking's `delta` as `0.0` for
    exactly that reason. So each comparison here is a **walk-forward replay**: the
    model is handed only the draws strictly before the target draw (the slice in
    `backtest.training_slice`, the same leakage boundary `tests/test_backtest.py`
    verifies by spying on the rows the model receives) and asked what it would have
    said, and that answer is then compared against the published result.

    That is the honest way to mark the model's work, and it is *not* the same claim
    as "this is what the AI predicted before the draw". The response says which one
    it is in `prediction_basis`, `replay_notice` and `limitations`, because a
    replayed prediction presented as a recorded one would be a fabricated claim
    about the past. A genuine pre-draw record needs a snapshot written when the
    prediction is made; `limitations` names that as the follow-up.

    What is scored: every position of the first prize (six for Thailand and Laos,
    five for Vietnam — the positions present are exactly the digits the prize has),
    against a 10% uniform baseline; and the two 2-digit channels, exact and inside
    the top five, against 1% and 5%. Every rate carries its baseline, its lift and
    a one-sided binomial p-value, so a green hit cannot be read as skill on its own.
    Insufficient data is a 200 with `status` set, never an error.
    """
    client = get_supabase()
    lottery_type = type.value

    try:
        # The whole rolling window, not just `draws`: the targets are its tail and
        # each one trains on the rows before it, so the window has to hold history
        # *and* the draws under test. The fetch clamps anything larger.
        rows = fetch_draw_history(client, MAX_HISTORY_LIMIT, type)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed (accuracy, type=%s).", lottery_type)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to fetch {lottery_type} draw history from '{DRAWS_TABLE}': {exc}"
            ),
        ) from exc

    try:
        result = accuracy.build_report(
            rows,
            lottery_type=lottery_type,
            draws=draws,
            train_window=MAX_HISTORY_LIMIT,
            prize_digits=LOTTERY_PRIZE_DIGITS[type],
        )
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Accuracy report failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to build the accuracy report: {exc}",
        ) from exc

    log.info(
        "premium/accuracy-report: status=%s type=%s compared=%d/%d user=%s",
        result.get("status"),
        lottery_type,
        result.get("draws_evaluated", 0),
        draws,
        user.user_id,
    )
    return result


@app.get(
    "/api/backtest",
    tags=["predict"],
    summary="Walk-forward backtest of the recent draws",
    response_description=(
        "AI win rate, ROI and every baseline (uniform, simulated random, break-even) "
        "for the 2-digit channels, plus the premium positional model's out-of-sample "
        "accuracy, each with a p-value against chance"
    ),
)
async def backtest_endpoint(
    type: LotteryType = LOTTERY_TYPE_QUERY,
    draws: int = Query(
        backtest.DEFAULT_DRAWS,
        ge=backtest.MIN_DRAWS,
        le=backtest.MAX_DRAWS,
        description=(
            f"How many of the most recent draws to replay as if they had not happened "
            f"yet ({backtest.MIN_DRAWS}-{backtest.MAX_DRAWS}, default "
            f"{backtest.DEFAULT_DRAWS}). Cost is roughly linear: at 60 draws this "
            "endpoint spends about five seconds computing, which is the ceiling "
            "because it is a request budget rather than a statistical one."
        ),
    ),
    payout_multiple: float | None = Query(
        None,
        gt=0,
        le=1000,
        description=(
            "Units returned per unit staked on a winning 2-digit pick, used for the "
            "ROI. Omit to use the ledger's documented default: 25 for Thailand (an "
            "฿80 ticket paying a ฿2,000 เลขท้าย 2 ตัว prize) and fair odds (100) for "
            "Laos and Vietnam, where no sourced payout exists here. Pass one value "
            "to compare all three ledgers on the same footing."
        ),
    ),
) -> dict[str, Any]:
    """Replay recent draws through the models using only their own past.

    For each replayed draw the models are trained on the draws strictly before it —
    see ``backtest.LEAKAGE_GUARD`` for the exact slice, which
    ``tests/test_backtest.py`` verifies by spying on the rows the model is handed.

    What is measured, and what is not:

    * the **2-digit channels** (``top``, ``bottom``) via the Frequency + Markov
      ensemble behind ``/api/predict/basic`` — win rate, ROI and the baselines;
    * the **premium positional model** via ``models.bayesian`` — a per-position
      out-of-sample hit rate, which is the claim the premium tier is sold on;
    * **not** the ARIMA/Monte Carlo ensemble. One walk-forward step through it costs
      a measured 8.28 s, so a 30-draw replay would take about four minutes per
      request. The payload says so in ``models_excluded`` rather than quietly
      dropping it.

    ``draws`` is a *request* budget, not a promise: a ledger with less history
    evaluates what it has, reports ``draws_evaluated``, and lists the shortfall in
    ``warnings``. Insufficient data is never an error here either — an empty ledger
    returns HTTP 200 with ``status`` set, exactly as the prediction endpoints do.
    """
    client = get_supabase()
    lottery_type = type.value

    try:
        # The whole rolling window, not just `draws`: the targets are its tail and
        # each step trains on the rows before its own target, so the window has to
        # be deep enough to contain history *and* the draws under test. Asking for
        # more than this is pointless — the fetch clamps it — and asking for less
        # would starve the earliest steps of training data.
        rows = fetch_draw_history(client, MAX_HISTORY_LIMIT, type)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed (backtest, type=%s).", lottery_type)
        raise HTTPException(
            status_code=500,
            detail=(
                f"Failed to fetch {lottery_type} draw history from '{DRAWS_TABLE}': {exc}"
            ),
        ) from exc

    try:
        result = backtest.run_backtest(
            rows,
            lottery_type=lottery_type,
            draws=draws,
            train_window=MAX_HISTORY_LIMIT,
            prize_digits=LOTTERY_PRIZE_DIGITS[type],
            payout_multiple=payout_multiple,
        )
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Backtest failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute the backtest: {exc}",
        ) from exc

    log.info(
        "backtest: status=%s type=%s evaluated=%d/%d train=%d-%d",
        result.get("status"),
        lottery_type,
        result.get("draws_evaluated", 0),
        draws,
        (result.get("train_sizes") or {}).get("min", 0),
        (result.get("train_sizes") or {}).get("max", 0),
    )
    return result


# ---------------------------------------------------------------------------
# Account — what the signed-in caller is entitled to
# ---------------------------------------------------------------------------
@app.get(
    "/api/me",
    tags=["account"],
    summary="The caller's account and subscription state",
    response_description=(
        "The verified user id, the subscription tier and its expiry, and whether "
        "the positional analysis is currently unlocked for this account"
    ),
)
async def me(
    response: Response,
    user: auth.AuthenticatedUser = Depends(require_user),
) -> dict[str, Any]:
    """Report the caller's own entitlement.

    This exists because the client has to answer one question after a successful
    sign-in — *is this account premium, and until when?* — and without this
    endpoint its only way to find out would be to call a premium endpoint and read
    the status code of a failure. That works, but it makes "am I subscribed" a
    property of an error path, which then has to be kept in step with the gate.
    Answering it directly is less code and cannot disagree with the gate, because
    both go through `auth.resolve_entitlement`.

    **Personalized, so it must never be cached**: `Cache-Control: private, no-store`
    is set explicitly. A shared cache holding this response would hand one user's
    subscription state to the next caller of the same URL.

    Signed out is a 401 rather than an "authenticated: false" body, so the client
    has exactly one way to learn that a token is missing or dead.
    """
    response.headers["Cache-Control"] = "private, no-store"

    log.info(
        "me: user=%s tier=%s premium=%s profile_missing=%s",
        user.user_id,
        user.tier,
        user.is_premium(),
        user.profile_missing,
    )
    return user.as_payload()


# ---------------------------------------------------------------------------
# Checkout — the price list, and a session endpoint that sells nothing yet
# ---------------------------------------------------------------------------
@app.get(
    "/api/checkout/plans",
    tags=["checkout"],
    summary="The subscription price list",
    response_description=(
        "Plan ids, integer amounts in the currency's minor unit, intervals, and "
        "whether a payment gateway is connected yet"
    ),
)
async def checkout_plans() -> dict[str, Any]:
    """The catalogue. Public — prices are not a secret, and a signed-out user is
    exactly who needs to read them before deciding to create an account.

    Amounts are integers in the minor unit (9900 = ฿99.00). The server owns the
    price list so the number the user is shown and the number they would be
    charged cannot drift apart.
    """
    return checkout.plans_payload()


class CheckoutSessionRequest(BaseModel):
    """Body of a checkout request.

    A model rather than `dict[str, Any]` so the field names and the plan id land in
    the OpenAPI schema, and so a missing `plan` is a 422 FastAPI raises before the
    handler runs rather than a `KeyError` inside it.
    """

    plan: str = Field(
        ...,
        description=(
            "Which plan to buy. One of the ids from `GET /api/checkout/plans` "
            f"({', '.join(plan.id for plan in checkout.PLANS)})."
        ),
    )
    user_id: str | None = Field(
        None,
        description=(
            "Optional, and **not** used to choose the account: the user id always "
            "comes from the verified bearer token. If this is supplied it must "
            "match that id, so a client that has drifted out of step is told "
            "rather than charged for the wrong account."
        ),
    )
    return_origin: str | None = Field(
        None,
        description=(
            "Optional bare origin to send the customer back to after paying, "
            "e.g. `https://superheng-3yf.pages.dev`. Validated against the "
            "server's own allow-list — it is never used unchecked, because a "
            "client-chosen redirect target is an open redirect."
        ),
    )
    idempotency_key: str | None = Field(
        None,
        min_length=8,
        max_length=255,
        pattern=r"^[A-Za-z0-9_-]+$",
        description=(
            "Optional. Send the *same* value again to retry a request safely. If "
            "a call times out after Stripe created the session, retrying with the "
            "same key returns that same session rather than creating a second "
            "payable one. Generate a new key for a new purchase — two taps are two "
            "intents. Values outside `[A-Za-z0-9_-]` are refused rather than "
            "forwarded, so a malformed key cannot smuggle anything into the "
            "gateway request."
        ),
    )


# The same handler is served under the shorter name the integration brief uses.
# A stacked route rather than a second function: an alias that re-implemented the
# token check, the plan lookup or the return-URL allow-list would be a second
# place for those rules to drift, and the drift would be invisible until someone
# bought through the other path. Both names therefore run the identical code.
@app.post(
    "/api/create-checkout-session",
    tags=["checkout"],
    summary="Create a Checkout Session (alias of /api/checkout/create-session)",
    response_description="Identical to `/api/checkout/create-session`.",
)
@app.post(
    "/api/checkout/create-session",
    tags=["checkout"],
    summary="Open a Stripe Checkout Session (card / PromptPay)",
    response_description=(
        "A `status` of `created` with a `checkout_url` to send the customer to, or "
        "`not_implemented` when no gateway is configured. `charged` and "
        "`subscription_granted` are **always** false — creating a session takes no "
        "money and grants nothing."
    ),
)
async def create_checkout_session(
    body: CheckoutSessionRequest,
    response: Response,
    user: auth.AuthenticatedUser = Depends(require_user),
) -> dict[str, Any]:
    """Start a purchase. **Nothing is charged and nothing is granted.**

    Two possible outcomes, and the client should branch on `status`:

    * ``created`` — a real, payable Stripe session. `checkout_url` is where to send
      the customer. No money has moved: they still have to complete the payment on
      Stripe's page, and access is granted by the webhook when Stripe confirms, not
      by returning to the app.
    * ``not_implemented`` — no gateway is configured on this server. The response
      describes the session that would have been created and says so plainly. An
      HTTP 200 rather than 501, so "not open yet" does not arrive in the client as
      an error; see `checkout.py`.

    `charged` and `subscription_granted` are false in both cases. That is the
    invariant a test can hold this endpoint to, and it is what makes a client bug
    unable to show a success screen for a purchase that did not happen.

    Authenticated but not premium-gated: an account with no subscription yet is
    precisely the account that should be able to start one. The id used for the
    session comes from the token, never from the body — see
    `CheckoutSessionRequest.user_id`.
    """
    response.headers["Cache-Control"] = "private, no-store"

    plan = checkout.PLANS_BY_ID.get(body.plan)
    if plan is None:
        # 422 to match how FastAPI reports an unprocessable value elsewhere, and
        # the message lists the ids so a client is told what to send instead.
        raise HTTPException(
            status_code=422,
            detail=(
                f"Unknown plan {body.plan!r}. Known plans: "
                f"{', '.join(plan.id for plan in checkout.PLANS)}."
            ),
        )

    if body.user_id is not None and body.user_id != user.user_id:
        # Refused rather than ignored. Ignoring it would let a client bug — one
        # account sending another's id — pass silently here and become a mis-billed
        # charge.
        raise HTTPException(
            status_code=403,
            detail=(
                "The `user_id` in the body does not match the account this token "
                "belongs to. A checkout can only be opened for the token's own "
                "account."
            ),
        )

    # Resolved before the gateway is touched, so a bad redirect target is refused
    # without creating a session nobody can be sent back from.
    return_origin = resolve_return_origin(body.return_origin)

    try:
        session = checkout.create_session(
            user,
            plan,
            return_origin=return_origin,
            claimed_user_id=body.user_id,
            idempotency_key=body.idempotency_key,
        )
    except payments.PaymentError as exc:
        # `PaymentError` carries the status and a sentence written for the caller.
        # The gateway's own failure detail is logged inside `payments.py`; what
        # reaches the client names what it can act on and never quotes a credential.
        log.error(
            "checkout/create-session failed: user=%s plan=%s status=%s detail=%s",
            user.user_id,
            plan.id,
            exc.status_code,
            exc.detail,
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    log.info(
        "checkout/create-session: user=%s plan=%s status=%s provider=%s charged=%s",
        user.user_id,
        plan.id,
        session["status"],
        session["provider"],
        session["charged"],
    )
    return session


class PortalSessionRequest(BaseModel):
    """Body of a portal request — one optional field, and no customer id.

    There is deliberately **no** `customer_id` here. A caller-supplied customer id
    would be a way to open somebody else's billing page: the id is resolved from the
    token's own profile row, and the email on that row is the only fallback. The
    model exists at all so `return_origin` is documented in the OpenAPI schema and
    validated like the checkout one.
    """

    return_origin: str | None = Field(
        None,
        description=(
            "Optional bare origin to send the customer back to when they leave the "
            "portal, e.g. `https://superheng-3yf.pages.dev`. Validated against the "
            "server's own allow-list — it is never used unchecked, because a "
            "client-chosen redirect target is an open redirect."
        ),
    )


@app.post(
    "/api/create-portal-session",
    tags=["checkout"],
    summary="Open Stripe's Billing Portal for the caller's own account",
    response_description=(
        "A `status` of `created` with a `portal_url` to send the customer to. "
        "Opening the portal changes nothing by itself — a cancellation or a refund "
        "started there takes effect when Stripe tells the webhook about it."
    ),
)
async def create_portal_session(
    response: Response,
    body: PortalSessionRequest | None = None,
    user: auth.AuthenticatedUser = Depends(require_user),
) -> dict[str, Any]:
    """Open a self-service Billing Portal session for the caller.

    This is the only place a customer can cancel, change a card, or download a
    receipt without an operator, and it exists for the same reason the entitlement
    does not: **nothing here is authoritative**. The portal is Stripe's page, and a
    cancellation or refund becomes real when Stripe delivers
    `customer.subscription.deleted` or `charge.refunded` to `/api/webhook` — which
    revokes the tier through the one database function that writes it. So this
    endpoint only mints a URL, and needs no lock, no ledger row, and no idempotency
    key: opening the portal twice is two windows on the same billing page.

    The Customer is resolved in two steps, most certain first:

    1. `stripe_customer_id` from the caller's own profile row — the id recorded at
       checkout, read with the caller's own token in `require_user`.
    2. A live lookup by the caller's own email in Stripe, for an account with an
       entitlement but no recorded Customer: a manually granted premium, or a
       profile written before the column existed. Without this they would be told
       they have no billing to manage while Stripe is holding their receipt.

    A caller *supplying* a customer id is not an option. It is not a parameter on
    the request model, so there is no code path where one account opens another's
    billing page.
    """
    response.headers["Cache-Control"] = "private, no-store"

    return_origin = resolve_return_origin(body.return_origin if body else None)

    customer_id = user.stripe_customer_id
    if customer_id is None:
        try:
            customer_id = payments.find_customer_id_by_email(user.email)
        except payments.PaymentError as exc:
            log.error(
                "create-portal-session: customer lookup failed for user=%s status=%s detail=%s",
                user.user_id,
                exc.status_code,
                exc.detail,
            )
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    if customer_id is None:
        # Not an error in the caller's browser: an account can legitimately hold a
        # manually granted entitlement and have no Stripe customer at all. 404 says
        # "there is no billing here", which is the truth and what a support
        # conversation needs to read.
        log.info(
            "create-portal-session: no Stripe customer for user=%s (tier=%s)",
            user.user_id,
            user.tier,
        )
        raise HTTPException(
            status_code=404,
            detail=(
                "This account has no Stripe customer recorded and none could be "
                "found for its email, so there is no billing to manage. Access "
                "issued by hand cannot be cancelled here — contact support."
            ),
        )

    try:
        portal = payments.create_portal_session(
            customer_id=customer_id,
            # `/premium` again, built from the validated origin: the customer comes
            # back to the page that shows what their cancellation did, not to a
            # generic Stripe receipt.
            return_url=return_origin.rstrip("/") + checkout.SUCCESS_PATH,
        )
    except payments.PaymentError as exc:
        log.error(
            "create-portal-session failed: user=%s status=%s detail=%s",
            user.user_id,
            exc.status_code,
            exc.detail,
        )
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    log.info(
        "create-portal-session: user=%s customer=%s provider=%s",
        user.user_id,
        # The customer id is not a secret, but it is also not something to spray
        # into logs in full; the last four characters identify it in a Stripe search.
        f"...{customer_id[-4:]}",
        payments.PROVIDER,
    )
    return {
        # Named from `PROVIDER`, not from `provider_name()`: the latter is None
        # unless the *webhook* secret is set too, and a successful portal call in a
        # build whose webhook is unconfigured would then report `provider: null`
        # beside a real URL. Opening the portal needs the API key and nothing else.
        "status": "created",
        "provider": payments.PROVIDER,
        "portal_url": portal.url,
    }


# ---------------------------------------------------------------------------
# Stripe webhook — the only code path in the project that grants premium
# ---------------------------------------------------------------------------
# Alias for the same reason as the checkout route above: the handler that verifies
# a signature and writes the entitlement exists once, and is registered at both
# names so a dashboard endpoint configured to either spelling is served by it.
@app.post(
    "/api/webhook",
    tags=["checkout"],
    summary="Stripe events (alias of /api/webhook/stripe)",
    response_description="Identical to `/api/webhook/stripe`.",
)
@app.post(
    "/api/webhook/stripe",
    tags=["checkout"],
    summary="Stripe server-to-server events (signature-verified)",
    response_description=(
        "What the event did: `applied` (the entitlement was written), `duplicate` "
        "(already processed), or `recorded` (arrived, granted nothing)"
    ),
)
async def stripe_webhook(request: Request) -> dict[str, Any]:
    """Receive Stripe's events and act on the ones that grant an entitlement.

    **This endpoint is authenticated by a signature, not by a token.** Stripe is a
    server and cannot hold a session, so there is no bearer header to require;
    `Stripe-Signature` over the request body is the authentication, and it is the
    only thing standing between the internet and the one function that writes
    `subscription_tier`. Hence the order of operations below, which is deliberate:

    1. **Read the raw body and nothing else.** The signature covers the exact bytes
       Stripe sent. Parsing the JSON first — with a Pydantic model or
       `request.json()` — changes whitespace and key order, and every genuine event
       would then fail verification. This is the single most common way a webhook
       integration is written wrong.
    2. **Refuse to guess when unconfigured.** Without a signing secret nothing can
       be verified, so this answers 503 rather than accepting anything.
    3. **Verify before trusting a field.** Everything the handler acts on comes from
       the verified event: the account from `client_reference_id`, the period from
       the catalogue rather than from the event.
    4. **Deduplicate durably.** Stripe retries a failed delivery for up to three
       days, and can deliver the same event twice even when nothing failed. The
       idempotency is the primary key of `payment_events`, applied inside the same
       transaction as the grant — not a set in memory that dies with the process.

    A non-2xx makes Stripe retry, which is exactly what should happen when the
    database is unreachable: the payment is real and the grant must eventually
    land. A 400 is returned for a bad signature, and Stripe does not retry those.
    """
    # Both halves of what this endpoint needs, checked before any work is done so
    # the failure names the actual missing variable. Note what is *not* checked:
    # the Stripe API key. Verifying a delivery needs the signing secret, not the
    # credential used to create sessions — see `payments.missing_verification_
    # configuration`, which explains why letting the entitlement path depend on the
    # charging path's key would be a mistake.
    verification_problem = payments.missing_verification_configuration()
    if verification_problem is not None:
        log.error("Stripe webhook called but it cannot be verified: %s", verification_problem)
        raise HTTPException(
            status_code=503,
            detail="This deployment cannot verify Stripe webhooks yet. " + verification_problem,
        )

    service_key_problem = _service_key_problem()
    if service_key_problem is not None:
        # 503 rather than 401: the request is authentic, this server just cannot
        # act on it. Stripe retries, so the grant lands once the key is set — which
        # is the whole reason not to acknowledge the event here.
        log.error("Stripe webhook cannot record the payment: %s", service_key_problem)
        raise HTTPException(status_code=503, detail=service_key_problem)

    # The raw bytes, untouched. See point 1 above.
    payload = await request.body()
    signature = request.headers.get("stripe-signature")

    try:
        result = webhook.handle(
            payload,
            signature,
            base_url=SUPABASE_URL,
            service_key=SUPABASE_SERVICE_KEY,
        )
    except payments.PaymentError as exc:
        # A bad signature or a malformed body: 400, and Stripe does not retry.
        log.warning("Rejected a Stripe webhook: %s", exc.detail)
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    except webhook.WebhookProblem as exc:
        # A database failure: 503, so Stripe retries and the grant lands later.
        log.error("Stripe webhook could not be recorded: %s", exc.detail)
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    return result


if __name__ == "__main__":
    # Convenience for `python main.py`; `uvicorn main:app --reload` is preferred.
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
