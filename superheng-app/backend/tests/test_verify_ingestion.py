"""Tests for ``verify_ingestion.py`` — the post-scrape ledger check.

The stakes here are the reason for the detail. This script is the *only* thing
standing between a silently broken scrape and a workflow that reports success,
so its failure modes matter more than its happy path: an empty ledger must be
reported (not passed), a stale ledger must be reported, and a malformed row must
not slip through as "data present".

Two halves, deliberately separated:

* ``check_ledger`` is pure — a snapshot in, problem strings out — so every branch
  is exercised without a database, a clock or a network.
* ``fetch_ledger_state`` is exercised against a fake client that really pages and
  really orders, because the counting strategy is the subtle part: this postgrest
  release cannot request a row count, so the script walks pages itself and would
  report 0 for a populated table if that walk were wrong.
"""

from __future__ import annotations

from datetime import date, timedelta

import pytest

import verify_ingestion as vi
from scraper import IngestionError


# ---------------------------------------------------------------------------
# A client that pages and orders for real
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, data):
        self.data = data


class _FakeBuilder:
    """Mimics the postgrest select builder closely enough to be worth trusting."""

    def __init__(self, client, columns: str):
        self._client = client
        self._columns = [c.strip() for c in columns.split(",")]
        self._desc = False
        self._limit: int | None = None
        self._range: tuple[int, int] | None = None
        self._filters: list[tuple[str, str]] = []

    def eq(self, column, value):
        assert column == "lottery_type", column
        self._filters.append((column, value))
        return self

    def order(self, column, desc: bool = False):
        assert column == "draw_date", column
        self._desc = desc
        return self

    def limit(self, count: int):
        self._limit = count
        return self

    def range(self, start: int, end: int):
        self._range = (start, end)
        return self

    def execute(self):
        self._client.requests.append(self)
        rows = list(self._client.rows)  # already ascending by draw_date
        # Filtered before the range/limit, as PostgREST applies them.
        for column, value in self._filters:
            rows = [row for row in rows if row.get(column) == value]

        if self._range is not None:
            start, end = self._range
            # PostgREST ranges are inclusive.
            rows = rows[start : end + 1]
        elif self._limit is not None:
            rows = rows[-self._limit :] if self._desc else rows[: self._limit]

        return _FakeResponse(
            [{c: row[c] for c in self._columns} for row in rows]
        )


class _FakeClient:
    def __init__(self, rows):
        self.rows = sorted(rows, key=lambda r: r["draw_date"])
        self.requests: list[_FakeBuilder] = []

    def table(self, name: str):
        assert name == "lottery_draws", name
        return _FakeTable(self)


class _FakeTable:
    def __init__(self, client):
        self._client = client

    def select(self, columns: str = "*"):
        return _FakeBuilder(self._client, columns)


def ledger(
    count: int = 472,
    *,
    newest: date | None = None,
    first_prize: str = "402701",
    bottom_two: str = "70",
    lottery_type: str = "thai",
) -> list[dict[str, str]]:
    """A ledger of ``count`` draws, 15 days apart, ending at ``newest``.

    The newest row carries the caller's prize values so the shape checks have
    something to inspect; every older row is deliberately unremarkable. Every row
    carries its ``lottery_type``, because the table now holds three ledgers and
    every read is scoped to one of them.
    """
    newest = newest or (date.today() - timedelta(days=3))
    filler_prize = "12345" if lottery_type == "vietnam" else "123456"
    return [
        {
            "lottery_type": lottery_type,
            "draw_date": (newest - timedelta(days=15 * i)).isoformat(),
            "first_prize": first_prize if i == 0 else filler_prize,
            "bottom_two": bottom_two if i == 0 else "42",
        }
        for i in range(count)
    ]


def state_for(
    *,
    rows: int = 472,
    newest: str | None = None,
    first_prize: str | None = "402701",
    bottom_two: str | None = "70",
) -> vi.LedgerState:
    return vi.LedgerState(
        rows=rows,
        oldest="2006-12-30" if rows else None,
        newest=newest if newest is not None else (date.today() - timedelta(days=3)).isoformat(),
        newest_first_prize=first_prize,
        newest_bottom_two=bottom_two,
    )


# ---------------------------------------------------------------------------
# Reading the ledger
# ---------------------------------------------------------------------------


def test_count_rows_pages_past_a_single_page():
    """The count must not stop at the first page — that is how a real count hides."""
    client = _FakeClient(ledger(2500))
    assert vi.count_rows(client) == 2500
    # 1000 + 1000 + 500: three requests, the last one short.
    assert len(client.requests) == 3
    assert client.requests[-1]._range == (2000, 2999)


def test_count_rows_of_an_empty_table_is_zero():
    client = _FakeClient([])
    assert vi.count_rows(client) == 0


