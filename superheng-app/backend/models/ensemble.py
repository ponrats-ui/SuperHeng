"""SuperHeng — Day 5: the ensemble and the final Heng Score.

Four signals, one score
-----------------------
Each model answers a different question about the same 100 codes:

===================  ============================================================
``frequency``        How often does this code appear, against the uniform rate?
``markov``           Given the last draw's code, what follows it?
``timeseries``       What does this code's own occurrence series forecast?
``montecarlo``       How often does this code hold a top-K place in simulated draws?
===================  ============================================================

The blend normalises every signal to a common 0–1 scale by **rank** (VISION §2.5),
weights them, and calibrates the result to a 0–100 **Heng Score**. Because the
normalisation is rank-based, the score expresses *agreement between signals*
rather than any single model's magnitude — which is why the app can show it
next to a confidence label and why it is never described as a chance of winning.

Default weights, and the one that is a substitution
---------------------------------------------------
VISION §2.5's four-model profile is Time Series ``0.30`` · Markov ``0.30`` ·
Monte Carlo ``0.25`` · LSTM ``0.15``. The LSTM is not built (it is a Phase-2
item), and Day 5's request adds Frequency alongside the three it names, so:

    frequency 0.15 · markov 0.30 · timeseries 0.30 · montecarlo 0.25

Frequency inherits the ``0.15`` the LSTM would have held rather than the other
three being scaled up to fill the gap. It is the same *kind* of signal — a
per-code occurrence rate — so it is the least disruptive stand-in, and leaving
the slot unassigned would silently inflate three weights and quietly change the
published blend. This substitution is recorded in the response as
``weights_note`` so it is never invisible.

Weights are configuration throughout: pass ``weights=`` to override them.

The trap this module exists to close: score and probability are not the same unit
----------------------------------------------------------------------------------
The ensemble publishes two numbers, and conflating them would be a
factor-of-``top_k`` error:

``score``
    Rank-based model agreement, 0–100. All four signals contribute.
``probability``
    A genuine **per-draw occurrence probability**, 0–100, where 1.0% is the
    uniform baseline across 100 codes. Only the three signals that *estimate a
    per-draw probability* contribute — see ``PROBABILITY_SIGNALS``.

Monte Carlo's survival rate is deliberately **excluded** from the probability. It
is ``P(code holds a top-K place in a simulated draw)``, which for a code with a
1% draw rate is roughly 5% with ``top_k = 5`` — about five times its per-draw
chance. Averaging it into a probability would overstate every candidate by about
a factor of ``top_k`` and would look entirely plausible in the output. It is a
fine *ranking* signal and a wrong *rate*, so it feeds the score only.

Confidence, from disagreement
-----------------------------
VISION §5 is explicit that a confidence label expresses model agreement, never
certainty. ``agreement`` is the mean pairwise Spearman rank correlation between
the available signals, mapped from ``[-1, 1]`` onto ``[0, 1]`` so that 0.5 means
"unrelated" rather than "slightly divergent". It is published alongside the raw
pairwise matrix, so the label can be audited rather than trusted.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import numpy as np
import pandas as pd

from models.montecarlo import (
    DEFAULT_SEED,
    DEFAULT_SIMULATIONS,
    MonteCarloResult,
    monte_carlo_survival,
)
from models.timeseries import (
    DEFAULT_MAX_CODES,
    DEFAULT_ORDER_GRID,
    TimeSeriesResult,
    arima_forecast,
)
from services import (
    CHANNEL_LABELS,
    CHANNELS,
    DEFAULT_SMOOTHING,
    MIN_DRAWS_ANY,
    MIN_DRAWS_FREQUENCY,
    MIN_MARKOV_STRONG,
    NUMBER_UNIVERSE,
    TOP_N,
    FrequencyRow,
    MarkovResult,
    build_reason,
    channel_series,
    draws_since_last_seen,
    effective_weights,
    frequency_counts,
    frequency_rows,
    markov_analysis,
    prepare_history,
    rank_normalise,
    signal_tone,
    unconditional_distribution,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# See the module docstring: VISION's profile with Frequency standing in for the
# not-yet-built LSTM's 0.15 slot.
DEFAULT_WEIGHTS: dict[str, float] = {
    "frequency": 0.15,
    "markov": 0.30,
    "timeseries": 0.30,
    "montecarlo": 0.25,
}

WEIGHTS_NOTE = (
    "VISION §2.5's profile is Time Series 0.30 / Markov 0.30 / Monte Carlo 0.25 / "
    "LSTM 0.15. The LSTM is not implemented, and Frequency joins the blend in its "
    "place, so the applied default is frequency 0.15 / markov 0.30 / timeseries "
    "0.30 / montecarlo 0.25."
)

# Signals whose output is a per-draw occurrence probability. Monte Carlo is
# absent on purpose: its survival rate is a top-K quantity, not a draw rate.
PROBABILITY_SIGNALS: tuple[str, ...] = ("frequency", "markov", "timeseries")

# Agreement thresholds for the confidence label, calibrated against measured
# ledgers rather than chosen. Mean pairwise rank correlation by ledger size:
#
#   draws   60    120   200   400   800   1500   3000   6000
#   rho   0.99   0.99  0.78  0.78  0.80  0.75   0.79   0.77
#
# Two things follow. Four signals at a realistic archive size land in a narrow
# 0.72-0.80 band, so a threshold near 0.75 is the discriminating point; and the
# 0.98-0.99 readings at 60-120 draws are NOT stronger agreement, they are fewer
# signals (Markov is unusable and ARIMA has nothing to fit, so only the
# occurrence-count derivatives remain — see SHARED_INPUT_CAVEAT).
CONFIDENCE_HIGH_AGREEMENT = 0.75
CONFIDENCE_MEDIUM_AGREEMENT = 0.60

# Published with every payload. Three of the four signals are functions of the
# same per-code occurrence counts — ARIMA is fitted to those counts, and the
# Monte Carlo input distribution is the blend of the rate estimates — so their
# mutual correlation is partly structural rather than independent confirmation.
# Markov is the only signal reading conditional structure instead of a marginal
# rate. Saying this out loud is the difference between a confidence label and a
# false claim of consensus.
SHARED_INPUT_CAVEAT = (
    "Agreement is a mean pairwise rank correlation. Note that frequency, the "
    "ARIMA series and the Monte Carlo input are all derived from the same per-code "
    "occurrence counts, so part of their correlation is structural; only Markov "
    "reads conditional structure rather than a marginal rate. High agreement is "
    "therefore not the same as independent confirmation."
)

METHODOLOGY_NOTE = (
    "The Heng Score blends four rank-normalised signals into a 0-100 measure of "
    "model agreement about historical behaviour. It is not a probability of "
    "winning: a fair draw is independent, and the Monte Carlo survival rate "
    "describes simulated top-K placement, not the chance of a real draw. The "
    "published probability is a per-draw occurrence estimate that excludes the "
    "simulation, because the two are different quantities."
)


# ---------------------------------------------------------------------------
# Blending
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class EnsembleResult:
    """One channel's blended score, probability, and the evidence behind them."""

    channel: str
    label: str
    draws: int
    current_state: str
    weights_configured: dict[str, float]
    weights_applied: dict[str, float]
    weights_probability: dict[str, float]
    frequencies: list[FrequencyRow]
    markov: MarkovResult
    signals_contributing: list[str]
    score: pd.Series  # 0-100
    probability: pd.Series  # 0-100, per-draw
    normalised: dict[str, pd.Series]
    agreement: float
    agreement_pairs: dict[str, float]
    confidence: str
    confidence_reason: str
    top_pick_agreement: float
    score_vs_probability: dict[str, Any]
    probability_raw_total: float
    probability_scale: float
    rankings: list[dict[str, Any]]
    timeseries: TimeSeriesResult
    montecarlo: MonteCarloResult
    markov_support: int
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "label": self.label,
            "draws": self.draws,
            "current_state": self.current_state,
            # `weights`, `frequencies` and `markov` mirror Day 3's ChannelResult
            # key-for-key. They are not part of the RankEntry contract, but the
            # client's `toChannel` parser reads exactly these three names, and
            # omitting them made it fall back to an empty frequency list and an
            # unusable Markov row -- a silent loss of the evidence the endpoint
            # had already computed. Publishing the four-model blend under the
            # same `weights` key keeps one shape for both endpoints.
            "weights": {k: round(v, 4) for k, v in self.weights_applied.items()},
            "frequencies": [row.as_dict() for row in self.frequencies],
            "markov": self.markov.as_dict(),
            "weights_configured": {k: round(v, 4) for k, v in self.weights_configured.items()},
            "weights_applied": {k: round(v, 4) for k, v in self.weights_applied.items()},
            "weights_probability": {
                k: round(v, 4) for k, v in self.weights_probability.items()
            },
            "weights_note": WEIGHTS_NOTE,
            "signals_contributing": self.signals_contributing,
            "agreement": round(self.agreement, 4),
            "agreement_pairs": self.agreement_pairs,
            "agreement_caveat": SHARED_INPUT_CAVEAT,
            "score_vs_probability": self.score_vs_probability,
            "probability_normalisation": {
                "raw_total": round(self.probability_raw_total, 4),
                "scale": round(self.probability_scale, 8),
                "note": (
                    "The rates were blended, then scaled so the 100 published "
                    "probabilities sum to 100% — one draw. The scale is uniform "
                    "and does not reorder anything."
                ),
            },
            "top_pick_agreement": round(self.top_pick_agreement, 4),
            "confidence": self.confidence,
            "confidence_reason": self.confidence_reason,
            "markov_support": self.markov_support,
            "timeseries": self.timeseries.as_dict(),
            "montecarlo": self.montecarlo.as_dict(),
            "rankings": self.rankings,
        }


