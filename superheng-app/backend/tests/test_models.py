"""Unit tests for the Day 5 models (`models/timeseries.py`, `montecarlo.py`,
`ensemble.py`).

Expectations are derived by hand from the synthetic ledger, or asserted as
invariants that must hold for *any* input — a Monte Carlo run that does not
account for exactly ``simulations * top_k`` survivors is wrong regardless of the
numbers, so that is tested as an invariant rather than a snapshot.

The ARIMA stage is the slow part of this suite (~50 ms per fit), so tests pass a
small ``max_codes`` and a small ``simulations`` unless the parameter is itself
under test.

Run from the `backend` directory:

    .venv/Scripts/python -m pytest -q
"""

from __future__ import annotations

import random
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from models import ensemble as ens
from models import montecarlo as mc
from models import timeseries as ts
from services import (
    DEFAULT_WEIGHTS as BASIC_WEIGHTS,
)
from services import (
    MODEL_KEYS,
    MODEL_LABELS,
    REASON_INSUFFICIENT_SUPPORT,
    REASON_NO_ARIMA_FIT,
    REASON_WEIGHTED_ZERO,
    STATUS_ACTIVE,
    STATUS_NEUTRAL,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DRAW_COUNT = 400
LEDGER_SEED = 20261013


def ledger_rows(count: int = DRAW_COUNT, seed: int = LEDGER_SEED) -> list[dict]:
    """A deterministic ledger on the real GLO cadence (1st and 16th)."""
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
        for draw_date in reversed(dates)
    ]


@pytest.fixture(scope="module")
def series() -> pd.Series:
    """The 'top' channel of the synthetic ledger."""
    from services import channel_series, prepare_history

    frame, _ = prepare_history(ledger_rows())
    return channel_series(frame, "top")


@pytest.fixture(scope="module")
def forecast(series: pd.Series) -> ts.TimeSeriesResult:
    """One ARIMA run, shared by the read-only tests."""
    return ts.arima_forecast(series, "top", max_codes=6)


@pytest.fixture(scope="module")
def blended(series: pd.Series) -> ens.EnsembleResult:
    """One ensemble run at test-friendly sizes."""
    return ens.blend_channel(series, "top", simulations=5_000, max_codes=6)


def uniform_weights() -> pd.Series:
    from services import NUMBER_UNIVERSE

    return pd.Series(1.0 / 100, index=list(NUMBER_UNIVERSE), dtype="float64")


# ---------------------------------------------------------------------------
# timeseries — the indicator series
# ---------------------------------------------------------------------------


def test_occurrence_series_is_binary_and_counts_appearances():
    series = pd.Series(["48", "03", "48", "07", "48"], dtype="object")
    indicator = ts.occurrence_series(series, "48")

    assert list(indicator) == [1.0, 0.0, 1.0, 0.0, 1.0]
    assert indicator.sum() == 3
    assert len(indicator) == len(series)


def test_occurrence_series_of_an_absent_code_is_all_zero():
    series = pd.Series(["48", "03"], dtype="object")
    assert ts.occurrence_series(series, "99").sum() == 0


# ---------------------------------------------------------------------------
# timeseries — the forecast
# ---------------------------------------------------------------------------


def test_forecast_covers_every_code(forecast: ts.TimeSeriesResult):
    distribution = forecast.distribution()
    assert len(distribution) == 100
    assert list(distribution.index) == [f"{i:02d}" for i in range(100)]


def test_forecast_probabilities_are_valid_probabilities(forecast: ts.TimeSeriesResult):
    """An ARIMA point forecast can leave [0, 1]; it must be clamped, not shipped."""
    distribution = forecast.distribution()
    assert (distribution >= 0.0).all()
    assert (distribution <= 1.0).all()


def test_unfitted_codes_hold_the_smoothed_unconditional_rate(series: pd.Series, forecast):
    """The fallback is the baseline, never zero and never missing."""
    from services import unconditional_distribution

    baseline = unconditional_distribution(series, 1.0)
    for code, item in forecast.detail.items():
        if not item.fitted:
            assert item.method == "unconditional_fallback"
            assert item.probability == pytest.approx(float(baseline[code]), abs=1e-9)


def test_distribution_is_not_renormalised_but_stays_close_to_one(
    forecast: ts.TimeSeriesResult,
):
    """Documented contract: per-code model outputs, so the sum is ~1 but not 1.

    Fitting a code replaces its smoothed baseline with a usually-larger fitted
    value, which inflates the total. The ensemble renormalises the *published*
    probability instead of rescaling individual model outputs here.
    """
    total = float(forecast.distribution().sum())
    assert 1.0 < total < 1.10, f"expected a small inflation over 1, got {total}"
    assert forecast.fitted_codes > 0, "this assertion is only meaningful with fits"


def test_max_codes_bounds_the_number_of_fits(forecast: ts.TimeSeriesResult):
    assert forecast.fitted_codes <= 6
    assert forecast.fitted_codes + forecast.fallback_codes == 100