def test_count_rows_refuses_to_guess_when_paging_runs_away():
    """A fake that never returns a short page must raise, not loop forever."""

    class _NeverEnds(_FakeClient):
        def table(self, name):
            return _FakeTable(self)

    class _FullPageBuilder(_FakeBuilder):
        def execute(self):
            full = [
                {"draw_date": f"{2000 + (i // 1000):04d}-01-01"}
                for i in range(vi.PAGE_SIZE)
            ]
            return _FakeResponse(full)

    class _FullPageTable:
        def __init__(self, client):
            self._client = client

        def select(self, columns: str = "*"):
            return _FullPageBuilder(self._client, columns)

    client = _NeverEnds([])
    client.table = lambda name: _FullPageTable(client)  # type: ignore[assignment]

    with pytest.raises(IngestionError, match="exceeded"):
        vi.count_rows(client)


def test_newest_row_returns_the_latest_draw():
    client = _FakeClient(ledger(10, newest=date(2026, 10, 1)))
    assert vi.newest_row(client)["draw_date"] == "2026-10-01"


def test_newest_row_of_an_empty_table_is_empty():
    assert vi.newest_row(_FakeClient([])) == {}


def test_oldest_draw_date_finds_the_start_of_the_archive():
    # The oracle is the fixture's own minimum rather than a date written out by
    # hand: what is under test is that the query returns the earliest row, and a
    # hard-coded date would only re-test the fixture's arithmetic.
    rows = ledger(10, newest=date(2026, 10, 1))
    client = _FakeClient(rows)

    assert vi.oldest_draw_date(client) == min(r["draw_date"] for r in rows)
    assert vi.oldest_draw_date(client) != max(r["draw_date"] for r in rows)


def test_oldest_draw_date_of_an_empty_table_is_none():
    assert vi.oldest_draw_date(_FakeClient([])) is None


def test_fetch_ledger_state_reads_rows_dates_and_the_newest_prizes():
    rows = ledger(472, newest=date(2026, 10, 1), first_prize="402701", bottom_two="70")
    client = _FakeClient(rows)
    state = vi.fetch_ledger_state(client)

    assert state.rows == 472
    assert state.newest == max(r["draw_date"] for r in rows)
    assert state.oldest == min(r["draw_date"] for r in rows)
    assert state.newest_first_prize == "402701"
    assert state.newest_bottom_two == "70"


# ---------------------------------------------------------------------------
# Judging the ledger — the pure checks
# ---------------------------------------------------------------------------


def test_a_populated_current_ledger_passes():
    assert vi.check_ledger(state_for(), today=date.today()) == []


def test_an_empty_ledger_fails_and_names_the_service_role_key():
    """Zero rows is the failure this whole script exists for."""
    problems = vi.check_ledger(state_for(rows=0), today=date.today())

    assert len(problems) == 1
    assert "0 row(s)" in problems[0]
    # The message must be actionable, not just descriptive.
    assert "service_role" in problems[0]


def test_min_rows_is_enforced():
    problems = vi.check_ledger(state_for(rows=10), today=date.today(), min_rows=400)
    assert any("400" in p for p in problems)


def test_a_stale_ledger_fails_and_reports_the_age():
    stale = (date.today() - timedelta(days=60)).isoformat()
    problems = vi.check_ledger(state_for(newest=stale), today=date.today())

    assert len(problems) == 1
    assert "60 day(s) old" in problems[0]
    assert stale in problems[0]


def test_a_ledger_exactly_at_the_staleness_limit_passes():
    """The bound is inclusive: 45 days old is fine, 46 is not."""
    limit = vi.DEFAULT_MAX_STALENESS_DAYS
    at_limit = (date.today() - timedelta(days=limit)).isoformat()
    just_over = (date.today() - timedelta(days=limit + 1)).isoformat()

    assert vi.check_ledger(state_for(newest=at_limit), today=date.today()) == []
    assert vi.check_ledger(state_for(newest=just_over), today=date.today()) != []


def test_a_future_dated_draw_is_rejected():
    """Usually a Buddhist-era year written as CE — silently corrupting, so fail."""
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    problems = vi.check_ledger(state_for(newest=tomorrow), today=date.today())

    assert any("future" in p for p in problems)


def test_a_non_iso_draw_date_is_rejected():
    problems = vi.check_ledger(state_for(newest="01/10/2569"), today=date.today())
    assert any("ISO date" in p for p in problems)


def test_a_short_first_prize_is_rejected():
    problems = vi.check_ledger(state_for(first_prize="12345"), today=date.today())
    assert any("first_prize" in p for p in problems)


def test_a_missing_bottom_two_is_rejected():
    problems = vi.check_ledger(state_for(bottom_two=None), today=date.today())
    assert any("bottom_two" in p for p in problems)


def test_rows_without_a_newest_draw_are_reported_as_inconsistent():
    problems = vi.check_ledger(
        vi.LedgerState(rows=5, oldest="2026-01-01", newest=None,
                       newest_first_prize=None, newest_bottom_two=None),
        today=date.today(),
    )
    assert any("inconsistent" in p for p in problems)


def test_an_empty_ledger_reports_only_the_count_problem():
    """Staleness and shape say nothing useful about an empty table."""
    problems = vi.check_ledger(
        state_for(rows=0, newest=None, first_prize=None, bottom_two=None),
        today=date.today(),
    )
    assert len(problems) == 1


# ---------------------------------------------------------------------------
# The CLI
# ---------------------------------------------------------------------------