def score_agreement(values: Mapping[str, pd.Series]) -> tuple[float, dict[str, float]]:
    """Mean pairwise Spearman correlation between signals, mapped to ``[0, 1]``.

    Returns ``(agreement, pairwise)``. ``pairwise`` is the raw correlation per
    signal pair so the summary can be audited.

    Spearman is the right measure here and Pearson is not: the signals are
    rank-normalised and highly non-linear in each other's units (a survival rate
    is not numerically comparable to a conditional probability), so only their
    *orderings* can be meaningfully compared. A non-finite correlation — which
    pandas returns for a constant signal — is treated as no relationship.
    """
    names = list(values)
    if len(names) < 2:
        # A single signal cannot disagree with itself. The caller reports this
        # separately rather than reading it as strong agreement.
        return 1.0, {}

    frame = pd.DataFrame({name: values[name].astype("float64") for name in names})
    correlation = frame.corr(method="spearman")

    pairwise: dict[str, float] = {}
    total = 0.0
    for index, first in enumerate(names):
        for second in names[index + 1 :]:
            value = float(correlation.loc[first, second])
            if not np.isfinite(value):
                value = 0.0
            pairwise[f"{first}|{second}"] = round(value, 4)
            total += value

    mean = total / len(pairwise) if pairwise else 0.0
    return float((mean + 1.0) / 2.0), pairwise