def test_only_codes_above_the_occurrence_floor_are_fitted(forecast: ts.TimeSeriesResult):
    for code, item in forecast.detail.items():
        if item.fitted:
            assert item.occurrences >= ts.MIN_OCCURRENCES


def test_more_frequent_codes_forecast_higher_rates(forecast: ts.TimeSeriesResult):
    """The sanity property: ARIMA on an indicator should track the observed rate."""
    fitted = [item for item in forecast.detail.values() if item.fitted]
    assert len(fitted) >= 2
    most = max(fitted, key=lambda item: item.occurrences)
    least = min(fitted, key=lambda item: item.occurrences)
    assert most.probability > least.probability


def test_forecast_is_reproducible(series: pd.Series, forecast: ts.TimeSeriesResult):
    again = ts.arima_forecast(series, "top", max_codes=6)
    assert (again.distribution() == forecast.distribution()).all()


def test_convergence_warnings_are_captured_and_reported(forecast: ts.TimeSeriesResult):
    """statsmodels chatter must be counted and published, not streamed to the log."""
    assert isinstance(forecast.total_warnings, int)
    assert forecast.total_warnings >= 0
    assert forecast.as_dict()["convergence_warnings"] == forecast.total_warnings


def test_order_grid_is_echoed_for_auditability(forecast: ts.TimeSeriesResult):
    assert forecast.order_grid == ts.DEFAULT_ORDER_GRID
    assert forecast.order_grid == ((1, 0, 0),)


# ---------------------------------------------------------------------------
# timeseries — degenerate input
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("length", [0, 1, 5, 29])
def test_short_history_is_not_usable_and_does_not_raise(length: int):
    series = pd.Series([f"{index % 100:02d}" for index in range(length)], dtype="object")
    result = ts.arima_forecast(series, "top")

    assert result.usable is False
    assert result.fitted_codes == 0
    assert len(result.distribution()) == 100
    assert float(result.distribution().sum()) == pytest.approx(1.0, abs=1e-9)


def test_history_without_repeats_has_nothing_to_fit():
    """Every code unique: no candidate reaches the occurrence floor."""
    series = pd.Series([f"{index % 100:02d}" for index in range(60)], dtype="object")
    result = ts.arima_forecast(series, "top")

    assert result.fitted_codes == 0
    assert result.usable is False


def test_all_identical_draws_stay_valid_probabilities():
    """A degenerate ledger must still yield probabilities, not NaNs or outsides."""
    series = pd.Series(["48"] * 60, dtype="object")
    result = ts.arima_forecast(series, "top")

    distribution = result.distribution()
    assert result.usable is True
    assert distribution.notna().all()
    assert (distribution >= 0.0).all() and (distribution <= 1.0).all()
    # The current state is the single code, so the fit should favour it.
    assert float(distribution["48"]) == float(distribution.max())


def test_as_dict_reports_the_contract_fields(forecast: ts.TimeSeriesResult):
    payload = forecast.as_dict()
    for key in (
        "channel",
        "model",
        "usable",
        "order_grid",
        "max_codes",
        "fitted_codes",
        "fallback_codes",
        "failures",
        "convergence_warnings",
        "top_forecasts",
    ):
        assert key in payload
    assert payload["model"] == "ARIMA"
    assert len(payload["top_forecasts"]) == 5


# ---------------------------------------------------------------------------
# timeseries — order selection
# ---------------------------------------------------------------------------


def test_select_order_picks_the_lowest_aic(series: pd.Series):
    code = series.value_counts().index[0]
    indicator = ts.occurrence_series(series, code)
    choice = ts.select_order(indicator, ts.AIC_ORDER_GRID)

    assert choice is not None
    evaluated = [row for row in choice.evaluated if row["status"] == "ok"]
    assert len(evaluated) >= 2
    assert choice.aic <= min(row["aic"] for row in evaluated)
    assert list(choice.order) in [row["order"] for row in evaluated]


def test_select_order_records_every_candidate(series: pd.Series):
    code = series.value_counts().index[0]
    choice = ts.select_order(ts.occurrence_series(series, code), ts.AIC_ORDER_GRID)
    assert choice is not None
    assert len(choice.evaluated) == len(ts.AIC_ORDER_GRID)


def test_select_order_returns_none_when_nothing_fits():
    """An empty series must not "fit". ARIMA(1,1,1) otherwise returns a garbage
    model (AIC 6.0, 86 convergence warnings) instead of failing."""
    assert ts.select_order(pd.Series([], dtype="float64"), ts.AIC_ORDER_GRID) is None


def test_fit_refuses_a_series_below_the_observation_floor():
    short = pd.Series([1.0, 0.0, 1.0], dtype="float64")
    with pytest.raises(ts.ArimaFitError, match="observation"):
        ts.fit_arima(short, (1, 0, 0))


