"""SuperHeng — GLO draw ingestion engine.

Scrapes/fetches historical Thai Government Lottery (GLO) results and upserts them
into the Supabase ``lottery_draws`` table, keyed on ``draw_date``, so re-running is
safe and never duplicates a draw.

Four sources, because they fail in different ways
-------------------------------------------------
``archive``  **Sanook's paginated HTML history — the bulk path.**

             ``https://news.sanook.com/lotto/archive/page/{n}/`` renders one
             ``<article class="archive--lotto">`` per draw, ~20 draws to a page,
             each carrying the draw date, รางวัลที่ 1 (6 digits) and the
             separately drawn เลขท้าย 2 ตัว (2 digits).

             Measured against the live site on 2026-10-13: **24 pages**, page 1
             starting at 2026-10-01 and page 24 ending at 2006-12-30 — about 20
             years of history. A 10-year backfill therefore needs ~13 requests
             instead of the ~240 an equivalent per-date walk would cost.

             Two further reasons to prefer it over probing draw dates:

             * It enumerates the draws that *actually happened* instead of
               assuming the 1st/16th schedule. The draws GLO moved off schedule
               (2025-01-02 and 2025-01-17 are both real, both present in the
               archive) come along for free.
             * It reports the *official* เลขท้าย 2 ตัว, which is separately drawn
               and is **not** the trailing digits of the first prize.

``glo``      The official GLO JSON API (``www.glo.or.th``), via
             ``data_ingestion.GLOClient``. Authoritative and returns the whole
             prize structure, but costs one request per draw date, so it is used
             as a targeted/authoritative check rather than the bulk backfill.

``sanook``   Per-draw Sanook pages (``/lotto/check/{DDMMYYYY_BE}/``), parsed with
             requests + BeautifulSoup. One request per date.

Whatever the source, every row is validated (6-digit first prize, 2-digit
separately drawn prize) and a later draw that merely repeats an earlier draw's
exact prize numbers is dropped — see :func:`drop_repeated_prize_pairs` for the
live defect that rule was written from.

``myhora``   Per-draw pages from an **independent** archive, used to fill holes in
             Sanook's (see :func:`find_missing_draw_dates`), not as a bulk source:
             it is addressed one draw at a time, so a full 20-year crawl through it
             would be ~470 requests against the ~13 the archive needs. It exists
             because Sanook is provably incomplete — it is missing 2007-12-01.

``auto``     Try ``archive``, fall back to ``glo``, fall back to ``sanook``. The
             default. Each fallback is logged with the reason, so a run never
             silently reports "no data" when only one source was reachable. Add
             ``--fill-gaps`` to then probe Myhora for any draw the spacing says is
             missing.

Scope note
----------
This script writes three columns: ``draw_date``, ``first_prize`` (รางวัลที่ 1,
6 digits) and ``bottom_two`` (เลขท้าย 2 ตัว, 2 digits). It deliberately does not
write the derived "trailing digits of the first prize": GLO draws its 2- and
3-digit prizes separately, so conflating them would corrupt the historical ledger
the models are trained on.

Usage (from the ``backend`` directory)::

    .venv/Scripts/python scraper.py --dry-run                    # fetch + validate, no writes
    .venv/Scripts/python scraper.py                              # 10-year backfill (default window)
    .venv/Scripts/python scraper.py --from 2016-01-01 --to 2026-10-01
    .venv/Scripts/python scraper.py --source archive --from 2006-01-01 --fill-gaps
    .venv/Scripts/python scraper.py --source archive --latest
    .venv/Scripts/python scraper.py --source glo --from 2024-01-01 --to 2024-12-31
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable, Sequence

import requests
from bs4 import BeautifulSoup
from bs4.element import Tag
from dotenv import load_dotenv

from data_ingestion import (
    DrawRecord,
    GLOClient,
    GLOError,
    generate_candidate_dates,
)

load_dotenv(Path(__file__).with_name(".env"))

log = logging.getLogger("superheng.scraper")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

TABLE_NAME = "lottery_draws"
CONFLICT_TARGET = "draw_date"

SANOOK_BASE = "https://news.sanook.com"
SANOOK_CHECK_PATH = "/lotto/check/{ddmmyyyy}/"
SANOOK_ARCHIVE_PATH = "/lotto/archive/"
SANOOK_ARCHIVE_PAGE_PATH = "/lotto/archive/page/{page}/"

# Myhora addresses draws the same way Sanook's per-draw pages do — the Buddhist
# calendar — and it is used as an independent second archive for gap filling.
MYHORA_BASE = "https://myhora.com"
MYHORA_DRAW_PATH = "/lottery/result-{day:02d}-{month:02d}-{year_be}.aspx"

DEFAULT_TIMEOUT = (10.0, 30.0)  # (connect, read) seconds
DEFAULT_MIN_INTERVAL = 1.5  # polite floor between archive requests, seconds
DEFAULT_MAX_RETRIES = 4
BACKOFF_BASE = 1.0
BACKOFF_CAP = 30.0
RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})

DEFAULT_LOOKBACK_DAYS = 45  # how far back `--latest` searches (per-date sources)
DEFAULT_WINDOW_RADIUS = 1  # days either side of a scheduled draw day
DEFAULT_BACKFILL_YEARS = 10  # the required historical depth

# The backfill window is widened by this much, and it is not padding.
#
# The requirement is "at least 10 years of history", and a bare 10-calendar-year
# window does not deliver that: draws happen roughly every 15 days, so the window
# opens between two draws and its first collected draw lands a fortnight LATER
# than the window start. Measured: a window opening 2016-10-13 produced data
# starting 2016-10-16, a span of 9.96 years — just under the requirement.
#
# Widening by the largest gap ever observed between consecutive draws (45 days,
# the COVID-19 suspension gap of 2020-04-01 -> 2020-05-16) guarantees the window
# contains a draw at or before `today - 10 years`, so the collected span is at
# least 10 full years by construction rather than by luck.
DEFAULT_BACKFILL_MARGIN_DAYS = 45

# A gap between two consecutive collected draws wider than this means at least
# one draw is unaccounted for. Calibrated from the data, not chosen: across 470
# consecutive draws the ordinary gaps are 12-18 days, and every genuine
# missing-draw hole shows up at 30 days or more. 20 sits in the empty band
# between the two.
DEFAULT_GAP_THRESHOLD_DAYS = 20

# Calendar days GLO has actually drawn on. The 1st and 16th are the schedule; the
# 2nd and 17th are the one-day moves it makes (January's Teachers' Day draw, 2
# May), and the 30th is the New Year draw that replaces early January. Measured
# across 2023-2026, every move was exactly one day and nothing appeared on any
# other day, so this set covers the whole observed schedule without probing 365
# dates.
DRAW_DAY_CANDIDATES = frozenset({1, 2, 16, 17, 30})

# The 30th is only ever a December draw (the New Year one), so it is offered for
# December alone. Offering it in every month would probe 30 November, 30 April and
# so on for nothing.
DRAW_NEW_YEAR_MONTH = 12

BATCH_SIZE = 200

# Safety stop. The archive currently ends at page 24 and a page past the end
# returns zero draw blocks, which stops the walk on its own; this only guards
# against a redirect loop or a pagination bug turning into an endless crawl.
MAX_ARCHIVE_PAGES = 500

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)

# GLO's own prize-group cardinalities. Verified against four real draws
# (2024-03-01, 2024-03-16, 2025-09-16, 2026-10-01) — all matched. A change here
# means GLO restructured the prize set, which invalidates the ledger, so it is
# treated as drift rather than ignored.
EXPECTED_GROUP_SIZES: dict[str, int] = {
    "first": 1,
    "second": 5,
    "third": 10,
    "fourth": 50,
    "fifth": 100,
    "near1": 2,
    "last3f": 2,
    "last3b": 2,
    "last2": 1,
}

BUDDHIST_ERA_OFFSET = 543

# ---------------------------------------------------------------------------
# Sanook archive selectors
# ---------------------------------------------------------------------------
# Verified against the live page on 2026-10-13. Each draw is one <article>:
#
#   <article class="archive--lotto">
#     <a href=".../lotto/check/01102569/">
#       <time class="archive--lotto__date" datetime="2026-10-01">
#         1 <small class="archive--lotto__month">ต.ค.</small>
#       </time>
#       <div class="archive--lotto__detail">
#         <h3 class="archive--lotto__head-lot">ตรวจหวย 1 ตุลาคม 2569</h3>
#         <ul class="archive--lotto__result-list">
#           <li><em class="archive--lotto__result-txt">…รางวัลที่ 1</em>
#               <strong class="archive--lotto__result-number">402701</strong></li>
#           …
#           <li><em class="archive--lotto__result-txt">…เลขท้าย 2 ตัว</em>
#               <strong class="archive--lotto__result-number">70</strong></li>
#         </ul>
#       </div>
#     </a>
#   </article>
_SEL_ARCHIVE_ARTICLE = "article.archive--lotto"
_SEL_ARCHIVE_TIME = "time.archive--lotto__date"
_SEL_ARCHIVE_HEAD = "h3.archive--lotto__head-lot"
_SEL_ARCHIVE_RESULT_ITEM = "ul.archive--lotto__result-list li"
_SEL_ARCHIVE_RESULT_LABEL = "em.archive--lotto__result-txt"
_SEL_ARCHIVE_RESULT_NUMBER = "strong.archive--lotto__result-number"

# Prize labels, whitespace-stripped for comparison so that "เลขท้าย 2 ตัว" and
# "เลขท้าย2ตัว" both match. Matching is `in`, so "เลขท้าย 3 ตัว" cannot satisfy
# the 2-digit label (it lacks the "2"), which is the distinction that matters.
_LABEL_FIRST = "รางวัลที่1"
_LABEL_LAST2 = "เลขท้าย2ตัว"

# The draw date encoded in the per-draw link, e.g. .../lotto/check/01102569/ is
# 01/10/BE 2569. Sanook has used this Buddhist-era convention for years, so it is
# a second, machine-readable date signal to cross-check the page text against.
_HREF_DATE_PATTERN = re.compile(r"/lotto/check/(?P<day>\d{2})(?P<month>\d{2})(?P<year>\d{4})/")

# ---------------------------------------------------------------------------
# Thai calendar tables
# ---------------------------------------------------------------------------

# Full names, the common short forms, the dotted abbreviations the sites actually
# render, and the un-dotted variants that survive whitespace stripping.
_THAI_MONTH_ALIASES: tuple[tuple[int, tuple[str, ...]], ...] = (
    (1, ("มกราคม", "มกรา", "ม.ค.", "มค")),
    (2, ("กุมภาพันธ์", "กุมภา", "ก.พ.", "กพ")),
    (3, ("มีนาคม", "มีนา", "มี.ค.", "มีค")),
    (4, ("เมษายน", "เมษา", "เม.ย.", "เมย")),
    (5, ("พฤษภาคม", "พฤษภา", "พ.ค.", "พค")),
    (6, ("มิถุนายน", "มิถุนา", "มิ.ย.", "มิย")),
    (7, ("กรกฎาคม", "กรกฎา", "ก.ค.", "กค")),
    (8, ("สิงหาคม", "สิงหา", "ส.ค.", "สค")),
    (9, ("กันยายน", "กันยา", "ก.ย.", "กย")),
    (10, ("ตุลาคม", "ตุลา", "ต.ค.", "ตค")),
    (11, ("พฤศจิกายน", "พฤศจิกา", "พ.ย.", "พย")),
    (12, ("ธันวาคม", "ธันวา", "ธ.ค.", "ธค")),
)


def _month_key(text: str) -> str:
    """Normalise a month token: drop dots and every kind of space."""
    return re.sub(r"[\s\u00a0\u200b.]+", "", text or "")


_THAI_MONTH_INDEX: dict[str, int] = {
    _month_key(alias): number for number, aliases in _THAI_MONTH_ALIASES for alias in aliases
}

# Thai digits ๐-๙ -> ASCII. Thai pages occasionally render prizes in Thai
# numerals; without this they would be rejected as non-numeric.
_THAI_DIGITS = str.maketrans("๐๑๒๓๔๕๖๗๘๙", "0123456789")

# "day month [year]" — the Thai convention, and the only order these sources use.
_MONTH_PATTERN = re.compile(r"(?P<day>\d{1,2})\s*(?P<month>[ก-๙.]+)\s*(?P<year>\d{2,4})?")


class ScrapeError(RuntimeError):
    """Raised when a source responds but its content cannot be trusted."""


class IngestionError(RuntimeError):
    """Raised when the database write fails."""


# ---------------------------------------------------------------------------
# Normalised row
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScrapedDraw:
    """One draw, reduced to exactly the columns the ``lottery_draws`` table has.

    ``source`` is provenance metadata — it is logged and reported, but never
    written, because the table has no such column.
    """

    draw_date: str  # ISO-8601, e.g. "2025-09-16"
    first_prize: str  # 6 digits, zero-padded
    bottom_two: str  # 2 digits, zero-padded
    source: str

    def as_row(self) -> dict[str, str]:
        return {
            "draw_date": self.draw_date,
            "first_prize": self.first_prize,
            "bottom_two": self.bottom_two,
        }


# ---------------------------------------------------------------------------
# Number cleaning and validation
# ---------------------------------------------------------------------------


def clean_number(raw: Any, length: int) -> str | None:
    """Return `raw` as exactly `length` ASCII digits, or None if it is not that.

    Cleaning is deliberately narrow, because the table's CHECK constraints accept
    only ``^[0-9]{6}$`` / ``^[0-9]{2}$`` and a value that fails here would be
    rejected by PostgreSQL anyway:

    * Thai numerals are transliterated to ASCII (๐๑๒๓๔๕๖๗๘๙ -> 0123456789).
    * Thousands separators and all whitespace forms (including NBSP and
      zero-width spaces) are stripped, so ``"1,234,567"`` and ``"040 123"``
      normalise.
    * Anything else — letters, a shorter or longer run of digits, an empty cell —
      returns None, and the caller skips the row rather than guessing a padding.

    Nothing is zero-padded here: a 1-digit 2-digit-prize cell is a *different*
    number to the site's 2-digit one, and inventing the leading zero would write a
    plausible-looking wrong value into an immutable ledger.
    """
    text = str(raw if raw is not None else "").translate(_THAI_DIGITS)
    text = re.sub(r"[\s\u00a0\u200b,]+", "", text)
    if not re.fullmatch(r"[0-9]+", text):
        return None
    if len(text) != length:
        return None
    return text


def _require_digits(value: Any, length: int, field_name: str, context: str) -> str:
    """Return `value` as a digit string of exactly `length`, or raise."""
    cleaned = clean_number(value, length)
    if cleaned is None:
        raise ScrapeError(
            f"{context}: {field_name}={value!r} is not exactly {length} digits"
        )
    return cleaned


def validate_draw(draw: ScrapedDraw) -> ScrapedDraw:
    """Assert the row matches the table's CHECK constraints before we send it."""
    context = f"draw {draw.draw_date} ({draw.source})"
    try:
        date.fromisoformat(draw.draw_date)
    except ValueError as exc:
        raise ScrapeError(f"{context}: draw_date={draw.draw_date!r} is not ISO-8601") from exc
    _require_digits(draw.first_prize, 6, "first_prize", context)
    _require_digits(draw.bottom_two, 2, "bottom_two", context)
    return draw


