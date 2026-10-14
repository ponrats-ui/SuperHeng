"""SuperHeng — Lao and Vietnamese (Hanoi) draw ingestion.

Scrapes the two non-Thai ledgers of ``lottery_draws`` and upserts them, keyed on
``(lottery_type, draw_date)``, so re-running is safe and never duplicates a draw.
Each row carries its own ``lottery_type`` — ``laos`` or ``vietnam`` — which is what
the premium endpoint's ``?type=`` parameter filters on.

Why this is a second script rather than a ``--type`` flag on ``scraper.py``
--------------------------------------------------------------------------
The Thai engine earns its length from one hard problem: Sanook's archive is
reachable in bulk but provably incomplete, so it carries four source paths, gap
detection and a bulk-versus-per-date split. Neither source here has that shape.
Both are date-addressable, both answer definitively, and **an absent draw is an
absent element rather than a hole to be hunted down** — so this engine is a plain
date walk, and the Thai script's fallback machinery is left untouched.

``laos`` — **Kapook's Lao lottery section.** ``https://lottery.kapook.com``
    ``/laolottery/{DDMMYYYY}`` renders one draw: ``.win-6`` is the 6-digit first
    prize and ``.laolottery-result-blocks`` also publishes the 4-, 3- and 2-digit
    tails under their Thai labels.

    Two things about this source are load-bearing. It addresses a draw by the
    **Buddhist year** (``13102569`` is 13 Oct 2569 BE = 2026-10-13), the same
    convention ``scraper.py`` already handles for Sanook and Myhora. And it answers
    a **non-draw date with its homepage and HTTP 200** rather than a 404, so "no
    draw that day" is signalled by the absence of ``.win-6``, never by the status
    code. Measured: Sat 2026-10-10 and Sun 2025-06-15 both returned 200 with no
    ``.win-6``, while 2026-10-13 returned ``487658``.

``vietnam`` — **XSMB (the northern lottery, the Hanoi draw) from xosodaiphat.com.**
    ``/xsmb-{DD-MM-YYYY}.html`` renders one date, with the giải đặc biệt
    (special prize) in ``.special-prize-lg``. Unlike Kapook's, this URL is in the
    **common era** and it does answer a date that has not been drawn yet — a future
    date returned 200 with no ``.special-prize-lg``, which is the same "no result
    yet" signal as Laos's.

    The special prize is a **five-digit** number, and it is stored as five digits:
    ``schema.sql`` allows 5 or 6, and the premium model publishes five positions for
    this ledger instead of padding a zero in and reporting a 100% posterior at a
    position that does not exist.

Positional format, and what "correctly" means here
--------------------------------------------------
The Bayesian model reads its thousands, hundreds, tens and units from fixed
offsets of the stored string (``POSITIONS`` in ``models/bayesian.py``), so the way
these sources are mapped onto "our standard positional format" is the **width** of
the value written: six digits for Laos, five for Vietnam. A six-digit read of a
five-digit Vietnamese prize would shift every position by one and hand the model a
thousands digit that is really a ten-thousands — a wrong answer that looks like a
working one. So the width is validated per ledger in two independent places (the
row refuses to exist at the wrong length, and ``main.LOTTERY_PRIZE_DIGITS`` says
what the model expects) plus a third on the way in, PostgreSQL's CHECK constraint.
Nothing is padded and nothing is trimmed to fit.

The two-digit column, and which values are derived
--------------------------------------------------
``bottom_two`` holds a **separately drawn** prize for Thailand (เลขท้าย 2 ตัว) and
``scraper.py`` deliberately refuses to put the first prize's tail there. Neither
source here draws one, and pretending otherwise is not an option the schema offers
— the column is ``NOT NULL``. What each ledger actually publishes:

``laos``     Kapook publishes เลขท้าย 2 ตัว, so it is **read from the page**, not
             computed. It is still the tail of the 6-digit first prize (487658 ->
             58), so the parser asserts that agreement and refuses the row when it
             does not hold: a pass-through that silently accepts a mismatch is how
             a format change corrupts an immutable ledger.
``vietnam``  Vietnam's đề *is* the last two digits of the special prize; there is no
             second draw. It is **derived** here, and that is the honest
             representation of the prize rule rather than a shortcut.

Both are recorded in ``schema.sql``'s column comment.

Windows, and why the default is short
-------------------------------------
This is a per-date source, so history costs one request per day. Thailand's ~13
requests for 20 years are not available here, and a ten-year default would mean
~2,600 requests against xosodaiphat. So the default is the **routine** window —
``--days 14`` back from today, which catches a missed schedule, a late result and a
corrected one — and a deep backfill is an explicit ``--from``/``--to`` run.

Usage (from the ``backend`` directory)::

    .venv/Scripts/python scripts/scrape_international.py --dry-run
    .venv/Scripts/python scripts/scrape_international.py --type laos
    .venv/Scripts/python scripts/scrape_international.py --type vietnam --days 30
    .venv/Scripts/python scripts/scrape_international.py --from 2025-01-01 --to 2026-10-14
    .venv/Scripts/python scripts/scrape_international.py --all-days --days 60

Invoked from the repository root by CI, exactly as ``scraper.py`` is::

    python backend/scripts/scrape_international.py --type laos
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
import time
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Iterable, Sequence

import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# The script lives in `backend/scripts/`, so `backend/` is not on sys.path when
# Python starts it as a file. Prefer a hard failure at the first import over the
# relative-import gymnastics the alternative needs.
BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from scraper import (  # noqa: E402 - after the sys.path insertion above
    IngestionError,
    build_session,
    clean_number,
    create_supabase_client,
    fetch_url,
    parse_thai_date,
    upsert_rows,
)

load_dotenv(BACKEND_DIR / ".env")

log = logging.getLogger("superheng.international")


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The ledgers this script owns. `thai` is deliberately absent: it has its own
# engine, its own sources and its own schedule, and `scraper.py` writes it.
LOTTERY_TYPES: tuple[str, ...] = ("laos", "vietnam")

# How many digits each ledger's first prize has. The premium model reads the same
# numbers from `main.LOTTERY_PRIZE_DIGITS`, and these two must agree — they are the
# two halves of one contract (what is written, and what is modelled).
PRIZE_DIGITS: dict[str, int] = {"laos": 6, "vietnam": 5}

ALL_WEEKDAYS = frozenset(range(7))  # Monday=0 .. Sunday=6

# Which weekdays each lottery draws on. Lao draws are Monday to Friday, checked
# against the dated archive rather than assumed: Kapook listed 1, 2, 5, 6, 7, 8, 9,
# 12 and 13 Oct 2026 — Thursday, Friday, Monday, Tuesday, Wednesday, Thursday,
# Friday, Monday, Tuesday — one result per date and nothing on a weekend.
#
# Vietnam's XSMB is drawn every day. Note the station: the northern lottery runs
# daily, but the **Hanoi** (Thủ đô) station issues the Monday and Thursday draws,
# which is why `lottery_type` is the ledger `vietnam` rather than `hanoi`.
DRAW_WEEKDAYS: dict[str, frozenset[int]] = {
    "laos": frozenset(range(5)),  # Monday .. Friday
    "vietnam": ALL_WEEKDAYS,
}

# The routine window: two weeks back from today. Long enough to cover a missed run,
# a result published late and a corrected result, short enough that the daily job is
# ~14 requests rather than thousands.
DEFAULT_LOOKBACK_DAYS = 14

# Politeness floor between requests, matching scraper.py's. These are small sites
# and one page per draw date adds up.
DEFAULT_MIN_INTERVAL = 1.5

# Kapook in the Buddhist era, xosodaiphat in the common era. Named because mixing
# them up produces a *valid* page for the wrong date, which is the failure this
# whole script is most exposed to.
BUDDHIST_ERA_OFFSET = 543

KAPOOK_BASE = "https://lottery.kapook.com"
KAPOOK_LAO_DRAW_PATH = "/laolottery/{ddmmyyyy}"

XSMB_BASE = "https://xosodaiphat.com"
XSMB_DRAW_PATH = "/xsmb-{dd}-{mm}-{yyyy}.html"

# The Lao prize labels, as Kapook writes them. The 6-digit block is the first
# prize; the 2-digit tail is the published เลขท้าย 2 ตัว.
LAO_FIRST_LABEL = "เลข 6 ตัว"
LAO_BOTTOM_TWO_LABEL = "เลขท้าย 2 ตัว"

# XSMB's date in the page heading, e.g. "XSMB 13/10, Xổ Số Miền Bắc Ngày 13/10/2026".
XSMB_DATE_PATTERN = re.compile(r"Ngày\s*(\d{1,2})/(\d{1,2})/(\d{4})")

# The table's CHECK constraints, duplicated here on purpose: a row that fails them
# is rejected by PostgreSQL *after* the whole batch has been sent, so catching it
# locally keeps one bad row from failing the other 199 in the batch.
FIRST_PRIZE_PATTERN = re.compile(r"^[0-9]{5,6}$")
BOTTOM_TWO_PATTERN = re.compile(r"^[0-9]{2}$")


# ---------------------------------------------------------------------------
# The row
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InternationalDraw:
    """One draw, already validated against the table's shape.

    Constructing this is the validation step: :meth:`__post_init__` refuses a row
    that PostgreSQL would refuse, and refuses a Lao row whose published 2-digit
    tail disagrees with its own first prize. Nothing downstream re-checks the
    values, because there is no way to hold an invalid one.
    """

    lottery_type: str
    draw_date: date
    first_prize: str
    bottom_two: str
    source_url: str

    def __post_init__(self) -> None:
        if self.lottery_type not in PRIZE_DIGITS:
            raise ValueError(
                f"unknown lottery_type {self.lottery_type!r}; expected one of "
                f"{LOTTERY_TYPES}"
            )
        expected = PRIZE_DIGITS[self.lottery_type]
        if not FIRST_PRIZE_PATTERN.fullmatch(self.first_prize):
            raise ValueError(
                f"{self.lottery_type} {self.draw_date}: first_prize "
                f"{self.first_prize!r} is not digits"
            )
        if len(self.first_prize) != expected:
            raise ValueError(
                f"{self.lottery_type} {self.draw_date}: first_prize "
                f"{self.first_prize!r} is not {expected} digits"
            )
        if not BOTTOM_TWO_PATTERN.fullmatch(self.bottom_two):
            raise ValueError(
                f"{self.lottery_type} {self.draw_date}: bottom_two "
                f"{self.bottom_two!r} is not 2 digits"
            )

    @property
    def key(self) -> tuple[str, str]:
        """The table's natural key, used for de-duplication within a run."""
        return (self.lottery_type, self.draw_date.isoformat())

    def as_row(self) -> dict[str, str]:
        """The five columns the upsert writes, and no others."""
        return {
            "lottery_type": self.lottery_type,
            "draw_date": self.draw_date.isoformat(),
            "first_prize": self.first_prize,
            "bottom_two": self.bottom_two,
        }


# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------


def lao_draw_url(when: date) -> str:
    """Kapook's URL for one Lao draw.

    The year is the **Buddhist** one: 2026-10-13 is ``13102569``, not
    ``13102026``. Requesting the common-era spelling returns Kapook's homepage,
    which this parser reads as "no draw" — so the arithmetic here is what stands
    between a silent empty ledger and a correct one.
    """
    be_year = when.year + BUDDHIST_ERA_OFFSET
    stamp = f"{when.day:02d}{when.month:02d}{be_year}"
    return f"{KAPOOK_BASE}{KAPOOK_LAO_DRAW_PATH.format(ddmmyyyy=stamp)}"


def xsmb_draw_url(when: date) -> str:
    """xosodaiphat's URL for one XSMB draw, in the common era."""
    stamp = XSMB_DRAW_PATH.format(
        dd=f"{when.day:02d}", mm=f"{when.month:02d}", yyyy=when.year
    )
    return f"{XSMB_BASE}{stamp}"


def draw_url(kind: str, when: date) -> str:
    if kind == "laos":
        return lao_draw_url(when)
    if kind == "vietnam":
        return xsmb_draw_url(when)
    raise ValueError(f"unknown lottery_type {kind!r}; expected one of {LOTTERY_TYPES}")


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------


def _labelled_blocks(soup: BeautifulSoup) -> dict[str, str]:
    """Kapook's Lao result blocks, keyed by their Thai label.

    Read generically rather than by position: the page publishes 6-, 4-, 3- and
    2-digit blocks in that order today, and a label-keyed read does not care if
    that order or that set changes.
    """
    blocks: dict[str, str] = {}
    for block in soup.select(".laolottery-result-blocks .result-block"):
        label = block.find(["h4", "h3", "span", "p"])
        number = block.select_one(".result-num")
        if label is None or number is None:
            continue
        key = " ".join(label.get_text(" ", strip=True).split())
        blocks[key] = number.get_text(strip=True)
    return blocks