def test_forecast_code_refuses_a_series_below_the_observation_floor():
    short = pd.Series([1.0, 0.0, 1.0], dtype="float64")
    with pytest.raises(ts.ArimaFitError):
        ts.forecast_code(short, (1, 0, 0))


def test_single_order_grid_needs_no_search(series: pd.Series):
    """The shipped default is one order; the result must say so."""
    result = ts.arima_forecast(series, "top", max_codes=3)
    assert result.order_grid == ((1, 0, 0),)
    for item in result.detail.values():
        if item.fitted:
            assert item.order == (1, 0, 0)


# ---------------------------------------------------------------------------
# montecarlo
# ---------------------------------------------------------------------------


def test_survivors_account_for_every_slot():
    """Invariant: each simulation fills exactly top_k places."""
    result = mc.monte_carlo_survival(uniform_weights(), simulations=5_000, top_k=5)
    assert int(result.survival_counts.sum()) == 5_000 * 5


def test_uniform_weights_reproduce_the_uniform_baseline():
    result = mc.monte_carlo_survival(uniform_weights(), simulations=20_000, top_k=5)
    for code in result.survival_rate.index:
        assert float(result.survival_rate[code]) == pytest.approx(5 / 100, abs=0.01)
    assert float(result.survival_rate.mean()) == pytest.approx(0.05, abs=0.002)


def test_uniform_weights_give_each_code_one_baseline_win_rate():
    result = mc.monte_carlo_survival(uniform_weights(), simulations=20_000, top_k=5)
    assert float(result.win_rate.mean()) == pytest.approx(0.01, abs=0.002)
    assert int(result.win_counts.sum()) == 20_000


def test_a_heavier_weight_survives_more_often():
    from services import NUMBER_UNIVERSE

    weights = pd.Series(1.0, index=list(NUMBER_UNIVERSE), dtype="float64")
    weights["48"] = 20.0
    result = mc.monte_carlo_survival(weights, simulations=20_000, top_k=5)

    assert float(result.survival_rate["48"]) > float(result.survival_rate["00"])
    assert float(result.survival_rate["48"]) > 0.05 * 3


def test_the_same_seed_is_reproducible():
    weights = uniform_weights()
    first = mc.monte_carlo_survival(weights, simulations=10_000, seed=7)
    second = mc.monte_carlo_survival(weights, simulations=10_000, seed=7)
    assert (first.survival_rate == second.survival_rate).all()
    assert (first.win_rate == second.win_rate).all()


def test_a_different_seed_moves_the_estimate_only_slightly():
    weights = uniform_weights()
    first = mc.monte_carlo_survival(weights, simulations=20_000, seed=7)
    second = mc.monte_carlo_survival(weights, simulations=20_000, seed=8)

    assert not (first.survival_rate == second.survival_rate).all()
    assert float((first.survival_rate - second.survival_rate).abs().max()) < 0.02


def test_more_simulations_reduce_the_standard_error():
    weights = uniform_weights()
    few = mc.monte_carlo_survival(weights, simulations=2_000, seed=3)
    many = mc.monte_carlo_survival(weights, simulations=40_000, seed=3)
    assert float(many.standard_error.mean()) < float(few.standard_error.mean())


def test_top_returns_survivors_in_descending_order():
    from services import NUMBER_UNIVERSE

    weights = pd.Series(1.0, index=list(NUMBER_UNIVERSE), dtype="float64")
    weights["48"] = 30.0
    result = mc.monte_carlo_survival(weights, simulations=10_000, top_k=5)

    top = result.top(5)
    assert [row["code"] for row in top][0] == "48"
    rates = [row["survival_rate"] for row in top]
    assert rates == sorted(rates, reverse=True)


def test_weights_are_normalised_when_they_do_not_sum_to_one():
    from services import NUMBER_UNIVERSE

    weights = pd.Series(2.0, index=list(NUMBER_UNIVERSE), dtype="float64")
    result = mc.monte_carlo_survival(weights, simulations=2_000)
    assert result.normalised is True
    assert float(result.weights.sum()) == pytest.approx(1.0, abs=1e-12)


def test_already_normalised_weights_are_reported_as_such():
    result = mc.monte_carlo_survival(uniform_weights(), simulations=2_000)
    assert result.normalised is False


def test_as_dict_publishes_the_seed_and_the_invariant():
    result = mc.monte_carlo_survival(uniform_weights(), simulations=3_000, seed=99)
    payload = result.as_dict()

    assert payload["seed"] == 99
    assert payload["simulations"] == 3_000
    assert payload["survival_assignments"] == payload["expected_assignments"] == 15_000
    assert payload["uniform_survival_baseline"] == pytest.approx(0.05)