def confidence_label(
    *,
    agreement: float,
    signals: int,
    draws: int,
    markov_support: int,
    fitted_codes: int,
) -> tuple[str, str]:
    """Map evidence strength to ``(label, reason)``.

    Deliberately conservative: a high correlation is only called ``High`` when
    the sample underneath it is adequate. Four signals agreeing on 12 draws is
    four models fitting the same noise, and the label must not dress that up.
    """
    if draws < MIN_DRAWS_ANY:
        return "Low", f"only {draws} draw(s) analysed; nothing is estimable"
    if signals < 2:
        return (
            "Low",
            "only one signal contributed, so there is nothing to agree with",
        )
    if draws < MIN_DRAWS_FREQUENCY:
        return (
            "Low",
            f"only {draws} draw(s) analysed; below {MIN_DRAWS_FREQUENCY} the "
            "signals cannot separate from noise",
        )
    if fitted_codes == 0:
        return "Low", "no ARIMA series could be fitted, so the blend rests on frequency alone"

    if agreement >= CONFIDENCE_HIGH_AGREEMENT and markov_support >= MIN_MARKOV_STRONG:
        return (
            "High",
            f"{signals} signals agree (mean rank correlation {agreement:.2f}) and the "
            f"Markov estimate rests on {markov_support} observed transitions",
        )
    if agreement >= CONFIDENCE_HIGH_AGREEMENT:
        return (
            "Medium",
            f"{signals} signals agree (mean rank correlation {agreement:.2f}) but the "
            f"Markov estimate rests on only {markov_support} observed transition(s)",
        )
    if agreement >= CONFIDENCE_MEDIUM_AGREEMENT:
        return (
            "Medium",
            f"{signals} signals agree only loosely (mean rank correlation {agreement:.2f})",
        )
    return (
        "Low",
        f"{signals} signals disagree (mean rank correlation {agreement:.2f}), so the "
        "blend is closer to an average of noise than a consensus",
    )