def parse_lao_html(
    html: str, expected: date, source_url: str
) -> tuple[InternationalDraw | None, str]:
    """Parse one Kapook Lao draw page. Returns ``(draw, reason)``.

    ``reason`` is empty on success and explains the skip otherwise. A page with no
    ``.win-6`` is **not** an error: Kapook serves its homepage, with HTTP 200, for a
    date that had no draw, so that is the expected answer for a Saturday and the
    caller treats it as "nothing on this date" rather than as a failure.
    """
    soup = BeautifulSoup(html, "html.parser")

    heading = soup.find("h1")
    heading_text = " ".join(heading.get_text(" ", strip=True).split()) if heading else ""
    page_date = parse_thai_date(heading_text) if heading_text else None

    # The whole script's reason for existing is writing the right number under the
    # right date, and a date-addressable source can still serve the wrong date (a
    # redirect, a cached page, a rewritten URL scheme). Where the page states its own
    # date, it must agree; where it does not, the row is refused rather than guessed,
    # because "probably the date we asked for" is not good enough for an immutable
    # ledger.
    if page_date is None:
        # What an **undrawn** date looks like here: Kapook answers with its homepage,
        # which has a heading and no draw date in it. Reported as a skip rather than
        # an error because that is the ordinary state of every future date.
        return None, (
            f"{source_url}: no Thai draw date in the page heading — undrawn date, or "
            "Kapook served its homepage"
        )
    if page_date != expected:
        return None, (
            f"{source_url}: page is dated {page_date.isoformat()} but "
            f"{expected.isoformat()} was requested"
        )

    blocks = _labelled_blocks(soup)
    first_prize = clean_number(blocks.get(LAO_FIRST_LABEL), 6)
    if first_prize is None:
        return None, (
            f"{source_url}: no usable {LAO_FIRST_LABEL!r} block (got "
            f"{blocks.get(LAO_FIRST_LABEL)!r}) — treated as no draw on this date"
        )

    published_two = clean_number(blocks.get(LAO_BOTTOM_TWO_LABEL), 2)
    derived_two = first_prize[-2:]
    if published_two is None:
        return None, (
            f"{source_url}: no usable {LAO_BOTTOM_TWO_LABEL!r} block to check the "
            f"2-digit prize against (got {blocks.get(LAO_BOTTOM_TWO_LABEL)!r})"
        )
    if published_two != derived_two:
        # Laos publishes the tail of the first prize, so these agree on every real
        # draw. A disagreement means one of the two cells was mis-read — and
        # guessing which would write a wrong number into the ledger.
        return None, (
            f"{source_url}: published 2-digit prize {published_two} is not the tail "
            f"of the first prize {first_prize} — refusing the row"
        )

    try:
        draw = InternationalDraw(
            lottery_type="laos",
            draw_date=expected,
            first_prize=first_prize,
            bottom_two=published_two,
            source_url=source_url,
        )
    except ValueError as exc:
        return None, f"{source_url}: {exc}"
    return draw, ""


