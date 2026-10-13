"""SuperHeng — Day 5 advanced models.

Four model families now feed one score, split across two packages:

``services`` (Day 3)
    ``Frequency``  — unconditional rate per 2-digit code, against the uniform
    baseline.
    ``Markov``     — first-order transition matrix over the channel's own state,
    with add-k smoothing and observed lift.

``models`` (Day 5, this package)
    :mod:`models.timeseries`  ``ARIMA`` — a per-code univariate forecast of the
    next draw's occurrence probability.
    :mod:`models.montecarlo`  ``Monte Carlo`` — 100,000 simulated draws sampled
    from the historical weights, scored by how often a code *survives* into the
    simulated top-K.
    :mod:`models.ensemble`    the weighted blend of all four into the final
    **Heng Score**, plus the agreement measure behind the confidence label.

Why a package and not a module
------------------------------
Day 2's request offered ``models.py`` *or* ``services.py``; ``services.py`` was
chosen precisely because a ``models.py`` module and this ``models/`` package
cannot coexist under one name. The split Day 3 deferred lands here.

The same honesty constraints as Day 3 apply, and are enforced in code rather
than in prose:
  * every signal reports its own support, and a signal with too little evidence
    is dropped from the blend rather than guessed at;
  * scores are rank-normalised (VISION §2.5), so they express *agreement between
    signals*, never a probability of winning;
  * the simulation seed is recorded on every response, so any published score
    can be reproduced exactly.
"""

from __future__ import annotations

from models.ensemble import (
    DEFAULT_WEIGHTS,
    EnsembleResult,
    analyse_draws_advanced,
    blend_channel,
    build_advanced_reason,
)
from models.montecarlo import (
    DEFAULT_SEED,
    DEFAULT_SIMULATIONS,
    DEFAULT_TOP_K,
    MonteCarloResult,
    monte_carlo_survival,
)
from models.timeseries import (
    DEFAULT_MAX_CODES,
    DEFAULT_ORDER_GRID,
    TimeSeriesResult,
    arima_forecast,
    select_order,
)

__all__ = [
    # ensemble
    "DEFAULT_WEIGHTS",
    "EnsembleResult",
    "analyse_draws_advanced",
    "blend_channel",
    "build_advanced_reason",
    # monte carlo
    "DEFAULT_SEED",
    "DEFAULT_SIMULATIONS",
    "DEFAULT_TOP_K",
    "MonteCarloResult",
    "monte_carlo_survival",
    # timeseries
    "DEFAULT_MAX_CODES",
    "DEFAULT_ORDER_GRID",
    "TimeSeriesResult",
    "arima_forecast",
    "select_order",
]
