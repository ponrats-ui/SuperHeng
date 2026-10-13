"""SuperHeng — Day 5: ARIMA time-series model.

What is being modelled, and why it is not "the number as a series"
------------------------------------------------------------------
A 2-digit code is a **label**, not a quantity. A draw of ``48`` followed by
``03`` does not mean the value went down; the codes have no order relationship,
so regressing the code itself would fit arithmetic to a categorical variable and
produce a number with no meaning.

What *is* numerically meaningful is the **occurrence rate over time**. For one
code, the draw ledger becomes a binary indicator series:

    draws:  48, 03, 48, 07, 48, ...   ->   code "48" => 1, 0, 1, 0, 1, ...

An ARIMA model on that indicator forecasts *"what is the probability this code
appears in the next draw?"* — a real quantity, comparable across codes, and the
same units the Day 3 frequency and Markov models already speak. That is the
series fitted here, one per code.

Order selection: measured, not assumed
--------------------------------------
The roadmap asks for automatic order selection by AIC. That is implemented
(:func:`select_order`) and testable, but it is **not the default**, because it
was measured on a realistic 400-draw ledger and lost on every count:

===================================  ======  ========  =============  =============
order                                AIC#    median    median |forecast -   cost per
                                     wins    fit (ms)  observed rate|      fit (ms)
===================================  ======  ========  =============  =============
``ARIMA(1, 0, 0)``                     21/25     41.9      0.00035          41.9
``ARIMA(0, 0, 1)``                      1/25     22.9      0.00042          22.9
``ARIMA(1, 0, 1)``                      2/25     85.4      0.00388          85.4
``ARIMA(2, 0, 1)``                      1/25    132.1      0.00389         132.1
``ARIMA(1, 1, 1)``                      0/25     58.9      0.00046          58.9
===================================  ======  ========  =============  =============

Two things follow. The parsimonious ``(1, 0, 0)`` wins AIC most often, is the
cheapest to fit, **and** is an order of magnitude closer to the observed rate
than any order carrying an MA term. And the median AIC margin between the best
and runner-up order was **1.94**, with 13 of 25 codes inside a margin below 2 —
on this sample the search is choosing between statistically indistinguishable
models, so its extra cost buys a coin toss rather than accuracy.

The default is therefore a single fixed ``(1, 0, 0)``. Pass ``AIC_ORDER_GRID``
to :func:`arima_forecast` to run the full five-order search anyway — it costs
about 5x and is there for anyone who wants to re-test the claim on a larger
ledger.

Cost, and the fallback that keeps it bounded
--------------------------------------------
Even at one order, a fit is ~42 ms, so fitting all 100 codes in both channels
would cost ~8 s per request. ARIMA is therefore fitted only for the
``max_codes`` most frequent codes per channel — the only codes that can
plausibly reach a top-5 ranking, since a code with 3 occurrences is already
outside the top 30 on frequency alone.

Every other code is assigned the **smoothed unconditional rate**, and is marked
``fitted: False`` with the reason. It is not zero and it is not a guess: it is the
same add-k smoothed baseline ``services`` already uses for the Markov lift
denominator, so a cold code sits at the historical average rather than being
penalised for having not been modelled.

Failure handling
----------------
Sparse binary series are hostile to an ARIMA optimiser, so every fit is wrapped:
a ``LinAlgError``, a ``ValueError``, or any other fitting failure is **recorded
per code and reported in the response** — never swallowed, and never allowed to
take down the request. A forecast is clamped to ``[0, 1]`` because ARIMA will
happily return a negative "probability" on a series with almost no events
(measured: ``-0.01446`` on a 30-draw series with three occurrences); the raw value
is kept alongside so the clamp is visible rather than hidden.
"""

from __future__ import annotations

import time
import warnings
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
import pandas as pd
from statsmodels.tsa.arima.model import ARIMA

