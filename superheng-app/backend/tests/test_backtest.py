"""Tests for the walk-forward backtest engine and `GET /api/backtest`.

Three properties are load-bearing enough to be tested deliberately rather than
incidentally:

1. **No leakage.** For every replayed draw the model must be handed only draws
   strictly earlier than its target. This is asserted by *spying on the rows the
   model actually receives* (`test_the_model_never_sees_the_target_or_any_later_draw`),
   not by re-deriving the slice the way the implementation does — a test that
   recomputes the implementation's own arithmetic would pass for a wrong
   implementation too.
2. **The baseline is beside every headline number.** ROADMAP.md requires it, and a
   hit rate published without its baseline is the failure this whole endpoint
   exists to prevent.
3. **The reported arithmetic is right.** ROI, the break-even rate and the binomial
   tail are checked against hand-computed values, because a metrics endpoint that
   is subtly wrong about money is worse than one that is absent.
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

import backtest
import main
import services


def ledger_rows(count: int, digits: int = 6, seed: int = 20261013) -> list[dict]:
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
            "first_prize": "".join(str(rng.randrange(10)) for _ in range(digits)),
            "bottom_two": f"{rng.randrange(100):02d}",
        }
        for draw_date in dates  # newest first
    ]


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch, premium_account) -> TestClient:
    """Stubbed database, real models — the endpoint's whole compute path runs."""
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, limit, _type=main.LotteryType.thai: ledger_rows(limit),
    )
    return TestClient(main.app)


@pytest.fixture()
def empty_client(monkeypatch: pytest.MonkeyPatch, premium_account) -> TestClient:
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, limit, _type=main.LotteryType.thai: [],
    )
    return TestClient(main.app)


def replay(client: TestClient, **params):
    query = {"draws": 10, **params}
    response = client.get("/api/backtest", params=query)
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# The leakage boundary
# ---------------------------------------------------------------------------


def synthetic_frame():
    """A 50-draw chronological frame, oldest first, as the engine receives it."""
    frame, _ = services.prepare_history(ledger_rows(50))
    return frame


def test_training_slice_holds_only_earlier_draws():
    frame = synthetic_frame()

    window = backtest.training_slice(frame, 10, 100)

    assert len(window) == 10
    target_date = frame.iloc[10].draw_date.date().isoformat()
    assert all(row["draw_date"] < target_date for row in window)
    assert window[-1]["draw_date"] == frame.iloc[9].draw_date.date().isoformat()


def test_training_slice_respects_the_window_and_never_goes_negative():
    frame = synthetic_frame()

    assert len(backtest.training_slice(frame, 10, 4)) == 4
    # The first draw in the ledger has no history at all — an empty slice, not a
    # wrap-around into the future.
    assert backtest.training_slice(frame, 0, 100) == []


def test_the_first_target_is_never_trained_on_itself():
    """Index 0 has nothing before it, so it cannot be scored without fabrication."""
    frame = synthetic_frame()
    assert backtest.training_slice(frame, 0, 400) == []


def test_the_model_never_sees_the_target_or_any_later_draw(monkeypatch: pytest.MonkeyPatch):
    """The leakage guarantee, asserted by spying on the rows the model is handed.

    Each call to `services.analyse_draws` is recorded together with the draw being
    predicted at that moment. For every call: the target's date is absent from the
    training rows, and every training date is strictly older.
    """
    rows = ledger_rows(40)
    seen: list[list[dict]] = []

    def spy(train_rows, **kwargs):
        # Copy: the engine builds a fresh list per step, but a spy must not depend
        # on that staying true.
        seen.append(list(train_rows))
        return {"channels": {"top": {"rankings": []}, "bottom": {"rankings": []}}}

    monkeypatch.setattr(services, "analyse_draws", spy)
    monkeypatch.setattr(backtest, "_position_predictions", lambda *a, **k: ({}, {}))

    payload = backtest.run_backtest(
        rows, lottery_type="thai", draws=10, train_window=100, prize_digits=6
    )

    assert payload["draws_evaluated"] == 10
    # 40 rows, the last 10 replayed.
    frame, _ = services.prepare_history(rows)
    target_dates = [frame.iloc[index].draw_date.date().isoformat() for index in range(30, 40)]

    assert len(seen) == 10
    for offset, (train_rows, target_date) in enumerate(zip(seen, target_dates)):
        assert train_rows, "a step was scored with no history at all"
        dates = [row["draw_date"] for row in train_rows]
        assert target_date not in dates, "the target leaked into its own training set"
        assert all(trained < target_date for trained in dates)
        # The window grows with the target until it hits the cap: the first replayed
        # draw has 30 earlier draws, the last has 39, and neither may exceed 100.
        assert len(train_rows) == min(100, 30 + offset)