def test_top_k_changes_the_survival_baseline():
    small = mc.monte_carlo_survival(uniform_weights(), simulations=10_000, top_k=1)
    large = mc.monte_carlo_survival(uniform_weights(), simulations=10_000, top_k=10)

    assert float(small.survival_rate.mean()) == pytest.approx(0.01, abs=0.003)
    assert float(large.survival_rate.mean()) == pytest.approx(0.10, abs=0.004)


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"weights": pd.Series([0.0] * 100)}, "no positive weight"),
        ({"weights": None, "top_k": 101}, "top_k out of range"),
        ({"weights": None, "simulations": 0}, "simulations below one"),
    ],
)
def test_unsimulatable_input_raises_value_error(kwargs, reason):
    weights = uniform_weights() if kwargs.get("weights") is None else kwargs["weights"]
    with pytest.raises(ValueError):
        mc.monte_carlo_survival(
            weights,
            simulations=kwargs.get("simulations", 1_000),
            top_k=kwargs.get("top_k", 5),
        )


# ---------------------------------------------------------------------------
# ensemble — agreement
# ---------------------------------------------------------------------------


def test_identical_signals_agree_completely():
    values = pd.Series([1.0, 2.0, 3.0, 4.0], index=["00", "01", "02", "03"])
    agreement, pairs = ens.score_agreement({"a": values, "b": values})
    assert agreement == pytest.approx(1.0)
    assert pairs["a|b"] == pytest.approx(1.0)


def test_reversed_signals_agree_not_at_all():
    values = pd.Series([1.0, 2.0, 3.0, 4.0], index=["00", "01", "02", "03"])
    agreement, pairs = ens.score_agreement({"a": values, "b": -values})
    assert agreement == pytest.approx(0.0, abs=1e-9)
    assert pairs["a|b"] == pytest.approx(-1.0)


def test_a_single_signal_cannot_disagree_with_itself():
    values = pd.Series([1.0, 2.0], index=["00", "01"])
    agreement, pairs = ens.score_agreement({"a": values})
    assert agreement == 1.0
    assert pairs == {}


def test_a_constant_signal_is_treated_as_no_relationship():
    index = [f"{i:02d}" for i in range(10)]
    flat = pd.Series([1.0] * 10, index=index)
    varying = pd.Series(range(10), index=index, dtype="float64")
    agreement, _ = ens.score_agreement({"flat": flat, "varying": varying})
    assert agreement == pytest.approx(0.5)


def test_agreement_pairs_are_published_per_pair():
    index = [f"{i:02d}" for i in range(10)]
    signals = {
        "a": pd.Series(range(10), index=index, dtype="float64"),
        "b": pd.Series(range(10), index=index, dtype="float64"),
        "c": pd.Series(range(9, -1, -1), index=index, dtype="float64"),
    }
    _, pairs = ens.score_agreement(signals)
    assert set(pairs) == {"a|b", "a|c", "b|c"}


# ---------------------------------------------------------------------------
# ensemble — confidence
# ---------------------------------------------------------------------------


def test_confidence_is_low_without_enough_draws():
    label, reason = ens.confidence_label(
        agreement=0.99, signals=4, draws=3, markov_support=50, fitted_codes=10
    )
    assert label == "Low"
    assert "3 draw" in reason


def test_confidence_is_low_with_only_one_signal():
    label, reason = ens.confidence_label(
        agreement=1.0, signals=1, draws=400, markov_support=50, fitted_codes=10
    )
    assert label == "Low"
    assert "one signal" in reason


def test_confidence_is_capped_when_the_markov_support_is_thin():
    """High correlation on 3 observed transitions is not High confidence."""
    label, reason = ens.confidence_label(
        agreement=0.95, signals=4, draws=400, markov_support=3, fitted_codes=10
    )
    assert label == "Medium"
    assert "3 observed transition" in reason


def test_confidence_is_high_only_with_agreement_and_support():
    label, _ = ens.confidence_label(
        agreement=0.80, signals=4, draws=1500, markov_support=15, fitted_codes=30
    )
    assert label == "High"


def test_confidence_is_low_when_the_signals_disagree():
    label, reason = ens.confidence_label(
        agreement=0.10, signals=4, draws=800, markov_support=20, fitted_codes=30
    )
    assert label == "Low"
    assert "disagree" in reason


def test_confidence_is_low_when_no_arima_series_could_be_fitted():
    label, reason = ens.confidence_label(
        agreement=0.99, signals=4, draws=400, markov_support=20, fitted_codes=0
    )
    assert label == "Low"
    assert "ARIMA" in reason


# ---------------------------------------------------------------------------
# ensemble — the blend
# ---------------------------------------------------------------------------


def test_applied_weights_sum_to_one(blended: ens.EnsembleResult):
    assert sum(blended.weights_applied.values()) == pytest.approx(1.0)
    assert set(blended.weights_applied) <= set(ens.DEFAULT_WEIGHTS)


def test_default_weights_match_the_documented_profile():
    assert ens.DEFAULT_WEIGHTS == {
        "frequency": 0.15,
        "markov": 0.30,
        "timeseries": 0.30,
        "montecarlo": 0.25,
    }
    assert sum(ens.DEFAULT_WEIGHTS.values()) == pytest.approx(1.0)