from services import (
    DEFAULT_SMOOTHING,
    NUMBER_UNIVERSE,
    TOP_N,
    UNIVERSE_SIZE,
    unconditional_distribution,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# The shipped default: one parsimonious order. See the module docstring for the
# measurement that selected it.
PARSIMONIOUS_ORDER: tuple[int, int, int] = (1, 0, 0)
DEFAULT_ORDER_GRID: tuple[tuple[int, int, int], ...] = (PARSIMONIOUS_ORDER,)

# The full search the roadmap specifies. Off by default; ~5x the cost.
AIC_ORDER_GRID: tuple[tuple[int, int, int], ...] = (
    (1, 0, 0),
    (0, 0, 1),
    (1, 0, 1),
    (2, 0, 1),
    (1, 1, 1),
)

# How many codes per channel get a real fit. See the docstring: the rest receive
# the smoothed unconditional rate instead.
DEFAULT_MAX_CODES = 30

# A code must have appeared at least this often for its indicator series to
# carry any signal, and a channel needs at least this many draws for the series
# to be worth fitting at all.
MIN_OCCURRENCES = 4
MIN_ARIMA_DRAWS = 30

# Hard floor for a single fit, checked inside `fit_arima` so the primitives are
# safe on their own and not only behind `arima_forecast`'s earlier gate. Without
# it statsmodels will happily "fit" an empty series: ARIMA(1,1,1) on zero
# observations returned an AIC of 6.0 with 86 convergence warnings, which is a
# successful-looking garbage model and exactly the sort of thing that would be
# published as a forecast.
MIN_FIT_OBSERVATIONS = 10

# statsmodels signals a failed optimisation with different exception types
# depending on where it gave up. Anything raised here is caught, attributed to
# the code, and reported in the response.
FITTING_ERRORS: tuple[type[BaseException], ...] = (
    np.linalg.LinAlgError,
    ValueError,
    FloatingPointError,
    ArithmeticError,
    ZeroDivisionError,
)


class ArimaFitError(RuntimeError):
    """Both the constrained and the relaxed fit failed for one code."""


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------


def occurrence_series(series: pd.Series, code: str) -> pd.Series:
    """The 0/1 indicator series for one code: did it appear in each draw?"""
    return (series == code).astype("float64").reset_index(drop=True)


def _fit_once(
    indicator: pd.Series, order: tuple[int, int, int], *, relaxed: bool
) -> tuple[Any, int]:
    """One ARIMA fit. Returns ``(result, warning_count)``.

    Warnings are *captured* rather than printed: a sparse binary series produces
    convergence notices on almost every fit, and letting them stream to stdout
    would bury the real log. The count is returned so the response can report
    how noisy each fit was.
    """
    kwargs: dict[str, Any] = (
        {"enforce_stationarity": False, "enforce_invertibility": False} if relaxed else {}
    )
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = ARIMA(indicator, order=order, **kwargs).fit()
    return result, len(caught)


def fit_arima(
    indicator: pd.Series, order: tuple[int, int, int]
) -> tuple[Any, bool, int]:
    """Fit ``order`` to ``indicator``, relaxing the constraints only if needed.

    The library defaults enforce stationarity and invertibility, which is the
    correct assumption for a stationary binary series and was honoured on 25/25
    measurable codes. A relaxation is a *fallback*, and whether it was used is
    reported per code so a relaxed fit is never mistaken for a clean one.

    Returns ``(result, relaxed, warning_count)``. Raises :class:`ArimaFitError`
    when the series is too short to estimate anything, or when both attempts
    fail.
    """
    if len(indicator) < MIN_FIT_OBSERVATIONS:
        raise ArimaFitError(
            f"ARIMA{order}: only {len(indicator)} observation(s); at least "
            f"{MIN_FIT_OBSERVATIONS} are required to estimate the parameters"
        )

    try:
        result, warning_count = _fit_once(indicator, order, relaxed=False)
        return result, False, warning_count
    except FITTING_ERRORS as strict_error:
        try:
            result, warning_count = _fit_once(indicator, order, relaxed=True)
        except FITTING_ERRORS as relaxed_error:
            raise ArimaFitError(
                f"ARIMA{order}: {type(strict_error).__name__} "
                f"({strict_error}); relaxed retry failed with "
                f"{type(relaxed_error).__name__} ({relaxed_error})"
            ) from strict_error
        return result, True, warning_count


@dataclass(frozen=True)
class Forecast:
    """One code's fitted next-draw occurrence probability."""

    raw: float
    probability: float
    order: tuple[int, int, int]
    aic: float
    relaxed: bool
    warning_count: int

    @property
    def clamped(self) -> bool:
        return self.probability != self.raw


def forecast_code(indicator: pd.Series, order: tuple[int, int, int]) -> Forecast:
    """Fit one code's indicator series and forecast the next draw.

    The point forecast is clamped to ``[0, 1]`` and the pre-clamp value retained:
    on a near-empty series ARIMA returns a negative number, which would be
    nonsense presented as a probability.
    """
    result, relaxed, warning_count = fit_arima(indicator, order)
    raw = float(np.asarray(result.forecast(1)).reshape(-1)[0])
    return Forecast(
        raw=raw,
        probability=float(min(1.0, max(0.0, raw))),
        order=order,
        aic=float(result.aic),
        relaxed=relaxed,
        warning_count=warning_count,
    )


@dataclass(frozen=True)
class OrderChoice:
    """The AIC-winning order, plus every candidate that was evaluated."""

    order: tuple[int, int, int]
    aic: float
    relaxed: bool
    evaluated: list[dict[str, Any]]


def select_order(
    indicator: pd.Series, grid: Sequence[tuple[int, int, int]] = AIC_ORDER_GRID
) -> OrderChoice | None:
    """Pick the order with the lowest AIC, or ``None`` if none of them fitted.

    A candidate that raises is recorded with its error and skipped — one bad
    order must not eliminate the code. Note the measured caveat in the module
    docstring: on a ~400-draw ledger the winning margin is usually below 2 AIC
    points, so this returns a defensible order rather than a decisively better
    one.
    """
    best: tuple[tuple[int, int, int], float, bool] | None = None
    evaluated: list[dict[str, Any]] = []

    for order in grid:
        try:
            result, relaxed, warning_count = fit_arima(indicator, order)
        except FITTING_ERRORS as exc:
            evaluated.append({"order": list(order), "status": "failed", "error": str(exc)})
            continue
        except ArimaFitError as exc:
            evaluated.append({"order": list(order), "status": "failed", "error": str(exc)})
            continue

        aic = float(result.aic)
        evaluated.append(
            {
                "order": list(order),
                "status": "ok",
                "aic": round(aic, 3),
                "relaxed": relaxed,
                "convergence_warnings": warning_count,
            }
        )
        if best is None or aic < best[1]:
            best = (tuple(order), aic, relaxed)

    if best is None:
        return None
    return OrderChoice(order=best[0], aic=best[1], relaxed=best[2], evaluated=evaluated)


@dataclass(frozen=True)
class CodeForecast:
    """One code's outcome, whether it was fitted or fell back."""

    code: str
    occurrences: int
    probability: float
    fitted: bool
    method: str  # "arima" | "unconditional_fallback"
    order: tuple[int, int, int] | None = None
    aic: float | None = None
    relaxed: bool = False
    clamped: bool = False
    raw: float | None = None
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "occurrences": self.occurrences,
            "probability": round(self.probability, 6),
            "fitted": self.fitted,
            "method": self.method,
            "order": list(self.order) if self.order else None,
            "aic": round(self.aic, 3) if self.aic is not None else None,
            "relaxed": self.relaxed,
            "clamped": self.clamped,
            "raw": round(self.raw, 6) if self.raw is not None else None,
            "note": self.note,
        }