def parse_xsmb_html(
    html: str, expected: date, source_url: str
) -> tuple[InternationalDraw | None, str]:
    """Parse one xosodaiphat XSMB page. Returns ``(draw, reason)``.

    The special prize is five digits and is stored as five. A page with no
    ``.special-prize-lg`` is the answer for a date that has not been drawn yet, so
    it is reported as a skip rather than raised as an error.
    """
    soup = BeautifulSoup(html, "html.parser")

    heading = soup.find("h1")
    heading_text = " ".join(heading.get_text(" ", strip=True).split()) if heading else ""
    match = XSMB_DATE_PATTERN.search(heading_text)
    if match is None:
        return None, f"{source_url}: no date in the page heading to verify against"
    page_date = date(int(match.group(3)), int(match.group(2)), int(match.group(1)))
    if page_date != expected:
        return None, (
            f"{source_url}: page is dated {page_date.isoformat()} but "
            f"{expected.isoformat()} was requested"
        )

    # A date that has not been drawn yet renders the page with an **empty** special
    # prize cell, so "no prize" arrives two ways: the cell absent, or the cell
    # present and blank. Both mean the same thing to this script and both are
    # skips, but only when the cell really is empty — a cell holding the wrong
    # shape is a format change and is reported as one.
    node = soup.select_one(".special-prize-lg")
    raw = node.get_text(strip=True) if node is not None else ""
    if not raw:
        return None, f"{source_url}: no special prize on the page — not drawn yet"

    # Exactly five digits, and this is asserted rather than trimmed: xosodaiphat
    # prefixes the cell with the ticket-series ("Mã ĐB") markup, so a six-digit read
    # would mean the selector has begun matching something else.
    first_prize = clean_number(raw, PRIZE_DIGITS["vietnam"])
    if first_prize is None:
        return None, (
            f"{source_url}: special prize {raw!r} is not "
            f"{PRIZE_DIGITS['vietnam']} digits"
        )

    try:
        draw = InternationalDraw(
            lottery_type="vietnam",
            draw_date=expected,
            first_prize=first_prize,
            # Vietnam's đề: the last two digits of the special prize, by rule. There
            # is no separately drawn 2-digit prize for this lottery to read instead.
            bottom_two=first_prize[-2:],
            source_url=source_url,
        )
    except ValueError as exc:
        return None, f"{source_url}: {exc}"
    return draw, ""