def test_training_rows_are_passed_newest_last(monkeypatch: pytest.MonkeyPatch):
    """Chronological order is what makes the Markov step mean 'the next draw'."""
    captured: list[list[str]] = []
    monkeypatch.setattr(
        services,
        "analyse_draws",
        lambda train_rows, **kwargs: (
            captured.append([row["draw_date"] for row in train_rows])
            or {"channels": {"top": {"rankings": []}, "bottom": {"rankings": []}}}
        ),
    )
    monkeypatch.setattr(backtest, "_position_predictions", lambda *a, **k: ({}, {}))

    backtest.run_backtest(
        ledger_rows(40), lottery_type="thai", draws=5, train_window=100, prize_digits=6
    )

    for dates in captured:
        assert dates == sorted(dates), "training rows arrived out of chronological order"


# ---------------------------------------------------------------------------
# Metrics arithmetic
# ---------------------------------------------------------------------------


def test_binomial_tail_matches_hand_computed_values():
    assert backtest.binomial_tail(0, 30, 0.01) == 1.0
    assert backtest.binomial_tail(31, 30, 0.01) == 0.0
    # P(X >= 30) for p = 0.5 is 0.5**30.
    assert backtest.binomial_tail(30, 30, 0.5) == pytest.approx(0.5**30)
    # One hit in two fair trials: P(X >= 1) = 0.75.
    assert backtest.binomial_tail(1, 2, 0.5) == pytest.approx(0.75)
    # The tail is monotone decreasing in k.
    tails = [backtest.binomial_tail(k, 30, 0.05) for k in range(0, 8)]
    assert all(earlier >= later for earlier, later in zip(tails, tails[1:]))


def test_hits_needed_for_significance_is_the_smallest_qualifying_count():
    needed = backtest.hits_needed_for_significance(30, 0.05)
    assert needed is not None
    assert backtest.binomial_tail(needed, 30, 0.05) < 0.05
    assert backtest.binomial_tail(needed - 1, 30, 0.05) >= 0.05
    # Five hits, not four: the tail at k=4 is P(X=4)+P(X>=5) = 0.0608, still above
    # alpha, because the bound sums every value at or above the count. Getting this
    # wrong would have the report claim significance one hit too early.
    assert needed == 5
    assert backtest.binomial_tail(4, 30, 0.05) == pytest.approx(0.0608, abs=0.001)

    # The exact 1-in-100 game resolves even later: two hits is the floor at n=30.
    assert backtest.hits_needed_for_significance(30, 0.01) == 2


def test_roi_is_the_net_return_over_the_stake():
    # 1 hit in 30 draws at 25x: 25 returned against 30 staked.
    block = backtest._roi(1, 30.0, 25.0)
    assert block["staked"] == 30.0
    assert block["returned"] == 25.0
    assert block["net"] == -5.0
    assert block["roi_percent"] == pytest.approx(-16.67, abs=0.01)

    # A losing run returns nothing and loses the whole stake.
    assert backtest._roi(0, 30.0, 25.0)["roi_percent"] == -100.0

    # Break-even: exactly payout hits in payout draws.
    assert backtest._roi(25, 625.0, 25.0)["roi_percent"] == 0.0


