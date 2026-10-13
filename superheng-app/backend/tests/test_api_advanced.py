"""HTTP tests for `/api/predict/advanced`.

These exercise the endpoint the way a client does — a real request through the
ASGI app, real query-parameter validation, real JSON response — while stubbing
only the database read.

Stubbing `fetch_draw_history` rather than seeding a database is deliberate and
worth being explicit about: the `lottery_draws` table exists but is **empty**
(`Content-Range: */0`, verified against the live project), so an unstubbed test
would exercise the `insufficient_data` branch and say nothing about the success
path. What is *not* stubbed is the entire model stack — `analyse_draws_advanced`
runs for real, so the response shape, the RankEntry contract and the
reproducibility guarantee are all genuinely verified.

Requests use a short `limit` and the endpoint's minimum `simulations`, so the
suite stays quick without ever asking the published contract for less than the
Day 5 requirement. That floor is genuinely the cheap part to hold at: measured
on a 400-draw ledger, 10,000 draws and 100,000 draws differ by well under a
second, because the simulation is vectorised and ARIMA is what costs time.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import main


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


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A client whose database is stubbed but whose models are real."""
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: ledger_rows(limit))
    return TestClient(main.app)


@pytest.fixture()
def empty_client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: [])
    return TestClient(main.app)


def advanced(client: TestClient, **params):
    query = {"limit": 120, "simulations": 10_000, **params}
    response = client.get("/api/predict/advanced", params=query)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Wiring and shape
# ---------------------------------------------------------------------------


def test_the_endpoint_exists_and_returns_200(client: TestClient):
    assert client.get("/api/predict/advanced", params={"limit": 60, "simulations": 10_000}).status_code == 200


def test_health_reports_the_models_as_available(client: TestClient):
    payload = client.get("/api/health").json()

    assert payload["models"]["status"] == "implemented"
    assert payload["models"]["available"] == [
        "frequency",
        "markov",
        "timeseries",
        "montecarlo",
        "bayesian_positional",
    ]
    assert payload["models"]["endpoints"]["advanced"] == "/api/predict/advanced"
    assert payload["models"]["endpoints"]["premium"] == "/api/predict/premium"


def test_response_carries_the_documented_top_level_fields(client: TestClient):
    payload = advanced(client)

    for key in (
        "status",
        "model",
        "draws_analyzed",
        "date_range",
        "latest_draw",
        "weights_configured",
        "weights_note",
        "simulation",
        "channels",
        "warnings",
        "methodology",
    ):
        assert key in payload, f"missing {key}"
    assert payload["model"] == "advanced"
    assert set(payload["channels"]) == {"top", "bottom"}


def test_draws_analyzed_equals_the_requested_limit(client: TestClient):
    assert advanced(client, limit=90)["draws_analyzed"] == 90


def test_both_channels_return_five_picks(client: TestClient):
    channels = advanced(client)["channels"]

    for channel in ("top", "bottom"):
        assert len(channels[channel]["rankings"]) == 5


# ---------------------------------------------------------------------------
# The RankEntry contract, over HTTP
# ---------------------------------------------------------------------------


def test_rankings_match_the_frontend_rank_entry_contract(client: TestClient):
    """`RankEntry` in src/data/mock.ts, as the client destructures it."""
    for channel in advanced(client)["channels"].values():
        for entry in channel["rankings"]:
            assert isinstance(entry["code"], str) and len(entry["code"]) == 2
            assert entry["code"].isdigit()
            assert isinstance(entry["probability"], (int, float))
            assert 0.0 < entry["probability"] < 100.0
            assert isinstance(entry["score"], (int, float))
            assert 0.0 <= entry["score"] <= 100.0
            assert isinstance(entry["delta"], (int, float))
            assert entry["delta"] == 0.0
            assert entry["lastSeenDays"] is None or isinstance(entry["lastSeenDays"], int)
            assert isinstance(entry["reason"], str) and entry["reason"]
            assert entry["tone"] in {"high", "medium", "low", "cold"}


def test_the_reason_names_both_advanced_models(client: TestClient):
    for channel in advanced(client)["channels"].values():
        for entry in channel["rankings"]:
            assert "Monte Carlo simulations" in entry["reason"]
            assert "ARIMA" in entry["reason"]


def test_every_pick_publishes_its_per_signal_evidence(client: TestClient):
    for channel in advanced(client)["channels"].values():
        for entry in channel["rankings"]:
            evidence = entry["evidence"]
            assert set(evidence) >= {"frequency", "markov", "timeseries", "montecarlo", "contributions"}
            assert evidence["montecarlo"]["survival_rate"] > 0
            assert "order" in evidence["timeseries"]