def assert_glo_integrity(record: DrawRecord) -> list[str]:
    """Check a full GLO record against the documented prize structure.

    Returns a list of human-readable problems; empty means the record is intact.
    A non-empty result is drift, and drift means the ledger is suspect.
    """
    problems: list[str] = []
    prizes = record.as_dict()["prizes"]

    for name, expected in EXPECTED_GROUP_SIZES.items():
        numbers = prizes.get(name, {}).get("numbers") or []
        if len(numbers) != expected:
            problems.append(f"{name}: expected {expected} number(s), got {len(numbers)}")

    first = record.first_number
    if first is None or len(first) != 6:
        problems.append(f"first prize: expected 6 digits, got {first!r}")
    last2 = record.official_last2
    if last2 is None or len(last2) != 2:
        problems.append(f"last2 prize: expected 2 digits, got {last2!r}")

    return problems


# ---------------------------------------------------------------------------
# Thai date parsing
# ---------------------------------------------------------------------------


def to_ce_year(year: int, *, ce_hint: bool = False) -> int | None:
    """Convert a Thai-format year to a Gregorian (CE) year, or None if unsure.

    Three cases, in the order a reader would resolve them:

    * **4-digit Buddhist era** (``2569``) — the overwhelmingly common form.
      Subtract 543.
    * **4-digit Gregorian** (``2026``) — already CE; returned unchanged. Both
      are 4-digit, so the 2400 floor is what separates them.
    * **2-digit Buddhist era** (``69``) — the short form Thai sites use in
      headers. Resolved against the current BE century, i.e. ``25xx``, which
      covers BE 2500-2599 / CE 1957-2056. A 2-digit CE year would be ambiguous
      with a 2-digit BE year, so it is only accepted when ``ce_hint`` says the
      text explicitly marked the year as ค.ศ. (CE).
    """
    if ce_hint:
        return year if 1900 <= year <= 2100 else None
    if 2400 <= year <= 2699:  # 4-digit BE
        return year - BUDDHIST_ERA_OFFSET
    if 1900 <= year <= 2100:  # already CE
        return year
    if 0 <= year <= 99:  # 2-digit BE, resolved against the 25xx century
        return (2500 + year) - BUDDHIST_ERA_OFFSET
    return None


def thai_month_number(token: str) -> int | None:
    """Map a Thai month name or abbreviation to its 1-12 number."""
    return _THAI_MONTH_INDEX.get(_month_key(token))