def _stub_client(monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, str]]):
    client = _FakeClient(rows)
    monkeypatch.setattr(vi, "create_supabase_client", lambda: client)
    return client


def test_main_succeeds_and_emits_a_notice(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    _stub_client(monkeypatch, ledger(472, newest=date.today() - timedelta(days=2)))

    assert vi.main([]) == 0

    out = capsys.readouterr().out
    assert "::notice::" in out
    assert "472 row(s)" in out
    assert "::error::" not in out


def test_main_fails_with_an_error_annotation_on_an_empty_ledger(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    _stub_client(monkeypatch, [])

    assert vi.main([]) == 1

    out = capsys.readouterr().out
    assert "::error::" in out
    assert "service_role" in out
    assert "::notice::" not in out


def test_main_fails_with_an_error_annotation_on_a_stale_ledger(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    _stub_client(monkeypatch, ledger(20, newest=date.today() - timedelta(days=90)))

    assert vi.main([]) == 1
    assert "::error::" in capsys.readouterr().out


def test_main_reports_a_client_that_cannot_be_built(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    def explode():
        raise IngestionError("SUPABASE_URL and SUPABASE_KEY must both be set.")

    monkeypatch.setattr(vi, "create_supabase_client", explode)

    assert vi.main([]) == 1
    out = capsys.readouterr().out
    assert "::error::" in out
    assert "SUPABASE_URL" in out


def test_main_reports_a_read_failure(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    class _Broken(_FakeClient):
        def table(self, name):
            raise RuntimeError("connection reset")

    monkeypatch.setattr(vi, "create_supabase_client", lambda: _Broken([]))

    assert vi.main([]) == 1
    assert "connection reset" in capsys.readouterr().out


def test_main_rejects_a_min_rows_of_zero_without_touching_the_database(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
):
    """`--min-rows 0` would disable the check the caller asked for, so refuse it."""

    def explode():
        raise AssertionError("must not contact Supabase when the arguments are invalid")

    monkeypatch.setattr(vi, "create_supabase_client", explode)

    assert vi.main(["--min-rows", "0"]) == 1
    assert "at least 1" in capsys.readouterr().out


def test_main_defaults_match_the_documented_values():
    args = vi._parse_args([])
    assert args.min_rows == 1
    assert args.max_staleness_days == 45
    assert args.type == "thai"


def test_main_accepts_every_ledger_and_refuses_an_unknown_one():
    for kind in ("thai", "laos", "vietnam"):
        assert vi._parse_args(["--type", kind]).type == kind
    with pytest.raises(SystemExit):
        vi._parse_args(["--type", "burma"])


# ---------------------------------------------------------------------------
# One ledger at a time
# ---------------------------------------------------------------------------


def test_every_read_is_scoped_to_the_requested_ledger():
    """Without the filter, a Lao job would judge itself against a Thai draw."""
    rows = ledger(3, newest=date(2026, 10, 13), lottery_type="laos") + ledger(
        5, newest=date(2026, 10, 13), lottery_type="vietnam", first_prize="53618"
    )
    client = _FakeClient(rows)

    assert vi.count_rows(client, "laos") == 3
    assert vi.count_rows(client, "vietnam") == 5
    assert vi.count_rows(client, "thai") == 0
    # Every read carried the filter, not just the count, and it named one country.
    assert all(len(builder._filters) == 1 for builder in client.requests)
    assert [builder._filters[0][1] for builder in client.requests] == [
        "laos",
        "vietnam",
        "thai",
    ]
    assert vi.newest_row(client, "laos")["first_prize"] == "402701"
    assert vi.newest_row(client, "vietnam")["first_prize"] == "53618"
    assert [builder._filters[0][1] for builder in client.requests[-2:]] == [
        "laos",
        "vietnam",
    ]


def test_fetch_ledger_state_reads_one_country_at_a_time():
    rows = ledger(2, lottery_type="vietnam", first_prize="53618", bottom_two="18") + ledger(
        400, lottery_type="thai"
    )

    vietnam = vi.fetch_ledger_state(_FakeClient(rows), "vietnam")

    assert vietnam.rows == 2
    assert vietnam.newest_first_prize == "53618"


def test_the_shape_check_follows_the_ledger_width():
    """A five-digit Vietnamese prize is correct; a five-digit Thai one is not."""
    five = state_for(first_prize="53618", bottom_two="18")
    six = state_for(first_prize="402701", bottom_two="01")

    assert vi.check_ledger(five, today=date.today(), lottery_type="vietnam") == []
    assert vi.check_ledger(six, today=date.today(), lottery_type="vietnam") != []
    assert vi.check_ledger(six, today=date.today(), lottery_type="thai") == []
    assert vi.check_ledger(six, today=date.today(), lottery_type="laos") == []
    assert vi.check_ledger(five, today=date.today(), lottery_type="laos") != []


def test_the_shape_check_names_the_ledger_it_rejected():
    problems = vi.check_ledger(
        state_for(first_prize="53618", bottom_two="18"),
        today=date.today(),
        lottery_type="laos",
    )

    assert any("newest laos row" in problem and "not 6 digits" in problem for problem in problems)