def parse_draw_html(
    kind: str, html: str, expected: date, source_url: str
) -> tuple[InternationalDraw | None, str]:
    if kind == "laos":
        return parse_lao_html(html, expected, source_url)
    if kind == "vietnam":
        return parse_xsmb_html(html, expected, source_url)
    raise ValueError(f"unknown lottery_type {kind!r}; expected one of {LOTTERY_TYPES}")


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------


def draw_days(kind: str, *, all_days: bool = False) -> frozenset[int]:
    """Which weekdays this lottery draws on, 0=Monday.

    ``all_days`` widens it to the whole week, which is the override for a backfill
    if a source's schedule has changed since it was measured.
    """
    if all_days:
        return ALL_WEEKDAYS
    return DRAW_WEEKDAYS[kind]


def candidate_dates(
    kind: str, start: date, end: date, *, all_days: bool = False
) -> list[date]:
    """The draw dates to try in ``[start, end]``, oldest first.

    Weekends are dropped for Laos because it does not draw on them, which is worth
    ~29% of the requests on a long backfill for no lost rows. A weekend draw would
    be missed by this filter, which is why ``--all-days`` exists rather than the
    assumption being buried.
    """
    allowed = draw_days(kind, all_days=all_days)
    span = (end - start).days
    return [
        start + timedelta(days=offset)
        for offset in range(span + 1)
        if (start + timedelta(days=offset)).weekday() in allowed
    ]


def _pace(last_request_at: list[float], min_interval: float) -> None:
    """Sleep so two requests are at least ``min_interval`` apart.

    The same politeness floor ``scraper.py`` applies, for the same reason: these
    are small sites and a date walk is many requests from one host.
    """
    if min_interval <= 0:
        return
    elapsed = time.monotonic() - last_request_at[0]
    if elapsed < min_interval:
        time.sleep(min_interval - elapsed)
    last_request_at[0] = time.monotonic()


def collect(
    session: requests.Session,
    kind: str,
    dates: Iterable[date],
    *,
    min_interval: float = DEFAULT_MIN_INTERVAL,
) -> tuple[list[InternationalDraw], list[str], int]:
    """Fetch every candidate date, returning ``(draws, notes, requests_made)``.

    A date that has no draw is a **note**, not a failure and not a row: the caller
    can tell "this source is answering and there is nothing on that date" from "the
    source is unreachable" (which raises) and from "the page did not look like we
    expect" (which is also a note, but a loud one).
    """
    draws: list[InternationalDraw] = []
    notes: list[str] = []
    last_request_at = [0.0]
    requests_made = 0

    for when in dates:
        url = draw_url(kind, when)
        _pace(last_request_at, min_interval)
        requests_made += 1
        # `fetch_url` retries 429/5xx with backoff and raises ScrapeError when every
        # attempt failed. That propagates: an unreachable source must fail the run
        # rather than report a clean, empty ledger for a country nobody read.
        html = fetch_url(session, url)

        if html is None:
            notes.append(f"{when.isoformat()} {kind}: HTTP 404 — no draw page")
            continue

        draw, reason = parse_draw_html(kind, html, when, url)
        if draw is None:
            notes.append(f"{when.isoformat()} {kind}: {reason}")
            continue

        draws.append(draw)
        log.info("  %s %s -> %s", draw.draw_date, kind, draw.first_prize)

    return draws, notes, requests_made


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def dedupe_rows(
    rows: Sequence[dict[str, str]],
) -> tuple[list[dict[str, str]], int]:
    """Collapse rows sharing ``(lottery_type, draw_date)``, keeping the last.

    Required, not cosmetic: PostgreSQL refuses an ``INSERT ... ON CONFLICT DO
    UPDATE`` that touches the same conflict target twice (``cannot affect row a
    second time``, SQLSTATE 21000), so a duplicate key inside one batch fails the
    whole batch. ``scraper.py`` de-duplicates on ``draw_date`` alone because every
    row it writes is Thai; this one has to key on the pair, or a Lao and a
    Vietnamese draw on the same date would collapse into each other.
    """
    by_key: dict[tuple[str, str], dict[str, str]] = {}
    for row in rows:
        by_key[(row["lottery_type"], row["draw_date"])] = row
    kept = [by_key[key] for key in sorted(by_key)]
    return kept, len(rows) - len(kept)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scrape_international.py",
        description="Ingest Lao and Vietnamese (Hanoi) draw results into Supabase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "The default window is the last "
            f"{DEFAULT_LOOKBACK_DAYS} days, which is what the scheduled job runs.\n"
            "Both sources are addressed one draw date at a time, so deep history is\n"
            "an explicit --from/--to run rather than the default.\n"
        ),
    )
    parser.add_argument(
        "--type",
        choices=(*LOTTERY_TYPES, "all"),
        default="all",
        help="which ledger to ingest (default: all of them)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help=(
            "how many days back from --to (or today) to walk "
            f"(default: {DEFAULT_LOOKBACK_DAYS})"
        ),
    )
    parser.add_argument("--from", dest="start", help="first draw date, YYYY-MM-DD")
    parser.add_argument("--to", dest="end", help="last draw date, YYYY-MM-DD")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and validate, write nothing",
    )
    parser.add_argument(
        "--all-days",
        action="store_true",
        help=(
            "try every calendar date instead of the lottery's draw days "
            "(use for a backfill if a source's schedule has changed)"
        ),
    )
    parser.add_argument(
        "--min-interval",
        type=float,
        default=DEFAULT_MIN_INTERVAL,
        help=f"seconds between requests (default: {DEFAULT_MIN_INTERVAL})",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="debug logging")
    return parser


