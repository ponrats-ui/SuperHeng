"""SuperHeng — the walk-forward backtest engine.

This module answers the only question that makes a published accuracy claim
credible: *if the models had been run on each of the last N draws using only the
data that existed before that draw, how often would they have been right, and how
does that compare with guessing?*

The API payload is built in :func:`run_backtest`, which — like
``services.analyse_draws`` — is **pure over its input rows**. The endpoint fetches
the ledger, this module computes. That is what makes the leakage guarantee
testable without a database, and it keeps the model code and the reporting code
separable.

Leakage: the one rule this module exists to enforce
--------------------------------------------------
For a target draw at chronological index ``t``, the rows handed to a model are
exactly ``frame[t - train_window : t]`` — the draws *strictly before* it, in
chronological order. The target row is never in the training slice, and neither is
any later row. There is exactly one function that builds a training slice
(:func:`training_slice`), every model call goes through it, and
``tests/test_backtest.py`` asserts the property directly by spying on the rows the
model is handed.

Getting this wrong is the single failure mode that would make every number on the
screen a lie while still looking plausible, so the slice is derived by index from a
frame that has already been sorted, never by filtering on the target's date — a
date filter is the version that silently leaks when two draws share a date.

Which models are backtested, and why not all of them
---------------------------------------------------
* **The 2-digit channels** (``top`` = last two digits of the first prize,
  ``bottom`` = the separately drawn 2-digit prize) via ``services.analyse_draws``
  — the Frequency + Markov ensemble behind ``/api/predict/basic``. This is where
  win rate and ROI are meaningful, because a 2-digit bet has both a hit condition
  and a published payout.
* **The premium positional model** via ``models.bayesian.analyse_positions`` —
  one digit prediction per position per draw. This is the tier the paywall sells,
  and :data:`ROADMAP` requires the 6-digit model to publish its out-of-sample hit
  rate next to the uniform baseline before the tier is sold.

The four-model ARIMA/Monte Carlo ensemble behind ``/api/predict/advanced`` is
**deliberately absent**, and the omission is a measurement rather than a
preference: one walk-forward step through it costs **8.28 s** on a 400-draw ledger
(this machine, ``simulations=10_000``), so the 30-draw backtest the endpoint
promises would take about four minutes per request — past any HTTP timeout, and
past Render's. Frequency + Markov costs 62 ms for both channels, and the Bayesian
positional model 9.5 ms, so those two are what a request can actually afford. A
model that cannot be backtested inside a request is reported in
``models_excluded`` with that reason, never quietly dropped.

Statistics: the baseline is printed beside every headline number
---------------------------------------------------------------
``ROADMAP.md`` requires it, and it is the difference between a marketing claim and
a measurement. Every rate this module publishes is accompanied by:

* the **uniform baseline** for the same quantity — 1% for an exact 2-digit hit,
  5% for a hit inside five picks, 10% for one digit in one position;
* an identically-computed **random baseline** from a seeded simulated player, so
  the reader can see the sampling noise rather than only the closed-form rate;
* a one-sided **binomial p-value** for "the model is no better than chance", which
  is what stops a 30-draw sample from being read as proof. At this sample size the
  honest answer is usually "indistinguishable", and the payload says so.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import services

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: Draws evaluated by default. 30 is the figure the Founder asked for and the
#: smallest sample that still shows a trend shape rather than a single point.
DEFAULT_DRAWS = 30

#: Upper bound on a request. Cost is roughly linear in this — measured at 62 ms
#: per step for the two 2-digit channels plus 9.5 ms for the positional model —
#: so 60 draws is about 4.5 s of compute, which is the most a synchronous request
#: should spend. The ceiling is a request budget, not a statistical one.
MAX_DRAWS = 60

#: Fewer than two draws is not a backtest.
MIN_DRAWS = 2

#: A step is only evaluated once the model has this many draws behind it. Well
#: above ``services.MIN_DRAWS_ANY`` (5), because a step scored on five draws would
#: publish a rate the model itself would refuse to stand behind.
MIN_TRAIN_DRAWS = 20

#: Picks counted as a "hit inside the picks". Five matches the Top-5 list the
#: dashboard already shows, so the backtest scores the thing users actually see.
DEFAULT_TOP_K = 5

#: Fixed so the random baseline is reproducible: the same ledger and window always
#: produce the same comparison line, and re-running does not move it.
RANDOM_BASELINE_SEED = 20261014

#: Every 2-digit code, in order. The baseline draws from this uniformly.
ALL_CODES: tuple[str, ...] = tuple(f"{value:02d}" for value in range(100))

#: Closed-form baselines. A 2-digit draw is uniform over 100 codes, so one pick
#: hits 1% of the time and a set of five picks 5%; one digit in one position is
#: 10%. These are exact, not simulated, which is why they are reported next to the
#: simulated baseline: the two should agree, and the gap between them is the
#: sampling noise no model has escaped.
UNIFORM_EXACT_RATE = 1.0 / 100
UNIFORM_TOP_K_RATE = DEFAULT_TOP_K / 100
UNIFORM_DIGIT_RATE = 1.0 / 10

#: Alpha for "is this distinguishable from chance".
SIGNIFICANCE_ALPHA = 0.05

#: Return on one unit staked on a winning 2-digit pick, by ledger.
#:
#: Thailand's figure is the real GLO economics and is used as the default:
#: a ticket costs **฿80** and the เลขท้าย 2 ตัว prize pays **฿2,000**, so one baht
#: staked returns 25 on a hit. That is the number a Thai reader can check against
#: their own ticket, and it carries the GLO's overround with it — the break-even
#: hit rate is 4%, four times the 1% a random pick manages, which is why an honest
#: ROI on this game is negative for a player and only the *gap* to the baseline is
#: evidence of skill.
#:
#: Lao and Vietnamese 2-digit payouts are **not** verified here — this project has
#: no sourced market payout for either ledger, and inventing one would be exactly
#: the kind of number this file exists to avoid. They therefore default to
#: **fair odds** (100), which models "no house edge" and is stated as an assumption
#: in the payload rather than presented as fact. Pass ``payout_multiple`` to
#: compare all three ledgers on one footing.
PAYOUT_MULTIPLE_BY_LEDGER: dict[str, float] = {
    "thai": 25.0,
    "laos": 100.0,
    "vietnam": 100.0,
}

PAYOUT_BASIS: dict[str, str] = {
    "thai": (
        "GLO: an ฿80 ticket, a ฿2,000 เลขท้าย 2 ตัว prize, so one baht staked "
        "returns 25 on a hit. Verified."
    ),
    "laos": (
        "Unverified: fair odds (100) are assumed because no sourced Lao 2-digit "
        "payout is available to this project. The break-even rate below is a "
        "property of this assumption, not a fact about the Lao market."
    ),
    "vietnam": (
        "Unverified: fair odds (100) are assumed because no sourced Vietnamese "
        "2-digit payout is available to this project."
    ),
}

METHODOLOGY = (
    "Generated by replaying each of the most recent draws as if it had not happened "
    "yet: for every target draw, the models are trained only on the draws strictly "
    "before it, so no future row is ever visible. Three baselines are reported beside "
    "every rate — the closed-form uniform rate, a seeded simulated random player, and "
    "the break-even rate implied by the payout — because a hit rate without a baseline "
    "says nothing. A p-value tests the model against chance; where it is above 0.05 the "
    "honest reading is that this sample cannot tell the model from a coin, and the "
    "response says so rather than implying otherwise."
)

LEAKAGE_GUARD = (
    "For a target draw at chronological index t, the training rows are exactly "
    "frame[t - train_window : t]: strictly earlier draws, selected by index from a "
    "frame that was sorted once, never by filtering on the target's date. The target "
    "row and every later row are excluded by construction."
)

MODELS_EXCLUDED: list[dict[str, str]] = [
    {
        "model": "advanced (ARIMA + Monte Carlo ensemble)",
        "reason": (
            "One walk-forward step costs 8.28 s on a 400-draw ledger "
            "(simulations=10_000, measured on this machine), so 30 draws would take "
            "roughly four minutes per request — past any HTTP timeout. Its two cheap "
            "component models are still backtested here as the 2-digit ensemble."
        ),
    }
]


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


def binomial_tail(k: int, n: int, p: float) -> float:
    """One-sided ``P(X >= k)`` for ``X ~ Binomial(n, p)``.

    The probability, under the null hypothesis that every prediction is an
    independent coin with the baseline's success rate, of scoring *at least* what
    was observed. Small values are evidence the model is doing something; a large
    value is the honest "not distinguishable from chance".

    Computed with ``math.comb`` rather than a solver dependency: ``n`` here is at
    most a few hundred, so the exact sum is cheap and — unlike an approximation —
    cannot be wrong in the tail, which is exactly where this number is read.
    """
    if n <= 0:
        return 1.0
    if k <= 0:
        return 1.0
    if k > n:
        return 0.0
    return sum(
        math.comb(n, hits) * (p**hits) * ((1.0 - p) ** (n - hits))
        for hits in range(k, n + 1)
    )


def hits_needed_for_significance(n: int, p: float, alpha: float = SIGNIFICANCE_ALPHA) -> int | None:
    """Fewest hits out of ``n`` that would clear ``alpha`` against baseline ``p``.

    Published because it turns a p-value into an actionable sentence: "this window
    would need 4 hits to say anything". ``None`` when even a perfect score could not
    clear the bound, which happens on samples too small to resolve the event at all.
    """
    for hits in range(0, n + 1):
        if binomial_tail(hits, n, p) < alpha:
            return hits
    return None


def _rate_percent(hits: int, total: int) -> float | None:
    """Hit rate as a percentage, or ``None`` when there is nothing to divide by."""
    if total <= 0:
        return None
    return round(100.0 * hits / total, 2)


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    """``numerator / denominator``, guarding the zero and ``None`` cases."""
    if numerator is None or not denominator:
        return None
    return round(numerator / denominator, 3)


def _roi(hits: int, staked: float, payout_multiple: float) -> dict[str, Any]:
    """Net return of staking ``staked`` units and being paid on ``hits`` of them.

    ``staked`` is the total across every evaluated draw (so a 5-pick cover over 30
    draws stakes 150 units), and ``returned`` is ``payout_multiple`` times the units
    that hit. ROI is expressed on the stake, in percent.
    """
    returned = payout_multiple * hits
    net = returned - staked
    return {
        "staked": round(staked, 2),
        "returned": round(returned, 2),
        "net": round(net, 2),
        "roi_percent": round(100.0 * net / staked, 2) if staked else None,
    }


# ---------------------------------------------------------------------------
# The walk-forward loop
# ---------------------------------------------------------------------------


def training_slice(frame: Any, index: int, train_window: int) -> list[dict[str, str]]:
    """The rows a model may see when predicting the draw at ``index``.

    **The leakage boundary.** Slice by position, not by date: ``frame`` is already
    chronological (``services.prepare_history`` sorted it oldest-first), so
    ``frame[index - train_window : index]`` is exactly the history available before
    the target and the target itself is excluded by construction. A date comparison
    would be the version that leaks — ``draw_date`` is not unique across ledgers, and
    a ``<=`` off-by-one on equal dates is invisible in review.

    Returns plain mappings with the three keys the models consume, because the
    model entry points take raw ledger rows rather than a frame.
    """
    start = max(0, index - train_window)
    return [
        {
            "draw_date": row.draw_date.date().isoformat(),
            "first_prize": str(row.first_prize),
            "bottom_two": str(row.bottom_two),
        }
        for row in frame.iloc[start:index].itertuples(index=False)
    ]


@dataclass
class EvaluatedStep:
    """One draw, and what each model said about it before it happened."""

    draw_date: str
    prize: str
    #: The code actually drawn, per channel (``None`` when the channel cannot be
    #: derived for this ledger's prize width).
    actual: dict[str, str | None]
    #: The model's ranked codes, best first. Empty when the channel is not modelled.
    picks: dict[str, tuple[str, ...]]
    #: A seeded random player's codes for the same draw, filled after the AI pass.
    random_picks: dict[str, tuple[str, ...]] = field(default_factory=dict)
    #: The digit actually drawn in each modelled position.
    actual_digits: dict[str, str] = field(default_factory=dict)
    #: The digit the positional model ranked first in each position.
    predicted_digits: dict[str, str] = field(default_factory=dict)
    train_size: int = 0


def _position_predictions(
    train_rows: Sequence[Mapping[str, Any]],
    prize: str,
    digits: int,
) -> tuple[dict[str, str], dict[str, str]]:
    """Top-1 digit per position, plus the digits the prize actually held.

    Imported here rather than at module scope for the reason ``main.py`` documents:
    ``from models.bayesian import ...`` still executes ``models/__init__.py``, which
    pulls in the ARIMA stack (statsmodels, a measured 1738 ms). ``backtest.py`` is
    imported lazily by the endpoint for the same reason, and this keeps the module
    importable — and its unit tests fast — without paying that at import time.
    """
    from models.bayesian import analyse_positions

    payload = analyse_positions(list(train_rows), length=digits)
    positions = payload.get("positions") or {}

    predicted: dict[str, str] = {}
    actual: dict[str, str] = {}
    for name, position in positions.items():
        top = position.get("top") or []
        if not top:
            continue
        index = position.get("index")
        # Guard the prize's width rather than trusting it: a row whose prize is a
        # different length than the ledger's is reported by the models and must not
        # crash the index below.
        if not isinstance(index, int) or index < 0 or index >= len(prize):
            continue
        predicted[name] = str(top[0]["digit"])
        actual[name] = prize[index]
    return predicted, actual


def walk_forward(
    frame: Any,
    *,
    draws: int,
    train_window: int,
    digits: int,
    top_k: int = DEFAULT_TOP_K,
    warnings: list[str] | None = None,
) -> list[EvaluatedStep]:
    """Replay the most recent ``draws`` draws, each against its own past.

    The models are called through ``services.analyse_draws`` by module attribute —
    not bound at import — so a test can substitute a spy and assert on the rows it
    was handed. That is how the no-leakage property is verified rather than trusted.
    """
    notes = warnings if warnings is not None else []
    total = len(frame)
    # How many draws are candidates for replay: the request, capped by the ledger.
    # Kept separate from the count that end up scored, because the two differ both
    # when the ledger is short and when a step has too little history.
    candidates = min(draws, total)
    start = total - candidates

    steps: list[EvaluatedStep] = []
    skipped = 0
    for index in range(start, total):
        train_rows = training_slice(frame, index, train_window)
        if len(train_rows) < MIN_TRAIN_DRAWS:
            skipped += 1
            continue

        row = frame.iloc[index]
        prediction = services.analyse_draws(train_rows)
        channels = (prediction.get("channels") or {}) if isinstance(prediction, dict) else {}

        picks: dict[str, tuple[str, ...]] = {}
        for channel in services.CHANNELS:
            rankings = (channels.get(channel) or {}).get("rankings") or []
            picks[channel] = tuple(str(entry["code"]) for entry in rankings[:top_k])

        prize = str(row.first_prize)
        predicted_digits, actual_digits = _position_predictions(train_rows, prize, digits)

        steps.append(
            EvaluatedStep(
                draw_date=row.draw_date.date().isoformat(),
                prize=prize,
                actual={"top": row.top if isinstance(row.top, str) else None,
                        "bottom": row.bottom if isinstance(row.bottom, str) else None},
                picks=picks,
                actual_digits=actual_digits,
                predicted_digits=predicted_digits,
                train_size=len(train_rows),
            )
        )

    if skipped:
        notes.append(
            f"Skipped {skipped} of the {candidates} draw(s) available to replay "
            f"(of {draws} requested): fewer than {MIN_TRAIN_DRAWS} earlier draws were "
            "available to train on, and a prediction made without history would be a "
            "fabricated hit rate rather than a backtest."
        )
    return steps


def attach_random_baseline(
    steps: Sequence[EvaluatedStep],
    *,
    top_k: int = DEFAULT_TOP_K,
    seed: int = RANDOM_BASELINE_SEED,
) -> None:
    """Give every step a simulated random player's picks, in place.

    Filled in a second pass, over the steps in chronological order and the channels
    in the API's fixed order, so the sequence of draws the RNG produces depends only
    on the window — not on anything the models did. That is what makes the baseline
    reproducible across runs.
    """
    rng = random.Random(seed)
    for step in steps:
        step.random_picks = {
            channel: tuple(rng.sample(ALL_CODES, top_k)) for channel in services.CHANNELS
        }


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _channel_report(
    steps: Sequence[EvaluatedStep],
    channel: str,
    top_k: int,
    payout_multiple: float,
) -> dict[str, Any]:
    """Win rates, the paired baselines, the p-value, the ROI and the equity curve."""
    # The scored set is built once and used for every metric below, so the AI's
    # denominator and the random player's can never drift apart.
    #
    # A channel counts only where the ledger has a code to compare against *and*
    # the model produced picks: a draw with no derivable code must not enter the
    # denominator, or the hit rate would be diluted by draws nobody could win.
    usable = [
        (step, str(step.actual[channel]))
        for step in steps
        if step.picks.get(channel) and isinstance(step.actual.get(channel), str)
    ]
    total = len(usable)

    if total == 0:
        return {
            "available": False,
            "draws": 0,
            "reason": (
                f"The '{channel}' channel produced no picks for this ledger. For "
                "'top' that is structural: the last two digits of a 6-digit first "
                "prize are not derivable from a 5-digit prize, which is the same rule "
                "that gives Vietnam five modelled positions instead of six."
            ),
        }

    ai_exact = [1 if step.picks[channel][0] == actual else 0 for step, actual in usable]
    ai_top_k = [1 if actual in step.picks[channel] else 0 for step, actual in usable]
    rnd_exact = [
        1 if step.random_picks.get(channel, ())[:1] and step.random_picks[channel][0] == actual else 0
        for step, actual in usable
    ]
    rnd_top_k = [
        1 if actual in step.random_picks.get(channel, ()) else 0 for step, actual in usable
    ]

    exact_hits = sum(ai_exact)
    top_k_hits = sum(ai_top_k)
    rnd_exact_hits = sum(rnd_exact)
    rnd_top_k_hits = sum(rnd_top_k)

    uniform_exact = 100.0 * UNIFORM_EXACT_RATE
    uniform_top_k = 100.0 * top_k / 100.0

    p_exact = binomial_tail(exact_hits, total, UNIFORM_EXACT_RATE)
    p_top_k = binomial_tail(top_k_hits, total, top_k / 100.0)

    return {
        "available": True,
        "draws": total,
        "ai": {
            "exact_hits": exact_hits,
            "exact_hit_rate_percent": _rate_percent(exact_hits, total),
            f"top_{top_k}_hits": top_k_hits,
            f"top_{top_k}_hit_rate_percent": _rate_percent(top_k_hits, total),
        },
        "random": {
            "seed": RANDOM_BASELINE_SEED,
            "exact_hits": rnd_exact_hits,
            "exact_hit_rate_percent": _rate_percent(rnd_exact_hits, total),
            f"top_{top_k}_hits": rnd_top_k_hits,
            f"top_{top_k}_hit_rate_percent": _rate_percent(rnd_top_k_hits, total),
        },
        "uniform": {
            "exact_hit_rate_percent": uniform_exact,
            f"top_{top_k}_hit_rate_percent": uniform_top_k,
        },
        "skill": {
            "exact_lift_vs_uniform": _ratio(
                _rate_percent(exact_hits, total), uniform_exact
            ),
            f"top_{top_k}_lift_vs_uniform": _ratio(
                _rate_percent(top_k_hits, total), uniform_top_k
            ),
            "exact_p_value": round(p_exact, 4),
            f"top_{top_k}_p_value": round(p_top_k, 4),
            "exact_significant": p_exact < SIGNIFICANCE_ALPHA,
            f"top_{top_k}_significant": p_top_k < SIGNIFICANCE_ALPHA,
            "alpha": SIGNIFICANCE_ALPHA,
            "exact_hits_needed": hits_needed_for_significance(total, UNIFORM_EXACT_RATE),
            f"top_{top_k}_hits_needed": hits_needed_for_significance(
                total, top_k / 100.0
            ),
        },
        "timeline": _timeline(usable, channel, top_k),
        "roi": _roi_block(
            exact_hits,
            top_k_hits,
            rnd_exact_hits,
            rnd_top_k_hits,
            total,
            payout_multiple,
            top_k,
        ),
        "equity": _equity_curve(usable, channel, payout_multiple),
    }


def _timeline(
    usable: Sequence[tuple[EvaluatedStep, str]],
    channel: str,
    top_k: int,
) -> list[dict[str, Any]]:
    """Cumulative rates after each draw — the series the chart plots.

    Cumulative rather than a rolling window: at this sample size a rolling rate is
    dominated by whichever single draw fell out of the window, which reads as
    volatility in the model when it is only the sample.
    """
    timeline: list[dict[str, Any]] = []
    ai_exact = ai_top_k = rnd_exact = rnd_top_k = 0
    for position, (step, actual) in enumerate(usable, start=1):
        ai_exact += 1 if step.picks[channel][0] == actual else 0
        ai_top_k += 1 if actual in step.picks[channel] else 0
        random_picks = step.random_picks.get(channel, ())
        rnd_exact += 1 if random_picks[:1] and random_picks[0] == actual else 0
        rnd_top_k += 1 if actual in random_picks else 0
        timeline.append(
            {
                "draw_date": step.draw_date,
                "draws": position,
                "actual": actual,
                "pick": step.picks[channel][0],
                f"ai_top_{top_k}_rate_percent": _rate_percent(ai_top_k, position),
                f"random_top_{top_k}_rate_percent": _rate_percent(rnd_top_k, position),
                "ai_exact_rate_percent": _rate_percent(ai_exact, position),
                "random_exact_rate_percent": _rate_percent(rnd_exact, position),
                "exact_hit": 1 if step.picks[channel][0] == actual else 0,
                f"top_{top_k}_hit": 1 if actual in step.picks[channel] else 0,
            }
        )
    return timeline


def _equity_curve(
    usable: Sequence[tuple[EvaluatedStep, str]],
    channel: str,
    payout_multiple: float,
) -> list[dict[str, Any]]:
    """Cumulative net units for the AI and the random player, bet for bet.

    Both lines stake one unit per draw on their single top pick, so the vertical gap
    between them *is* the edge, and either line crossing zero is the break-even the
    payout implies. Plotted instead of two ROI figures alone because a rate hides
    the sequence, and the sequence is what a player experiences.
    """
    curve: list[dict[str, Any]] = []
    ai_net = rnd_net = 0.0
    for position, (step, actual) in enumerate(usable, start=1):
        ai_net += (payout_multiple if step.picks[channel][0] == actual else 0.0) - 1.0
        random_picks = step.random_picks.get(channel, ())
        rnd_net += (payout_multiple if random_picks[:1] and random_picks[0] == actual else 0.0) - 1.0
        curve.append(
            {
                "draw_date": step.draw_date,
                "draws": position,
                "ai_net_units": round(ai_net, 2),
                "random_net_units": round(rnd_net, 2),
            }
        )
    return curve


def _roi_block(
    exact_hits: int,
    top_k_hits: int,
    random_exact_hits: int,
    random_top_k_hits: int,
    total: int,
    payout_multiple: float,
    top_k: int,
) -> dict[str, Any]:
    """ROI for the two strategies, each against the random player's same strategy.

    Both strategies are real and are priced separately rather than blended: backing
    one pick per draw stakes one unit, and covering all ``top_k`` picks stakes
    ``top_k`` units for the same draw, so the cover's ROI is lower unless its extra
    hits pay for the extra stake. Reporting only the better-looking one would be a
    choice about which story to tell; reporting both is a measurement.
    """
    return {
        "payout_multiple": payout_multiple,
        "stake_per_pick_units": 1.0,
        "break_even_hit_rate_percent": round(100.0 / payout_multiple, 2),
        "exact": {
            "strategy": "one unit on the top-ranked code, every draw",
            "ai": _roi(exact_hits, float(total), payout_multiple),
            "random": _roi(random_exact_hits, float(total), payout_multiple),
        },
        "cover": {
            "strategy": f"one unit on each of the {top_k} ranked codes, every draw",
            "picks_per_draw": top_k,
            "ai": _roi(top_k_hits, float(total * top_k), payout_multiple),
            "random": _roi(random_top_k_hits, float(total * top_k), payout_multiple),
        },
    }


def _positional_report(steps: Sequence[EvaluatedStep]) -> dict[str, Any]:
    """The premium model's per-position accuracy, against its own 10% baseline.

    This section is why the premium tier can be sold on evidence: six positions
    across 30 draws is 180 predictions, which is enough for a 10% event to be
    measurable — unlike the 1% 2-digit game, where the same window has no resolving
    power at all. Per-position and pooled rates are both reported, because a single
    strong position and six mediocre ones produce the same pooled number.
    """
    scored = [step for step in steps if step.predicted_digits and step.actual_digits]
    positions: dict[str, dict[str, Any]] = {}

    # The model's own reading order, taken from the payload dicts rather than
    # hard-coded: `hundred_thousands` must precede `units` for a 6-digit prize, and
    # a 5-digit ledger simply never mentions `hundred_thousands`.
    names: list[str] = []
    for step in scored:
        for name in step.predicted_digits:
            if name not in names:
                names.append(name)

    total_hits = 0
    total_predictions = 0
    for name in names:
        # Counted position by position, skipping any step that did not evaluate this
        # one — comparing two absent digits must never be scored as a hit.
        hits = 0
        predictions = 0
        for step in scored:
            actual = step.actual_digits.get(name)
            if actual is None:
                continue
            predictions += 1
            if step.predicted_digits.get(name) == actual:
                hits += 1
        total_hits += hits
        total_predictions += predictions
        p_value = binomial_tail(hits, predictions, UNIFORM_DIGIT_RATE)
        positions[name] = {
            "hits": hits,
            "predictions": predictions,
            "hit_rate_percent": _rate_percent(hits, predictions),
            "baseline_percent": 100.0 * UNIFORM_DIGIT_RATE,
            "lift_vs_uniform": _ratio(_rate_percent(hits, predictions), 100.0 * UNIFORM_DIGIT_RATE),
            "p_value": round(p_value, 4),
            "significant": p_value < SIGNIFICANCE_ALPHA,
            "hits_needed": hits_needed_for_significance(predictions, UNIFORM_DIGIT_RATE),
        }

    pooled_p = binomial_tail(total_hits, total_predictions, UNIFORM_DIGIT_RATE)
    return {
        "model": "bayesian_positional",
        "draws": len(scored),
        "positions": positions,
        "overall": {
            "hits": total_hits,
            "predictions": total_predictions,
            "hit_rate_percent": _rate_percent(total_hits, total_predictions),
            "baseline_percent": 100.0 * UNIFORM_DIGIT_RATE,
            "lift_vs_uniform": _ratio(
                _rate_percent(total_hits, total_predictions), 100.0 * UNIFORM_DIGIT_RATE
            ),
            "p_value": round(pooled_p, 4),
            "significant": pooled_p < SIGNIFICANCE_ALPHA,
            "hits_needed": hits_needed_for_significance(total_predictions, UNIFORM_DIGIT_RATE),
        },
        "timeline": _positional_timeline(scored, names),
    }


def _positional_timeline(
    scored: Sequence[EvaluatedStep],
    names: Sequence[str],
) -> list[dict[str, Any]]:
    """Cumulative positional accuracy, AI against the 10% baseline.

    This is the series with the statistical power to move: up to six observations
    per draw against a 10% event, where the 2-digit chart has one against 1%.
    """
    timeline: list[dict[str, Any]] = []
    hits = predictions = 0
    for step in scored:
        for name in names:
            actual = step.actual_digits.get(name)
            if actual is None:
                continue
            predictions += 1
            hits += 1 if step.predicted_digits.get(name) == actual else 0
        timeline.append(
            {
                "draw_date": step.draw_date,
                "draws": len(timeline) + 1,
                "predictions": predictions,
                "hits": hits,
                "hit_rate_percent": _rate_percent(hits, predictions),
                "baseline_percent": 100.0 * UNIFORM_DIGIT_RATE,
            }
        )
    return timeline


def _power_block(total: int, top_k: int) -> dict[str, Any]:
    """What this window can and cannot resolve, stated numerically."""
    return {
        "draws": total,
        "exact_hits_needed": hits_needed_for_significance(total, UNIFORM_EXACT_RATE),
        f"top_{top_k}_hits_needed": hits_needed_for_significance(total, top_k / 100.0),
        "note": (
            f"With {total} draw(s), the 1-in-100 exact game is expected to hit "
            f"{round(total * UNIFORM_EXACT_RATE, 2)} times, so this window cannot "
            "resolve the 2-digit model on its own. The positional section has "
            "roughly six times as many predictions against a 10% baseline and is "
            "the part of this report that can actually distinguish the model from "
            "chance."
        ),
    }


# ---------------------------------------------------------------------------
# The API payload
# ---------------------------------------------------------------------------


def run_backtest(
    rows: Iterable[Mapping[str, Any]],
    *,
    lottery_type: str = "thai",
    draws: int = DEFAULT_DRAWS,
    train_window: int,
    prize_digits: int | None = None,
    payout_multiple: float | None = None,
    top_k: int = DEFAULT_TOP_K,
) -> dict[str, Any]:
    """Replay the last ``draws`` draws and report how the models did.

    Pure over ``rows``: the same input always produces the same payload, so every
    number here is reproducible from the ledger alone. Degrades rather than
    raising — an empty or short ledger returns a well-formed ``insufficient_data``
    response with the reason in ``warnings``, matching ``services.analyse_draws``
    and every other endpoint in this service.
    """
    warnings: list[str] = []
    frame, frame_warnings = services.prepare_history(rows)
    warnings.extend(frame_warnings)
    total = int(len(frame))

    digits = prize_digits
    if digits is None:
        digits = len(str(frame.iloc[-1].first_prize)) if total else 6

    payout = payout_multiple
    if payout is None:
        payout = PAYOUT_MULTIPLE_BY_LEDGER.get(lottery_type, 100.0)

    payload: dict[str, Any] = {
        "status": "insufficient_data",
        "engine": "walk_forward",
        "lottery_type": lottery_type,
        "prize_digits": digits,
        "draws_requested": draws,
        "draws_evaluated": 0,
        "train_window": train_window,
        "top_k": top_k,
        "leakage_guard": LEAKAGE_GUARD,
        "models": ["frequency", "markov", "bayesian_positional"],
        "models_excluded": MODELS_EXCLUDED,
        "economy": {
            "payout_multiple": payout,
            "payout_basis": PAYOUT_BASIS.get(lottery_type, ""),
            "break_even_hit_rate_percent": round(100.0 / payout, 2) if payout else None,
            "assumption": (
                "ROI is computed at the payout multiple stated above. A negative ROI "
                "on a real payout is the house edge, not a model failure: at 25x the "
                "break-even hit rate is 4%, so the comparison against the random "
                "baseline is the evidence of skill, not the sign of the ROI."
            ),
        },
        "random_baseline": {
            "method": (
                f"A seeded uniform draw of {top_k} distinct codes per draw per "
                "channel, replayed over the same draws as the model."
            ),
            "seed": RANDOM_BASELINE_SEED,
            "expected_exact_rate_percent": 100.0 * UNIFORM_EXACT_RATE,
            f"expected_top_{top_k}_rate_percent": 100.0 * top_k / 100.0,
        },
        "channels": {},
        "positional": {},
        "warnings": warnings,
        "methodology": METHODOLOGY,
    }

    if total == 0:
        warnings.append(
            "No usable draws, so nothing could be replayed. Seed the ledger with "
            "backend/scraper.py (Thai) or backend/scripts/scrape_international.py "
            "(Lao and Vietnamese)."
        )
        return payload

    steps = walk_forward(
        frame,
        draws=draws,
        train_window=train_window,
        digits=digits,
        top_k=top_k,
        warnings=warnings,
    )
    attach_random_baseline(steps, top_k=top_k)

    payload["draws_evaluated"] = len(steps)
    payload["date_range"] = {
        "from": steps[0].draw_date if steps else None,
        "to": steps[-1].draw_date if steps else None,
    }
    payload["train_sizes"] = {
        "min": min((step.train_size for step in steps), default=0),
        "max": max((step.train_size for step in steps), default=0),
    }
    payload["power"] = _power_block(len(steps), top_k)

    channels: dict[str, Any] = {
        channel: _channel_report(steps, channel, top_k, payout)
        for channel in services.CHANNELS
    }
    payload["channels"] = channels

    payload["positional"] = _positional_report(steps)

    available = [name for name, report in channels.items() if report.get("available")]
    positional = payload["positional"]
    if not available and not (positional.get("overall") or {}).get("predictions"):
        payload["status"] = "insufficient_data"
        warnings.append(
            "No channel and no position could be evaluated for this ledger, so no "
            "accuracy claim is published."
        )
    elif not available or len(steps) < min(draws, total):
        payload["status"] = "limited"
    else:
        payload["status"] = "ok"

    return payload