def test_probability_weights_exclude_monte_carlo(blended: ens.EnsembleResult):
    """The survival rate is a top-K quantity and must not become a draw rate."""
    assert "montecarlo" not in blended.weights_probability
    assert "montecarlo" not in ens.PROBABILITY_SIGNALS
    assert set(blended.weights_probability) <= set(ens.PROBABILITY_SIGNALS)
    assert sum(blended.weights_probability.values()) == pytest.approx(1.0)


def test_an_unknown_signal_name_is_rejected(series: pd.Series):
    with pytest.raises(ValueError):
        ens.blend_channel(series, "top", weights={"frequency": 0.5, "lstm": 0.5}, max_codes=1)


def test_scores_stay_within_zero_to_one_hundred(blended: ens.EnsembleResult):
    assert float(blended.score.min()) >= 0.0
    assert float(blended.score.max()) <= 100.0


def test_rankings_are_ordered_by_score_then_code(blended: ens.EnsembleResult):
    """The documented sort key is ``(-score, code)``, and must be total."""
    keys = [(-entry["score"], entry["code"]) for entry in blended.rankings]
    assert keys == sorted(keys)


def test_each_ranking_satisfies_the_frontend_rank_entry_contract(
    blended: ens.EnsembleResult,
):
    """`RankEntry` in src/data/mock.ts: every field the client destructures."""
    assert len(blended.rankings) == 5
    for entry in blended.rankings:
        assert isinstance(entry["code"], str) and len(entry["code"]) == 2
        assert entry["code"].isdigit()
        assert isinstance(entry["delta"], float)
        assert entry["delta"] == 0.0, "no previous run is stored, so movement is zero"
        assert entry["lastSeenDays"] is None or isinstance(entry["lastSeenDays"], int)
        assert isinstance(entry["reason"], str) and entry["reason"]
        assert 0.0 <= entry["score"] <= 100.0
        assert 0.0 < entry["probability"] < 100.0
        assert entry["tone"] in {"high", "medium", "low", "cold"}


def test_every_pick_carries_evidence_for_all_four_signals(blended: ens.EnsembleResult):
    for entry in blended.rankings:
        evidence = entry["evidence"]
        assert evidence["frequency"]["code"] == entry["code"]
        assert "occurrences" in evidence["timeseries"]
        assert "survival_rate" in evidence["montecarlo"]
        assert set(evidence["contributions"]) <= set(blended.weights_applied)


def test_contributions_reconstruct_the_score(blended: ens.EnsembleResult):
    """The published score must equal the weighted sum of the parts, exactly."""
    for entry in blended.rankings:
        total = sum(entry["evidence"]["contributions"].values())
        assert 100.0 * total == pytest.approx(entry["score"], abs=0.05)


def test_published_probabilities_describe_exactly_one_draw(
    blended: ens.EnsembleResult,
):
    """Coherence: across all 100 codes, the per-draw probabilities sum to 100%.

    Day 3 had this for free; adding a non-distribution ARIMA signal broke it, so
    the ensemble renormalises. Without this, the values over-count by ~1.5%.
    """
    assert float(blended.probability.sum()) == pytest.approx(100.0, abs=0.2)
    assert blended.probability_raw_total > 100.0, "the raw blend over-counted"
    assert blended.probability_scale < 1.0, "the fix-up must shrink, not grow"


def test_probability_reconstructs_from_the_rate_signals_only(
    blended: ens.EnsembleResult,
):
    """Independent recomputation of the per-draw probability from its evidence.

    The ARIMA term is always included: the signal covers every code, using the
    smoothed baseline for codes that were not fitted.
    """
    scale = blended.probability_scale
    for entry in blended.rankings:
        evidence = entry["evidence"]
        expected = blended.weights_probability["frequency"] * evidence["frequency"]["share"]
        if evidence["markov"] is not None:
            expected += (
                blended.weights_probability["markov"] * evidence["markov"]["conditional"]
            )
        expected += (
            blended.weights_probability["timeseries"]
            * evidence["timeseries"]["probability"]
        )
        assert 100.0 * scale * expected == pytest.approx(entry["probability"], abs=0.01)


def test_the_probability_is_a_draw_rate_not_a_survival_rate(
    blended: ens.EnsembleResult,
):
    """The two differ by roughly top_k; conflating them is the trap this guards."""
    for entry in blended.rankings:
        survival_pct = 100.0 * entry["evidence"]["montecarlo"]["survival_rate"]
        assert entry["probability"] < survival_pct, (
            f"{entry['code']}: probability {entry['probability']} should be below "
            f"the top-K survival rate {survival_pct}"
        )


def test_top_pick_agreement_is_a_share_of_signals(blended: ens.EnsembleResult):
    assert 0.0 <= blended.top_pick_agreement <= 1.0


def test_score_and_probability_divergence_is_published(blended: ens.EnsembleResult):
    payload = blended.score_vs_probability
    assert payload["top_by_score"] in {entry["code"] for entry in blended.rankings}
    assert isinstance(payload["agree"], bool)
    assert payload["note"]