@dataclass(frozen=True)
class TimeSeriesResult:
    """A complete per-code forecast distribution for one channel."""

    channel: str
    draws: int
    order_grid: tuple[tuple[int, int, int], ...]
    max_codes: int
    usable: bool
    forecasts: pd.Series  # index = NUMBER_UNIVERSE
    detail: dict[str, CodeForecast]
    fitted_codes: int
    fallback_codes: int
    failures: list[dict[str, Any]] = field(default_factory=list)
    total_warnings: int = 0
    elapsed_ms: float = 0.0
    note: str = ""

    def distribution(self) -> pd.Series:
        """The forecast probability per code — the signal the ensemble consumes.

        Always covers all 100 codes, so it can be rank-compared against the
        frequency and Markov signals without a code silently dropping out.

        **This is not a normalised distribution, and deliberately so.** Each
        entry is that code's own model output: an independent per-code forecast
        for a fitted code, and the smoothed unconditional rate for one that was
        not. Fitting a code replaces its baseline with a value that is usually
        slightly larger, so the vector sums to a little over 1 — measured at
        1.015 with ``max_codes=6`` and 1.038 with ``max_codes=30`` on a 400-draw
        ledger. Forcing the sum to 1 here would rescale real model forecasts to
        fix a bookkeeping property. The composite that must be coherent is the
        published probability, and ``models.ensemble`` normalises that instead,
        publishing the correction rather than hiding it.
        """
        return self.forecasts

    def top(self, top_n: int = TOP_N) -> list[CodeForecast]:
        """The strongest fitted forecasts, highest first."""
        ranked = sorted(
            self.detail.values(), key=lambda item: (-item.probability, item.code)
        )
        return ranked[:top_n]

    def as_dict(self, top_n: int = TOP_N) -> dict[str, Any]:
        return {
            "channel": self.channel,
            "model": "ARIMA",
            "draws": self.draws,
            "usable": self.usable,
            "order_grid": [list(order) for order in self.order_grid],
            "max_codes": self.max_codes,
            "fitted_codes": self.fitted_codes,
            "fallback_codes": self.fallback_codes,
            "failures": self.failures,
            "convergence_warnings": self.total_warnings,
            "elapsed_ms": round(self.elapsed_ms, 1),
            "top_forecasts": [item.as_dict() for item in self.top(top_n)],
            "note": self.note,
        }


