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
``GET /api/health``        service + dependency status
``GET /api/latest-draws``  the 10 most recent rows from ``lottery_draws``
``GET /api/predict/basic`` Frequency + Markov Chain -> ranked 2-digit picks
``GET /api/predict/advanced`` Frequency + Markov + ARIMA + Monte Carlo -> the
                          weighted ensemble Heng Score
``GET /api/predict/premium`` Bayesian positional posteriors for all six digits
                          of the first prize (Premium tier)

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
* This module currently exposes only public routes. The Day 2 plan also calls
  for ``X-API-Key`` auth and ``slowapi`` rate limiting; those are not here yet
  (see ROADMAP.md, Day 2).
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

# `load_dotenv` MUST run before the credential constants below are read.
# Loading backend/.env explicitly (rather than relying on the CWD) matters:
# `load_dotenv()` with no argument silently finds nothing when uvicorn is
# launched from the repository root instead of from backend/.
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

from fastapi import FastAPI, HTTPException, Query  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from supabase import Client, create_client  # noqa: E402

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

# History window for the prediction models. PostgREST caps a single response at
# 1000 rows by default, so 1000 is the largest window one request can cover; the
# full ledger is only ~400 rows, so this reaches the whole archive today.
DEFAULT_HISTORY_LIMIT = 1000
MAX_HISTORY_LIMIT = 1000

# Columns the models need. Selecting them explicitly keeps the payload small and
# makes the contract obvious, rather than shipping the whole table each request.
HISTORY_COLUMNS = "draw_date,first_prize,bottom_two"

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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/", tags=["meta"], summary="Health check")
async def root() -> dict[str, str]:
    """Liveness probe. Public — never require an API key to read this."""
    return {"status": "SuperHeng API is running", "version": "1.0"}


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
            },
        },
    }


def fetch_draw_history(client: Client, limit: int) -> list[dict[str, Any]]:
    """Fetch up to ``limit`` draws, newest first, for the models.

    Returned newest-first to match the table's descending order, then re-sorted
    chronologically inside ``services.prepare_history``. Doing the ordering in
    one place keeps "the next draw" unambiguous for the Markov step.
    """
    response = (
        client.table(DRAWS_TABLE)
        .select(HISTORY_COLUMNS)
        .order("draw_date", desc=True)
        .limit(limit)
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
) -> list[dict[str, Any]]:
    """Return the most recent rows from ``lottery_draws``, newest first.

    Ordered by ``draw_date`` descending, which is also the table's unique key,
    so the ordering is total and stable — there is no tie to break.

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
    limit: int = Query(
        DEFAULT_HISTORY_LIMIT,
        ge=2,
        le=MAX_HISTORY_LIMIT,
        description=(
            "How many recent draws to analyse "
            f"(2-{MAX_HISTORY_LIMIT}, default {DEFAULT_HISTORY_LIMIT} = the whole ledger)."
        ),
    ),
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
    limit: int = Query(
        DEFAULT_HISTORY_LIMIT,
        ge=2,
        le=MAX_HISTORY_LIMIT,
        description=(
            "How many recent draws to analyse "
            f"(2-{MAX_HISTORY_LIMIT}, default {DEFAULT_HISTORY_LIMIT} = the whole ledger)."
        ),
    ),
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
    summary="Bayesian positional posteriors for all six digits of รางวัลที่ 1",
    response_description=(
        "Top 3 digits per position (hundred_thousands to units), each with a "
        "posterior probability (0.0-1.0) and a math-derived reason"
    ),
)
async def predict_premium(
    limit: int = Query(
        DEFAULT_HISTORY_LIMIT,
        ge=2,
        le=MAX_HISTORY_LIMIT,
        description=(
            "How many recent draws to analyse "
            f"(2-{MAX_HISTORY_LIMIT}, default {DEFAULT_HISTORY_LIMIT} = the whole ledger)."
        ),
    ),
) -> dict[str, Any]:
    """Premium tier: a per-position Bayesian model of the 6-digit first prize.

    For each of the six modelled positions — ``hundred_thousands``,
    ``ten_thousands``, ``thousands``, ``hundreds``, ``tens`` and ``units`` (the
    whole first prize, read left to right) — this returns the **top 3** digits with
    their posterior probability (0.0-1.0) and a reason assembled from the computed
    counts.

    Two probabilities drive each pick, and the difference between them is the
    Premium feature:

    * the **marginal** ``P(digit | position)`` — the historical occurrence
      probability, under a uniform Dirichlet prior;
    * the **conditional** ``P(digit | position, higher-digit = x)`` given the
      latest draw's adjacent higher digit, shrinking each row toward the marginal.
      A position ranks on the conditional when that state has enough support, and
      falls back to the marginal (saying so) when it does not.

    The leading digit (``hundred_thousands``) has no higher neighbour, so it is the
    one position that always ranks on its marginal: it reports ``conditioned_on``
    as ``null`` and ``basis`` as ``"marginal"``, and is not marked unusable for it.

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

    try:
        rows = fetch_draw_history(client, limit)
    except Exception as exc:  # noqa: BLE001 - translated into an HTTP response
        log.exception("Draw history query failed (premium).")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to fetch draw history from '{DRAWS_TABLE}': {exc}",
        ) from exc

    try:
        result = analyse_positions(rows)
    except Exception as exc:  # noqa: BLE001 - a model bug must not look like bad input
        log.exception("Premium prediction failed after fetching %d row(s).", len(rows))
        raise HTTPException(
            status_code=500,
            detail=f"Failed to compute premium predictions: {exc}",
        ) from exc

    log.info(
        "predict/premium: status=%s draws=%d (limit=%d)",
        result.get("status"),
        result.get("draws_analyzed", 0),
        limit,
    )
    return result


if __name__ == "__main__":
    # Convenience for `python main.py`; `uvicorn main:app --reload` is preferred.
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
