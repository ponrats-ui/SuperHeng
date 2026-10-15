"""Post-draw accuracy — what the model said about a draw *before* it happened.

WHY THIS IS A REPLAY, AND NOT A RECORDED FORECAST
-------------------------------------------------
Nothing in this system stores a prediction. There is no predictions table, and
``services.py`` is explicit about it: the ranking's ``delta`` ("change vs the
previous model run") is shipped as ``0.0`` because "no run is stored yet — that
arrives with the Day 5 draw-cycle job".

So the only honest way to compare a model against a completed draw is to rebuild
the prediction the way it *would* have been made at the time. For a target draw at
chronological index ``t`` the models are handed exactly
``frame[t - train_window : t]`` — the draws strictly before it — through
``backtest.training_slice``, which is the same function the backtest engine uses
and the same property ``tests/test_backtest.py`` verifies by spying on the rows the
model is handed. The target row, and every later row, are excluded by construction.

That distinction is carried into the payload: every response states
``prediction_basis: "walk_forward_replay"`` and repeats it in ``replay_notice`` and
``limitations``. Printing a replayed prediction under the heading "what the AI
predicted for this draw" would be a fabricated claim about the past, which is the
one thing an accuracy report must never do. A recorded forecast needs a snapshot
written *before* the draw; until that exists this report is a reconstruction, and
it says so on its own screen.

WHAT IS SCORED
--------------
* **Per position** — the premium tier's own model
  (``models.bayesian.analyse_positions``). The last completed draw is re-predicted
  and each position's top three digits are returned with the digit that was
  actually drawn, its 1-based rank among them, and whether it was the top pick.
  This is the part with statistical power: six positions against a 10% baseline is
  a measurable event, where the 1-in-100 two-digit game is not.
* **The two 2-digit channels** — ``top`` (last two digits of the first prize,
  derived) and ``bottom`` (the separately drawn 2-digit prize) through
  ``services.analyse_draws``, scored both exactly and inside the top five, matching
  the five picks the dashboard shows.

Every rate is published beside the baseline it must beat — 10% per position, 1%
exact and 5% in five picks for the 2-digit channels — and with a one-sided binomial
p-value from ``backtest.binomial_tail``. At a handful of draws the honest reading is
almost always "indistinguishable from chance", and the payload says that rather
than letting a green hit stand alone as proof.

WHAT THIS CANNOT DO
-------------------
* It cannot report a **recorded** forecast (see above).
* It cannot score the promised 3-digit prize: ``lottery_draws`` stores only
  ``first_prize`` and ``bottom_two``, so there is no 3-digit result in the ledger to
  compare against. Both facts are listed in the payload's ``limitations``.
* It is deliberately not the ARIMA/Monte Carlo ensemble, for the reason
  ``backtest.py`` measures: one walk-forward step through it costs 8.28 s, which no
  request can afford.

Pure over its input rows, like ``backtest.run_backtest`` and
``services.analyse_draws``: the endpoint fetches the ledger, this module computes,
so the whole report is reproducible from the rows alone.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

import backtest
import services

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

#: How many recent draws to compare by default. The card's headline is the latest
#: draw; the rest give the hit rate a sample and make one lucky or unlucky draw
#: visible as what it is.
DEFAULT_DRAWS = 5

#: Upper bound on a request. A step costs a measured ~62 ms for the two 2-digit
#: channels plus ~9.5 ms for the positional model, so 20 steps is roughly 1.5 s of
#: compute — a request budget, not a statistical one.
MAX_DRAWS = 20

#: At least one draw: "how did the last draw go" is the question being asked.
MIN_DRAWS = 1

PREDICTION_BASIS = "walk_forward_replay"

REPLAY_NOTICE = (
    "These are replayed predictions, not recorded ones. The model was re-run for "
    "each draw using only the draws before it, because this service does not store "
    "a prediction when it makes one. A recorded forecast would need a snapshot "
    "written before the draw."
)

LIMITATIONS: list[str] = [
    (
        "Replay, not a record: no prediction is stored anywhere in this service, so "
        "each one below was recomputed from the draws preceding its target draw. "
        "That reproduces what the model would have said and is not evidence that it "
        "was run at the time."
    ),
    (
        "The 3-digit prize is not scored: `lottery_draws` stores only `first_prize` "
        "and `bottom_two`, so there is no 3-digit result in the ledger to compare a "
        "3-digit prediction against."
    ),
    (
        "Positions are scored one digit at a time against a 10% baseline. Winning "
        "two positions is not a prediction of a winning ticket — the digits are "
        "ranked independently, and a full 6-digit match is a 1-in-a-million event "
        "that a handful of draws cannot demonstrate either way."
    ),
    (
        "The p-values are per quantity and are **not** corrected for the number of "
        "things compared here — six positions, two channels, two strategies per "
        "channel. A `significant` flag on a handful of draws is therefore weaker "
        "than it looks: about one in twenty of them would clear 0.05 by chance "
        "alone. The sample size and the hits needed for significance are published "
        "beside every rate so this can be judged rather than taken on trust."
    ),
]

METHODOLOGY = (
    "For each draw under test the models are trained only on the draws strictly "
    "before it (walk-forward replay, no future row visible), then compared against "
    "the result that was actually published. Every rate is reported beside its "
    "uniform baseline — 10% for one digit in one position, 1% for an exact 2-digit "
    "hit and 5% for a hit inside five picks — with a one-sided binomial p-value for "
    "'the model is no better than chance'. A p-value above 0.05 means this sample "
    "cannot tell the model from a coin, and the response says so."
)


# ---------------------------------------------------------------------------
# One draw, as a comparison
# ---------------------------------------------------------------------------


def position_comparison(
    train_rows: Sequence[Mapping[str, Any]],
    prize: str,
    digits: int,
) -> list[dict[str, Any]]:
    """The model's top three digits per position, against the digit drawn.

    Imported inside the function, not at module scope: ``models.bayesian`` pulls in
    the statsmodels stack (a measured 1738 ms), and ``backtest._position_predictions``
    documents the same deferral for the same reason.

    Sorted by ``index`` — 0 is the leading digit — rather than trusting the order
    the model's dict happens to iterate in, so the panel always reads left to right
    however the payload is later reorganised.

    A position whose index falls outside the prize string is skipped rather than
    indexed into: a ledger row whose width disagrees with the ledger's declared
    ``prize_digits`` is a data problem, and it must not raise here.
    """
    from models.bayesian import analyse_positions

    payload = analyse_positions(list(train_rows), length=digits)
    positions = payload.get("positions") or {}

    rows: list[dict[str, Any]] = []
    for name, position in positions.items():
        index = position.get("index")
        if not isinstance(index, int) or index < 0 or index >= len(prize):
            continue

        top = [
            entry
            for entry in (position.get("top") or [])
            if isinstance(entry, Mapping) and isinstance(entry.get("digit"), str)
        ]
        actual = prize[index]
        predicted = str(top[0]["digit"]) if top else None
        rank = next(
            (position + 1 for position, entry in enumerate(top) if entry["digit"] == actual),
            None,
        )

        rows.append(
            {
                "name": name,
                "index": index,
                "actual": actual,
                "predicted": predicted,
                "hit": predicted == actual,
                # The actual digit is somewhere in the top three: a near miss, and
                # reported as one rather than collapsed into the yes/no above.
                "in_top": rank is not None,
                "actual_rank": rank,
                "support": position.get("support"),
                "basis": position.get("basis"),
                "top": [
                    {
                        "digit": entry["digit"],
                        "probability": entry.get("probability"),
                    }
                    for entry in top
                ],
            }
        )

    rows.sort(key=lambda row: row["index"])
    return rows


def channel_comparison(
    train_rows: Sequence[Mapping[str, Any]],
    actual: Mapping[str, str | None],
    *,
    top_k: int,
) -> dict[str, Any]:
    """The 2-digit model's picks per channel, against the code that was drawn.

    ``actual[channel]`` is ``None`` when the ledger cannot supply that channel for
    this row — for Vietnam a five-digit first prize has no last-two-digits to derive,
    which is structural rather than missing data — and that is reported as an
    unavailable channel rather than as a miss.
    """
    prediction = services.analyse_draws(list(train_rows))
    channels = (prediction.get("channels") or {}) if isinstance(prediction, dict) else {}

    out: dict[str, Any] = {}
    for channel in services.CHANNELS:
        drawn = actual.get(channel)
        rankings = (channels.get(channel) or {}).get("rankings") or []
        picks = [str(entry["code"]) for entry in rankings[:top_k]]

        if not isinstance(drawn, str):
            out[channel] = {
                "available": False,
                "actual": None,
                "picks": picks,
                "reason": (
                    f"The '{channel}' channel has no result to compare against for "
                    "this ledger. For 'top' that is structural: the last two digits "
                    "of a six-digit first prize cannot be derived from a five-digit "
                    "one."
                ),
            }
            continue

        out[channel] = {
            "available": True,
            "actual": drawn,
            "picks": picks,
            "predicted": picks[0] if picks else None,
            "exact_hit": bool(picks) and picks[0] == drawn,
            f"in_top_{top_k}": drawn in picks,
        }
    return out


def compare_draw(
    frame: Any,
    index: int,
    *,
    train_window: int,
    digits: int,
    top_k: int,
) -> dict[str, Any] | None:
    """One draw's full comparison, or ``None`` when history is too thin to replay.

    ``None`` is returned rather than a fabricated prediction, matching
    ``backtest.walk_forward``: a step scored on five draws would publish a rate the
    model itself would refuse to stand behind.
    """
    train_rows = backtest.training_slice(frame, index, train_window)
    if len(train_rows) < backtest.MIN_TRAIN_DRAWS:
        return None

    row = frame.iloc[index]
    prize = str(row.first_prize)

    positions = position_comparison(train_rows, prize, digits)
    channels = channel_comparison(
        train_rows,
        {
            "top": row.top if isinstance(row.top, str) else None,
            "bottom": row.bottom if isinstance(row.bottom, str) else None,
        },
        top_k=top_k,
    )

    return {
        "draw_date": row.draw_date.date().isoformat(),
        "first_prize": prize,
        "bottom_two": str(row.bottom_two),
        "top_two": row.top if isinstance(row.top, str) else None,
        "train_size": len(train_rows),
        "positions": positions,
        "position_hits": sum(1 for entry in positions if entry["hit"]),
        "position_in_top": sum(1 for entry in positions if entry["in_top"]),
        "position_predictions": len(positions),
        "channels": channels,
    }


# ---------------------------------------------------------------------------
# Aggregates
# ---------------------------------------------------------------------------


def _rate(hits: int, total: int) -> float | None:
    """Hit rate as a percentage, or ``None`` when there is nothing to divide by."""
    if total <= 0:
        return None
    return round(100.0 * hits / total, 2)


def _lift(rate: float | None, baseline_percent: float) -> float | None:
    if rate is None or not baseline_percent:
        return None
    return round(rate / baseline_percent, 3)


def _scored(
    hits: int,
    predictions: int,
    baseline: float,
) -> dict[str, Any]:
    """A rate with its baseline, lift, p-value and a verdict. One shape, everywhere.

    Built by a single function so no section of this payload can publish a rate
    without the baseline it has to be read against — the rule the whole project
    applies to accuracy numbers, applied here structurally instead of by discipline.
    """
    p_value = backtest.binomial_tail(hits, predictions, baseline)
    baseline_percent = round(100.0 * baseline, 2)
    rate = _rate(hits, predictions)
    return {
        "hits": hits,
        "predictions": predictions,
        "hit_rate_percent": rate,
        "baseline_percent": baseline_percent,
        "lift_vs_uniform": _lift(rate, baseline_percent),
        "p_value": round(p_value, 4),
        "significant": p_value < backtest.SIGNIFICANCE_ALPHA,
        "hits_needed": backtest.hits_needed_for_significance(predictions, baseline),
        "alpha": backtest.SIGNIFICANCE_ALPHA,
    }


def positional_accuracy(
    comparisons: Sequence[Mapping[str, Any]],
    digits: int,
) -> dict[str, Any]:
    """Per-position and pooled accuracy over the replayed draws.

    Pooled *and* per position, because one strong position and five mediocre ones
    produce the same pooled number and only the breakdown says which happened.
    Position names are collected in the order they appear (the model's reading
    order) so a five-digit ledger simply never mentions ``hundred_thousands``.
    """
    names: list[str] = []
    for comparison in comparisons:
        for entry in comparison.get("positions") or []:
            name = entry.get("name")
            if isinstance(name, str) and name not in names:
                names.append(name)

    by_position: dict[str, Any] = {}
    total_hits = total_predictions = 0
    for name in names:
        hits = predictions = 0
        for comparison in comparisons:
            entry = next(
                (item for item in (comparison.get("positions") or []) if item.get("name") == name),
                None,
            )
            if entry is None or not entry.get("predicted"):
                continue
            predictions += 1
            if entry.get("hit"):
                hits += 1
        total_hits += hits
        total_predictions += predictions
        by_position[name] = _scored(hits, predictions, backtest.UNIFORM_DIGIT_RATE)

    return {
        "model": "bayesian_positional",
        "draws": len(comparisons),
        "prize_digits": digits,
        "positions": by_position,
        "overall": _scored(total_hits, total_predictions, backtest.UNIFORM_DIGIT_RATE),
    }


def channel_accuracy(
    comparisons: Sequence[Mapping[str, Any]],
    top_k: int,
) -> dict[str, Any]:
    """Exact and top-``top_k`` accuracy per 2-digit channel.

    Both strategies are priced separately rather than blended, for the reason
    ``backtest._roi_block`` gives: backing one pick per draw and covering all five
    stake different amounts, and reporting only the better-looking one would be a
    choice about which story to tell.
    """
    report: dict[str, Any] = {}
    for channel in services.CHANNELS:
        exact_hits = top_hits = total = 0
        for comparison in comparisons:
            entry = (comparison.get("channels") or {}).get(channel) or {}
            if not entry.get("available"):
                continue
            total += 1
            if entry.get("exact_hit"):
                exact_hits += 1
            if entry.get(f"in_top_{top_k}"):
                top_hits += 1

        if total == 0:
            report[channel] = {
                "available": False,
                "draws": 0,
                "reason": (
                    f"The '{channel}' channel produced nothing to score for this "
                    "ledger, which is structural for 'top' when the first prize has "
                    "five digits."
                ),
            }
            continue

        report[channel] = {
            "available": True,
            "draws": total,
            "exact": _scored(exact_hits, total, backtest.UNIFORM_EXACT_RATE),
            f"in_top_{top_k}": _scored(top_hits, total, top_k / 100.0),
            "picks_per_draw": top_k,
        }
    return report


# ---------------------------------------------------------------------------
# The API payload
# ---------------------------------------------------------------------------


def build_report(
    rows: Iterable[Mapping[str, Any]],
    *,
    lottery_type: str = "thai",
    draws: int = DEFAULT_DRAWS,
    train_window: int,
    prize_digits: int | None = None,
    top_k: int = backtest.DEFAULT_TOP_K,
) -> dict[str, Any]:
    """Compare the most recent draws against what the model said about them.

    Degrades rather than raising, like every other endpoint here: an empty or short
    ledger returns a well-formed ``insufficient_data`` payload with the reason in
    ``warnings``, so the card renders an empty state instead of an error.
    """
    warnings: list[str] = []
    frame, frame_warnings = services.prepare_history(rows)
    warnings.extend(frame_warnings)
    total = int(len(frame))

    digits = prize_digits
    if digits is None:
        digits = len(str(frame.iloc[-1].first_prize)) if total else 6

    payload: dict[str, Any] = {
        "status": "insufficient_data",
        "lottery_type": lottery_type,
        "prize_digits": digits,
        "model": "bayesian_positional",
        "draws_requested": draws,
        "draws_evaluated": 0,
        "train_window": train_window,
        "top_k": top_k,
        "prediction_basis": PREDICTION_BASIS,
        "replay_notice": REPLAY_NOTICE,
        "comparisons": [],
        "accuracy": {},
        "warnings": warnings,
        "limitations": LIMITATIONS,
        "methodology": METHODOLOGY,
    }

    if total == 0:
        warnings.append(
            "No usable draws, so no comparison could be rebuilt. Seed the ledger "
            "with backend/scraper.py (Thai) or "
            "backend/scripts/scrape_international.py (Lao and Vietnamese)."
        )
        return payload

    candidates = min(draws, total)
    start = total - candidates

    comparisons: list[dict[str, Any]] = []
    # Newest first: the card's headline is the most recent draw, and a reader
    # scrolling a short list should meet the interesting row first.
    for index in range(total - 1, start - 1, -1):
        comparison = compare_draw(
            frame,
            index,
            train_window=train_window,
            digits=digits,
            top_k=top_k,
        )
        if comparison is not None:
            comparisons.append(comparison)

    payload["comparisons"] = comparisons
    payload["draws_evaluated"] = len(comparisons)

    if not comparisons:
        warnings.append(
            f"None of the {candidates} most recent draw(s) had at least "
            f"{backtest.MIN_TRAIN_DRAWS} earlier draws to train on, so no prediction "
            "could be rebuilt for them. A prediction made without history would be a "
            "fabricated comparison rather than a replay."
        )
        return payload

    positional = positional_accuracy(comparisons, digits)
    channels = channel_accuracy(comparisons, top_k)
    payload["accuracy"] = {"positional": positional, "channels": channels}

    payload["date_range"] = {
        "from": comparisons[-1]["draw_date"],
        "to": comparisons[0]["draw_date"],
    }
    payload["train_sizes"] = {
        "min": min(comparison["train_size"] for comparison in comparisons),
        "max": max(comparison["train_size"] for comparison in comparisons),
    }

    scored_channels = [name for name, report in channels.items() if report.get("available")]
    if not scored_channels and not positional["overall"]["predictions"]:
        payload["status"] = "insufficient_data"
        warnings.append(
            "No position and no channel could be scored, so this ledger publishes "
            "no accuracy claim at all."
        )
    elif len(comparisons) < candidates or not scored_channels:
        # Fewer draws than were asked for, or a channel this ledger cannot supply.
        # Both are "read this with the limitation stated", not failures.
        payload["status"] = "limited"
    else:
        payload["status"] = "ok"

    if len(comparisons) < candidates:
        warnings.append(
            f"Compared {len(comparisons)} of the {candidates} draw(s) available "
            f"(of {draws} requested): the rest had fewer than "
            f"{backtest.MIN_TRAIN_DRAWS} earlier draws to train on."
        )

    positional_overall = positional["overall"]
    if positional_overall["predictions"] and not positional_overall["significant"]:
        warnings.append(
            f"Across {positional_overall['predictions']} positional prediction(s) "
            f"the model hit {positional_overall['hits']} at "
            f"{positional_overall['hit_rate_percent']}% against a "
            f"{positional_overall['baseline_percent']}% baseline (p="
            f"{positional_overall['p_value']}). At this sample size that is "
            "indistinguishable from chance, and a green row or two below is not "
            "evidence of skill."
        )

    return payload
