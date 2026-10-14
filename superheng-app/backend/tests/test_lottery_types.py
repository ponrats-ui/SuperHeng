"""Tests for the multi-country ledger: `?type=thai|laos|vietnam`.

The premium tier computes one model over one country's history, and the country is
a property of the **data** rather than of the maths. So the thing worth testing is
the boundary: that the country filter is applied in the query, that it is applied
*before* the rolling window's limit, and that it reaches every reader of the table
(the premium panel, the dashboard's latest-draws, ingestion's upsert target).

These tests stub at the Supabase client rather than at ``fetch_draw_history`` on
purpose — ``fetch_draw_history`` is what is under test here, so stubbing it would
assert only that the endpoint forwards its argument, and nothing about the query
that argument turns into. The fake below therefore implements the one PostgREST
feature this path needs: ``eq``, chained before ``order``/``limit``.

The fixtures deliberately give two countries a draw on the **same calendar date**
with different prizes. That is the whole reason the unique key is
``(lottery_type, draw_date)`` rather than ``draw_date``, and a date-only key would
make this suite fail in exactly the way the real table would.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import main
from models.bayesian import POSITION_NAMES


# ---------------------------------------------------------------------------
# A PostgREST-shaped fake, with the country filter
# ---------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, data: list[dict]) -> None:
        self.data = data


class _FakeQueryBuilder:
    """Records what it was asked for, then answers like PostgREST would."""

    def __init__(self, client: _FakeClient, columns: str) -> None:
        self._client = client
        self._columns = [column.strip() for column in columns.split(",")]
        self.filters: list[tuple[str, str]] = []
        self.order_column: str | None = None
        self.desc: bool | None = None
        self.limit_value: int | None = None

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

        # Filter, then sort, then take the newest `n` rows — the order PostgREST
        # applies them in, and the reason a filter applied after the limit would be
        # a different (wrong) answer.
        rows = [
            row
            for row in self._client.rows
            if all(row.get(column) == value for column, value in self.filters)
        ]
        rows.sort(key=lambda row: row["draw_date"])
        if self.limit_value is not None:
            rows = rows[-self.limit_value :] if self.desc else rows[: self.limit_value]
        if self.desc:
            rows = list(reversed(rows))

        if self._columns == ["*"]:
            return _FakeResponse([dict(row) for row in rows])
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
    """A TestClient whose database is a fake holding ``rows``."""
    fake = _FakeClient(rows)
    monkeypatch.setattr(main, "get_supabase", lambda: fake)
    return TestClient(main.app), fake


# ---------------------------------------------------------------------------
# The mixed ledger the fake serves
# ---------------------------------------------------------------------------

# Both of these are draws on 2026-10-01. That is unremarkable on the real
# calendars, and it is exactly what a date-only key cannot represent.
THAI_LATEST = "402701"
LAOS_LATEST = "881204"


def ledger(
    lottery_type: str,
    count: int,
    *,
    newest: date,
    step_days: int,
    seed: int,
    latest_prize: str | None = None,
) -> list[dict]:
    """``count`` well-formed rows for one country, newest first."""
    rng = random.Random(seed)
    rows: list[dict] = []
    cursor = newest
    while len(rows) < count:
        drawn = "".join(str(rng.randrange(10)) for _ in range(6))
        rows.append(
            {
                "lottery_type": lottery_type,
                "draw_date": cursor.isoformat(),
                "first_prize": latest_prize if latest_prize and not rows else drawn,
                "bottom_two": f"{rng.randrange(100):02d}",
            }
        )
        cursor = cursor - timedelta(days=step_days)

    assert len({row["draw_date"] for row in rows}) == count  # the unique key
    return rows


def dates_of(rows: list[dict], lottery_type: str) -> list[str]:
    """One country's draw dates, oldest first."""
    return sorted(row["draw_date"] for row in rows if row["lottery_type"] == lottery_type)


@pytest.fixture()
def mixed() -> list[dict]:
    """A Thai ledger, a Lao one, and no Vietnamese one at all."""
    return ledger(
        "thai", 120, newest=date(2026, 10, 1), step_days=15, seed=1, latest_prize=THAI_LATEST
    ) + ledger(
        "laos", 30, newest=date(2026, 10, 1), step_days=7, seed=2, latest_prize=LAOS_LATEST
    )


@pytest.fixture()
def client() -> TestClient:
    """A client for the route-shape tests that never reach the database."""
    return TestClient(main.app)


# ---------------------------------------------------------------------------
# The fetch, where the filter has to live
# ---------------------------------------------------------------------------


def test_each_ledger_is_fetched_on_its_own(mixed: list[dict]):
    fake = _FakeClient(mixed)

    thai = main.fetch_draw_history(fake, 400, main.LotteryType.thai)
    laos = main.fetch_draw_history(fake, 400, main.LotteryType.laos)

    assert fake.queries[-2].filters == [("lottery_type", "thai")]
    assert fake.queries[-1].filters == [("lottery_type", "laos")]
    assert len(thai) == 120
    assert len(laos) == 30
    # Newest first, and the shared date carries each country's own prize. A filter
    # that did not run would return the Thai draw under the Lao request.
    assert laos[0]["draw_date"] == "2026-10-01"
    assert laos[0]["first_prize"] == LAOS_LATEST
    assert thai[0]["first_prize"] == THAI_LATEST


def test_the_filter_runs_before_the_window_limit(mixed: list[dict]):
    fake = _FakeClient(mixed)

    laos = main.fetch_draw_history(fake, 10, main.LotteryType.laos)

    # The ten newest Lao draws, in descending order. Filtering in Python after a
    # ten-row window would instead return whichever country owned the ten newest
    # rows overall — the Thai ones.
    assert [row["draw_date"] for row in laos] == list(reversed(dates_of(mixed, "laos")[-10:]))


