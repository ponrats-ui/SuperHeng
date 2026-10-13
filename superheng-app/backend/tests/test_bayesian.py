"""Tests for the Premium Bayesian positional model.

Two layers, deliberately separated:

* **Model tests** run the math against a hand-built ledger whose counts can be
  computed by hand, so every posterior assertion is an exact fraction rather than
  a shape check. The conditional shrinkage, the unvisited-state fallback and the
  digit tie-break are all pinned to numbers worked out on paper.
* **HTTP tests** exercise `/api/predict/premium` the way a client does — a real
  request through the ASGI app — while stubbing only the database read, exactly as
  `test_api_advanced.py` does. The whole model runs for real.

The ledger in `PRIZES` is chronological (oldest first), as the model requires.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import main
from models.bayesian import (
    DEFAULT_MIN_SUPPORT,
    POSITION_NAMES,
    POSITIONS,
    BayesianPositionalModel,
    analyse_positions,
    _prepare_prizes,
)

# index:            012345
# prize[2:6] = thousands, hundreds, tens, units
PRIZES = [
    "000000",
    "000000",
    "000010",
    "000011",
    "000012",
    "000013",
    "000024",
    "000016",  # latest: tens=1, units=6
]

# Derived by hand from PRIZES (N = 8) and asserted below:
#   units marginal counts : 0 -> 3, 1 -> 1, 2 -> 1, 3 -> 1, 6 -> 1
#   units row for tens = 1 : joint 0->1, 1->1, 2->1, 3->1, 6->1 (row_total 5)
UNIT_ROW_TOTAL = 5
UNIT_MARGINAL_0 = 4 / 18  # (3 + 1) / (8 + 10)
UNIT_MARGINAL_6 = 2 / 18  # (1 + 1) / (8 + 10)
# conditional[1][y] = (joint + 1 * marginal) / (5 + 1)
UNIT_CONDITIONAL_0 = (1 + UNIT_MARGINAL_0) / (UNIT_ROW_TOTAL + 1)
# Digits 1, 2, 3 and 6 each carry exactly one joint observation and share the
# same marginal, so their conditionals are identical: 5/27.
UNIT_CONDITIONAL_TIE = (1 + UNIT_MARGINAL_6) / (UNIT_ROW_TOTAL + 1)


@pytest.fixture()
def model() -> BayesianPositionalModel:
    return BayesianPositionalModel(PRIZES)


# ---------------------------------------------------------------------------
# Data preparation
# ---------------------------------------------------------------------------


def test_positions_are_the_lower_four_digits_and_their_indices_match():
    assert POSITION_NAMES == ("thousands", "hundreds", "tens", "units")
    assert [spec.index for spec in POSITIONS] == [2, 3, 4, 5]
    # Each target's conditioning neighbour is the one immediately to its left.
    assert [spec.higher_index for spec in POSITIONS] == [1, 2, 3, 4]


def test_prepare_prizes_sorts_chronologically_and_keeps_the_full_prize():
    rows = [
        {"draw_date": "2026-10-01", "first_prize": "402701"},
        {"draw_date": "2026-09-16", "first_prize": "730640"},
        {"draw_date": "2026-09-01", "first_prize": "113410"},
    ]
    prizes, warnings = _prepare_prizes(rows)

    assert warnings == []
    assert [prize for _, prize in prizes] == ["113410", "730640", "402701"]
    assert prizes[0][0] == "2026-09-01" and prizes[-1][0] == "2026-10-01"


def test_prepare_prizes_drops_and_reports_bad_rows():
    rows = [
        {"draw_date": "2026-10-01", "first_prize": "402701"},
        {"draw_date": "not-a-date", "first_prize": "123456"},
        {"draw_date": "2026-09-16", "first_prize": "12345"},  # 5 digits
        {"draw_date": "2026-09-01", "first_prize": "ABCDEF"},
    ]
    prizes, warnings = _prepare_prizes(rows)

    assert [prize for _, prize in prizes] == ["402701"]
    assert any("unparseable draw_date" in warning for warning in warnings)
    assert any("not exactly 6 digits" in warning for warning in warnings)


def test_empty_rows_report_a_warning_without_raising():
    prizes, warnings = _prepare_prizes([])
    assert prizes == []
    assert warnings == ["No draw rows were supplied."]


# ---------------------------------------------------------------------------
# Posterior math — exact fractions
# ---------------------------------------------------------------------------


def test_marginal_posterior_matches_the_dirichlet_mean(model):
    assert model.marginal_posterior["units"]["0"] == pytest.approx(UNIT_MARGINAL_0)
    assert model.marginal_posterior["units"]["6"] == pytest.approx(UNIT_MARGINAL_6)
    # Ten digits, uniform alpha=1: the posterior over the whole alphabet sums to 1.
    assert sum(model.marginal_posterior["units"].values()) == pytest.approx(1.0)


def test_conditional_posterior_matches_the_shrunk_fraction(model):
    row = model.conditional_posterior["units"]["1"]
    assert row["0"] == pytest.approx(UNIT_CONDITIONAL_0)
    assert row["6"] == pytest.approx(UNIT_CONDITIONAL_TIE)
    assert row["1"] == pytest.approx(UNIT_CONDITIONAL_TIE)
    assert UNIT_CONDITIONAL_0 == pytest.approx(11 / 54)
    assert UNIT_CONDITIONAL_TIE == pytest.approx(5 / 27)
    assert sum(row.values()) == pytest.approx(1.0)


def test_an_unvisited_state_falls_back_to_the_marginal_exactly(model):
    unseen = model.conditional_posterior["units"]["9"]  # tens = 9 never happens
    assert model.row_counts["units"]["9"] == 0
    for digit in "0123456789":
        assert unseen[digit] == pytest.approx(model.marginal_posterior["units"][digit])


@pytest.mark.parametrize("name", POSITION_NAMES)
def test_every_conditional_row_is_a_distribution(model, name):
    for higher in "0123456789":
        assert sum(model.conditional_posterior[name][higher].values()) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Ranking and reasons
# ---------------------------------------------------------------------------


def test_top_three_is_ranked_by_the_conditional_posterior(model):
    units = model.predict()["units"]

    assert units["conditioned_digit"] == "1"  # latest draw's tens digit
    assert units["support"] == UNIT_ROW_TOTAL
    assert units["usable"] is True
    assert units["basis"] == "conditional"

    # Ties (1, 2, 3, 6 all at 5/27) break by ascending digit, so the second and
    # third picks are deterministic rather than dependent on dict order.
    assert [entry["digit"] for entry in units["top"]] == ["0", "1", "2"]
    # Probabilities are rounded to 6 dp in the payload.
    assert units["top"][0]["probability"] == pytest.approx(UNIT_CONDITIONAL_0, abs=1e-6)
    assert units["top"][1]["probability"] == pytest.approx(UNIT_CONDITIONAL_TIE, abs=1e-6)
    assert units["top"][2]["probability"] == pytest.approx(UNIT_CONDITIONAL_TIE, abs=1e-6)


def test_every_pick_publishes_a_probability_in_range_and_a_reason(model):
    for payload in model.predict().values():
        assert len(payload["top"]) == 3
        for entry in payload["top"]:
            assert entry["digit"] in "0123456789"
            assert 0.0 < entry["probability"] <= 1.0
            assert entry["reason"]
            assert entry["basis"] in {"conditional", "marginal"}


def test_the_conditional_reason_quotes_the_counts_it_used(model):
    entry = model.predict()["units"]["top"][0]

    assert "tens digit of 1" in entry["reason"]
    assert "1 of 5 historical draws" in entry["reason"]
    assert "posterior vs" in entry["reason"]


def test_a_thin_state_falls_back_to_the_marginal_and_says_so():
    # Force every conditioning row to be too thin to trust.
    guarded = BayesianPositionalModel(PRIZES, min_support=100)
    payload = guarded.predict()["units"]

    assert payload["usable"] is False
    assert payload["basis"] == "marginal"
    # Ranked on the marginal: '0' has the highest marginal count (3 of 8).
    assert payload["top"][0]["digit"] == "0"
    assert payload["top"][0]["probability"] == pytest.approx(UNIT_MARGINAL_0, abs=1e-6)
    assert "ranked on the marginal" in payload["top"][0]["reason"]


def test_the_distribution_published_is_the_one_it_ranked_on(model):
    units = model.predict()["units"]
    assert set(units["distribution"]) == set("0123456789")
    # Each element is rounded to 6 dp for JSON, so the total is 1.0 up to that.
    assert sum(units["distribution"].values()) == pytest.approx(1.0, abs=1e-5)
    assert units["distribution"]["0"] == pytest.approx(UNIT_CONDITIONAL_0, abs=1e-6)
    assert units["marginal_distribution"]["0"] == pytest.approx(UNIT_MARGINAL_0, abs=1e-6)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"prior_alpha": 0},
        {"pseudocount": 0},
        {"min_support": -1},
        {"top_n": 0},
    ],
)
def test_invalid_configuration_is_rejected(kwargs):
    with pytest.raises(ValueError):
        BayesianPositionalModel(PRIZES, **kwargs)


# ---------------------------------------------------------------------------
# The payload wrapper
# ---------------------------------------------------------------------------


def ledger_rows(count: int, seed: int = 20261013) -> list[dict]:
    """Newest-first, as `fetch_draw_history` returns them."""
    rng = random.Random(seed)
    cursor = date(2026, 10, 1)
    dates: list[date] = []
    while len(dates) < count:
        dates.append(cursor)
        cursor = cursor - timedelta(days=15) if cursor.day == 1 else cursor.replace(day=1)

    return [
        {
            "draw_date": draw_date.isoformat(),
            "first_prize": "".join(str(rng.randrange(10)) for _ in range(6)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for draw_date in dates  # newest first
    ]


def test_an_empty_ledger_is_an_empty_state_not_an_error():
    payload = analyse_positions([])

    assert payload["status"] == "insufficient_data"
    assert payload["draws_analyzed"] == 0
    assert payload["positions"] == {}
    assert payload["latest_draw"] is None
    assert payload["warnings"]


def test_a_full_ledger_reports_ok_status():
    payload = analyse_positions(ledger_rows(120))

    assert payload["status"] == "ok"
    assert payload["draws_analyzed"] == 120
    assert set(payload["positions"]) == set(POSITION_NAMES)
    assert all(item["usable"] for item in payload["positions"].values())


def test_a_short_ledger_is_limited_not_ok():
    payload = analyse_positions(ledger_rows(20))

    assert payload["status"] == "limited"
    assert any("indicative only" in warning for warning in payload["warnings"])


def test_a_ledger_below_the_floor_publishes_no_picks():
    payload = analyse_positions(ledger_rows(3))  # 3 < MIN_DRAWS_ANY (5)

    assert payload["status"] == "insufficient_data"
    assert payload["positions"] == {}
    assert payload["latest_draw"] is not None


# ---------------------------------------------------------------------------
# HTTP — /api/predict/premium
# ---------------------------------------------------------------------------


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: ledger_rows(limit))
    return TestClient(main.app)


@pytest.fixture()
def empty_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: [])
    return TestClient(main.app)


def test_the_endpoint_exists_and_returns_200(client: TestClient):
    response = client.get("/api/predict/premium", params={"limit": 120})
    assert response.status_code == 200, response.text


def test_health_reports_the_premium_model_and_endpoint(client: TestClient):
    models = client.get("/api/health").json()["models"]

    assert "bayesian_positional" in models["available"]
    assert models["endpoints"]["premium"] == "/api/predict/premium"


def test_response_carries_the_documented_top_level_fields(client: TestClient):
    payload = client.get("/api/predict/premium", params={"limit": 120}).json()

    for key in (
        "status",
        "model",
        "draws_analyzed",
        "date_range",
        "latest_draw",
        "positions",
        "warnings",
        "methodology",
    ):
        assert key in payload, f"missing {key}"
    assert payload["model"] == "bayesian_positional"
    assert set(payload["positions"]) == set(POSITION_NAMES)


def test_every_position_returns_three_scored_digits_over_http(client: TestClient):
    positions = client.get("/api/predict/premium", params={"limit": 120}).json()["positions"]

    for payload in positions.values():
        assert len(payload["top"]) == 3
        for entry in payload["top"]:
            assert entry["digit"] in "0123456789"
            assert 0.0 < entry["probability"] <= 1.0
            assert isinstance(entry["reason"], str) and entry["reason"]
            assert entry["basis"] in {"conditional", "marginal"}


def test_an_empty_ledger_is_an_empty_state_over_http(empty_client: TestClient):
    response = empty_client.get("/api/predict/premium")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "insufficient_data"
    assert payload["draws_analyzed"] == 0
    assert payload["positions"] == {}
    assert payload["warnings"]


def test_a_model_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    import models.bayesian as bayesian

    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: ledger_rows(limit))

    def explode(*_args, **_kwargs):
        raise RuntimeError("positional model exploded")

    # The endpoint imports `analyse_positions` lazily from the module, so the
    # patch has to land there rather than on `main`.
    monkeypatch.setattr(bayesian, "analyse_positions", explode)

    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/predict/premium", params={"limit": 120}
    )

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "Failed to compute premium predictions" in detail
    assert "positional model exploded" in detail


def test_a_database_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "get_supabase", lambda: object())

    def explode(_client, _limit):
        raise RuntimeError("PGRST205 could not find the table")

    monkeypatch.setattr(main, "fetch_draw_history", explode)
    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/predict/premium", params={"limit": 120}
    )

    assert response.status_code == 500
    assert "Failed to fetch draw history" in response.json()["detail"]


def test_out_of_range_limit_is_rejected(client: TestClient):
    assert client.get("/api/predict/premium", params={"limit": 1}).status_code == 422