def parse_thai_date(text: str, *, default_year: int | None = None) -> date | None:
    """Parse a Thai-calendar date into a ``datetime.date``, or None.

    Handles the forms these sources actually publish::

        "1 ตุลาคม 2569"     -> 2026-10-01   full month name, 4-digit BE year
        "16 กันยายน 2569"   -> 2026-09-16
        "30 ธันวาคม 2549"   -> 2006-12-30
        "1 พ.ย. 69"         -> 2026-11-01   dotted abbreviation, 2-digit BE year
        "1 ต.ค."            -> needs default_year (see below)
        "1 มีนาคม 2026"     -> 2026-03-01   4-digit CE year, no subtraction

    ``default_year`` supplies the year when the text omits one — which is exactly
    the Sanook archive's visible cell, ``1 ต.ค.``. Callers pass the year they read
    from the machine-readable ``datetime`` attribute or the link URL, so the
    abbreviated form is still resolved exactly rather than guessed. Without a
    default, a year-less date returns None instead of assuming the current year.

    Returns None rather than raising for anything unparseable, at any stage:
    an unknown month token, an implausible year, or an impossible day (31 Feb).
    The caller decides whether that means "skip this row" or "this page has no
    draw", and those are different answers.
    """
    if not text:
        return None

    # Normalise before matching: Thai numerals, NBSP, and every whitespace form.
    flat = str(text).translate(_THAI_DIGITS)
    flat = re.sub(r"[\s\u00a0\u200b]+", " ", flat).strip()
    ce_hint = "คศ" in _month_key(flat)  # "ค.ศ."

    for match in _MONTH_PATTERN.finditer(flat):
        month_number = thai_month_number(match.group("month"))
        if month_number is None:
            continue  # a Thai run that is not a month, e.g. "ตรวจหวย"

        raw_year = match.group("year")
        if raw_year is None:
            if default_year is None:
                continue  # a real date with no year at all: unresolvable here
            year = int(default_year)
        else:
            year = int(raw_year)

        ce_year = to_ce_year(year, ce_hint=ce_hint)
        if ce_year is None:
            continue

        try:
            return date(ce_year, month_number, int(match.group("day")))
        except ValueError:
            return None  # e.g. 31 Feb — the row is malformed, not merely year-less

    return None


def years_before(when: date, years: int) -> date:
    """`when` minus `years` calendar years, clamped for 29 February."""
    try:
        return when.replace(year=when.year - years)
    except ValueError:  # 29 Feb in a non-leap target year
        return when.replace(year=when.year - years, day=28)


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class _RetryableStatus(Exception):
    def __init__(self, status: int, retry_after: str | None = None) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status
        self.retry_after = retry_after


def build_session() -> requests.Session:
    """A plain session: retries are handled explicitly so the two layers cannot
    double-multiply into a request storm."""
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "th,en-US;q=0.9,en;q=0.8",
        }
    )
    return session


def _decode(response: requests.Response) -> str:
    """Decode a response, forcing UTF-8 when the server omitted a charset.

    Sanook serves UTF-8; requests sometimes guesses ISO-8859-1, which would
    mangle every Thai label the parser keys on.
    """
    if not response.encoding or response.encoding.lower() in ("iso-8859-1", "latin-1"):
        response.encoding = response.apparent_encoding or "utf-8"
    return response.text


