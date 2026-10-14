"""SuperHeng — post-ingestion verification of the draw ledger.

Answers the one question ``scraper.py``'s exit code cannot: **did the data
actually land in the table?**

A zero exit from the scraper only proves it *sent* rows. Everything between that
and a usable ledger can fail quietly — the credentials may authenticate but point
at a different project, row-level security may accept the statement and keep
nothing, the table may be empty because a migration was re-run, or the source may
have stopped publishing while the scrape still "succeeds" against stale pages.
So this script reads the table back using the same credentials the workflow
supplies and fails loudly when the result is not usable.

What it asserts
---------------
``--type`` chooses which ledger the checks describe (``thai`` by default, or
``laos`` / ``vietnam``). That is not cosmetic: without it the script reads all
three ledgers at once, so a Lao job would measure its own staleness against a Thai
draw and check its prize width against whichever country happened to be newest.

1. **The ledger is not empty.** Zero rows is the explicit failure mode: either
   the write never happened, or the credentials cannot see it.
2. **The newest draw is recent.** A ledger that stops advancing is the quiet
   version of the same bug — a source that changed its markup, or an archive that
   stopped paginating, yields a "successful" scrape that adds nothing new.
   ``--max-staleness-days`` (default 45) is deliberately loose: consecutive draws
   are at most 15 days apart, the job also runs on the 1st/2nd and 16th/17th as
   fallbacks, and a draw can be published late. 45 days means two whole draw
   cycles were missed before it complains, so it does not cry wolf.
3. **The newest row is well formed** — a first prize of the width that ledger uses
   (6 digits for Thai and Lao, 5 for Vietnam's giải đặc biệt) and a 2-digit bottom
   prize, the same shape the ingestion enforces on the way in. This catches a
   partial or altered write that a row count alone would miss.

Reaching the database
---------------------
The Supabase client is imported from ``scraper`` rather than rebuilt, so the
environment handling — including the "still holds the ``.env.example``
placeholders" guard — keeps exactly one implementation. The row count is paged
manually: this postgrest release exposes no ``count`` parameter, and
``APIResponse.count`` is ``None`` unless one is requested, so an aggregate would
silently read as 0.

Usage (from the repository root, exactly as the workflow invokes it)::

    python backend/verify_ingestion.py
    python backend/verify_ingestion.py --max-staleness-days 20
    python backend/verify_ingestion.py --type laos
    python backend/verify_ingestion.py --type vietnam --min-rows 400

Exits 0 when the ledger is usable and 1 otherwise, emitting ``::error::`` lines
so a failure is legible in the Actions summary rather than buried in the log.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
from dataclasses import dataclass
from datetime import date
from typing import Any, Sequence

from scraper import TABLE_NAME, IngestionError, create_supabase_client

log = logging.getLogger("superheng.verify_ingestion")

# How wide each ledger's first prize is, so the shape check is the right shape for
# the country being verified. A Vietnam row that is 6 digits is as wrong as a Thai
# row that is 5 — see `PRIZE_DIGITS` below.
#
# This constant exists in three places — here, `scraper.PRIZE_DIGITS` (what gets
# written) and `main.LOTTERY_PRIZE_DIGITS` (what gets modelled) — which is a smell
# that would normally be fixed by importing one from another. It is not, because
# `main` deliberately keeps its import graph light for Render cold starts, and
# `verify_ingestion` imports only `scraper` so it stays runnable in CI without the
# model stack. Instead the agreement is *asserted*: see
# `test_international_scraper.test_the_scraper_and_the_api_agree_on_how_wide_each_ledger_is`,
# which fails the moment the three drift apart.
PRIZE_DIGITS: dict[str, int] = {"thai": 6, "laos": 6, "vietnam": 5}
LOTTERY_TYPES: tuple[str, ...] = tuple(PRIZE_DIGITS)

# The shape the ingestion enforces on the way in. Re-checking it here is the
# point: a row that is present but malformed is not a successful ingestion.
BOTTOM_TWO_RE = re.compile(r"^\d{2}$")

DEFAULT_MIN_ROWS = 1
DEFAULT_MAX_STALENESS_DAYS = 45

# PostgREST pages inclusively; 1000 matches Supabase's default row cap, so each
# request is one full page whether or not the server imposes that ceiling.
PAGE_SIZE = 1000
# A runaway guard, not a real limit: 100k rows is ~4,000 years of draws.
MAX_PAGES = 100


# ---------------------------------------------------------------------------
# Reading the ledger
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerState:
    """What the ledger looks like right now, read back from the database."""

    rows: int
    oldest: str | None
    newest: str | None
    newest_first_prize: str | None
    newest_bottom_two: str | None


def count_rows(client: Any, lottery_type: str = "thai") -> int:
    """Count one ledger exactly, by paging.

    ``APIResponse.count`` is ``None`` unless a count is requested, and this
    postgrest release has no way to request one, so an aggregate query would
    report 0 against a populated table — the worst possible failure mode for a
    verifier.
    """
    total = 0
    for _ in range(MAX_PAGES):
        response = (
            client.table(TABLE_NAME)
            .select("draw_date")
            .eq("lottery_type", lottery_type)
            .order("draw_date")
            .range(total, total + PAGE_SIZE - 1)
            .execute()
        )
        batch = response.data or []
        total += len(batch)
        if len(batch) < PAGE_SIZE:
            return total

    raise IngestionError(
        f"paging {TABLE_NAME} exceeded {MAX_PAGES} page(s) of {PAGE_SIZE}; "
        "refusing to report a row count that may be wrong"
    )


def newest_row(client: Any, lottery_type: str = "thai") -> dict[str, Any]:
    """Return one ledger's most recent draw, or ``{}`` when it is empty."""
    response = (
        client.table(TABLE_NAME)
        .select("draw_date,first_prize,bottom_two")
        .eq("lottery_type", lottery_type)
        .order("draw_date", desc=True)
        .limit(1)
        .execute()
    )
    data = response.data or []
    return data[0] if data else {}