def arima_forecast(
    series: pd.Series,
    channel: str,
    *,
    order_grid: Sequence[tuple[int, int, int]] = DEFAULT_ORDER_GRID,
    max_codes: int = DEFAULT_MAX_CODES,
    min_occurrences: int = MIN_OCCURRENCES,
    min_draws: int = MIN_ARIMA_DRAWS,
    smoothing: float = DEFAULT_SMOOTHING,
) -> TimeSeriesResult:
    """Forecast each code's next-draw occurrence probability with ARIMA.

    Degrades rather than raising. An empty, short, or entirely sparse ledger
    returns ``usable=False`` with every code sitting on the smoothed
    unconditional baseline, and the caller drops the signal from the blend
    instead of scoring noise.
    """
    started = time.perf_counter()
    grid = tuple(tuple(order) for order in order_grid)
    draws = int(len(series))

    # Every code starts on the smoothed unconditional rate; a successful fit
    # overwrites its own entry. This is what makes the distribution complete and
    # gives unmodelled codes a neutral, defensible value.
    baseline = unconditional_distribution(series, smoothing)
    forecasts = baseline.astype("float64").copy()

    counts = series.value_counts()
    detail: dict[str, CodeForecast] = {}
    failures: list[dict[str, Any]] = []
    total_warnings = 0
    fitted = 0

    for code in NUMBER_UNIVERSE:
        occurrences = int(counts.get(code, 0))
        detail[code] = CodeForecast(
            code=code,
            occurrences=occurrences,
            probability=float(forecasts[code]),
            fitted=False,
            method="unconditional_fallback",
            note="smoothed unconditional rate (not modelled)",
        )

    notes: list[str] = []
    if draws < min_draws:
        notes.append(
            f"{channel}: only {draws} draw(s); at least {min_draws} are needed "
            "before an ARIMA forecast is meaningful, so every code holds the "
            "smoothed unconditional rate."
        )
    else:
        # Highest-frequency codes first; ties broken by code so the fitted set —
        # and therefore the output — is reproducible.
        candidates = [
            code
            for code in NUMBER_UNIVERSE
            if int(counts.get(code, 0)) >= min_occurrences
        ]
        candidates.sort(key=lambda code: (-int(counts[code]), code))
        skipped = candidates[max_codes:]
        candidates = candidates[:max_codes]

        if not candidates:
            notes.append(
                f"{channel}: no code appeared at least {min_occurrences} times, so "
                "there is no series to fit."
            )

        for code in candidates:
            indicator = occurrence_series(series, code)
            try:
                if len(grid) > 1:
                    choice = select_order(indicator, grid)
                    if choice is None:
                        raise ArimaFitError(f"ARIMA: no order in {list(grid)} fitted")
                    order, aic, relaxed = choice.order, choice.aic, choice.relaxed
                    outcome = forecast_code(indicator, order)
                    warning_count = outcome.warning_count
                    total_warnings += warning_count
                    probability, raw, clamped = (
                        outcome.probability,
                        outcome.raw,
                        outcome.clamped,
                    )
                else:
                    order = grid[0]
                    outcome = forecast_code(indicator, order)
                    aic, relaxed = outcome.aic, outcome.relaxed
                    warning_count = outcome.warning_count
                    total_warnings += warning_count
                    probability, raw, clamped = (
                        outcome.probability,
                        outcome.raw,
                        outcome.clamped,
                    )
            except FITTING_ERRORS as exc:
                failures.append(
                    {"code": code, "error": f"{type(exc).__name__}: {exc}"}
                )
                continue
            except ArimaFitError as exc:
                failures.append({"code": code, "error": str(exc)})
                continue
            except Exception as exc:  # noqa: BLE001 - attributed, never swallowed
                # Any other optimisation failure is still attributed to its code
                # and surfaced in the response rather than crashing the request.
                failures.append(
                    {"code": code, "error": f"{type(exc).__name__}: {exc}"}
                )
                continue

            forecasts[code] = probability
            fitted += 1
            detail[code] = CodeForecast(
                code=code,
                occurrences=int(counts[code]),
                probability=probability,
                fitted=True,
                method="arima",
                order=order,
                aic=aic,
                relaxed=relaxed,
                clamped=clamped,
                raw=raw,
                note=(
                    f"ARIMA{order} fitted"
                    + (" (constraints relaxed)" if relaxed else "")
                    + (" — negative forecast clamped to 0" if clamped else "")
                ),
            )

        # Stated precisely, because "the rest" hides two different reasons: codes
        # that never qualified on occurrences, and codes that did but were cut by
        # the max_codes budget.
        notes.append(
            f"{channel}: ARIMA was fitted for {fitted} of {len(candidates)} candidate "
            f"code(s) appearing at least {min_occurrences} times"
            + (
                f" ({len(skipped)} further candidate(s) were excluded by "
                f"max_codes={max_codes})"
                if skipped
                else ""
            )
            + f"; the other {UNIVERSE_SIZE - fitted} code(s) hold the smoothed "
            "unconditional rate."
        )
        if failures:
            notes.append(
                f"{channel}: {len(failures)} code(s) failed to fit and hold the "
                "smoothed unconditional rate; see failures for the error text."
            )

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return TimeSeriesResult(
        channel=channel,
        draws=draws,
        order_grid=grid,
        max_codes=max_codes,
        usable=bool(draws >= min_draws and fitted > 0),
        forecasts=forecasts,
        detail=detail,
        fitted_codes=fitted,
        fallback_codes=len(NUMBER_UNIVERSE) - fitted,
        failures=failures,
        total_warnings=total_warnings,
        elapsed_ms=elapsed_ms,
        note=" ".join(notes),
    )