def _parse_iso(value: str | None, flag: str) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise SystemExit(f"{flag} must be YYYY-MM-DD, got {value!r}") from exc


def _resolve_window(args: argparse.Namespace) -> tuple[date, date]:
    end = _parse_iso(args.end, "--to") or date.today()
    start = _parse_iso(args.start, "--from") or end - timedelta(days=args.days)
    if start > end:
        raise SystemExit(f"--from {start} is after --to {end}")
    return start, end


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.days < 1 and args.start is None:
        raise SystemExit("--days must be at least 1")

    kinds = LOTTERY_TYPES if args.type == "all" else (args.type,)
    start, end = _resolve_window(args)

    session = build_session()
    draws: list[InternationalDraw] = []
    notes: list[str] = []
    planned = 0

    for kind in kinds:
        dates = candidate_dates(kind, start, end, all_days=args.all_days)
        planned += len(dates)
        log.info(
            "%s: %d draw date(s) in %s -> %s",
            kind,
            len(dates),
            start.isoformat(),
            end.isoformat(),
        )
        collected, kind_notes, _ = collect(
            session, kind, dates, min_interval=args.min_interval
        )
        draws.extend(collected)
        notes.extend(kind_notes)

    log.info(
        "Collected %d draw(s) from %d candidate date(s); %d date(s) had no draw.",
        len(draws),
        planned,
        len(notes),
    )
    for note in notes[:20]:
        log.info("  skipped: %s", note)
    if len(notes) > 20:
        log.info("  ... and %d more skipped date(s).", len(notes) - 20)

    if not draws:
        # Zero rows across a whole window is not "nothing new", it is a broken
        # source or a window with no draw days in it. The job must fail loudly:
        # a scraper that reports success while writing nothing is worse than one
        # that fails, because nothing alerts on it.
        log.error("No draws collected from any source — refusing to report success.")
        return 1

    if args.dry_run:
        for draw in sorted(draws, key=lambda item: item.key):
            log.info(
                "DRY RUN %s %s first_prize=%s bottom_two=%s",
                draw.lottery_type,
                draw.draw_date,
                draw.first_prize,
                draw.bottom_two,
            )
        log.info("Dry run: %d row(s) validated, nothing written.", len(draws))
        return 0

    rows, dropped = dedupe_rows([draw.as_row() for draw in draws])
    if dropped:
        log.info("Collapsed %d duplicate key(s) before writing.", dropped)

    try:
        client = create_supabase_client()
    except IngestionError as exc:
        log.error("Could not build a Supabase client: %s", exc)
        return 1

    try:
        written = upsert_rows(client, rows)
    except IngestionError as exc:
        log.error("%s", exc)
        return 1

    log.info("Wrote %d row(s) into lottery_draws.", written)
    return 0


if __name__ == "__main__":
    sys.exit(main())