def oldest_draw_date(client: Any, lottery_type: str = "thai") -> str | None:
    """Return one ledger's earliest draw date, or ``None`` when it is empty."""
    response = (
        client.table(TABLE_NAME)
        .select("draw_date")
        .eq("lottery_type", lottery_type)
        .order("draw_date")
        .limit(1)
        .execute()
    )
    data = response.data or []
    return data[0].get("draw_date") if data else None


def fetch_ledger_state(client: Any, lottery_type: str = "thai") -> LedgerState:
    """Read everything the checks need for one ledger, in one pass."""
    count = count_rows(client, lottery_type)
    latest = newest_row(client, lottery_type)
    return LedgerState(
        rows=count,
        oldest=oldest_draw_date(client, lottery_type),
        newest=latest.get("draw_date"),
        newest_first_prize=latest.get("first_prize"),
        newest_bottom_two=latest.get("bottom_two"),
    )


# ---------------------------------------------------------------------------
# Judging the ledger
# ---------------------------------------------------------------------------


def check_ledger(
    state: LedgerState,
    *,
    today: date,
    min_rows: int = DEFAULT_MIN_ROWS,
    max_staleness_days: int = DEFAULT_MAX_STALENESS_DAYS,
    lottery_type: str = "thai",
) -> list[str]:
    """Return the problems that make the ledger unusable; empty means healthy.

    Pure: it takes a snapshot and today's date and returns strings, so every
    branch is testable without a database, a clock or a network.
    """
    problems: list[str] = []

    if state.rows < min_rows:
        problems.append(
            f"the {lottery_type} ledger holds {state.rows} row(s) but {min_rows} are "
            "required — the scrape wrote nothing these credentials can see. Confirm "
            "SUPABASE_KEY is the service_role key (schema.sql grants SELECT only, so "
            "anon cannot insert) and that schema.sql has been applied to this project."
        )
        # Staleness and shape say nothing useful about an empty ledger.
        return problems

    if state.newest is None:
        problems.append(
            "the ledger reported rows but returned no newest draw; the read was "
            "inconsistent."
        )
        return problems

    try:
        newest = date.fromisoformat(state.newest)
    except ValueError:
        problems.append(
            f"the newest draw_date {state.newest!r} is not an ISO date, so the ledger "
            "cannot be trusted for modelling."
        )
        return problems

    age = (today - newest).days
    if age < 0:
        problems.append(
            f"the newest draw is dated {state.newest}, {abs(age)} day(s) in the future. "
            "That is a corrupted date, most likely a Buddhist-era year written as CE."
        )
    elif age > max_staleness_days:
        problems.append(
            f"the newest draw is {state.newest} — {age} day(s) old, past the "
            f"{max_staleness_days}-day limit. The scrape ran but the ledger stopped "
            "advancing, which usually means the source changed its markup or stopped "
            "publishing. Compare against the draw count the previous step reported."
        )

    digits = PRIZE_DIGITS.get(lottery_type, 6)
    if not re.fullmatch(rf"\d{{{digits}}}", state.newest_first_prize or ""):
        problems.append(
            f"the newest {lottery_type} row's first_prize is "
            f"{state.newest_first_prize!r}, not {digits} digits. schema.sql constrains "
            "this, so a mismatch means the row was not written by this project's "
            "ingestion (or that the wrong ledger was read)."
        )
    if not BOTTOM_TWO_RE.match(state.newest_bottom_two or ""):
        problems.append(
            f"the newest {lottery_type} row's bottom_two is "
            f"{state.newest_bottom_two!r}, not two digits, so the ledger the models "
            "train on is corrupt."
        )

    return problems


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _fail(message: str) -> None:
    """Report a failure as a GitHub annotation *and* a normal log line."""
    log.error("%s", message)
    print(f"::error::{message}", flush=True)