def test_normalised_signals_stay_within_zero_to_one(blended: ens.EnsembleResult):
    for name, values in blended.normalised.items():
        assert float(values.min()) >= 0.0, name
        assert float(values.max()) <= 1.0, name


def test_blend_is_reproducible(series: pd.Series):
    first = ens.blend_channel(series, "top", simulations=3_000, seed=11, max_codes=3)
    second = ens.blend_channel(series, "top", simulations=3_000, seed=11, max_codes=3)

    assert first.score.equals(second.score)
    assert first.probability.equals(second.probability)
    assert [row["code"] for row in first.rankings] == [row["code"] for row in second.rankings]
    assert [row["reason"] for row in first.rankings] == [row["reason"] for row in second.rankings]


def test_blend_carries_the_basic_models_language(blended: ens.EnsembleResult):
    """The Day 3 sentence is reused, so both endpoints describe evidence alike."""
    for entry in blended.rankings:
        assert "as the 2-digit top" in entry["reason"]


def test_advanced_reasons_name_the_monte_carlo_run(blended: ens.EnsembleResult):
    for entry in blended.rankings:
        assert "Monte Carlo simulations" in entry["reason"]
        assert "5,000" in entry["reason"], "the simulation count must be stated"


def test_advanced_reasons_describe_the_arima_fit(blended: ens.EnsembleResult):
    for entry in blended.rankings:
        assert "ARIMA" in entry["reason"]


def test_tone_matches_the_shared_thresholds(blended: ens.EnsembleResult):
    from services import signal_tone

    for entry in blended.rankings:
        assert entry["tone"] == signal_tone(entry["score"])


# ---------------------------------------------------------------------------
# ensemble — the payload
# ---------------------------------------------------------------------------


def test_empty_ledger_yields_a_well_formed_response():
    payload = ens.analyse_draws_advanced([], simulations=2_000, max_codes=2)

    assert payload["status"] == "insufficient_data"
    assert payload["draws_analyzed"] == 0
    assert payload["date_range"] == {"from": None, "to": None}
    assert payload["latest_draw"] is None
    for channel in ("top", "bottom"):
        assert payload["channels"][channel]["rankings"] == []
    assert payload["warnings"]


def test_a_thin_ledger_is_limited_not_an_error():
    """40 draws over 100 codes leaves no code with 4 occurrences, so no ARIMA fit."""
    payload = ens.analyse_draws_advanced(ledger_rows(40), simulations=2_000, max_codes=2)

    assert payload["status"] == "limited"
    assert payload["draws_analyzed"] == 40
    assert payload["channels"]["top"]["timeseries"]["usable"] is False
    assert payload["channels"]["top"]["rankings"], "rankings are still produced"


def test_payload_reports_the_simulation_settings():
    payload = ens.analyse_draws_advanced(ledger_rows(200), simulations=4_000, seed=5, top_k=3)

    assert payload["simulation"]["simulations"] == 4_000
    assert payload["simulation"]["seed"] == 5
    assert payload["simulation"]["top_k"] == 3
    assert "reproducible" in payload["simulation"]


def test_the_seed_actually_drives_the_simulation():
    first = ens.analyse_draws_advanced(ledger_rows(150), simulations=3_000, seed=1, max_codes=2)
    second = ens.analyse_draws_advanced(ledger_rows(150), simulations=3_000, seed=2, max_codes=2)

    first_rates = [
        entry["evidence"]["montecarlo"]["survival_rate"]
        for entry in first["channels"]["top"]["rankings"]
    ]
    second_rates = [
        entry["evidence"]["montecarlo"]["survival_rate"]
        for entry in second["channels"]["top"]["rankings"]
    ]
    assert first_rates != second_rates


def test_the_same_seed_reproduces_every_published_score():
    """Timing fields are the only thing allowed to differ between runs."""
    first = ens.analyse_draws_advanced(ledger_rows(150), simulations=3_000, seed=1, max_codes=2)
    second = ens.analyse_draws_advanced(ledger_rows(150), simulations=3_000, seed=1, max_codes=2)

    def strip(node):
        if isinstance(node, dict):
            return {k: strip(v) for k, v in node.items() if not k.endswith("_ms")}
        if isinstance(node, list):
            return [strip(item) for item in node]
        return node

    assert strip(first) == strip(second)


def test_payload_publishes_the_weights_and_the_substitution_note():
    payload = ens.analyse_draws_advanced(ledger_rows(120), simulations=2_000, max_codes=2)

    assert payload["weights_configured"] == ens.DEFAULT_WEIGHTS
    assert "LSTM" in payload["weights_note"]
    assert "LSTM" in payload["channels"]["top"]["weights_note"]


def test_payload_uses_the_advanced_not_the_basic_weights():
    """Day 5 reweights: the advanced profile must not silently stay 50/50."""
    payload = ens.analyse_draws_advanced(ledger_rows(300), simulations=3_000, max_codes=4)
    applied = payload["channels"]["top"]["weights_applied"]

    assert applied != BASIC_WEIGHTS
    assert "timeseries" in applied or "montecarlo" in applied