def fetch_url(
    session: requests.Session,
    url: str,
    *,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> str | None:
    """GET a URL with exponential backoff **with jitter**.

    Returns the body, or None for a 404 (meaning "this page does not exist").
    Raises ScrapeError when every attempt failed. Retrying on 429/5xx is safe
    here because GET is idempotent; jitter matters because a single-threaded
    client that retries on a fixed curve synchronises with a rate limiter
    instead of backing off from it.
    """
    last_error = "unknown error"

    for attempt in range(1, max_retries + 1):
        try:
            response = session.get(url, timeout=timeout)

            if response.status_code == 404:
                return None
            if response.status_code in RETRYABLE_STATUS:
                raise _RetryableStatus(response.status_code, response.headers.get("Retry-After"))
            response.raise_for_status()
            return _decode(response)

        except requests.Timeout as exc:
            last_error = f"timeout after {timeout[1]}s"
            log.warning("%s attempt %d/%d failed: %s", url, attempt, max_retries, last_error)
            cause: Exception = exc
        except requests.ConnectionError as exc:
            last_error = f"connection error ({exc.__class__.__name__})"
            log.warning("%s attempt %d/%d failed: %s", url, attempt, max_retries, last_error)
            cause = exc
        except _RetryableStatus as exc:
            last_error = str(exc)
            cause = exc
            log.warning("%s attempt %d/%d failed: %s", url, attempt, max_retries, last_error)
            # Honour Retry-After when the server states one.
            if exc.retry_after:
                try:
                    time.sleep(min(float(exc.retry_after), BACKOFF_CAP))
                except ValueError:
                    pass
        except requests.HTTPError as exc:
            # 4xx other than 404/429 will not improve on retry.
            raise ScrapeError(f"GET {url} failed: {exc}") from exc

        if attempt < max_retries:
            delay = min(BACKOFF_CAP, BACKOFF_BASE * (2 ** (attempt - 1)))
            delay += random.uniform(0, delay / 2)  # full jitter on the backoff
            log.debug("sleeping %.2fs before retry", delay)
            time.sleep(delay)

    raise ScrapeError(f"GET {url} failed after {max_retries} attempts: {last_error}")


def _pace(last_request_at: list[float], min_interval: float) -> None:
    """Sleep so requests are at least `min_interval` apart."""
    if min_interval <= 0:
        return
    elapsed = time.monotonic() - last_request_at[0]
    if elapsed < min_interval:
        time.sleep(min_interval - elapsed)
    last_request_at[0] = time.monotonic()


# ---------------------------------------------------------------------------
# Source 1 — Sanook HTML archive (the bulk path)
# ---------------------------------------------------------------------------


def sanook_archive_url(page: int = 1) -> str:
    """URL of one archive listing page. Page 1 has no `/page/` segment."""
    if page <= 1:
        return f"{SANOOK_BASE}{SANOOK_ARCHIVE_PATH}"
    return f"{SANOOK_BASE}{SANOOK_ARCHIVE_PAGE_PATH.format(page=page)}"


def _squash(text: str) -> str:
    """Collapse all whitespace — Thai labels are inconsistently spaced."""
    return re.sub(r"[\s\u00a0\u200b]+", "", text or "")


def _date_from_href(href: str | None) -> date | None:
    """Read the draw date out of a ``/lotto/check/DDMMYYYY_BE/`` link."""
    if not href:
        return None
    match = _HREF_DATE_PATTERN.search(href)
    if not match:
        return None
    ce_year = to_ce_year(int(match.group("year")))
    if ce_year is None:
        return None
    try:
        return date(ce_year, int(match.group("month")), int(match.group("day")))
    except ValueError:
        return None


def _date_from_time_element(soup: BeautifulSoup | Tag) -> date | None:
    """Read the machine-readable date from every ``<time datetime=...>``.

    Prefers the archive's own ``time.archive--lotto__date`` when present; falls
    back to any ``<time>`` on the page, which is what the per-draw source needs.
    """
    preferred = soup.select_one(_SEL_ARCHIVE_TIME) if isinstance(soup, Tag) else None
    for tag in ([preferred] if preferred is not None else []) + soup.find_all("time"):
        raw = (tag.get("datetime") or "").strip()
        if not raw:
            continue
        candidate = raw.split(" ")[0].split("T")[0]
        try:
            return date.fromisoformat(candidate)
        except ValueError:
            continue
    return None


def parse_archive_article(article: Tag) -> tuple[ScrapedDraw | None, str]:
    """Parse one ``<article class="archive--lotto">`` block.

    Returns ``(draw, "")`` on success or ``(None, reason)`` when the block cannot
    be trusted. A reason rather than an exception, because one malformed block
    must not abort a 24-page crawl — but it must also not be silently dropped, so
    the caller logs and counts it.

    The date is read from up to four independent signals and they are required to
    agree. Sanook publishes the draw date four times over — as an ISO ``datetime``
    attribute, inside the per-draw link (in the Buddhist calendar), in the Thai
    heading text, and as an abbreviated Thai cell (``1 ต.ค.``) — so a mismatch
    means the page is misaligned and the row is unsafe, not merely odd.
    """
    heading = article.select_one(_SEL_ARCHIVE_HEAD)
    link = article.find("a", href=_HREF_DATE_PATTERN)

    signals: dict[str, date] = {}

    iso_date = _date_from_time_element(article)
    if iso_date is not None:
        signals["datetime attribute"] = iso_date

    href_date = _date_from_href(link.get("href") if link else None)
    if href_date is not None:
        signals["draw link"] = href_date

    if heading is not None:
        heading_date = parse_thai_date(heading.get_text(" ", strip=True))
        if heading_date is not None:
            signals["Thai heading"] = heading_date

    # The visible abbreviated cell ("1 ต.ค.") carries no year, so it is resolved
    # against a year read elsewhere on the block. That is the whole point of
    # supporting a default: it turns a year-less abbreviation into an exact date.
    time_tag = article.select_one(_SEL_ARCHIVE_TIME)
    if time_tag is not None:
        year_source = signals.get("draw link") or signals.get("datetime attribute")
        default_year = None
        if year_source is not None:
            default_year = year_source.year + BUDDHIST_ERA_OFFSET  # back to BE for the parser
        abbrev_date = parse_thai_date(
            time_tag.get_text(" ", strip=True), default_year=default_year
        )
        if abbrev_date is not None:
            signals["abbreviated cell"] = abbrev_date

    if not signals:
        return None, "could not read a draw date from any of the four date signals"

    distinct = set(signals.values())
    if len(distinct) > 1:
        rendered = ", ".join(f"{name}={value.isoformat()}" for name, value in signals.items())
        return None, f"date signals disagree ({rendered})"

    draw_date = distinct.pop()
    context = f"draw {draw_date.isoformat()} (archive)"

    numbers: dict[str, list[str]] = {}
    for item in article.select(_SEL_ARCHIVE_RESULT_ITEM):
        label_el = item.select_one(_SEL_ARCHIVE_RESULT_LABEL)
        if label_el is None:
            continue
        label = _squash(label_el.get_text())
        values = item.select(_SEL_ARCHIVE_RESULT_NUMBER)
        if not values:
            continue
        if _LABEL_FIRST in label and _LABEL_FIRST not in numbers:
            numbers[_LABEL_FIRST] = [el.get_text(" ", strip=True) for el in values]
        elif _LABEL_LAST2 in label and _LABEL_LAST2 not in numbers:
            numbers[_LABEL_LAST2] = [el.get_text(" ", strip=True) for el in values]

    if _LABEL_FIRST not in numbers:
        return None, f"{context}: no '{_LABEL_FIRST}' prize cell"

    if len(numbers[_LABEL_FIRST]) != 1:
        return None, (
            f"{context}: expected exactly one 1st-prize number, "
            f"found {len(numbers[_LABEL_FIRST])}"
        )

    if _LABEL_LAST2 not in numbers:
        return None, f"{context}: no '{_LABEL_LAST2}' prize cell"

    if len(numbers[_LABEL_LAST2]) != 1:
        return None, (
            f"{context}: expected exactly one 2-digit prize, found {len(numbers[_LABEL_LAST2])}"
        )

    first_prize = clean_number(numbers[_LABEL_FIRST][0], 6)
    if first_prize is None:
        return None, f"{context}: 1st prize {numbers[_LABEL_FIRST][0]!r} is not 6 digits"

    bottom_two = clean_number(numbers[_LABEL_LAST2][0], 2)
    if bottom_two is None:
        return None, f"{context}: 2-digit prize {numbers[_LABEL_LAST2][0]!r} is not 2 digits"

    return ScrapedDraw(
        draw_date=draw_date.isoformat(),
        first_prize=first_prize,
        bottom_two=bottom_two,
        source="sanook-archive",
    ), ""


@dataclass(frozen=True)
class ArchivePage:
    """The outcome of parsing one archive listing page."""

    page: int
    draws: list[ScrapedDraw]
    skipped: list[str]  # human-readable reason per unparseable draw block
    last_page: int | None  # as advertised by the page's own pagination

    @property
    def oldest(self) -> date | None:
        return min((date.fromisoformat(d.draw_date) for d in self.draws), default=None)

    @property
    def newest(self) -> date | None:
        return max((date.fromisoformat(d.draw_date) for d in self.draws), default=None)


def _archive_last_page(soup: BeautifulSoup) -> int | None:
    """The highest page number the archive's own pagination links to."""
    numbers = [
        int(match)
        for match in re.findall(r"/lotto/archive/page/(\d+)/", str(soup))
    ]
    return max(numbers) if numbers else None


def parse_sanook_archive_page(html: str, *, page: int = 1) -> ArchivePage:
    """Parse one archive listing page into draws, skipping unusable blocks."""
    soup = BeautifulSoup(html, "html.parser")
    articles = soup.select(_SEL_ARCHIVE_ARTICLE)

    draws: list[ScrapedDraw] = []
    skipped: list[str] = []

    for index, article in enumerate(articles, start=1):
        draw, problem = parse_archive_article(article)
        if draw is None:
            reason = f"page {page} block {index}: {problem}"
            log.warning("SKIPPED %s", reason)
            skipped.append(reason)
            continue
        draws.append(draw)

    return ArchivePage(
        page=page,
        draws=draws,
        skipped=skipped,
        last_page=_archive_last_page(soup),
    )


def collect_sanook_archive(
    start: date,
    end: date,
    *,
    first_page: int = 1,
    max_pages: int | None = None,
    min_interval: float = DEFAULT_MIN_INTERVAL,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
    session: requests.Session | None = None,
) -> Collection:
    """Walk the archive pages from newest to oldest, collecting the window.

    The archive is ordered newest-first, so the walk starts at page 1 and stops
    at whichever comes first:

    * a page that renders no draw blocks at all (past the end of the archive —
      Sanook answers those with HTTP 200 and an empty body, not a 404, so the
      content, not the status, is what terminates the crawl);
    * a page whose oldest draw predates `start` (the window has been passed);
    * `max_pages`, when the caller wants a bounded run.

    Draws outside ``[start, end]`` are filtered out, not counted as failures:
    walking into the window legitimately passes over newer draws than requested.
    """
    owned = session is None
    session = session or build_session()
    result = Collection(draws=[], missing=[], failures=[], skipped=[])
    clock = [time.monotonic()]
    page = max(1, first_page)
    pages_read = 0
    advertised_last: int | None = None
    stopped_because = "exhausted"

    try:
        while page <= MAX_ARCHIVE_PAGES:
            if max_pages is not None and pages_read >= max_pages:
                stopped_because = f"page cap ({max_pages})"
                break

            url = sanook_archive_url(page)
            _pace(clock, min_interval)

            try:
                html = fetch_url(session, url, timeout=timeout, max_retries=max_retries)
            except ScrapeError as exc:
                log.error("FAILED %s: %s", url, exc)
                result.failures.append((url, str(exc)))
                stopped_because = "request failure"
                break

            if html is None:
                stopped_because = f"HTTP 404 at page {page}"
                break

            parsed = parse_sanook_archive_page(html, page=page)
            pages_read += 1
            # Only trust the pagination of a page that actually held draws. Past
            # the end, Sanook returns an empty shell whose pager still links to
            # itself, which would otherwise advertise one page more than exists.
            if parsed.draws:
                advertised_last = parsed.last_page or advertised_last
            result.skipped.extend(parsed.skipped)

            if not parsed.draws and not parsed.skipped:
                stopped_because = f"page {page} had no draw blocks"
                break

            in_window = [
                draw
                for draw in parsed.draws
                if start <= date.fromisoformat(draw.draw_date) <= end
            ]
            result.draws.extend(in_window)
            log.info(
                "  page %d: %d/%d draw(s) in window (page range %s -> %s)",
                page,
                len(in_window),
                len(parsed.draws),
                parsed.oldest.isoformat() if parsed.oldest else "?",
                parsed.newest.isoformat() if parsed.newest else "?",
            )

            oldest = parsed.oldest
            if oldest is not None and oldest < start:
                stopped_because = f"page {page} reached past {start.isoformat()}"
                break

            page += 1
    finally:
        if owned:
            session.close()

    if advertised_last is not None:
        log.info(
            "Archive advertises %d page(s); read %d this run (%s).",
            advertised_last,
            pages_read,
            stopped_because,
        )
    return result


# ---------------------------------------------------------------------------
# Source 2 — official GLO JSON API
# ---------------------------------------------------------------------------


def draw_from_glo(record: DrawRecord) -> ScrapedDraw:
    """Reduce a full GLO record to the three stored columns."""
    problems = assert_glo_integrity(record)
    if problems:
        joined = "; ".join(problems)
        raise ScrapeError(f"GLO record for {record.draw_date} failed integrity checks: {joined}")

    return validate_draw(
        ScrapedDraw(
            draw_date=record.draw_date,
            first_prize=record.first_number or "",
            bottom_two=record.official_last2 or "",
            source="glo",
        )
    )


def collect_glo(
    dates: Iterable[date],
    *,
    cache_dir: Path | None = None,
    use_cache: bool = True,
    min_interval: float = DEFAULT_MIN_INTERVAL,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> Collection:
    """Walk candidate dates over the official API, using ``data_ingestion``."""
    result = Collection(draws=[], missing=[], failures=[], skipped=[])
    client = GLOClient(
        timeout=timeout,
        min_interval=min_interval,
        max_retries=max_retries,
        cache_dir=cache_dir,
        use_cache=use_cache,
    )

    try:
        candidates = list(dates)
        for index, when in enumerate(candidates, start=1):
            try:
                record = client.fetch_by_date(when)
            except GLOError as exc:
                log.error("FAILED %s: %s", when, exc)
                result.failures.append((when.isoformat(), str(exc)))
                continue
            except Exception as exc:  # noqa: BLE001 - isolate per date
                log.exception("Unexpected error for %s", when)
                result.failures.append((when.isoformat(), f"unexpected: {exc}"))
                continue

            if record is None:
                result.missing.append(when.isoformat())
            else:
                try:
                    result.draws.append(draw_from_glo(record))
                    log.debug("  %s -> %s", record.draw_date, record.first_number)
                except ScrapeError as exc:
                    log.error("INTEGRITY %s: %s", when, exc)
                    result.failures.append((when.isoformat(), str(exc)))

            if index % 20 == 0 or index == len(candidates):
                log.info("  %d/%d dates processed", index, len(candidates))
    finally:
        client.close()

    return result


# ---------------------------------------------------------------------------
# Source 3 — Sanook per-draw HTML
# ---------------------------------------------------------------------------


def sanook_url(when: date) -> str:
    """Build the per-draw URL.

    Sanook addresses draws in the Buddhist calendar: 2025-09-16 -> ``16092568``
    (the trailing ``2568`` is 2025 + 543). Getting this wrong returns a 404 for
    every date, which looks identical to "no draw", so it is easy to misdiagnose.
    """
    ddmmyyyy = f"{when.day:02d}{when.month:02d}{when.year + BUDDHIST_ERA_OFFSET}"
    return f"{SANOOK_BASE}{SANOOK_CHECK_PATH.format(ddmmyyyy=ddmmyyyy)}"


def _date_from_thai_text(text: str) -> date | None:
    """Parse a Thai-calendar date out of free text, e.g. a page title.

    Delegates to :func:`parse_thai_date`, which also handles the dotted
    abbreviations and 2-digit Buddhist years this helper used to miss.
    """
    return parse_thai_date(text)


def _collect_prize_columns(soup: BeautifulSoup) -> dict[str, list[str]]:
    """Map a whitespace-normalised Thai prize label to the numbers under it."""
    columns: dict[str, list[str]] = {}
    for column in soup.select("div.lottocheck__column"):
        label_el = column.select_one("span.default-font--reward")
        if label_el is None:
            continue
        label = _squash(label_el.get_text())
        numbers = [el.get_text(strip=True) for el in column.select("strong.lotto__number")]
        if label and numbers:
            columns.setdefault(label, []).extend(numbers)
    return columns


def parse_sanook_html(html: str, expected: date) -> ScrapedDraw | None:
    """Parse one Sanook per-draw page.

    Returns a ScrapedDraw, or None when the page is simply not a draw-result
    page (a 404 body, or a date with no draw).

    Raises ScrapeError when the page *is* a result page but cannot be trusted —
    a missing first prize on a page that has a prize table, a prize that is not
    the right shape, or a page describing a different draw than the one
    requested. Those are structural changes, not empty dates, and failing
    loudly is the point: silently skipping them would look like a sparse
    archive while the parser was actually broken.
    """
    soup = BeautifulSoup(html, "html.parser")
    body_classes = soup.body.get("class") if soup.body else None
    is_result_page = bool(soup.select_one("div.lottocheck__table")) or "lottocheck" in (
        body_classes or []
    )
    if not is_result_page:
        log.debug("%s: not a draw-result page (no result table).", expected)
        return None

    columns = _collect_prize_columns(soup)

    first_el = soup.select_one("strong.lotto__number--first")
    if first_el is None:
        raise ScrapeError(
            f"page for {expected} has a prize table but no 1st-prize element "
            "('strong.lotto__number--first') — the markup has likely changed"
        )
    first_prize = first_el.get_text(strip=True)

    # Cross-check against the labelled column so a single stray span cannot
    # supply the first prize.
    labelled_first = columns.get(_LABEL_FIRST) or []
    if labelled_first and labelled_first[0] != first_prize:
        raise ScrapeError(
            f"page for {expected} disagrees with itself about the 1st prize: "
            f"'{first_prize}' vs labelled '{labelled_first[0]}'"
        )

    bottom_numbers = columns.get(_LABEL_LAST2) or []
    if len(bottom_numbers) != 1:
        raise ScrapeError(
            f"page for {expected}: expected exactly one 'เลขท้าย 2 ตัว' prize, "
            f"found {len(bottom_numbers)} ({bottom_numbers!r})"
        )
    bottom_two = bottom_numbers[0]

    # Date: prefer the machine-readable <time>, fall back to the Thai title.
    observed = _date_from_time_element(soup)
    if observed is None:
        observed = _date_from_thai_text(soup.title.get_text() if soup.title else "")

    if observed is None:
        log.warning(
            "%s: could not read a draw date from the page; trusting the requested "
            "URL date. Verify this row if the source is ever restructured.",
            expected,
        )
    elif observed != expected:
        raise ScrapeError(
            f"requested {expected} but the page reports {observed} — refusing to "
            "write a draw under the wrong date"
        )

    return validate_draw(
        ScrapedDraw(
            draw_date=expected.isoformat(),
            first_prize=first_prize,
            bottom_two=bottom_two,
            source="sanook",
        )
    )


def scrape_one_sanook(
    session: requests.Session,
    when: date,
    *,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> ScrapedDraw | None:
    """Fetch and parse a single draw date from Sanook."""
    url = sanook_url(when)
    html = fetch_url(session, url, timeout=timeout, max_retries=max_retries)
    if html is None:
        log.debug("%s: 404 — no draw page for this date.", when)
        return None
    return parse_sanook_html(html, when)


def collect_sanook(
    dates: Iterable[date],
    *,
    min_interval: float = DEFAULT_MIN_INTERVAL,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
    session: requests.Session | None = None,
) -> Collection:
    """Walk candidate dates over the HTML archive, isolating per-date failures."""
    owned = session is None
    session = session or build_session()
    result = Collection(draws=[], missing=[], failures=[], skipped=[])
    candidates = list(dates)
    clock = [time.monotonic()]

    try:
        for index, when in enumerate(candidates, start=1):
            _pace(clock, min_interval)
            try:
                draw = scrape_one_sanook(session, when, timeout=timeout, max_retries=max_retries)
            except ScrapeError as exc:
                log.error("FAILED %s: %s", when, exc)
                result.failures.append((when.isoformat(), str(exc)))
                continue
            except Exception as exc:  # noqa: BLE001 - one bad date must not end the run
                log.exception("Unexpected error for %s", when)
                result.failures.append((when.isoformat(), f"unexpected: {exc}"))
                continue

            if draw is None:
                result.missing.append(when.isoformat())
            else:
                result.draws.append(draw)
                log.debug("  %s -> %s", draw.draw_date, draw.first_prize)

            if index % 20 == 0 or index == len(candidates):
                log.info("  %d/%d dates processed", index, len(candidates))
    finally:
        if owned:
            session.close()

    return result


# ---------------------------------------------------------------------------
# Source 4 — Myhora per-draw pages (gap fill)
# ---------------------------------------------------------------------------


def myhora_url(when: date) -> str:
    """Build the Myhora per-draw URL, which is addressed in the Buddhist era."""
    return f"{MYHORA_BASE}{MYHORA_DRAW_PATH.format(day=when.day, month=when.month, year_be=when.year + BUDDHIST_ERA_OFFSET)}"


def _myhora_result_blocks(soup: BeautifulSoup) -> list[list[str]]:
    """The text of every non-empty result block, in document order."""
    blocks: list[list[str]] = []
    for block in soup.select("div.lot-dr"):
        cells = [el.get_text(" ", strip=True) for el in block.select("div.lot-dc")]
        if any(cells):
            blocks.append(cells)
    return blocks


def _block_holds(cells: Sequence[str], first_prize: str, bottom_two: str) -> bool:
    """Whether one block carries both of the prizes, each as an exact-width cell."""
    return any(clean_number(cell, 6) == first_prize for cell in cells) and any(
        clean_number(cell, 2) == bottom_two for cell in cells
    )


def parse_myhora_html(html: str, expected: date) -> ScrapedDraw | None:
    """Parse one Myhora draw page.

    Returns a ScrapedDraw, or None when Myhora simply has no draw for that date.
    The two cases are cleanly distinguishable, which was verified against dates
    GLO confirms had no draw (the COVID suspensions): a *no-draw* page is HTTP 200
    with an **empty** meta description, an empty ``<title>`` date and empty cells.
    Anything that looks like a result page but cannot be read raises
    :class:`ScrapeError` instead — that is structural drift, not an empty date.

    The numbers are read from two independent places and must agree: the meta
    description (``รางวัลที่ 1 (113410) … เลขท้าย 2 ตัว(18)``) and the visible
    result block. A page that contradicts itself is not written.

    That cross-check is deliberately *not* positional. Myhora renders six
    ``div.lot-dr`` blocks per page — the featured draw, then a sidebar of
    neighbouring draws, with the featured draw often appearing twice — so "the
    last 2-digit cell on the page" belongs to some *other* draw. On the live
    2007-12-01 page that cell is ``88`` (a 2008 draw), while the page's own draw is
    ``18``. The check therefore asks whether **some** block carries the exact pair
    the description states, which is true only of the draw the page is about.
    """
    soup = BeautifulSoup(html, "html.parser")

    meta = soup.find("meta", attrs={"name": re.compile(r"^description$", re.I)})
    description = (meta.get("content") or "").strip() if meta else ""
    title_text = soup.title.get_text(" ", strip=True) if soup.title else ""
    blocks = _myhora_result_blocks(soup)

    if not description and not blocks:
        log.debug("%s: Myhora has no draw page for this date.", expected)
        return None

    # Date: the page states it in its own title, in the Buddhist calendar. A
    # result page that will not say which draw it is must not be trusted.
    observed = parse_thai_date(title_text) or parse_thai_date(description)
    if observed is None:
        raise ScrapeError(
            f"Myhora page for {expected} looks like a result page but states no "
            "readable draw date — the markup has likely changed"
        )
    if observed != expected:
        raise ScrapeError(
            f"requested {expected} from Myhora but the page reports {observed} — "
            "refusing to write a draw under the wrong date"
        )

    context = f"draw {expected} (myhora)"

    desc_first = re.search(r"รางวัลที่\s*1\s*\(\s*([0-9]{6})\s*\)", description)
    desc_last2 = re.search(r"เลขท้าย\s*2\s*ตัว\s*\(\s*([0-9]{1,2})\s*\)", description)
    if desc_first is None or desc_last2 is None:
        raise ScrapeError(
            f"{context}: the meta description does not carry both prizes "
            f"(first={bool(desc_first)}, last2={bool(desc_last2)})"
        )

    first_prize = clean_number(desc_first.group(1), 6)
    bottom_two = clean_number(desc_last2.group(1), 2)
    if first_prize is None:
        raise ScrapeError(f"{context}: 1st prize {desc_first.group(1)!r} is not 6 digits")
    if bottom_two is None:
        raise ScrapeError(f"{context}: 2-digit prize {desc_last2.group(1)!r} is not 2 digits")

    # Corroborate: at least one block must carry BOTH numbers from the
    # description. Neighbouring-draw blocks cannot, so this picks out the draw the
    # page is about without depending on where it sits in the document.
    if not blocks:
        log.warning(
            "%s: no result block found; trusting the meta description alone.", context
        )
    elif not any(_block_holds(cells, first_prize, bottom_two) for cells in blocks):
        raise ScrapeError(
            f"{context}: no result block carries {first_prize}/{bottom_two}, so the "
            f"description and the page disagree (blocks: {blocks[:2]})"
        )

    return validate_draw(
        ScrapedDraw(
            draw_date=expected.isoformat(),
            first_prize=first_prize,
            bottom_two=bottom_two,
            source="myhora",
        )
    )


def scrape_one_myhora(
    session: requests.Session,
    when: date,
    *,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
) -> ScrapedDraw | None:
    """Fetch and parse a single draw date from Myhora."""
    html = fetch_url(session, myhora_url(when), timeout=timeout, max_retries=max_retries)
    if html is None:
        log.debug("%s: Myhora returned 404 — no draw page for this date.", when)
        return None
    return parse_myhora_html(html, when)


def collect_myhora(
    dates: Iterable[date],
    *,
    min_interval: float = DEFAULT_MIN_INTERVAL,
    timeout: tuple[float, float] = DEFAULT_TIMEOUT,
    max_retries: int = DEFAULT_MAX_RETRIES,
    session: requests.Session | None = None,
) -> Collection:
    """Probe specific dates against Myhora, isolating per-date failures."""
    owned = session is None
    session = session or build_session()
    result = Collection(draws=[], missing=[], failures=[], skipped=[])
    candidates = list(dates)
    clock = [time.monotonic()]

    try:
        for when in candidates:
            _pace(clock, min_interval)
            try:
                draw = scrape_one_myhora(session, when, timeout=timeout, max_retries=max_retries)
            except ScrapeError as exc:
                log.error("FAILED %s: %s", when, exc)
                result.failures.append((when.isoformat(), str(exc)))
                continue
            except Exception as exc:  # noqa: BLE001 - one bad date must not end the run
                log.exception("Unexpected error for %s", when)
                result.failures.append((when.isoformat(), f"unexpected: {exc}"))
                continue

            if draw is None:
                result.missing.append(when.isoformat())
            else:
                result.draws.append(draw)
                log.info("  gap filled: %s -> %s / %s", draw.draw_date, draw.first_prize, draw.bottom_two)
    finally:
        if owned:
            session.close()

    return result


def find_missing_draw_dates(
    draws: Sequence[ScrapedDraw],
    *,
    threshold_days: int = DEFAULT_GAP_THRESHOLD_DAYS,
) -> list[date]:
    """Dates a second source should be asked about, inferred from the spacing.

    Where a run shows a gap wider than ``threshold_days``, at least one draw is
    unaccounted for. The candidate days inside that gap are taken from GLO's
    observed draw-day set, so the tool does not need to be told where the hole is.

    Found a real hole this way: the Sanook archive jumps straight from 2007-11-16
    to 2007-12-16, omitting **2007-12-01** entirely — and its per-draw page for
    that date does not exist either. Myhora serves it as first prize ``113410``
    and agrees with Sanook on both neighbours, so the omission is the archive's,
    not a gap in the draw schedule.

    The 2020 COVID suspension (2020-04-01 -> 2020-06-01) is caught by the same
    test and correctly yields nothing: every candidate inside it is probed and
    every one is confirmed to have no draw. Detecting a gap is not the same as
    assuming one, which is why absence is verified rather than filled.

    One filter is applied to keep the probes honest: **the day after a draw we
    already hold is never offered**. A one-day move *replaces* its slot, so if the
    16th is collected the 17th cannot also be a separate draw. Without that rule,
    2007 would be probed at 17 November as well as at 1 December, and the real
    candidate would be buried among spurious ones.
    """
    ordered = sorted(date.fromisoformat(draw.draw_date) for draw in draws)
    collected = set(ordered)
    candidates: list[date] = []

    for earlier, later in zip(ordered, ordered[1:]):
        if (later - earlier).days <= threshold_days:
            continue
        for month in _months_between(earlier, later):
            for day in _candidate_days_in(month):
                try:
                    candidate = month.replace(day=day)
                except ValueError:
                    continue
                if not (earlier < candidate < later):
                    continue
                if candidate in collected:
                    continue
                if (candidate - timedelta(days=1)) in collected:
                    continue  # a move replaces its slot, it never follows it
                candidates.append(candidate)

    return candidates


def _months_between(earlier: date, later: date) -> list[date]:
    """First-of-month dates spanning the gap, inclusively."""
    months: list[date] = []
    cursor = date(earlier.year, earlier.month, 1)
    while cursor <= later:
        months.append(cursor)
        cursor = date(cursor.year + (cursor.month // 12), (cursor.month % 12) + 1, 1)
    return months


def _candidate_days_in(month_start: date) -> list[int]:
    """Plausible draw days within one month, newest-day-last."""
    days = [1, 2, 16, 17]
    if month_start.month == DRAW_NEW_YEAR_MONTH:
        days.append(30)
    return days


# ---------------------------------------------------------------------------
# Collection bookkeeping
# ---------------------------------------------------------------------------


@dataclass
class Collection:
    """Outcome of walking a source.

    ``missing`` is only meaningful for the per-date sources, which have to ask
    about every scheduled date and can therefore learn that one had no draw. The
    archive enumerates draws directly, so it reports no ``missing`` — a date it
    never saw is a page it never reached, which is a different fact.
    """

    draws: list[ScrapedDraw]
    missing: list[str]  # dates the source positively reported as having no draw
    failures: list[tuple[str, str]]  # (key, reason)
    skipped: list[str] = field(default_factory=list)  # malformed rows, skipped by design

    @property
    def ok(self) -> bool:
        return bool(self.draws)


def expand_window(scheduled: Iterable[date], radius: int) -> list[date]:
    """Widen each scheduled draw day into a +/-``radius`` window.

    Measured rather than assumed. Probing GLO live across 2023-2026 showed the
    mid-month draw moves to the **17th** every January (Teachers' Day) and the
    start-of-month draw to the **2nd** in some months, while most months are on
    schedule. Every move observed was exactly **one day**; nothing turned up at
    +/-2 or +/-3. A fixed 1st/16th probe therefore misses real draws outright -
    January 2025 and January 2026 each have a draw on the 2nd that the bare
    schedule never visits.

    Expanding the *already-special-aware* schedule by one day covers every
    observed move for a fraction of the cost of probing all 365 days. Note that
    the archive source does not need this at all: it lists the draws that
    happened, moved or not.
    """
    if radius <= 0:
        return sorted(set(scheduled))
    widened: set[date] = set()
    for when in scheduled:
        for delta in range(-radius, radius + 1):
            widened.add(when + timedelta(days=delta))
    return sorted(widened)


def merge_results(primary: Collection, secondary: Collection) -> Collection:
    """Combine two runs over the same dates, as used by the ``auto`` fallback.

    A draw is **positive evidence and always wins**. A source that produced no
    draws is a source that failed; it must not be allowed to veto dates that the
    other source resolved successfully. Getting this backwards makes the
    fallback silently useless — the dead API's "no draw" verdicts would filter
    out every real draw the HTML archive found, and the run would report zero
    rows while both sources were reached.

    Failures are likewise dropped for any date the secondary resolved, so a
    fully successful fallback is not reported as a failed run (which would also
    wrongly trip ``--strict``).
    """
    resolved_by_secondary = {d.draw_date for d in secondary.draws} | set(secondary.missing)

    draws_by_date: dict[str, ScrapedDraw] = {d.draw_date: d for d in secondary.draws}
    draws_by_date.update({d.draw_date: d for d in primary.draws})  # primary wins ties
    resolved = set(draws_by_date)

    # Report "no draw" only for dates neither source turned into a draw.
    missing = sorted((set(primary.missing) | set(secondary.missing)) - resolved)

    failures = [
        (when, reason) for when, reason in primary.failures if when not in resolved_by_secondary
    ] + secondary.failures

    return Collection(
        draws=[draws_by_date[key] for key in sorted(draws_by_date)],
        missing=missing,
        failures=failures,
        skipped=list(primary.skipped) + list(secondary.skipped),
    )


# ---------------------------------------------------------------------------
# Supabase
# ---------------------------------------------------------------------------


def drop_repeated_prize_pairs(
    draws: Sequence[ScrapedDraw],
) -> tuple[list[ScrapedDraw], list[str]]:
    """Drop a later draw that repeats an earlier draw's exact prize numbers.

    Not theoretical — this is a real defect in the archive, found by comparing a
    live 10-year scrape against the official API. Sanook publishes a page dated
    **2020-05-16** whose first prize is ``051095`` and whose 2-digit prize is
    ``22``: byte-identical to the **2020-04-01** draw. GLO agrees there was no
    draw on 2020-05-16 at all (``response: null``; COVID-19 suspended the 16 April
    and 2 May 2020 draws, leaving no draw between 1 April and 1 June 2020), and
    its own 2020-04-01 record is ``051095``. So the 2020-05-16 page is stale
    furniture carrying the previous draw's result.

    Writing it would insert a *second* row claiming a draw that never happened —
    a silent corruption of the historical ledger the models are trained on.

    Keeping the **earliest** date is the right resolution, because that is the
    date the authoritative source confirms, and a stale page can only ever be the
    later one. Two genuine draws sharing both a 6-digit first prize and the
    independently drawn 2-digit prize is roughly a 1-in-10^8 coincidence per
    pair; observed exactly once in 238 draws, it is far likelier to be a
    duplicated page than a real repeat.

    Returns ``(kept, skipped_reasons)``; the caller logs and counts the reasons.
    """
    kept: list[ScrapedDraw] = []
    skipped: list[str] = []
    seen: dict[tuple[str, str], str] = {}

    for draw in sorted(draws, key=lambda d: d.draw_date):
        key = (draw.first_prize, draw.bottom_two)
        first_date = seen.get(key)
        if first_date is None:
            seen[key] = draw.draw_date
            kept.append(draw)
            continue
        reason = (
            f"{draw.source} draw {draw.draw_date} repeats the prize numbers "
            f"{draw.first_prize}/{draw.bottom_two} already recorded for {first_date}"
        )
        log.warning("SKIPPED %s", reason)
        skipped.append(reason)

    return kept, skipped


def create_supabase_client() -> Any:
    """Build a Supabase client from the environment, or explain what is missing."""
    url = (os.getenv("SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_KEY") or "").strip()

    if not url or not key:
        raise IngestionError(
            "SUPABASE_URL and SUPABASE_KEY must both be set. "
            "Copy .env.example to .env and fill it in."
        )
    if "your-project-ref" in url or key.startswith("your-"):
        raise IngestionError(
            "SUPABASE_URL / SUPABASE_KEY still hold the .env.example placeholders."
        )

    try:
        from supabase import create_client

        return create_client(url, key)
    except Exception as exc:  # noqa: BLE001
        raise IngestionError(f"Could not create the Supabase client: {exc}") from exc


def dedupe(rows: Sequence[dict[str, str]]) -> tuple[list[dict[str, str]], int]:
    """Collapse rows sharing a draw_date, keeping the last.

    Required, not cosmetic: PostgreSQL rejects a single ``INSERT ... ON CONFLICT
    DO UPDATE`` statement that touches the same conflict target twice
    ("cannot affect row a second time", 21000). A duplicate draw_date in one
    batch would therefore fail the whole batch.
    """
    by_date: dict[str, dict[str, str]] = {}
    for row in rows:
        by_date[row["draw_date"]] = row
    dropped = len(rows) - len(by_date)
    return [by_date[k] for k in sorted(by_date)], dropped


def upsert_rows(
    client: Any,
    rows: Sequence[dict[str, str]],
    *,
    batch_size: int = BATCH_SIZE,
) -> int:
    """Upsert rows into ``lottery_draws``, keyed on ``draw_date``."""
    if not rows:
        log.warning("Nothing to upsert.")
        return 0

    written = 0
    for start in range(0, len(rows), batch_size):
        batch = list(rows[start : start + batch_size])
        try:
            response = (
                client.table(TABLE_NAME)
                .upsert(batch, on_conflict=CONFLICT_TARGET)
                .execute()
            )
        except Exception as exc:  # noqa: BLE001 - translate into actionable advice
            message = str(exc)
            if "row-level security" in message or "42501" in message:
                raise IngestionError(
                    "Supabase refused the write because of row-level security. "
                    "schema.sql grants SELECT to anon/authenticated but no write "
                    "policy, so ingestion needs the service_role key (see "
                    ".env.example). The anon key cannot insert."
                ) from exc
            if "42P10" in message or "no unique or exclusion constraint" in message:
                raise IngestionError(
                    "draw_date has no UNIQUE constraint, so ON CONFLICT cannot "
                    "target it. Run schema.sql against the project."
                ) from exc
            raise IngestionError(f"Supabase upsert failed: {message}") from exc

        # `return=representation` normally echoes the affected rows. An empty or
        # absent body is NOT evidence that nothing was written — it just means
        # PostgREST returned no representation. Counting it as 0 would badly
        # understate a successful run, so fall back to the number sent.
        returned = getattr(response, "data", None)
        if isinstance(returned, list) and returned:
            written += len(returned)
        else:
            log.debug("  no representation returned for this batch; counting rows sent")
            written += len(batch)
        log.info(
            "  upserted %d row(s) [%d/%d]",
            len(batch),
            min(start + batch_size, len(rows)),
            len(rows),
        )

    return written


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="scraper.py",
        description="Ingest Thai GLO draw results into Supabase.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python scraper.py --dry-run\n"
            "  python scraper.py --source archive --latest\n"
            "  python scraper.py --from 2016-01-01 --to 2026-10-01\n"
            "  python scraper.py --source glo --from 2024-01-01 --to 2024-03-31\n"
            "  python scraper.py --source sanook --from 2024-01-01 --to 2024-03-31\n"
        ),
    )
    parser.add_argument(
        "--source",
        choices=("auto", "archive", "glo", "sanook"),
        default="auto",
        help="archive = Sanook's paginated HTML history, ~20 draws per request "
        "(default path for a backfill); glo = the official JSON API, one request "
        "per date; sanook = per-draw HTML pages; "
        "auto = archive, then glo, then sanook (default)",
    )
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--latest", action="store_true", help="fetch only the most recent draw")
    scope.add_argument(
        "--from",
        dest="start",
        type=date.fromisoformat,
        metavar="YYYY-MM-DD",
        help=f"start of the window (default: {DEFAULT_BACKFILL_YEARS} years ago, "
        f"widened by {DEFAULT_BACKFILL_MARGIN_DAYS} days so the collected data "
        f"spans a full {DEFAULT_BACKFILL_YEARS} years)",
    )
    parser.add_argument(
        "--to",
        dest="end",
        type=date.fromisoformat,
        metavar="YYYY-MM-DD",
        help="end of the window (default: today)",
    )
    parser.add_argument(
        "--date-mode",
        choices=("draw-days", "draw-window", "all-days"),
        default="draw-window",
        help="candidate dates for the glo/sanook sources only; the archive "
        "enumerates draws directly. draw-days = the bare 1st/16th schedule plus "
        "known moved draws; draw-window = that schedule widened by --window-radius "
        "(default, and the only mode that catches the January 2nd draw); "
        "all-days = probe every date (exhaustive but ~30x the requests).",
    )
    parser.add_argument(
        "--window-radius",
        type=int,
        default=DEFAULT_WINDOW_RADIUS,
        help=f"days either side of each scheduled draw day for --date-mode draw-window "
        f"(default: {DEFAULT_WINDOW_RADIUS})",
    )
    parser.add_argument("--min-interval", type=float, default=DEFAULT_MIN_INTERVAL,
                        help=f"seconds between archive requests (default: {DEFAULT_MIN_INTERVAL})")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT[1],
                        help="read timeout in seconds (default: 30)")
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES,
                        help=f"max attempts per request (default: {DEFAULT_MAX_RETRIES})")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE,
                        help=f"rows per Supabase request (default: {BATCH_SIZE})")
    parser.add_argument("--archive-page", type=int, default=1,
                        help="first archive page to read (default: 1 = newest)")
    parser.add_argument("--max-pages", type=int, default=None,
                        help="stop after this many archive pages (default: walk until the "
                             "window is covered or the archive ends)")
    parser.add_argument("--fill-gaps", action="store_true",
                        help="after collecting, probe Myhora for any draw date the "
                             "collected spacing says is missing. Sanook's archive is "
                             "provably incomplete (it omits 2007-12-01), so a full "
                             "backfill wants this; a routine refresh does not.")
    parser.add_argument("--cache-dir", type=Path, default=None,
                        help="cache raw API responses here (GLO source only)")
    parser.add_argument("--no-cache", action="store_true", help="disable the API response cache")
    parser.add_argument("--dry-run", action="store_true",
                        help="fetch and validate, but never touch Supabase")
    parser.add_argument("--json-out", type=Path, default=None,
                        help="also write the collected rows to this JSON file")
    parser.add_argument("--strict", action="store_true",
                        help="exit non-zero if ANY individual date failed")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def _resolve_window(args: argparse.Namespace) -> tuple[date, date]:
    today = date.today()
    if args.latest:
        return today - timedelta(days=DEFAULT_LOOKBACK_DAYS), today
    # A calendar-year subtraction, not 365*n days: 3650 days is about 10 days
    # short of 10 real years once leap days are counted, and the requirement is
    # "at least 10 years".
    #
    # The margin covers the gap between the window opening and the first draw
    # inside it, so the collected *data* spans >= 10 years and not merely the
    # request. See DEFAULT_BACKFILL_MARGIN_DAYS.
    start = args.start or (
        years_before(today, DEFAULT_BACKFILL_YEARS) - timedelta(days=DEFAULT_BACKFILL_MARGIN_DAYS)
    )
    end = args.end or today
    return start, end


