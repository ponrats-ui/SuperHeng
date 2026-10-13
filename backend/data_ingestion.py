#!/usr/bin/env python3
"""
SuperHeng — GLO (Government Lottery Office) data ingestion engine.

Pulls official Thai government lottery draw results straight from GLO's own
documented API and normalises them into a shape that can be seeded into
PostgreSQL and consumed by the prediction models.

WHY AN API AND NOT HTML SCRAPING
--------------------------------
GLO publishes an open-data catalogue at https://gdcatalog.glo.or.th/dataset/dataset_c4-9_01
which documents JSON endpoints. Those are strictly better than parsing HTML:
they are the same data the official site itself renders, they are stable
against redesigns, and they avoid fragile selector maintenance. So this module
uses `requests` against the official API rather than BeautifulSoup. No scraping
of the marketing pages happens here at all.

Documented endpoints (both POST, JSON body, no API key):

    POST https://www.glo.or.th/api/lottery/getLatestLottery     body: {}
    POST https://www.glo.or.th/api/checking/getLotteryResult    body: {"date","month","year"}

VERIFIED BEHAVIOUR (probed against the live API, 2026-10-12)
-----------------------------------------------------------
* A date with no draw returns **HTTP 200** with `{"response": null}` — a "no
  data" signal, NOT an HTTP error. Both cases must be handled.
* The response envelope differs between the two endpoints:
    - getLatestLottery  -> prize data lives at `response`
    - getLotteryResult  -> prize data lives at `response.result`
* Coverage: data confirmed at 2014-01-16; `response: null` at 2010-01-01. The
  10-year backfill window (2016+) is comfortably inside that range.
* Numbers are zero-padded strings ("001973"). They are kept as strings
  throughout — never parsed as ints — or leading zeros are silently destroyed.

⚠️  IMPORTANT — PRIZE SEMANTICS
-------------------------------
The official 2-digit prize (`last2`, เลขท้าย 2 ตัว) is a **separately drawn
number**. It is NOT the last two digits of the first prize. Live proof:

    2024-03-01 -> first prize = "253603", official last2 = "79"
                  ("79" is not "03")
    2026-10-01 -> first prize = "402701", official last2 = "70"

The same applies to `last3b` (เลขท้าย 3 ตัว). Therefore this module keeps two
clearly separated concepts:

    * OFFICIAL prizes      -> last2, last3b, last3f, near1, first, second...fifth
    * DERIVED statistics   -> first_trailing2, first_trailing3 (the last 2/3
                              digits of the first prize)

The derived values are useful for the app's "Top position" series, but they are
not prizes anyone can win. Do not present them as such.

⚠️  LICENCE
-----------
GLO's data catalogue is published under **Creative Commons
Non-Commercial (Any)**. Non-commercial use is the intent here; commercial reuse
requires speaking to GLO first. This module also rate-limits politely (1 request
per second by default) and caches raw responses to disk.

USAGE
-----
    # Fetch the latest draw only
    python data_ingestion.py --latest

    # Backfill 10 years (the default window) into ./data
    python data_ingestion.py --out-dir ./data

    # A small window, useful as a smoke test
    python data_ingestion.py --from 2024-03-01 --to 2024-03-31 --out-dir ./data

    # Show what would be fetched without hitting the network
    python data_ingestion.py --from 2024-01-01 --to 2024-12-31 --dry-run

    # Belt and braces: probe every calendar day (also catches postponed draws)
    python data_ingestion.py --date-mode all-days --from 2024-01-01 --to 2024-12-31
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from pathlib import Path
from typing import Any
from typing import Iterable
from typing import Iterator
from typing import Sequence

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

try:  # pandas is optional: --format json works without it
    import pandas as pd
except ImportError:  # pragma: no cover - depends on install
    pd = None  # type: ignore[assignment]

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

GLO_API_BASE = "https://www.glo.or.th"
ENDPOINT_LATEST = f"{GLO_API_BASE}/api/lottery/getLatestLottery"
ENDPOINT_BY_DATE = f"{GLO_API_BASE}/api/checking/getLotteryResult"

DEFAULT_TIMEOUT = (10, 30)  # (connect, read) seconds
DEFAULT_MIN_INTERVAL = 1.0  # polite floor between requests, seconds
DEFAULT_MAX_RETRIES = 5
DEFAULT_LOOKBACK_YEARS = 10

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Safari/537.36"
)

# Prize groups GLO returns under `data`, with the official Thai name and the
# human-readable meaning. Used for documentation and for the long-form export.
PRIZE_GROUPS: dict[str, str] = {
    "first": "รางวัลที่ 1 — First prize (6 digits)",
    "second": "รางวัลที่ 2 — Second prize (5 x 6 digits)",
    "third": "รางวัลที่ 3 — Third prize (10 x 6 digits)",
    "fourth": "รางวัลที่ 4 — Fourth prize (50 x 6 digits)",
    "fifth": "รางวัลที่ 5 — Fifth prize (100 x 6 digits)",
    "near1": "รางวัลข้างเคียงรางวัลที่ 1 — Adjacent to first prize (2 x 6 digits)",
    "last3f": "เลขหน้า 3 ตัว — Front 3 digits (2 x 3 digits)",
    "last3b": "เลขท้าย 3 ตัว — Last 3 digits (2 x 3 digits)",
    "last2": "เลขท้าย 2 ตัว — Last 2 digits (1 x 2 digits)",
}

# Months whose draw day is officially moved. Kept here as documentation only —
# generate_candidate_dates() emits a SUPERSET (1st, 16th + these) and lets the
# API's `response: null` prune whatever did not actually run, so a stale entry
# can never cause a missing draw.
KNOWN_SPECIAL_DRAW_DAYS: tuple[tuple[int, int], ...] = (
    (1, 17),  # Teachers' Day draw
    (5, 2),   # Labour Day draw
    (12, 30),  # New Year draw
)

log = logging.getLogger("superheng.ingest")


# --------------------------------------------------------------------------
# Normalised model
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class PrizeGroup:
    """One prize category: its payout and the winning number(s)."""

    price: str | None
    numbers: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {"price": self.price, "numbers": list(self.numbers)}


@dataclass(frozen=True)
class DrawRecord:
    """A single official draw, normalised.

    All number values are strings so zero-padding survives a round trip.
    """

    draw_date: str  # ISO-8601, e.g. "2024-03-01"
    period: tuple[int, ...] = ()
    sheet_id: str | None = None
    status: int | None = None
    youtube_url: str | None = None
    pdf_url: str | None = None
    remark: str | None = None
    first: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    second: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    third: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    fourth: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    fifth: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    near1: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    last3f: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    last3b: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    last2: PrizeGroup = field(default_factory=lambda: PrizeGroup(None, ()))
    source: str = ENDPOINT_BY_DATE
    fetched_at: str = ""

    # -- convenience accessors -------------------------------------------

    @property
    def first_number(self) -> str | None:
        """The 6-digit first prize, or None when the draw is incomplete."""
        return self.first.numbers[0] if self.first.numbers else None

    @property
    def first_trailing2(self) -> str | None:
        """DERIVED — last 2 digits of the first prize. Not an official prize."""
        first = self.first_number
        return first[-2:] if first and len(first) >= 2 else None

    @property
    def first_trailing3(self) -> str | None:
        """DERIVED — last 3 digits of the first prize. Not an official prize."""
        first = self.first_number
        return first[-3:] if first and len(first) >= 3 else None

    @property
    def official_last2(self) -> str | None:
        """OFFICIAL — the separately drawn 2-digit prize (เลขท้าย 2 ตัว)."""
        return self.last2.numbers[0] if self.last2.numbers else None

    # -- serialisation ---------------------------------------------------

    def _groups(self) -> dict[str, PrizeGroup]:
        return {
            "first": self.first,
            "second": self.second,
            "third": self.third,
            "fourth": self.fourth,
            "fifth": self.fifth,
            "near1": self.near1,
            "last3f": self.last3f,
            "last3b": self.last3b,
            "last2": self.last2,
        }

    def as_dict(self) -> dict[str, Any]:
        """Full nested record — the canonical ingestion output."""
        return {
            "draw_date": self.draw_date,
            "period": list(self.period),
            "sheet_id": self.sheet_id,
            "status": self.status,
            "youtube_url": self.youtube_url,
            "pdf_url": self.pdf_url,
            "remark": self.remark,
            "prizes": {name: group.as_dict() for name, group in self._groups().items()},
            "derived": {
                "first_trailing2": self.first_trailing2,
                "first_trailing3": self.first_trailing3,
                "note": (
                    "Derived from the first prize for analysis only. NOT official "
                    "prizes: GLO draws the 2- and 3-digit prizes separately."
                ),
            },
            "source": self.source,
            "fetched_at": self.fetched_at,
        }

    def as_flat_row(self) -> dict[str, Any]:
        """One wide row per draw — convenient for CSV and for a `draws` table."""
        row: dict[str, Any] = {
            "draw_date": self.draw_date,
            "period": json.dumps(list(self.period), ensure_ascii=False),
            "sheet_id": self.sheet_id,
            "first_prize": self.first_number,
            "official_last2": self.official_last2,
            "derived_first_last2": self.first_trailing2,
            "derived_first_last3": self.first_trailing3,
            "last3b_1": self.last3b.numbers[0] if len(self.last3b.numbers) > 0 else None,
            "last3b_2": self.last3b.numbers[1] if len(self.last3b.numbers) > 1 else None,
            "last3f_1": self.last3f.numbers[0] if len(self.last3f.numbers) > 0 else None,
            "last3f_2": self.last3f.numbers[1] if len(self.last3f.numbers) > 1 else None,
            "near1": json.dumps(list(self.near1.numbers)),
            "second": json.dumps(list(self.second.numbers)),
            "third": json.dumps(list(self.third.numbers)),
            "fourth": json.dumps(list(self.fourth.numbers)),
            "fifth": json.dumps(list(self.fifth.numbers)),
            "source": self.source,
            "fetched_at": self.fetched_at,
        }
        return row


# --------------------------------------------------------------------------
# Parsing helpers
# --------------------------------------------------------------------------


def _parse_group(raw: Any) -> PrizeGroup:
    """Parse one `{price, number:[{round,value}]}` block defensively.

    Rows are ordered by `round` so repeated runs produce byte-identical output
    even though GLO returns them in arbitrary order.
    """
    if not isinstance(raw, dict):
        return PrizeGroup(None, ())

    price_raw = raw.get("price")
    price = str(price_raw) if price_raw is not None else None

    entries = raw.get("number")
    if not isinstance(entries, list):
        return PrizeGroup(price, ())

    cleaned: list[tuple[int, str]] = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        value = entry.get("value")
        if value is None:
            continue
        round_no = entry.get("round")
        order = round_no if isinstance(round_no, int) else index
        cleaned.append((order, str(value).strip()))

    cleaned.sort(key=lambda item: item[0])
    return PrizeGroup(price, tuple(value for _, value in cleaned))


def unwrap_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    """Return the draw body from either endpoint's envelope.

    Returns None when GLO signals "no draw on this date" (`response: null`).
    """
    response = payload.get("response")
    if not isinstance(response, dict):
        return None

    # getLotteryResult nests under `result`; getLatestLottery does not.
    nested = response.get("result")
    if isinstance(nested, dict) and "data" in nested:
        return nested
    if "data" in response:
        return response
    return None


def parse_draw(payload: dict[str, Any], source: str = ENDPOINT_BY_DATE) -> DrawRecord | None:
    """Convert a raw API payload into a DrawRecord, or None if there is no draw."""
    body = unwrap_payload(payload)
    if body is None:
        return None

    data = body.get("data")
    if not isinstance(data, dict):
        return None

    period_raw = body.get("period")
    period: tuple[int, ...] = ()
    if isinstance(period_raw, list):
        period = tuple(int(p) for p in period_raw if isinstance(p, (int, float)))

    draw_date = body.get("date")
    if not isinstance(draw_date, str) or not draw_date:
        return None

    return DrawRecord(
        draw_date=draw_date,
        period=period,
        sheet_id=body.get("sheetId"),
        status=body.get("status"),
        youtube_url=body.get("youtube_url"),
        pdf_url=body.get("pdf_url"),
        remark=body.get("remark"),
        first=_parse_group(data.get("first")),
        second=_parse_group(data.get("second")),
        third=_parse_group(data.get("third")),
        fourth=_parse_group(data.get("fourth")),
        fifth=_parse_group(data.get("fifth")),
        near1=_parse_group(data.get("near1")),
        last3f=_parse_group(data.get("last3f")),
        last3b=_parse_group(data.get("last3b")),
        last2=_parse_group(data.get("last2")),
        source=source,
        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------


class GLOError(RuntimeError):
    """Raised when a request fails after exhausting retries."""


class GLOClient:
    """Polite, resilient client for the official GLO results API."""

    def __init__(
        self,
        *,
        timeout: tuple[float, float] = DEFAULT_TIMEOUT,
        min_interval: float = DEFAULT_MIN_INTERVAL,
        max_retries: int = DEFAULT_MAX_RETRIES,
        cache_dir: Path | None = None,
        use_cache: bool = True,
        session: requests.Session | None = None,
    ) -> None:
        self.timeout = timeout
        self.min_interval = max(0.0, min_interval)
        self.max_retries = max(1, max_retries)
        self.cache_dir = cache_dir
        self.use_cache = use_cache
        self._last_request_at = 0.0
        self.session = session or self._build_session()

    def _build_session(self) -> requests.Session:
        session = requests.Session()
        session.headers.update(
            {
                "User-Agent": BROWSER_USER_AGENT,
                "Content-Type": "application/json",
                "Accept": "application/json, text/plain, */*",
                "Origin": GLO_API_BASE,
                "Referer": f"{GLO_API_BASE}/",
            }
        )

        # NOTE: urllib3's Retry ignores POST by default, so POST must be added
        # explicitly or transient 5xx/429 responses would never be retried.
        retry = Retry(
            total=self.max_retries,
            connect=self.max_retries,
            read=self.max_retries,
            status=self.max_retries,
            backoff_factor=1.0,
            backoff_max=30.0,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=frozenset({"POST", "GET"}),
            respect_retry_after_header=True,
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=4)
        session.mount("https://", adapter)
        session.mount("http://", adapter)
        return session

    # -- internals -------------------------------------------------------

    def _throttle(self) -> None:
        """Keep a polite floor between requests, with a little jitter."""
        if self.min_interval <= 0:
            return
        elapsed = time.monotonic() - self._last_request_at
        wait = self.min_interval - elapsed
        if wait > 0:
            time.sleep(wait + random.uniform(0, 0.25))

    def _cache_path(self, key: str) -> Path | None:
        if self.cache_dir is None:
            return None
        safe = key.replace("/", "-").replace(":", "-")
        return self.cache_dir / f"{safe}.json"

    def _read_cache(self, key: str) -> dict[str, Any] | None:
        path = self._cache_path(key)
        if path is None or not path.exists():
            return None
        try:
            with path.open("r", encoding="utf-8") as handle:
                return json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("Ignoring unreadable cache entry %s: %s", path, exc)
            return None

    def _write_cache(self, key: str, payload: dict[str, Any]) -> None:
        path = self._cache_path(key)
        if path is None:
            return
        try:
            # Created lazily so a --dry-run never touches the filesystem.
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
        except OSError as exc:  # never fail the run over a cache write
            log.warning("Could not write cache entry %s: %s", path, exc)

    def _post(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        """POST with throttling, cache and a final hard-failure guard."""
        last_error: Exception | None = None

        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            try:
                response = self.session.post(url, json=body, timeout=self.timeout)
                self._last_request_at = time.monotonic()

                if response.status_code != 200:
                    raise GLOError(f"HTTP {response.status_code} from {url}")

                payload = response.json()
                if not isinstance(payload, dict):
                    raise GLOError(f"Unexpected non-object JSON from {url}")
                return payload

            except (requests.Timeout, requests.ConnectionError) as exc:
                # Transient: dropped connection, DNS blip, slow socket.
                last_error = exc
                backoff = min(30.0, 2 ** (attempt - 1)) + random.uniform(0, 0.5)
                log.warning(
                    "Network error (%s) on attempt %d/%d — retrying in %.1fs",
                    type(exc).__name__,
                    attempt,
                    self.max_retries,
                    backoff,
                )
                time.sleep(backoff)

            except (GLOError, requests.RequestException, ValueError) as exc:
                last_error = exc
                backoff = min(30.0, 2 ** (attempt - 1)) + random.uniform(0, 0.5)
                log.warning(
                    "Request failed (%s) on attempt %d/%d — retrying in %.1fs",
                    exc,
                    attempt,
                    self.max_retries,
                    backoff,
                )
                time.sleep(backoff)

        raise GLOError(f"Giving up on {url} after {self.max_retries} attempts: {last_error}")

    # -- public API ------------------------------------------------------

    def fetch_latest(self) -> DrawRecord | None:
        """Fetch the most recent published draw."""
        key = "latest"
        if self.use_cache:
            cached = self._read_cache(key)
            if cached is not None:
                return parse_draw(cached, source=ENDPOINT_LATEST)

        payload = self._post(ENDPOINT_LATEST, {})
        if self.use_cache:
            self._write_cache(key, payload)
        return parse_draw(payload, source=ENDPOINT_LATEST)

    def fetch_by_date(self, when: date) -> DrawRecord | None:
        """Fetch one draw by date.

        Returns None when GLO reports no draw for that date (HTTP 200 with a
        null `response`). Raises GLOError only for genuine failures.
        """
        key = f"draw-{when.isoformat()}"
        if self.use_cache:
            cached = self._read_cache(key)
            if cached is not None:
                return parse_draw(cached, source=ENDPOINT_BY_DATE)

        body = {
            "date": f"{when.day:02d}",
            "month": f"{when.month:02d}",
            "year": f"{when.year:04d}",
        }
        payload = self._post(ENDPOINT_BY_DATE, body)
        if self.use_cache:
            self._write_cache(key, payload)
        return parse_draw(payload, source=ENDPOINT_BY_DATE)

    def close(self) -> None:
        self.session.close()

    def __enter__(self) -> "GLOClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()


# --------------------------------------------------------------------------
# Date generation
# --------------------------------------------------------------------------


def generate_candidate_dates(start: date, end: date, *, mode: str = "draw-days") -> Iterator[date]:
    """Yield candidate draw dates between `start` and `end` inclusive.

    `draw-days` emits a *superset* of the official schedule (the 1st and 16th of
    every month plus the known special draws). Non-draw dates simply come back
    as `response: null` and are dropped, so over-generating is safe and a stale
    special-date entry can never hide a real draw.

    `all-days` probes every calendar day. Slower, but it is the only mode that
    reliably catches a draw postponed to an unannounced date.
    """
    if end < start:
        raise ValueError("end date must not be before start date")

    if mode == "all-days":
        current = start
        while current <= end:
            yield current
            current += timedelta(days=1)
        return

    if mode != "draw-days":
        raise ValueError(f"unknown date mode: {mode!r}")

    special = set(KNOWN_SPECIAL_DRAW_DAYS)
    current = start
    while current <= end:
        in_schedule = current.day in (1, 16) or (current.month, current.day) in special
        if in_schedule:
            yield current
        current += timedelta(days=1)


# --------------------------------------------------------------------------
# Backfill
# --------------------------------------------------------------------------


@dataclass
class BackfillResult:
    records: list[DrawRecord] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # no draw on that date
    failures: list[tuple[str, str]] = field(default_factory=list)  # (date, reason)

    @property
    def ok(self) -> bool:
        return bool(self.records)


def backfill(
    client: GLOClient,
    dates: Iterable[date],
    *,
    skip_existing: set[str] | None = None,
    on_progress: Any = None,
) -> BackfillResult:
    """Fetch every candidate date, tolerating individual failures.

    A single bad date never aborts the run — it is recorded in `failures` and
    the backfill continues, so one flaky response cannot cost an hour of work.
    """
    existing = skip_existing or set()
    result = BackfillResult()
    candidates = list(dates)
    total = len(candidates)

    for index, when in enumerate(candidates, start=1):
        iso = when.isoformat()
        if iso in existing:
            result.skipped.append(iso)
            continue

        try:
            record = client.fetch_by_date(when)
        except GLOError as exc:
            log.error("Failed %s: %s", iso, exc)
            result.failures.append((iso, str(exc)))
            continue
        except Exception as exc:  # defensive: never die mid-backfill
            log.exception("Unexpected error for %s", iso)
            result.failures.append((iso, f"unexpected: {exc}"))
            continue

        if record is None:
            result.skipped.append(iso)
        else:
            result.records.append(record)

        if on_progress is not None:
            on_progress(index, total, record)

    return result


# --------------------------------------------------------------------------
# Output writers
# --------------------------------------------------------------------------


def _sort_records(records: Sequence[DrawRecord]) -> list[DrawRecord]:
    """Oldest first — the order the time-series models expect."""
    return sorted(records, key=lambda record: record.draw_date)


def write_json(records: Sequence[DrawRecord], path: Path) -> Path:
    ordered = _sort_records(records)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": ENDPOINT_BY_DATE,
        "licence": "GLO open data — Creative Commons Non-Commercial (Any)",
        "count": len(ordered),
        "draws": [record.as_dict() for record in ordered],
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return path


def write_csv(records: Sequence[DrawRecord], path: Path) -> Path:
    if pd is None:
        raise RuntimeError(
            "pandas is required for CSV output. Install it (pip install pandas) "
            "or use --format json."
        )
    ordered = _sort_records(records)
    frame = pd.DataFrame([record.as_flat_row() for record in ordered])
    # Keep zero-padded prize numbers as text in the CSV, not floats.
    frame = frame.astype({"first_prize": "string", "official_last2": "string"})
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(path, index=False, encoding="utf-8")
    return path


def write_legend(out_dir: Path) -> Path:
    """Write the prize-group legend so the client can render Thai prize labels."""
    path = out_dir / "prize_legend.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(PRIZE_GROUPS, handle, ensure_ascii=False, indent=2)
    return path


def write_series(records: Sequence[DrawRecord], path: Path, *, max_draws: int | None = None) -> Path:
    """Write the per-draw sequence the prediction models consume.

    Two clearly separated channels:
      * `bottom2` — OFFICIAL separately drawn 2-digit prize
      * `top2`    — DERIVED last 2 digits of the first prize
    """
    ordered = _sort_records(records)
    if max_draws is not None:
        ordered = ordered[-max_draws:]

    series = [
        {
            "draw_date": record.draw_date,
            "top2": record.first_trailing2,      # derived
            "top3": record.first_trailing3,      # derived
            "bottom2": record.official_last2,    # official
            "last3b": list(record.last3b.numbers),  # official
            "first_prize": record.first_number,
        }
        for record in ordered
    ]

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(series),
        "note": (
            "top2/top3 are DERIVED from the first prize for analysis only. "
            "bottom2/last3b are the official separately drawn prizes."
        ),
        "series": series,
    }
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return path


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="data_ingestion.py",
        description="Ingest official Thai GLO lottery draw results into JSON/CSV.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python data_ingestion.py --latest\n"
            "  python data_ingestion.py --out-dir ./data\n"
            "  python data_ingestion.py --from 2024-03-01 --to 2024-03-31\n"
            "  python data_ingestion.py --dry-run --from 2024-01-01 --to 2024-12-31\n"
        ),
    )
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--latest", action="store_true", help="fetch only the latest draw")
    scope.add_argument(
        "--from",
        dest="start",
        type=date.fromisoformat,
        metavar="YYYY-MM-DD",
        help=f"start of the backfill window (default: {DEFAULT_LOOKBACK_YEARS} years ago)",
    )
    parser.add_argument(
        "--to",
        dest="end",
        type=date.fromisoformat,
        metavar="YYYY-MM-DD",
        help="end of the backfill window (default: today)",
    )
    parser.add_argument(
        "--date-mode",
        choices=("draw-days", "all-days"),
        default="draw-days",
        help="candidate dates to probe (default: draw-days)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("data"),
        help="directory for outputs (default: ./data)",
    )
    parser.add_argument(
        "--format",
        choices=("json", "csv", "both"),
        default="both",
        help="output format (default: both)",
    )
    parser.add_argument(
        "--cache-dir",
        type=Path,
        default=None,
        help="cache raw responses here so re-runs are cheap (default: <out-dir>/cache)",
    )
    parser.add_argument("--no-cache", action="store_true", help="ignore and do not write the cache")
    parser.add_argument(
        "--min-interval",
        type=float,
        default=DEFAULT_MIN_INTERVAL,
        help=f"seconds between requests (default: {DEFAULT_MIN_INTERVAL})",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(DEFAULT_TIMEOUT[1]),
        help="read timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=DEFAULT_MAX_RETRIES,
        help=f"max attempts per request (default: {DEFAULT_MAX_RETRIES})",
    )
    parser.add_argument("--limit", type=int, default=None, help="stop after N draws")
    parser.add_argument("--dry-run", action="store_true", help="print the plan, make no requests")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    today = date.today()
    start = args.start or (today - timedelta(days=365 * DEFAULT_LOOKBACK_YEARS))
    end = args.end or today
    if end < start:
        log.error("--to (%s) is before --from (%s)", end, start)
        return 2

    cache_dir = None if args.no_cache else (args.cache_dir or (args.out_dir / "cache"))

    client = GLOClient(
        timeout=(min(10.0, args.timeout), args.timeout),
        min_interval=args.min_interval,
        max_retries=args.max_retries,
        cache_dir=cache_dir,
        use_cache=not args.no_cache,
    )

    try:
        # -- latest ------------------------------------------------------
        if args.latest:
            log.info("Fetching the latest draw...")
            record = client.fetch_latest()
            if record is None:
                log.error("No latest draw returned.")
                return 1
            log.info(
                "Latest draw %s | first prize %s | official last2 %s",
                record.draw_date,
                record.first_number,
                record.official_last2,
            )
            out = write_json([record], args.out_dir / "latest.json")
            write_series([record], args.out_dir / "series.json")
            log.info("Wrote %s", out)
            return 0

        # -- backfill ----------------------------------------------------
        candidates = list(generate_candidate_dates(start, end, mode=args.date_mode))
        if args.limit is not None:
            candidates = candidates[-args.limit :]

        log.info(
            "Window %s -> %s | mode=%s | %d candidate dates (superset; non-draw dates are dropped)",
            start,
            end,
            args.date_mode,
            len(candidates),
        )

        if args.dry_run:
            first_five = ", ".join(d.isoformat() for d in candidates[:5])
            last_five = ", ".join(d.isoformat() for d in candidates[-5:])
            log.info("DRY RUN - no requests made. First: %s ... Last: %s", first_five, last_five)
            return 0

        def progress(index: int, total: int, record: DrawRecord | None) -> None:
            if index % 20 == 0 or index == total:
                log.info("  %d/%d dates processed", index, total)
            if record is not None:
                log.debug("    %s -> %s", record.draw_date, record.first_number)

        result = backfill(client, candidates, on_progress=progress)

        log.info(
            "Ingested %d draws | %d dates had no draw | %d failures",
            len(result.records),
            len(result.skipped),
            len(result.failures),
        )
        for failed_date, reason in result.failures[:10]:
            log.warning("  FAILED %s: %s", failed_date, reason)
        if len(result.failures) > 10:
            log.warning("  ... and %d more failures", len(result.failures) - 10)

        if not result.records:
            log.error("Nothing ingested.")
            return 1

        written: list[Path] = [
            write_series(result.records, args.out_dir / "series.json"),
            write_legend(args.out_dir),
        ]
        if args.format in ("json", "both"):
            written.append(write_json(result.records, args.out_dir / "draws.json"))
        if args.format in ("csv", "both"):
            try:
                written.append(write_csv(result.records, args.out_dir / "draws.csv"))
            except RuntimeError as exc:
                log.warning("%s", exc)

        for path in written:
            log.info("Wrote %s", path)

        newest = _sort_records(result.records)[-1]
        log.info(
            "Coverage: %s -> %s",
            _sort_records(result.records)[0].draw_date,
            newest.draw_date,
        )
        return 0

    except KeyboardInterrupt:
        log.warning("Interrupted. Progress is cached, so re-running resumes where it stopped.")
        return 130
    except GLOError as exc:
        log.error("Fatal: %s", exc)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