def test_both_channels_are_reported_independently():
    payload = ens.analyse_draws_advanced(ledger_rows(300), simulations=3_000, max_codes=3)

    top = payload["channels"]["top"]
    bottom = payload["channels"]["bottom"]
    assert top["channel"] == "top"
    assert bottom["channel"] == "bottom"
    assert "Top" in top["label"]
    assert "Bottom" in bottom["label"]


def test_payload_exposes_custom_weights():
    custom = {"frequency": 1.0, "markov": 0.0, "timeseries": 0.0, "montecarlo": 0.0}
    payload = ens.analyse_draws_advanced(
        ledger_rows(200), weights=custom, simulations=2_000, max_codes=3
    )

    assert payload["weights_configured"] == custom
    assert payload["channels"]["top"]["weights_applied"]["frequency"] == pytest.approx(1.0)


def test_a_single_signal_weight_blend_still_produces_rankings():
    only_frequency = {
        "frequency": 1.0,
        "markov": 0.0,
        "timeseries": 0.0,
        "montecarlo": 0.0,
    }
    payload = ens.analyse_draws_advanced(
        ledger_rows(300), weights=only_frequency, simulations=2_000, max_codes=3
    )
    rankings = payload["channels"]["top"]["rankings"]

    assert len(rankings) == 5
    channel = payload["channels"]["top"]
    assert channel["confidence"] == "Low"
    assert "one signal contributed" in channel["confidence_reason"]
    # Zero-weighted signals must not be counted as agreeing participants.
    assert channel["signals_contributing"] == ["frequency"]


def test_dropping_a_signal_renormalises_the_rest_and_says_so():
    """With no ARIMA, the remaining weights must still sum to 1."""
    payload = ens.analyse_draws_advanced(ledger_rows(20), simulations=2_000, max_codes=2)
    channel = payload["channels"]["top"]

    assert channel["timeseries"]["usable"] is False
    assert sum(channel["weights_applied"].values()) == pytest.approx(1.0)
    assert any("ARIMA signal was dropped" in warning for warning in payload["warnings"])


def test_the_payload_carries_the_keys_the_client_parser_reads():
    """`toChannel` in src/lib/api.ts reads `weights`, `frequencies` and `markov`.

    Those three are not part of the RankEntry contract, so omitting them kept the
    rankings working while silently emptying the frequency table and resetting
    every Markov row to `usable: false`, no matter what the models had found.
    """
    payload = ens.analyse_draws_advanced(ledger_rows(120), simulations=2_000, max_codes=3)

    for channel in payload["channels"].values():
        assert set(channel) >= {"weights", "frequencies", "markov"}
        # Day 3's shapes, so one parser handles both endpoints.
        assert channel["weights"] == channel["weights_applied"]
        assert len(channel["frequencies"]) == 100
        assert {"code", "count", "share", "expected", "lift"} <= set(channel["frequencies"][0])
        assert set(channel["markov"]) == {
            "channel",
            "current_state",
            "support",
            "usable",
            "top_transitions",
        }


def test_the_frontend_parser_reads_a_real_frequency_and_markov_row():
    """The published evidence must survive the client's own narrowing rules."""
    payload = ens.analyse_draws_advanced(ledger_rows(120), simulations=2_000, max_codes=3)
    channel = payload["channels"]["top"]

    top = channel["frequencies"][0]
    assert top["count"] == max(row["count"] for row in channel["frequencies"])
    assert channel["markov"]["current_state"] == channel["current_state"]
    assert channel["markov"]["support"] == channel["markov_support"]


def test_no_warning_is_printed_twice_with_the_same_wording():
    """The ensemble renormalises twice per channel; each pass must label itself.

    Both passes share one warning list, so an unlabelled message meant a reader
    saw the identical sentence twice and could not tell whether the signal was
    dropped from the simulation rates, from the score blend, or was merely
    printed twice.
    """
    payload = ens.analyse_draws_advanced(ledger_rows(120), simulations=2_000, max_codes=2)

    assert len(payload["warnings"]) == len(set(payload["warnings"])), payload["warnings"]

    for key, channel in payload["channels"].items():
        # This ledger leaves Markov below its support floor in both channels while
        # ARIMA still fits, so exactly one signal is dropped and each pass names
        # the same one.
        assert channel["markov"]["usable"] is False
        scoped = [
            warning
            for warning in payload["warnings"]
            if warning.startswith(f"{key}: no usable markov signal")
        ]
        assert len(scoped) == 2, scoped
        assert "for the simulation rate estimate" in scoped[0]
        assert "for the score blend" in scoped[1]