def _close(client: Any) -> None:
    """Close the HTTP session the client opened, mirroring scraper.py."""
    session = getattr(getattr(client, "postgrest", None), "session", None)
    if callable(getattr(session, "close", None)):
        session.close()


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="verify_ingestion",
        description=(
            "Read the lottery_draws ledger back and fail if the ingestion did not "
            "leave it usable."
        ),
    )
    parser.add_argument(
        "--type",
        choices=LOTTERY_TYPES,
        default="thai",
        help="which ledger to verify (default: thai)",
    )
    parser.add_argument(
        "--min-rows",
        type=int,
        default=DEFAULT_MIN_ROWS,
        help=(
            "minimum number of rows the ledger must hold "
            f"(default: {DEFAULT_MIN_ROWS}; 0 rows is the failure this exists to catch)"
        ),
    )
    parser.add_argument(
        "--max-staleness-days",
        type=int,
        default=DEFAULT_MAX_STALENESS_DAYS,
        help=(
            "how old the newest draw may be before the check fails "
            f"(default: {DEFAULT_MAX_STALENESS_DAYS})"
        ),
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="enable debug logging",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.min_rows < 1:
        # A verifier that accepts an empty ledger verifies nothing. Fail rather
        # than let a typo silently disable the check the caller asked for.
        _fail(
            f"--min-rows must be at least 1, got {args.min_rows}. An empty ledger is "
            "the failure this script exists to detect."
        )
        return 1

    try:
        client = create_supabase_client()
    except IngestionError as exc:
        _fail(f"Could not build a Supabase client: {exc}")
        return 1

    try:
        state = fetch_ledger_state(client, args.type)
    except IngestionError as exc:
        _fail(str(exc))
        return 1
    except Exception as exc:  # noqa: BLE001 - surface any read failure, don't mask it
        _fail(f"Reading {TABLE_NAME} failed: {exc}")
        return 1
    finally:
        _close(client)

    today = date.today()
    problems = check_ledger(
        state,
        today=today,
        min_rows=args.min_rows,
        max_staleness_days=args.max_staleness_days,
        lottery_type=args.type,
    )

    log.info(
        "Ledger %s (%s): %d row(s), %s -> %s",
        TABLE_NAME,
        args.type,
        state.rows,
        state.oldest,
        state.newest,
    )
    if state.newest:
        try:
            log.info(
                "Newest draw is %d day(s) old (limit %d).",
                (today - date.fromisoformat(state.newest)).days,
                args.max_staleness_days,
            )
        except ValueError:
            pass  # already reported as a problem below

    if problems:
        log.error("Ingestion verification FAILED with %d problem(s):", len(problems))
        for problem in problems:
            print(f"::error::{problem}", flush=True)
        return 1

    log.info("Ingestion verified: the %s ledger is populated and current.", args.type)
    print(
        f"::notice::{args.type} ledger verified — {state.rows} row(s), newest "
        f"{state.newest}.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