def test_break_even_rate_is_the_inverse_of_the_payout():
    rows = ledger_rows(60)
    payload = backtest.run_backtest(
        rows, lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    economy = payload["economy"]
    assert economy["payout_multiple"] == 25.0
    assert economy["break_even_hit_rate_percent"] == 4.0
    for report in payload["channels"].values():
        if report["available"]:
            assert report["roi"]["break_even_hit_rate_percent"] == 4.0


def test_roi_covers_both_the_single_pick_and_the_full_cover():
    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    for report in payload["channels"].values():
        if not report["available"]:
            continue
        exact, cover = report["roi"]["exact"], report["roi"]["cover"]
        # The cover stakes five units per draw, so its stake is five times as large
        # for the same number of draws.
        assert cover["ai"]["staked"] == exact["ai"]["staked"] * 5
        assert cover["random"]["staked"] == exact["random"]["staked"] * 5
        assert exact["strategy"] != cover["strategy"]


def test_a_payout_override_is_honoured():
    payload = backtest.run_backtest(
        ledger_rows(60),
        lottery_type="thai",
        draws=10,
        train_window=40,
        prize_digits=6,
        payout_multiple=100.0,
    )
    assert payload["economy"]["payout_multiple"] == 100.0
    assert payload["economy"]["break_even_hit_rate_percent"] == 1.0


# ---------------------------------------------------------------------------
# The random baseline
# ---------------------------------------------------------------------------


def make_steps(count: int, actual: str = "42") -> list[backtest.EvaluatedStep]:
    return [
        backtest.EvaluatedStep(
            draw_date=f"2020-{(index % 12) + 1:02d}-01",
            prize="000000",
            actual={"top": actual, "bottom": actual},
            picks={"top": ("42", "07", "19", "88", "03"), "bottom": ("42", "07", "19", "88", "03")},
        )
        for index in range(count)
    ]


def test_the_random_baseline_is_not_the_model(monkeypatch: pytest.MonkeyPatch):
    """A baseline that matches the model everywhere would prove nothing."""
    steps = make_steps(50)
    backtest.attach_random_baseline(steps)

    assert len({step.random_picks["top"] for step in steps}) > 1
    matches = sum(1 for step in steps if step.random_picks["top"] == step.picks["top"])
    assert matches < len(steps)


def test_the_random_baseline_converges_on_the_uniform_rate():
    """The simulated baseline must agree with the closed-form one.

    This is the sanity check that makes the baseline *usable*: if the simulated line
    drifted away from 1% and 5%, the model-vs-baseline comparison on screen would be
    comparing against a bug.
    """
    steps = make_steps(4000)
    backtest.attach_random_baseline(steps)

    exact = sum(1 for step in steps if step.random_picks["top"][0] == "42") / len(steps)
    top5 = sum(1 for step in steps if "42" in step.random_picks["top"]) / len(steps)

    assert exact == pytest.approx(0.01, abs=0.004)
    assert top5 == pytest.approx(0.05, abs=0.008)


def test_the_random_baseline_is_reproducible():
    first, second = make_steps(30), make_steps(30)
    backtest.attach_random_baseline(first)
    backtest.attach_random_baseline(second)
    assert [step.random_picks for step in first] == [step.random_picks for step in second]


def test_the_seeded_baseline_does_not_move_between_runs():
    """Re-running the endpoint must not move the comparison line."""
    rows = ledger_rows(60)
    first = backtest.run_backtest(
        rows, lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )
    second = backtest.run_backtest(
        rows, lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    assert first["random_baseline"]["seed"] == second["random_baseline"]["seed"]
    for channel in ("top", "bottom"):
        assert (
            first["channels"][channel]["random"] == second["channels"][channel]["random"]
        )


# ---------------------------------------------------------------------------
# Baselines beside every headline number (the ROADMAP requirement)
# ---------------------------------------------------------------------------


def test_every_published_rate_carries_its_baseline():
    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    for channel in ("top", "bottom"):
        report = payload["channels"][channel]
        if not report["available"]:
            continue
        # The AI's number, the closed-form baseline, the simulated baseline, and a
        # significance test — all four, or the rate is not publishable.
        assert report["ai"]["exact_hit_rate_percent"] is not None
        assert report["uniform"]["exact_hit_rate_percent"] == 1.0
        assert report["uniform"]["top_5_hit_rate_percent"] == 5.0
        assert report["random"]["exact_hit_rate_percent"] is not None
        assert 0.0 <= report["skill"]["exact_p_value"] <= 1.0
        assert isinstance(report["skill"]["exact_significant"], bool)
        assert report["skill"]["exact_hits_needed"] is not None

    overall = payload["positional"]["overall"]
    assert overall["baseline_percent"] == 10.0
    assert overall["hit_rate_percent"] is not None
    assert 0.0 <= overall["p_value"] <= 1.0


def test_the_power_block_says_what_the_window_cannot_resolve():
    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    power = payload["power"]
    assert power["draws"] == 10
    assert power["exact_hits_needed"] is not None
    assert "cannot resolve" in power["note"]


def test_the_excluded_ensemble_is_stated_rather_than_dropped():
    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    assert payload["models"] == ["frequency", "markov", "bayesian_positional"]
    assert payload["models_excluded"]
    excluded = payload["models_excluded"][0]
    assert "ARIMA" in excluded["model"]
    # The reason must be the measurement, so the omission can be re-checked.
    assert "8.28 s" in excluded["reason"]


# ---------------------------------------------------------------------------
# Ledger-shape behaviour
# ---------------------------------------------------------------------------


def test_the_scores_are_not_biased_by_which_draws_were_usable():
    """A channel's denominator must not include draws it could not score.

    Vietnam's first prize is five digits, so the `top` channel is not derivable. Its
    `bottom` channel *is* — the derived tail — so the denominator has to be those
    draws, not the dropped `top` rows. Getting this wrong dilutes every rate.
    """
    payload = backtest.run_backtest(
        ledger_rows(60, digits=5),
        lottery_type="vietnam",
        draws=10,
        train_window=40,
        prize_digits=5,
    )

    assert payload["channels"]["top"]["available"] is False
    assert "reason" in payload["channels"]["top"]
    assert payload["channels"]["bottom"]["available"] is True
    assert payload["channels"]["bottom"]["draws"] == len(payload["channels"]["bottom"]["timeline"])


def test_vietnam_publishes_five_positions_not_six():
    payload = backtest.run_backtest(
        ledger_rows(60, digits=5),
        lottery_type="vietnam",
        draws=10,
        train_window=40,
        prize_digits=5,
    )

    positions = payload["positional"]["positions"]
    assert list(positions) == [
        "ten_thousands",
        "thousands",
        "hundreds",
        "tens",
        "units",
    ]
    assert payload["prize_digits"] == 5


def test_thailand_publishes_six_positions_in_reading_order():
    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )

    assert list(payload["positional"]["positions"]) == [
        "hundred_thousands",
        "ten_thousands",
        "thousands",
        "hundreds",
        "tens",
        "units",
    ]


def test_a_position_is_never_scored_where_the_digit_was_absent():
    """Two missing digits must not compare equal and count as a hit."""
    payload = backtest.run_backtest(
        ledger_rows(60, digits=5),
        lottery_type="vietnam",
        draws=10,
        train_window=40,
        prize_digits=5,
    )

    for report in payload["positional"]["positions"].values():
        assert report["predictions"] >= report["hits"]
        assert report["predictions"] <= payload["positional"]["draws"]


def test_an_empty_ledger_is_an_empty_state_not_an_error():
    payload = backtest.run_backtest(
        [], lottery_type="thai", draws=30, train_window=400, prize_digits=6
    )

    assert payload["status"] == "insufficient_data"
    assert payload["draws_evaluated"] == 0
    assert payload["channels"] == {}
    assert payload["warnings"]


def test_asking_for_more_draws_than_the_ledger_holds_is_reported_not_hidden():
    """A ledger too short to replay is reported, never padded out.

    25 draws with a 30-draw request is a double shortfall: five of the draws are
    past the end of the ledger, and most of the rest have too little history behind
    them to score. Both facts must be visible in the payload, because a smaller
    ``draws_evaluated`` than ``draws_requested`` is the honest outcome and silently
    returning 25 scored draws would not be.
    """
    payload = backtest.run_backtest(
        ledger_rows(25), lottery_type="thai", draws=30, train_window=400, prize_digits=6
    )

    assert payload["draws_requested"] == 30
    assert payload["draws_evaluated"] < payload["draws_requested"]
    assert payload["status"] == "limited"
    assert payload["warnings"]


def test_steps_without_enough_history_are_skipped_and_counted():
    payload = backtest.run_backtest(
        ledger_rows(30), lottery_type="thai", draws=20, train_window=400, prize_digits=6
    )

    # 30 rows with a 20-draw replay: the earliest targets have 10 rows of history,
    # below MIN_TRAIN_DRAWS, so they are skipped rather than guessed at.
    assert payload["draws_evaluated"] == 10
    assert payload["status"] == "limited"
    assert any("fewer than" in warning for warning in payload["warnings"])


def test_the_payload_is_json_serialisable():
    import json

    payload = backtest.run_backtest(
        ledger_rows(60), lottery_type="thai", draws=10, train_window=40, prize_digits=6
    )
    assert json.loads(json.dumps(payload))["engine"] == "walk_forward"


def test_the_engine_never_exceeds_the_requested_draws():
    payload = backtest.run_backtest(
        ledger_rows(200), lottery_type="thai", draws=15, train_window=100, prize_digits=6
    )
    assert payload["draws_evaluated"] == 15
    assert len(payload["channels"]["top"]["timeline"]) == 15


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


def test_the_endpoint_exists_and_returns_200(client: TestClient):
    response = client.get("/api/backtest", params={"draws": 10})
    assert response.status_code == 200, response.text


def test_health_advertises_the_backtest_endpoint(client: TestClient):
    payload = client.get("/api/health").json()
    assert payload["models"]["endpoints"]["backtest"] == "/api/backtest"


def test_the_ledger_is_echoed(client: TestClient):
    assert replay(client, type="laos")["lottery_type"] == "laos"
    assert replay(client, type="thai")["lottery_type"] == "thai"


def test_an_unknown_ledger_is_rejected(client: TestClient):
    """The same discriminator the deploy check uses: the enum is in the signature."""
    response = client.get("/api/backtest", params={"type": "bogus"})
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("params", [{"draws": 1}, {"draws": 0}, {"draws": 61}, {"draws": -5}])
def test_out_of_range_draws_are_rejected(client: TestClient, params):
    assert client.get("/api/backtest", params=params).status_code == 422


def test_a_payout_override_reaches_the_response(client: TestClient):
    payload = replay(client, payout_multiple=50)
    assert payload["economy"]["payout_multiple"] == 50.0


def test_an_empty_ledger_is_an_empty_state_over_http(empty_client: TestClient):
    response = empty_client.get("/api/backtest", params={"draws": 30})
    assert response.status_code == 200

    payload = response.json()
    assert payload["status"] == "insufficient_data"
    assert payload["draws_evaluated"] == 0
    assert payload["warnings"]


def test_a_database_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "get_supabase", lambda: object())

    def explode(_client, _limit, _type=None):
        raise RuntimeError("PGRST205 could not find the table")

    monkeypatch.setattr(main, "fetch_draw_history", explode)
    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/backtest", params={"draws": 10}
    )

    assert response.status_code == 500
    assert "Failed to fetch" in response.json()["detail"]