def build_advanced_reason(
    *,
    code: str,
    channel: str,
    frequency_row: Any,
    markov_row: Any | None,
    markov_usable: bool,
    current_state: str,
    forecast: CodeForecast,
    timeseries_usable: bool,
    montecarlo: MonteCarloResult,
    survival_rank: int,
    survival_ranks: int,
) -> str:
    """A deterministic sentence-set explaining the score, from measured values.

    The Day 3 frequency/Markov sentence is reused verbatim (``services.build_reason``)
    so the two endpoints describe the same evidence in the same words, and the
    advanced clauses are appended from the numbers that drove this run's score.

    Never an LLM call: every clause is a fact read out of the analysis, so the
    explanation cannot invent a pattern or misreport a count.
    """
    base = build_reason(frequency_row, markov_row, markov_usable, current_state, channel)

    count = f"{montecarlo.simulations:,}"
    survival_pct = f"{100.0 * float(montecarlo.survival_rate[code]):.1f}%"
    if survival_rank == 1:
        monte_carlo_clause = (
            f"Top performer in {count} Monte Carlo simulations "
            f"(survived {survival_pct} of them)."
        )
    elif survival_rank <= montecarlo.top_k:
        monte_carlo_clause = (
            f"Survived {survival_pct} of {count} Monte Carlo simulations "
            f"(rank {survival_rank} of {survival_ranks})."
        )
    else:
        monte_carlo_clause = (
            f"Survived only {survival_pct} of {count} Monte Carlo simulations "
            f"(rank {survival_rank} of {survival_ranks})."
        )

    if timeseries_usable and forecast.fitted and forecast.order is not None:
        order = ",".join(str(part) for part in forecast.order)
        timeseries_clause = (
            f"ARIMA({order}) forecasts a {100.0 * forecast.probability:.2f}% "
            f"next-draw rate."
        )
    elif forecast.fitted:
        timeseries_clause = (
            f"ARIMA forecasts a {100.0 * forecast.probability:.2f}% next-draw rate."
        )
    else:
        timeseries_clause = (
            f"No ARIMA fit ({forecast.occurrences} occurrence(s) in this window)."
        )

    return f"{base} {monte_carlo_clause} {timeseries_clause}"