def test_the_default_type_is_still_thai(mixed: list[dict]):
    fake = _FakeClient(mixed)

    rows = main.fetch_draw_history(fake, 400)

    # Called without a type — as the basic and advanced endpoints do — the fetch
    # must behave exactly as it did before the ledger gained a country.
    assert fake.queries[-1].filters == [("lottery_type", "thai")]
    assert len(rows) == 120


def test_an_empty_ledger_is_a_real_answer_not_an_error(mixed: list[dict]):
    fake = _FakeClient(mixed)

    rows = main.fetch_draw_history(fake, 400, main.LotteryType.vietnam)

    # No Vietnamese draws have been ingested. The query still ran and still
    # filtered; there is simply nothing to filter.
    assert fake.queries[-1].filters == [("lottery_type", "vietnam")]
    assert rows == []


def test_a_plain_string_type_is_accepted(mixed: list[dict]):
    fake = _FakeClient(mixed)

    rows = main.fetch_draw_history(fake, 400, "laos")

    # Scripts and tests reach the fetch directly; an enum or its value must both
    # work, since the value is what a stored preference or a CLI flag carries.
    assert fake.queries[-1].filters == [("lottery_type", "laos")]
    assert len(rows) == 30


# ---------------------------------------------------------------------------
# Through the endpoint, where the model actually runs
# ---------------------------------------------------------------------------


def test_the_premium_endpoint_analyses_only_the_requested_country(
    monkeypatch: pytest.MonkeyPatch, mixed: list[dict]
):
    served_client, _ = served(monkeypatch, mixed)

    thai = served_client.get("/api/predict/premium").json()
    laos = served_client.get("/api/predict/premium", params={"type": "laos"}).json()

    assert (thai["lottery_type"], thai["draws_analyzed"]) == ("thai", 120)
    assert (laos["lottery_type"], laos["draws_analyzed"]) == ("laos", 30)
    # The same six positions, modelled over different data.
    assert set(thai["positions"]) == set(POSITION_NAMES)
    assert set(laos["positions"]) == set(POSITION_NAMES)
    # ...and the layouts are identical, which is the requirement: the country swaps
    # the source, not the shape of the answer.
    assert set(thai) == set(laos)


def test_the_two_countries_do_not_share_a_latest_draw(
    monkeypatch: pytest.MonkeyPatch, mixed: list[dict]
):
    served_client, _ = served(monkeypatch, mixed)

    thai = served_client.get("/api/predict/premium").json()["latest_draw"]
    laos = served_client.get(
        "/api/predict/premium", params={"type": "laos"}
    ).json()["latest_draw"]

    # Both ledgers drew on 2026-10-01 and they are different draws. This is the
    # defect a `draw_date`-only key would produce: one row overwriting the other,
    # and one country's prize reported under the other's heading.
    assert thai["draw_date"] == laos["draw_date"] == "2026-10-01"
    assert thai["first_prize"] == THAI_LATEST
    assert laos["first_prize"] == LAOS_LATEST


def test_an_unseeded_country_degrades_instead_of_failing(
    monkeypatch: pytest.MonkeyPatch, mixed: list[dict]
):
    served_client, _ = served(monkeypatch, mixed)

    response = served_client.get("/api/predict/premium", params={"type": "vietnam"})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["lottery_type"] == "vietnam"
    assert payload["draws_analyzed"] == 0
    assert payload["positions"] == {}
    assert payload["status"] == "insufficient_data"
    assert payload["warnings"]  # a reason to show, not a blank panel


def test_every_supported_type_is_accepted(monkeypatch: pytest.MonkeyPatch, mixed: list[dict]):
    served_client, _ = served(monkeypatch, mixed)

    for kind in ("thai", "laos", "vietnam"):
        response = served_client.get("/api/predict/premium", params={"type": kind})
        assert response.status_code == 200, f"{kind}: {response.text}"
        assert response.json()["lottery_type"] == kind


def test_an_unknown_type_is_rejected_before_any_query(
    monkeypatch: pytest.MonkeyPatch, mixed: list[dict]
):
    served_client, fake = served(monkeypatch, mixed)

    response = served_client.get("/api/predict/premium", params={"type": "singapore"})

    # 422 from the query-parameter type — not a 500 from the database, and not an
    # empty success. An unplanned country is a client mistake, and the values that
    # are accepted are listed in the OpenAPI schema.
    assert response.status_code == 422, response.text
    assert fake.queries == []


def test_latest_draws_is_filtered_too(monkeypatch: pytest.MonkeyPatch, mixed: list[dict]):
    served_client, _ = served(monkeypatch, mixed)

    thai = served_client.get("/api/latest-draws", params={"limit": 5}).json()
    laos = served_client.get(
        "/api/latest-draws", params={"limit": 5, "type": "laos"}
    ).json()

    # The dashboard's "latest draw" stays the Thai one even though a Lao draw sits
    # on the same date: without this filter the two would interleave the moment Lao
    # ingestion starts, and the hero would show a Lao number under a Thai heading.
    assert {row["lottery_type"] for row in thai} == {"thai"}
    assert {row["lottery_type"] for row in laos} == {"laos"}
    assert thai[0]["draw_date"] == laos[0]["draw_date"] == "2026-10-01"


def test_health_advertises_the_ledgers(client: TestClient):
    payload = client.get("/api/health").json()

    assert payload["models"]["lottery_types"] == ["thai", "laos", "vietnam"]