def test_number_universe_and_shares_are_consistent():
    payload = ens.analyse_draws_advanced(ledger_rows(300), simulations=2_000, max_codes=3)
    for entry in payload["channels"]["top"]["rankings"]:
        frequency = entry["evidence"]["frequency"]
        assert frequency["count"] >= 1
        assert 0.0 < frequency["share"] <= 1.0


# ---------------------------------------------------------------------------
# ensemble — model statuses (\"transparency as a feature\")
# ---------------------------------------------------------------------------


def test_the_channel_lists_all_four_models_even_when_they_all_contribute():
    payload = ens.analyse_draws_advanced(ledger_rows(300), simulations=2_000, max_codes=3)
    channel = payload["channels"]["top"]

    assert list(channel["model_statuses"]) == list(MODEL_KEYS)
    for key, entry in channel["model_statuses"].items():
        assert entry["label"] == MODEL_LABELS[key]
        assert entry["reason"]
        assert entry["detail"]
        assert entry["status"] in {STATUS_ACTIVE, STATUS_NEUTRAL}

    active = {
        key for key, entry in channel["model_statuses"].items() if entry["status"] == "active"
    }
    assert active == set(channel["weights_applied"]), "active means it carried weight"
    for key in active:
        assert channel["model_statuses"][key]["weight"] == pytest.approx(
            channel["weights_applied"][key]
        )


def test_a_dropped_arima_signal_is_reported_neutral_with_its_own_reason():
    """20 draws cannot fit ARIMA, so the signal is dropped — and said so."""
    payload = ens.analyse_draws_advanced(ledger_rows(20), simulations=2_000, max_codes=2)
    channel = payload["channels"]["top"]

    assert channel["timeseries"]["usable"] is False
    arima = channel["model_statuses"]["timeseries"]
    assert arima["status"] == STATUS_NEUTRAL
    assert arima["reason"] == REASON_INSUFFICIENT_SUPPORT
    assert arima["weight"] == 0.0
    assert "ARIMA was dropped from the blend" in arima["detail"]


def test_a_code_without_an_arima_fit_is_neutral_for_arima_alone():
    """Only the fitted codes are active for ARIMA; the rest hold a baseline.

    With ``max_codes=2`` the channel's ARIMA signal is usable, so this is the
    per-pick narrowing rather than a dropped model: the channel is active while
    most of its picks are neutral.
    """
    payload = ens.analyse_draws_advanced(ledger_rows(120), simulations=2_000, max_codes=2)
    channel = payload["channels"]["top"]

    assert channel["model_statuses"]["timeseries"]["status"] == STATUS_ACTIVE
    assert channel["timeseries"]["fitted_codes"] == 2

    for entry in channel["rankings"]:
        arima = entry["model_statuses"]["timeseries"]
        fitted = entry["evidence"]["timeseries"]["fitted"]
        assert (arima["status"] == STATUS_ACTIVE) is bool(fitted)
        if not fitted:
            assert arima["reason"] == REASON_NO_ARIMA_FIT
            assert "No ARIMA series was fitted" in arima["detail"]
            assert arima["weight"] == 0.0

    assert any(
        entry["model_statuses"]["timeseries"]["status"] == STATUS_ACTIVE
        for entry in channel["rankings"]
    ), "the two fitted codes are ranked and must show ARIMA active"


def test_a_zero_weighted_model_is_neutral_rather_than_missing():
    only_frequency = {
        "frequency": 1.0,
        "markov": 0.0,
        "timeseries": 0.0,
        "montecarlo": 0.0,
    }
    payload = ens.analyse_draws_advanced(
        ledger_rows(200), weights=only_frequency, simulations=2_000, max_codes=3
    )
    channel = payload["channels"]["top"]

    assert channel["model_statuses"]["frequency"]["status"] == STATUS_ACTIVE
    for key in ("markov", "timeseries", "montecarlo"):
        entry = channel["model_statuses"][key]
        assert entry["status"] == STATUS_NEUTRAL
        assert entry["reason"] == REASON_WEIGHTED_ZERO
        assert entry["weight"] == 0.0


def test_every_pick_carries_its_own_four_model_statuses():
    payload = ens.analyse_draws_advanced(ledger_rows(150), simulations=2_000, max_codes=2)

    for channel in payload["channels"].values():
        picks = channel["rankings"]
        assert picks, "the fixture must rank something"
        for entry in picks:
            statuses = entry["model_statuses"]
            assert list(statuses) == list(MODEL_KEYS)
            for key, value in statuses.items():
                assert value["label"] == MODEL_LABELS[key]
                assert value["status"] in {STATUS_ACTIVE, STATUS_NEUTRAL}
                assert value["reason"] and value["detail"]


def test_an_empty_ledger_still_reports_the_four_models_per_channel():
    payload = ens.analyse_draws_advanced([], simulations=2_000, max_codes=2)

    for channel in payload["channels"].values():
        assert channel["rankings"] == []
        assert list(channel["model_statuses"]) == list(MODEL_KEYS)
        assert all(
            entry["status"] == STATUS_NEUTRAL for entry in channel["model_statuses"].values()
        )