def blend_channel(
    series: pd.Series,
    channel: str,
    *,
    weights: Mapping[str, float] | None = None,
    top_n: int = TOP_N,
    smoothing: float = DEFAULT_SMOOTHING,
    simulations: int = DEFAULT_SIMULATIONS,
    seed: int = DEFAULT_SEED,
    top_k: int = TOP_N,
    order_grid: Sequence[tuple[int, int, int]] = DEFAULT_ORDER_GRID,
    max_codes: int = DEFAULT_MAX_CODES,
    warnings: list[str] | None = None,
) -> EnsembleResult:
    """Run all four models for one channel and blend them into a Heng Score."""
    warnings = warnings if warnings is not None else []
    configured = dict(weights or DEFAULT_WEIGHTS)
    # Reject an unknown signal name rather than silently dropping its weight.
    unknown = [name for name in configured if name not in DEFAULT_WEIGHTS]
    if unknown:
        raise ValueError(
            f"unknown signal(s) {unknown}; expected a subset of {list(DEFAULT_WEIGHTS)}"
        )

    draws = int(len(series))
    # Same limitation warnings as the Day 3 endpoint, in the same words: status
    # alone would say "limited" without saying which sample is too thin.
    if draws and draws < MIN_DRAWS_FREQUENCY:
        warnings.append(
            f"{channel}: only {draws} draw(s) analysed. Frequency ranks below "
            f"{MIN_DRAWS_FREQUENCY} draws are indicative only."
        )

    counts = frequency_counts(series)
    frequencies = frequency_rows(series)
    frequency_by_code = {row.code: row for row in frequencies}
    markov = markov_analysis(series, channel, smoothing=smoothing)
    current_state = markov.current_state
    if markov.usable and markov.support < MIN_MARKOV_STRONG:
        warnings.append(
            f"{channel}: the Markov estimate for state {markov.current_state} rests on "
            f"only {markov.support} observed transition(s), so its conditional "
            "probabilities are weak evidence and the scores should be read as "
            "frequency-driven."
        )

    timeseries_result = arima_forecast(
        series, channel, order_grid=order_grid, max_codes=max_codes, smoothing=smoothing
    )
    if not timeseries_result.usable:
        warnings.append(
            f"{channel}: the ARIMA signal was dropped from the blend. "
            f"{timeseries_result.note}"
        )

    # Per-draw rate estimates. These are the "historical probability distribution
    # weights" the simulation samples from.
    rates: dict[str, pd.Series] = {
        "frequency": (counts / draws) if draws else counts * 0.0
    }
    if markov.usable:
        rates["markov"] = markov.distribution()
    if timeseries_result.usable:
        rates["timeseries"] = timeseries_result.distribution()

    probability_weights = effective_weights(
        warnings,
        channel,
        [name for name in PROBABILITY_SIGNALS if name in rates],
        {name: configured[name] for name in PROBABILITY_SIGNALS},
        scope="simulation rate estimate",
    )
    if probability_weights and rates:
        simulation_weights = sum(
            probability_weights[name] * rates[name] for name in probability_weights
        )
        simulation_weights = simulation_weights.clip(lower=0.0)
        if float(simulation_weights.sum()) <= 0:
            simulation_weights = unconditional_distribution(series, smoothing)
            warnings.append(
                f"{channel}: the blended rate estimate summed to zero, so the "
                "simulation fell back to the smoothed unconditional distribution."
            )
    else:
        simulation_weights = unconditional_distribution(series, smoothing)
        warnings.append(
            f"{channel}: no per-draw rate signal was available, so the simulation "
            "sampled the smoothed unconditional distribution."
        )

    montecarlo = monte_carlo_survival(
        simulation_weights, channel=channel, simulations=simulations, top_k=top_k, seed=seed
    )

    # Signals for the score: all four, each rank-normalised to 0-1.
    signals: dict[str, pd.Series] = {"frequency": counts}
    if markov.usable:
        signals["markov"] = markov.distribution()
    if timeseries_result.usable:
        signals["timeseries"] = timeseries_result.distribution()
    signals["montecarlo"] = montecarlo.distribution()

    applied = effective_weights(
        warnings, channel, list(signals), configured, scope="score blend"
    )
    normalised = {name: rank_normalise(values) for name, values in signals.items()}

    # Agreement must be measured over the signals that actually shaped the score.
    # A signal the caller weighted to zero contributes nothing, so counting it as
    # a participant would let "four signals agree" describe a one-signal blend.
    contributing = {name: signals[name] for name, weight in applied.items() if weight > 0}
    agreement, agreement_pairs = score_agreement(contributing)
    confidence, confidence_reason = confidence_label(
        agreement=agreement,
        signals=len(contributing),
        draws=draws,
        markov_support=markov.support,
        fitted_codes=timeseries_result.fitted_codes,
    )

    markov_by_code = {row.code: row for row in markov.rows}
    survival_order = sorted(
        NUMBER_UNIVERSE, key=lambda code: (-float(montecarlo.survival_rate[code]), code)
    )
    survival_rank = {code: index + 1 for index, code in enumerate(survival_order)}

    # Computed once, then reused for both the published series and the rankings,
    # so a ranking entry can never disagree with the series it came from.
    scores = {
        code: round(
            100.0
            * sum(applied[name] * float(normalised[name].get(code, 0.0)) for name in applied),
            1,
        )
        for code in NUMBER_UNIVERSE
    }
    raw_probabilities = {
        code: 100.0
        * sum(
            probability_weights[name] * float(rates[name].get(code, 0.0))
            for name in probability_weights
        )
        for code in NUMBER_UNIVERSE
    }

    # Coherence fix-up. Blending rate estimates does not preserve the property
    # that the 100 values describe exactly one draw: the ARIMA signal replaces a
    # code's baseline with a slightly larger fitted value, so the raw blend summed
    # to a measured 101.5% rather than 100%. Day 3 had this for free because both
    # of its signals were already distributions, so adding ARIMA quietly broke a
    # property the earlier endpoint had. Renormalising restores it and keeps the
    # published number readable as "expected draws per 100 draws". The correction
    # is a uniform scale, it does not change any ranking, and both the raw total
    # and the applied scale are published so the adjustment is visible.
    raw_total = sum(raw_probabilities.values())
    probability_scale = (100.0 / raw_total) if raw_total > 0 else 0.0
    probabilities = {
        code: round(value * probability_scale, 3)
        for code, value in raw_probabilities.items()
    }

    rankings: list[dict[str, Any]] = []
    if draws >= MIN_DRAWS_ANY:
        for code in sorted(NUMBER_UNIVERSE, key=lambda item: (-scores[item], item))[:top_n]:
            frequency_row = frequency_by_code[code]
            markov_row = markov_by_code.get(code)
            # `arima_forecast` populates an entry for every code, fitted or
            # fallen back, so this lookup is total.
            forecast = timeseries_result.detail[code]
            rankings.append(
                {
                    # --- frontend RankEntry contract (src/data/mock.ts) -------
                    "code": code,
                    "probability": probabilities[code],
                    "score": scores[code],
                    # No previous model run is persisted yet, so movement is
                    # reported as zero rather than fabricated. Day 6's
                    # model_runs table is what turns this into a real delta.
                    "delta": 0.0,
                    "lastSeenDays": draws_since_last_seen(series, code),
                    "reason": build_advanced_reason(
                        code=code,
                        channel=channel,
                        frequency_row=frequency_row,
                        markov_row=markov_row,
                        markov_usable=markov.usable,
                        current_state=current_state,
                        forecast=forecast,
                        timeseries_usable=timeseries_result.usable,
                        montecarlo=montecarlo,
                        survival_rank=survival_rank[code],
                        survival_ranks=len(NUMBER_UNIVERSE),
                    ),
                    # --- additive detail --------------------------------------
                    "tone": signal_tone(scores[code]),
                    "evidence": {
                        "frequency": frequency_row.as_dict(),
                        "markov": markov_row.as_dict() if markov_row else None,
                        "timeseries": forecast.as_dict(),
                        "montecarlo": {
                            "survival_rate": round(
                                float(montecarlo.survival_rate[code]), 6
                            ),
                            "win_rate": round(float(montecarlo.win_rate[code]), 6),
                            "standard_error": round(
                                float(montecarlo.standard_error[code]), 6
                            ),
                            "survival_rank": survival_rank[code],
                        },
                        "contributions": {
                            name: round(applied[name] * float(normalised[name].get(code, 0.0)), 6)
                            for name in applied
                        },
                    },
                }
            )
    else:
        warnings.append(
            f"{channel}: only {draws} usable draw(s); at least {MIN_DRAWS_ANY} are "
            "needed before any ranking is meaningful, so no picks were produced."
        )

    # Does the ensemble's own #1 appear in each signal's top 5?
    top_codes = [entry["code"] for entry in rankings]
    if top_codes and len(applied) > 1:
        hits = 0
        for name in applied:
            own_top = sorted(
                NUMBER_UNIVERSE, key=lambda code: (-float(signals[name].get(code, 0.0)), code)
            )[:top_n]
            if top_codes[0] in own_top:
                hits += 1
        top_pick_agreement = hits / len(applied)
    else:
        top_pick_agreement = 1.0 if top_codes else 0.0

    # Published because the two numbers are different units and can legitimately
    # disagree: the top-scoring code is the best *rank agreement*, while the
    # top-probability code has the largest *estimated rate*. Surfacing the
    # divergence stops a reader assuming the 93.4-scoring pick is also the most
    # likely one.
    by_score = sorted(NUMBER_UNIVERSE, key=lambda code: (-scores[code], code))[0]
    by_probability = sorted(NUMBER_UNIVERSE, key=lambda code: (-probabilities[code], code))[0]
    score_vs_probability = {
        "top_by_score": by_score,
        "top_by_score_value": scores[by_score],
        "top_by_probability": by_probability,
        "top_by_probability_value": probabilities[by_probability],
        "agree": by_score == by_probability,
        "note": (
            "score is rank-normalised agreement (0-100); probability is the "
            "estimated per-draw occurrence rate (%). They rank different things "
            "and are not expected to name the same code."
        ),
    }

    return EnsembleResult(
        channel=channel,
        label=CHANNEL_LABELS[channel],
        draws=draws,
        current_state=current_state,
        weights_configured=configured,
        weights_applied=applied,
        weights_probability=probability_weights,
        frequencies=frequencies,
        markov=markov,
        signals_contributing=list(contributing),
        score=pd.Series(scores, dtype="float64"),
        probability=pd.Series(probabilities, dtype="float64"),
        normalised=normalised,
        agreement=agreement,
        agreement_pairs=agreement_pairs,
        confidence=confidence,
        confidence_reason=confidence_reason,
        top_pick_agreement=top_pick_agreement,
        score_vs_probability=score_vs_probability,
        probability_raw_total=raw_total,
        probability_scale=probability_scale,
        rankings=rankings,
        timeseries=timeseries_result,
        montecarlo=montecarlo,
        markov_support=markov.support,
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Top-level analysis
# ---------------------------------------------------------------------------


def analyse_draws_advanced(
    rows: Iterable[Mapping[str, Any]],
    *,
    weights: Mapping[str, float] | None = None,
    top_n: int = TOP_N,
    smoothing: float = DEFAULT_SMOOTHING,
    simulations: int = DEFAULT_SIMULATIONS,
    seed: int = DEFAULT_SEED,
    top_k: int = TOP_N,
    order_grid: Sequence[tuple[int, int, int]] = DEFAULT_ORDER_GRID,
    max_codes: int = DEFAULT_MAX_CODES,
) -> dict[str, Any]:
    """Run the Day 5 pipeline over raw ledger rows and return the API payload.

    Degrades instead of raising, exactly like ``services.analyse_draws``: an
    empty or thin history produces a well-formed response with ``status`` set and
    every limitation listed in ``warnings``.
    """
    frame, warnings = prepare_history(rows)

    latest: dict[str, Any] | None = None
    if not frame.empty:
        last_row = frame.iloc[-1]
        latest = {
            "draw_date": last_row["draw_date"].date().isoformat(),
            "first_prize": str(last_row["first_prize"]),
            "bottom_two": str(last_row["bottom_two"]),
        }

    channels: dict[str, Any] = {}
    for channel in CHANNELS:
        channels[channel] = blend_channel(
            channel_series(frame, channel),
            channel,
            weights=weights,
            top_n=top_n,
            smoothing=smoothing,
            simulations=simulations,
            seed=seed,
            top_k=top_k,
            order_grid=order_grid,
            max_codes=max_codes,
            warnings=warnings,
        )

    total_draws = int(len(frame))
    if total_draws < MIN_DRAWS_ANY:
        status = "insufficient_data"
        warnings.append(
            f"Only {total_draws} draw(s) available; at least {MIN_DRAWS_ANY} are "
            "needed before any ranking is meaningful."
        )
    elif any(
        not channels[channel].timeseries.usable
        or channels[channel].markov_support < MIN_MARKOV_STRONG
        or total_draws < MIN_DRAWS_FREQUENCY
        for channel in CHANNELS
    ):
        # "limited" is the expected steady state at this archive size, not an
        # edge case: with 100 states a ~400-draw history leaves ~4 transitions
        # per state, which is below MIN_MARKOV_STRONG by construction.
        status = "limited"
    else:
        status = "ok"

    return {
        "status": status,
        "model": "advanced",
        "draws_analyzed": total_draws,
        "date_range": {
            "from": frame["draw_date"].min().date().isoformat() if total_draws else None,
            "to": frame["draw_date"].max().date().isoformat() if total_draws else None,
        },
        "latest_draw": latest,
        "weights_configured": {
            key: round(float(value), 4)
            for key, value in (weights or DEFAULT_WEIGHTS).items()
        },
        "weights_note": WEIGHTS_NOTE,
        # Reproducibility contract, stated precisely because it was measured at
        # field level: two runs with the same seed differed in exactly four
        # leaves, and all four were *_ms timing values.
        "simulation": {
            "simulations": simulations,
            "top_k": top_k,
            "seed": seed,
            "reproducible": (
                "The same seed and inputs reproduce every score, ranking and "
                "evidence value exactly. Only the *_ms timing fields vary "
                "between runs."
            ),
        },
        "smoothing": smoothing,
        "channels": {channel: channels[channel].as_dict() for channel in CHANNELS},
        "warnings": warnings,
        "methodology": METHODOLOGY_NOTE,
    }