def _candidate_dates(args: argparse.Namespace, start: date, end: date) -> list[date]:
    """Scheduled draw dates to probe, for the per-date sources."""
    if args.date_mode == "all-days":
        candidates = list(generate_candidate_dates(start, end, mode="all-days"))
    else:
        scheduled = generate_candidate_dates(start, end, mode="draw-days")
        candidates = (
            expand_window(scheduled, args.window_radius)
            if args.date_mode == "draw-window"
            else sorted(set(scheduled))
        )
    if args.latest:
        candidates = list(reversed(candidates))
    return candidates


def _collect(args: argparse.Namespace, start: date, end: date, candidates: list[date]) -> Collection:
    """Run the requested source, with the auto fallback chain."""
    timeout = (min(10.0, args.timeout), args.timeout)
    archive_kwargs = dict(
        first_page=args.archive_page,
        max_pages=args.max_pages,
        min_interval=args.min_interval,
        timeout=timeout,
        max_retries=args.max_retries,
    )

    if args.source == "archive":
        return collect_sanook_archive(start, end, **archive_kwargs)

    if args.source == "glo":
        return collect_glo(
            candidates,
            cache_dir=args.cache_dir,
            use_cache=not args.no_cache,
            min_interval=args.min_interval,
            timeout=timeout,
            max_retries=args.max_retries,
        )

    if args.source == "sanook":
        return collect_sanook(
            candidates,
            min_interval=args.min_interval,
            timeout=timeout,
            max_retries=args.max_retries,
        )

    # auto — bulk archive first, then the authoritative API, then per-draw HTML.
    primary = collect_sanook_archive(start, end, **archive_kwargs)
    if primary.draws:
        return primary

    log.warning("The HTML archive yielded no draws — falling back to the official GLO API.")
    fallback = collect_glo(
        candidates,
        cache_dir=args.cache_dir,
        use_cache=not args.no_cache,
        min_interval=args.min_interval,
        timeout=timeout,
        max_retries=args.max_retries,
    )
    if fallback.draws:
        return merge_results(fallback, primary)

    log.warning("The GLO API yielded no draws either — falling back to per-draw HTML pages.")
    return merge_results(
        fallback,
        collect_sanook(
            candidates,
            min_interval=args.min_interval,
            timeout=timeout,
            max_retries=args.max_retries,
        ),
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    start, end = _resolve_window(args)
    if end < start:
        log.error("--to (%s) is before --from (%s)", end, start)
        return 2

    # Only the per-date sources need candidate dates; the archive lists draws
    # directly, so it is not asked to guess a schedule.
    needs_candidates = args.source in ("glo", "sanook") or args.source == "auto"
    candidates = _candidate_dates(args, start, end) if needs_candidates else []

    log.info(
        "Source=%s | window %s -> %s | mode=%s | %d candidate date(s)",
        args.source,
        start,
        end,
        args.date_mode,
        len(candidates),
    )

    if not candidates and args.source in ("glo", "sanook"):
        log.error("No candidate dates in that window.")
        return 2

    collection: Collection
    try:
        if args.source == "archive" and args.latest:
            # `--latest` means the newest single draw, so read page 1 only.
            args.max_pages = 1
        collection = _collect(args, start, end, candidates)

        # --- fill holes in whatever the bulk source produced -----------------
        if args.fill_gaps:
            missing_dates = find_missing_draw_dates(collection.draws)
            if missing_dates:
                log.info(
                    "Gap fill: %d date(s) are implied by the spacing but absent — "
                    "probing Myhora.",
                    len(missing_dates),
                )
                filled = collect_myhora(
                    missing_dates,
                    min_interval=args.min_interval,
                    timeout=(min(10.0, args.timeout), args.timeout),
                    max_retries=args.max_retries,
                )
                log.info(
                    "Gap fill: recovered %d draw(s); %d probed date(s) confirmed to "
                    "have no draw.",
                    len(filled.draws),
                    len(filled.missing),
                )
                collection = merge_results(collection, filled)
            else:
                log.info("Gap fill: no gaps in the collected spacing.")

        draws, repeated = drop_repeated_prize_pairs(collection.draws)
        collection.skipped.extend(repeated)

        # `--latest` means exactly that; a window probe may legitimately return
        # several draws.
        if args.latest and draws:
            draws = [max(draws, key=lambda d: d.draw_date)]

        log.info(
            "Collected %d draw(s) | %d date(s) had no draw | %d failure(s) | %d row(s) skipped",
            len(draws),
            len(collection.missing),
            len(collection.failures),
            len(collection.skipped),
        )
        for failed_date, reason in collection.failures[:10]:
            log.warning("  FAILED %s: %s", failed_date, reason)
        if len(collection.failures) > 10:
            log.warning("  ... and %d more", len(collection.failures) - 10)

        if not draws:
            log.error("No draws collected — nothing to write. Exiting non-zero.")
            return 1

        rows, dropped = dedupe([draw.as_row() for draw in draws])
        if dropped:
            log.warning("Dropped %d duplicate draw_date row(s) before upsert.", dropped)

        if args.json_out:
            args.json_out.parent.mkdir(parents=True, exist_ok=True)
            args.json_out.write_text(
                json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            log.info("Wrote %d row(s) to %s", len(rows), args.json_out)

        oldest, newest = rows[0]["draw_date"], rows[-1]["draw_date"]
        span_days = (date.fromisoformat(newest) - date.fromisoformat(oldest)).days
        log.info("Coverage: %s -> %s (%.1f years, %d draws)", oldest, newest, span_days / 365.25, len(rows))
        log.info("Sample:  %s", rows[-1])

        # --- write ----------------------------------------------------------
        if args.dry_run:
            log.info("DRY RUN — validated %d row(s); Supabase was not contacted.", len(rows))
        else:
            client = create_supabase_client()
            try:
                written = upsert_rows(client, rows, batch_size=args.batch_size)
            finally:
                session = getattr(getattr(client, "postgrest", None), "session", None)
                if callable(getattr(session, "close", None)):
                    session.close()
            log.info("Upserted %d row(s) into %s.", written, TABLE_NAME)

    except (ScrapeError, GLOError, IngestionError) as exc:
        log.error("Fatal: %s", exc)
        return 1
    except KeyboardInterrupt:
        log.warning("Interrupted.")
        return 130

    if args.strict and collection.failures:
        log.error("--strict: %d date(s) failed.", len(collection.failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
