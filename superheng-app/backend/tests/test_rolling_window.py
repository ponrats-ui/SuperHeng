"""Tests for the rolling window the prediction models train on.

The window is a property of the *data* feeding the models, so these tests stub at
the Supabase client rather than at ``fetch_draw_history``: the real query function
runs, and the fake below records what it was asked for and answers with rows in the
same order the real PostgREST does (newest first). That ordering matters — it is
what makes "the models re-sorted chronologically" a real assertion rather than an
assumption, since a descending window passed through unchanged would put the oldest
draw last and every time-series model would read the sequence backwards.

The four model families are covered end to end through the endpoints they live
behind: frequency and Markov in ``/api/predict/basic``, ARIMA and Monte Carlo added
in ``/api/predict/advanced``, and the Bayesian positional model in
``/api/predict/premium``.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import main
from conftest import grant_premium
from models.bayesian import POSITION_NAMES
from services import analyse_draws


# ---------------------------------------------------------------------------
# A PostgREST-shaped fake
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQueryBuilder:
    """Records the query it was asked to run, then answers like PostgREST.

    ``eq("lottery_type", ...).order("draw_date", desc=True).limit(n)`` returns the
    newest ``n`` rows **of that ledger, in descending order** — the country filter
    is applied here, before the limit, exactly as the real backend does it. That
    ordering is the behaviour the models have to cope with.
    """

    def __init__(self, client: _FakeClient, columns: str) -> None:
        self._client = client
        self._columns = [column.strip() for column in columns.split(",")]
        self.order_column: str | None = None
        self.desc: bool | None = None
        self.limit_value: int | None = None
        self.filters: list[tuple[str, str]] = []

    def eq(self, column: str, value: str) -> _FakeQueryBuilder:
        self.filters.append((column, value))
        return self

    def order(self, column: str, desc: bool = False) -> _FakeQueryBuilder:
        self.order_column = column
        self.desc = desc
        return self

    def limit(self, count: int) -> _FakeQueryBuilder:
        self.limit_value = count
        return self

    def execute(self) -> _FakeResponse:
        self._client.queries.append(self)

        rows = [
            row
            for row in self._client.rows
            if all(row.get(column) == value for column, value in self.filters)
        ]
        rows = sorted(rows, key=lambda row: row["draw_date"])
        if self.limit_value is not None:
            rows = rows[-self.limit_value :] if self.desc else rows[: self.limit_value]
        if self.desc:
            rows = list(reversed(rows))

        return _FakeResponse(
            [{column: row[column] for column in self._columns} for row in rows]
        )


class _FakeTable:
    def __init__(self, client: _FakeClient) -> None:
        self._client = client

    def select(self, columns: str = "*") -> _FakeQueryBuilder:
        return _FakeQueryBuilder(self._client, columns)


class _FakeClient:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.queries: list[_FakeQueryBuilder] = []

    def table(self, name: str) -> _FakeTable:
        assert name == main.DRAWS_TABLE, name
        return _FakeTable(self)


def served(monkeypatch: pytest.MonkeyPatch, rows: list[dict]) -> tuple[TestClient, _FakeClient]:
    """A TestClient whose database is a fake holding ``rows``, signed in as premium.

    A plain function rather than a fixture, so it signs the app in directly. The
    autouse fixture in `backend/conftest.py` clears the override afterwards.
    """
    fake = _FakeClient(rows)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    grant_premium()
    return TestClient(main.app), fake


# ---------------------------------------------------------------------------
# The ledger the fake serves
# ---------------------------------------------------------------------------


def ledger(count: int, *, seed: int = 20261014) -> list[dict]:
    """``count`` valid draw rows, newest first, ending at the real latest date.

    Every row is well-formed, so nothing is dropped in preparation and the counts
    asserted below are about the window rather than about filtering.
    """
    rng = random.Random(seed)
    dates: list[date] = []
    cursor = date(2026, 10, 1)
    while len(dates) < count:
        dates.append(cursor)
        # Two draws a month, walking backwards: the 1st, then the 16th before it.
        cursor = (
            cursor - timedelta(days=15) if cursor.day == 1 else cursor.replace(day=1)
        )

    assert len(set(dates)) == count  # the unique key the table relies on

    return [
        {
            # Every row is Thai: the column exists on the real table and the
            # query now filters on it, so the fixture has to carry it or the
            # fake would answer every request with nothing.
            "lottery_type": "thai",
            "draw_date": draw_date.isoformat(),
            "first_prize": "".join(str(rng.randrange(10)) for _ in range(6)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for draw_date in dates  # newest first, as the query returns them
    ]


# ---------------------------------------------------------------------------
# The constant, and the query it produces
# ---------------------------------------------------------------------------


def test_the_rolling_window_is_the_most_recent_four_hundred_draws():
    # The requirement, pinned. Both bounds matter: 400 is the default so an
    # unparameterised request gets the modern era, and 400 is the ceiling so no
    # request can widen it.
    assert main.ROLLING_WINDOW_DRAWS == 400
    assert main.DEFAULT_HISTORY_LIMIT == 400
    assert main.MAX_HISTORY_LIMIT == 400


def test_fetch_draw_history_asks_for_the_window_newest_first():
    fake = _FakeClient(ledger(1000))

    rows = main.fetch_draw_history(fake, 10_000)

    query = fake.queries[-1]
    assert query.filters == [("lottery_type", "thai")]
    assert query.order_column == "draw_date"
    assert query.desc is True
    # Clamped at the query, not after it: the database is never asked for rows the
    # models would then throw away.
    assert query.limit_value == main.ROLLING_WINDOW_DRAWS
    assert len(rows) == main.ROLLING_WINDOW_DRAWS == 400


def test_fetch_draw_history_honours_a_window_shorter_than_the_rolling_one():
    fake = _FakeClient(ledger(1000))

    rows = main.fetch_draw_history(fake, 60)

    assert fake.queries[-1].limit_value == 60
    assert len(rows) == 60


# ---------------------------------------------------------------------------
# Through the endpoints, where the models actually run
# ---------------------------------------------------------------------------


def test_a_thousand_row_ledger_is_analysed_as_its_last_four_hundred(monkeypatch):
    all_rows = ledger(1000)
    client, _ = served(monkeypatch, all_rows)

    payload = client.get("/api/predict/basic").json()

    chronological = sorted(all_rows, key=lambda row: row["draw_date"])
    window = chronological[-400:]
    assert payload["draws_analyzed"] == 400
    # The fetch answered newest-first. These three are what prove the models saw the
    # window oldest-first: the range starts at the window's oldest draw, not the
    # ledger's, and the latest draw is the newest one, not the last row returned.
    assert payload["date_range"]["from"] == window[0]["draw_date"]
    assert payload["date_range"]["to"] == window[-1]["draw_date"] == "2026-10-01"
    assert payload["latest_draw"]["draw_date"] == "2026-10-01"
    # Nothing here says 400 draws is too few to analyse — the window is far above
    # every model's floor, which is the whole point of choosing it.
    assert not any("indicative only" in warning for warning in payload["warnings"])


def test_the_window_is_what_truncates_the_history_not_the_model(monkeypatch):
    all_rows = ledger(1000)
    client, _ = served(monkeypatch, all_rows)

    windowed = client.get("/api/predict/basic").json()
    # The models themselves take whatever they are handed. The window lives at the
    # fetch boundary, so a script that wants the whole archive for a backtest still
    # can — and can prove it here.
    unclamped = analyse_draws(all_rows)

    assert windowed["draws_analyzed"] == 400
    assert unclamped["draws_analyzed"] == 1000
    # ...and the two genuinely differ, so the window changes the analysis rather
    # than relabelling the same one.
    assert windowed["channels"]["top"]["draws"] == 400
    assert unclamped["channels"]["top"]["draws"] == 1000


def test_every_model_family_accepts_the_window(monkeypatch):
    """All four families run on 400 rows, and none of them fails on the length.

    `status` is deliberately *not* asserted as ``"ok"``. This ledger is uniformly
    random, so its most recent 2-digit state occurs only a handful of times and the
    Markov step says so — the live 472-draw ledger reports ``limited`` for exactly
    that reason, so ``limited`` here is the data talking, not the window. What must
    hold is that no model reports the *window* as the problem, and that the models
    with real length requirements actually fitted instead of degrading.
    """
    client, _ = served(monkeypatch, ledger(1000))

    responses = {
        "basic (frequency + Markov)": client.get("/api/predict/basic"),
        "advanced (+ ARIMA + Monte Carlo)": client.get(
            "/api/predict/advanced", params={"simulations": 10_000}
        ),
        "premium (Bayesian positional)": client.get("/api/predict/premium"),
    }

    for label, response in responses.items():
        assert response.status_code == 200, f"{label}: {response.text}"
        payload = response.json()
        assert payload["draws_analyzed"] == 400, label
        assert payload["status"] in {"ok", "limited"}, label
        # No model may complain that the window is too short to be worth analysing.
        assert not any(
            "indicative only" in warning for warning in payload["warnings"]
        ), f"{label}: {payload['warnings']}"

    # Frequency + Markov produced a real ranking, scored in range.
    top = responses["basic (frequency + Markov)"].json()["channels"]["top"]
    assert top["rankings"]
    for entry in top["rankings"]:
        assert 0.0 <= entry["score"] <= 100.0
        assert entry["reason"]

    # ARIMA is the model with a genuine series-length requirement, so it is the one
    # worth proving fitted on the window rather than standing down.
    advanced = responses["advanced (+ ARIMA + Monte Carlo)"].json()["channels"]["top"]
    statuses = advanced["model_statuses"]
    assert statuses["frequency"]["status"] == "active"
    assert statuses["timeseries"]["status"] == "active"
    assert advanced["timeseries"]["usable"] is True
    # `failures` is the list of codes ARIMA could not fit, so an empty list is what
    # "the window is long enough for every series" looks like.
    assert advanced["timeseries"]["failures"] == []
    assert advanced["montecarlo"]["usable"] is True
    # Markov may legitimately stand down on a 400-draw window; when it does it must
    # say so rather than fail, and `insufficient_support` is the documented reason.
    assert statuses["markov"]["status"] in {"active", "neutral"}
    if statuses["markov"]["status"] == "neutral":
        assert statuses["markov"]["reason"] == "insufficient_support"

    # Bayesian positional: every position the model publishes, all usable.
    positions = responses["premium (Bayesian positional)"].json()["positions"]
    assert set(positions) == set(POSITION_NAMES)
    assert all(position["usable"] for position in positions.values())


def test_a_ledger_shorter_than_the_window_is_used_whole(monkeypatch):
    client, fake = served(monkeypatch, ledger(50))

    payload = client.get("/api/predict/basic").json()

    # Still asks for the full window — the window is a cap, not a floor.
    assert fake.queries[-1].limit_value == main.ROLLING_WINDOW_DRAWS
    assert payload["draws_analyzed"] == 50
    assert payload["date_range"]["from"] == min(
        row["draw_date"] for row in fake.rows
    )


def test_a_backtest_can_still_ask_for_a_shorter_window(monkeypatch):
    client, _ = served(monkeypatch, ledger(1000))

    payload = client.get("/api/predict/basic", params={"limit": 100}).json()

    assert payload["draws_analyzed"] == 100


def test_a_request_beyond_the_window_is_rejected_rather_than_silently_clamped(monkeypatch):
    client, _ = served(monkeypatch, ledger(1000))

    # Outside the published contract: fail loudly rather than train on 400 and
    # report a window the caller did not ask for.
    assert client.get("/api/predict/basic", params={"limit": 401}).status_code == 422
    assert client.get("/api/predict/basic", params={"limit": 400}).status_code == 200