def test_a_model_failure_becomes_a_500_with_detail(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(main, "get_supabase", lambda: object())
    monkeypatch.setattr(
        main,
        "fetch_draw_history",
        lambda _client, limit, _type=main.LotteryType.thai: ledger_rows(limit),
    )

    def explode(*_args, **_kwargs):
        raise RuntimeError("backtest exploded")

    monkeypatch.setattr(backtest, "run_backtest", explode)
    response = TestClient(main.app, raise_server_exceptions=False).get(
        "/api/backtest", params={"draws": 10}
    )

    assert response.status_code == 500
    detail = response.json()["detail"]
    assert "Failed to compute the backtest" in detail
    assert "backtest exploded" in detail


def test_the_prediction_endpoints_still_work_alongside_the_backtest(client: TestClient):
    """A new route must not shadow or disturb the existing ones."""
    assert client.get("/api/predict/basic", params={"limit": 120}).status_code == 200
    assert client.get("/api/predict/premium", params={"limit": 120}).status_code == 200
    assert client.get("/api/backtest", params={"draws": 10}).status_code == 200


def test_the_http_payload_is_leak_free_over_the_wire(client: TestClient):
    """End to end: the contract is stated in the response, not only in the code."""
    payload = replay(client, type="thai")

    assert payload["engine"] == "walk_forward"
    assert "strictly earlier" in payload["leakage_guard"]
    assert payload["train_sizes"]["max"] >= payload["train_sizes"]["min"] > 0
    assert payload["date_range"]["from"] <= payload["date_range"]["to"]