def test_every_pick_publishes_all_four_model_statuses(client: TestClient):
    """Over the wire: no pick may omit a model, active or neutral."""
    for channel in advanced(client)["channels"].values():
        assert list(channel["model_statuses"]) == [
            "frequency",
            "markov",
            "timeseries",
            "montecarlo",
        ]
        for entry in channel["rankings"]:
            statuses = entry["model_statuses"]
            assert list(statuses) == ["frequency", "markov", "timeseries", "montecarlo"]
            for value in statuses.values():
                assert value["status"] in {"active", "neutral"}
                assert value["reason"] and value["detail"]
                assert value["weight"] >= 0.0


def test_the_basic_endpoint_also_lists_all_four_models(client: TestClient):
    """Day 3 publishes two live models, and names the two it does not use."""
    payload = client.get("/api/predict/basic", params={"limit": 120}).json()

    for channel in payload["channels"].values():
        statuses = channel["model_statuses"]
        assert statuses["frequency"]["status"] == "active"
        assert statuses["timeseries"]["reason"] == "not_in_blend"
        assert statuses["montecarlo"]["reason"] == "not_in_blend"
        for entry in channel["rankings"]:
            assert list(entry["model_statuses"]) == [
                "frequency",
                "markov",
                "timeseries",
                "montecarlo",
            ]


def test_published_probabilities_sum_to_one_draw_per_channel(client: TestClient):
    """The coherence property the ARIMA signal broke and the ensemble restores."""
    for channel in advanced(client)["channels"].values():
        normalisation = channel["probability_normalisation"]
        assert normalisation["raw_total"] > 100.0
        assert 0.98 < normalisation["scale"] < 1.0


# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------


def test_the_seed_is_echoed_and_honoured(client: TestClient):
    first = advanced(client, seed=1)["simulation"]
    second = advanced(client, seed=2)["simulation"]

    assert first["seed"] == 1
    assert second["seed"] == 2


def test_identical_requests_reproduce_every_score(client: TestClient):
    first = advanced(client, seed=5)
    second = advanced(client, seed=5)

    def strip(node):
        if isinstance(node, dict):
            return {k: strip(v) for k, v in node.items() if not k.endswith("_ms")}
        if isinstance(node, list):
            return [strip(item) for item in node]
        return node

    assert strip(first) == strip(second)


def test_top_k_is_echoed(client: TestClient):
    assert advanced(client, top_k=3)["simulation"]["top_k"] == 3


def test_simulations_are_echoed(client: TestClient):
    assert advanced(client, simulations=20_000)["simulation"]["simulations"] == 20_000


@pytest.mark.parametrize(
    "params",
    [
        {"simulations": 9_999},  # one below the 10,000 floor the Day 5 spec sets
        {"simulations": 1_000_001},  # above the ceiling
        {"top_k": 0},
        {"top_k": 101},
        {"seed": -1},
        {"limit": 1},  # the models need at least 2 rows
    ],
)
def test_out_of_range_parameters_are_rejected(client: TestClient, params):
    response = client.get("/api/predict/advanced", params={"limit": 60, "simulations": 10_000, **params})
    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# Degraded and failing paths
# ---------------------------------------------------------------------------


def test_an_empty_ledger_is_an_empty_state_not_an_error(empty_client: TestClient):
    response = empty_client.get("/api/predict/advanced", params={"simulations": 10_000})
    assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "insufficient_data"
    assert payload["draws_analyzed"] == 0
    assert payload["latest_draw"] is None
    for channel in payload["channels"].values():
        assert channel["rankings"] == []
    assert payload["warnings"]


def test_a_model_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    """A model bug must surface as a 500 with detail, never as a broken 200."""
    import models

    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(main, "fetch_draw_history", lambda _client, limit: ledger_rows(limit))

    def explode(*args, **kwargs):
        raise RuntimeError("ensemble exploded")

    # The endpoint imports `analyse_draws_advanced` lazily from `models`, so the
    # patch has to land on the package rather than on `main`.
    monkeypatch.setattr(models, "analyse_draws_advanced", explode)

    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/predict/advanced", params={"limit": 60, "simulations": 10_000}
    )

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "Failed to compute advanced predictions" in detail
    assert "ensemble exploded" in detail


def test_a_database_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "get_supabase", lambda: object())

    def explode(_client, _limit):
        raise RuntimeError("PGRST205 could not find the table")

    monkeypatch.setattr(main, "fetch_draw_history", explode)
    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/predict/advanced", params={"limit": 60, "simulations": 10_000}
    )

    assert response.status_code == 500
    assert "Failed to fetch draw history" in response.json()["detail"]


def test_the_basic_endpoint_still_works_alongside_the_advanced_one(client: TestClient):
    """Day 3's contract must not have moved. `limit` is shared by both."""
    response = client.get("/api/predict/basic", params={"limit": 120})
    assert response.status_code == 200

    payload = response.json()
    assert "channels" in payload
    assert "rankings" in payload["channels"]["top"]
