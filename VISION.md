# SuperHeng — Vision & Predictive Models

> **SuperHeng** — ระบบวิเคราะห์ข้อมูลและความน่าจะเป็นสำหรับสลาก
> *A data-analytics and probability engine for lottery draws — not a gambling product.*

SuperHeng is built on a single premise: **every draw is a historical data point, not a bet.**
The app treats a lottery draw the way a quantitative desk treats a market tick — as a
time series with seasonality, regime shifts and transition structure that can be measured,
modelled and scored. It is a *probability instrument*, and the interface is deliberately
modelled on financial analytics software rather than a casino floor.

---

## 1. Project Vision

### 1.1 The problem with how lottery numbers are normally chosen

Most players pick numbers through superstition, birth dates, "lucky" plates or hot/cold
folklore. There is no measurement, no baseline, and no way to tell whether a pick was
genuinely well-researched or simply lucky. SuperHeng replaces intuition with a
**reproducible, published, falsifiable scoring process**.

### 1.2 What SuperHeng is

- **A statistical analysis tool.** It ingests historical draw results and surfaces
  measurable structure: temporal patterns, transition probabilities, distributional
  balance and sequence dependencies.
- **A transparency instrument.** Every prediction is published *before* the draw and never
  edited afterwards. The **AI Scorecard** screen shows predictions against actual outcomes
  side by side — including the misses.
- **An explainable system.** The **AI Reasoning Log** states *why* a number scored well
  (which model fired, on what evidence, with what confidence), so users can audit the logic
  instead of trusting a black box.

### 1.3 What SuperHeng is not

- ❌ Not a gambling or betting platform. It takes no wagers, holds no funds, and has no
  in-app purchase mechanism for stakes.
- ❌ Not a guarantee. No model can predict a fair random draw. SuperHeng quantifies
  historical behaviour and explicitly publishes its error rate.
- ❌ Not a black box selling "sure wins". If a feature cannot be explained or measured,
  it does not ship.

### 1.4 Design consequences of this vision

| Principle | Implementation in the app |
|---|---|
| Read like analytics, not a casino | Deep-navy / clean-white surfaces, crimson + gold accents, green–amber–grey signal tones |
| Numbers must be trustworthy at a glance | Tabular-figure numeric typography, consistent 0–100 scales, no decorative noise |
| Uncertainty is shown, not hidden | Confidence labels (`High` / `Medium` / `Low`), sample sizes, visible miss rate |
| Explainability is a first-class screen | Dedicated reasoning log per draw cycle |
| Reproducibility | Deterministic mock data layer now; a seeded, versioned model pipeline later |

---

## 2. Core Algorithms & Mathematical Models

The backend engine is planned as a Python (FastAPI) service. Four model families run
independently on the same historical draw table; their outputs are blended per-number and
then calibrated into a single **Heng Score**.

```
                    ┌──────────────────────────────┐
   historical draws │  Draw results (PostgreSQL)   │
   ────────────────▶│  date, position, digit set   │
                    └──────────────┬───────────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              │
   ┌─────────┐   ┌──────────┐  ┌───────────┐ ┌──────────┐     │
   │ ARIMA / │   │  Markov  │  │  Monte    │ │  LSTM    │     │
   │ Prophet │   │  Chains  │  │  Carlo    │ │  Neural  │     │
   │ (tempo) │   │(transit.)│  │(survival) │ │  Net     │     │
   └────┬────┘   └────┬─────┘  └─────┬─────┘ └────┬─────┘     │
        │             │              │            │           │
        └─────────────┴──────┬───────┴────────────┘           │
                             ▼                                │
                   ┌──────────────────┐                       │
                   │  Ensemble blend  │◀──────────────────────┘
                   │  + calibration   │   (weights, recency decay)
                   └────────┬─────────┘
                            ▼
                   ┌──────────────────┐
                   │   HENG SCORE     │  0–100 per number / position
                   │  + confidence    │
                   └──────────────────┘
```

### 2.1 Time Series Analysis — ARIMA & Prophet

**Purpose:** track temporal patterns and seasonality — numbers that repeatedly surface in
specific months, quarters or draw cycles.

- **ARIMA `(p, d, q)`** models the drift and autocorrelation of each number's occurrence
  rate. Differencing (`d`) removes the non-stationarity of a growing history; the moving
  average term (`q`) absorbs short-lived shocks so a single anomalous draw does not
  distort the baseline.
- **Prophet** decomposes the series into trend + yearly/weekly seasonality + holiday
  effects, which is what surfaces claims like *"numbers ending in 4 outperform their
  12-draw baseline in Q4"*.
- **Output:** a per-number temporal weight, plus a **volatility** signal. Narrowing
  residual variance is treated as a precursor to a higher-conviction prediction.
- **Why both:** ARIMA is strong on short-horizon autocorrelation; Prophet is robust to
  missing draws and is easier to interpret seasonally. They are cross-checked, and
  disagreement between them lowers the reported confidence.

### 2.2 Markov Chains

**Purpose:** compute **state transition probabilities** between draws.

Rather than asking *"how often does 48 appear?"*, the Markov layer asks the conditional
question: *"given that 01 was drawn last, what is the probability of each number group
appearing next?"*

- Each draw is encoded as a **state** — either an individual number, or a coarser bucket
  (parity band, high/low band, digit-sum class) to keep the state space well-populated.
- A **transition matrix** `P` is estimated from consecutive draws, with Laplace /
  add-k smoothing so unseen transitions are not assigned zero probability.
- **Higher-order chains** (order 2–3) are evaluated with AIC/BIC to avoid overfitting a
  sparse matrix — the app reports the observed lift, e.g. *"transition `93 → 48` gives
  0.31 conditional probability, ≈1.9× its unconditional rate."*
- **Output:** a conditional-probability multiplier per candidate number.

### 2.3 Monte Carlo Simulation

**Purpose:** convert the other models' outputs into an empirical **survival / winning rate**
via simulation rather than closed-form algebra.

- **100,000+ simulated draws** per prediction cycle.
- Each simulation samples candidates using the **historical weights** produced by the
  ARIMA/Prophet and Markov layers — not uniform random draws. This is what makes the
  simulation reflect the modelled structure rather than pure noise.
- Survival logic: candidates that persist across the greatest share of simulations, and
  that occupy the top-K of each simulated draw, accumulate a survival score.
- **Output:** an empirical probability + variance per number, which drives the final
  calibration. Variance feeds directly into the confidence label — a number with a good
  mean but high variance is reported as `Medium`, not `High`.
- **Cost control:** vectorised NumPy sampling, with a fixed simulation seed recorded per
  prediction so any published score can be reproduced exactly.

### 2.4 Deep Learning — LSTM Neural Networks

**Purpose:** recognise complex, **non-linear** patterns and long/short-term dependencies
across past draw results that the statistical models above cannot express.

- Draw history is encoded as a sequence of feature vectors (digits, position, parity, sum,
  inter-draw gaps) and fed to a **Long Short-Term Memory** network — chosen over a plain
  RNN specifically because its gating mechanism retains dependencies across many draws
  without vanishing gradients.
- Regularisation: dropout, early stopping on a **chronologically split** validation set
  (never randomly shuffled — that would leak future information into training).
- Interpretability: because LSTMs are opaque by construction, this model's contribution is
  reported through **permutation importance** on the input features, so the reasoning log
  can still state which signal drove the output. The LSTM is deliberately weighted as a
  *contributor*, never as the sole authority.
- **Output:** a learned sequence score per candidate number.

### 2.5 The Ensemble & the "Heng Score"

The four models answer different questions — *when*, *what follows what*, *how often does
it survive*, and *what does the sequence suggest*. The ensemble layer:

1. **Normalises** each model's output to a common 0–1 scale (rank-based).
2. **Weights** them, with a configurable profile. The default blend is
   Time Series `0.30` · Markov `0.30` · Monte Carlo `0.25` · LSTM `0.15`.
3. **Applies recency decay** so the last N draws carry more weight than year-old ones.
4. **Calibrates** the blended value into the published **Heng Score (0–100)**.

The five axes exposed in the app's radar chart are the interpretable components of that
blend, which is why they are shown to the user rather than hidden:

| Axis | Question it answers |
|---|---|
| **Frequency** | How often has this number appeared relative to its baseline? |
| **Recency** | Has it appeared recently, or is it overdue by historical spacing? |
| **Seasonality** | Does it cluster in particular months / quarters / draw cycles? |
| **Balance** | How does it sit on parity, high/low and digit-sum distributions? |
| **Momentum** | Is its occurrence rate accelerating or decaying right now? |

The score is then mapped to a human-readable signal tone, consistent across every screen:

| Heng Score | Tone | Meaning |
|---|---|---|
| `75 – 100` | 🟢 High | Strong model consensus |
| `55 – 74` | 🟡 Medium | Positive but unconfirmed signal |
| `35 – 54` | 🔴 Low | Weak or conflicting signal |
| `0 – 34` | ⚪ Cold | No meaningful signal |

> **Important:** the Heng Score is a measure of *model agreement about historical
> behaviour*. It is **not** a probability of winning, and it cannot be.

---

## 3. Data Pipeline & Planned Architecture

| Stage | Component | Responsibility |
|---|---|---|
| Ingestion | FastAPI scheduled job | Fetch/verify official draw results, normalise positions and digit sets |
| Storage | PostgreSQL (Supabase) | Immutable draw ledger, model runs, published predictions |
| Features | Python service | Rolling windows, gap analysis, digit statistics, encoders |
| Modelling | ARIMA/Prophet · Markov · Monte Carlo · LSTM | Per-model scoring, versioned artefacts |
| Ensemble | Calibration service | Weighting, recency decay, Heng Score + confidence |
| Serving | FastAPI REST | Read-only JSON: rankings, heatmap, history, scorecard, reasoning log |
| Client | React Native / Expo | Presentation, on-device analysis UX, deep links from the heatmap |

**Auditability:** each published prediction stores the model versions, ensemble weights and
simulation seed that produced it, so the scorecard can always be recomputed from the same
inputs.

The mobile client is designed against these payload shapes today — see
[`src/data/mock.ts`](src/data/mock.ts), whose deterministic fixtures mirror the intended
API responses so the backend can be swapped in without touching the UI.

---

## 4. Roadmap

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundation** | Expo Router shell, 4-tab navigation, design system, mock analytics layer | ✅ Done |
| **1 — Live data** | FastAPI + PostgreSQL draw ledger; replace mock layer with real endpoints; loading/error/empty states | ⏳ Planned |
| **2 — Model pipeline** | ARIMA/Prophet + Markov + Monte Carlo in production, versioned and seeded | ⏳ Planned |
| **3 — Deep learning** | LSTM training pipeline, chronological validation, permutation-importance reporting | ⏳ Planned |
| **4 — Automation & trust** | Held-out backtesting, drift monitoring, automatic scorecard publication, on-device watchlists and notifications | ⏳ Planned |
| **5 — MLOps** | Managed training/serving (Google Cloud or AWS), model registry, retraining triggers | ⏳ Planned |

---

## 5. Responsible Play & Honest Limitations

- **A fair draw is independent.** Any structure the models detect is a property of the
  *sample*, and may be entirely noise. SuperHeng's own scorecard exists to keep that
  visible: a published hit rate below 100% is the expected outcome, not a failure.
- **No model can guarantee an outcome.** Confidence labels express model agreement, never
  certainty of winning.
- **The scorecard is append-only.** Published predictions are never retro-edited.
- **Gambling carries real risk of loss.** SuperHeng is an analytics tool; it does not
  encourage spending beyond what a user can afford to lose. Play responsibly.

---

## 6. Glossary

| Term | Meaning |
|---|---|
| **Draw** | One official lottery result event, comprising several positions |
| **Position** | A digit slot in the result (e.g. the 2-digit *Top* vs *Bottom* position) |
| **Heng Score** | SuperHeng's composite 0–100 model-agreement score for a candidate number |
| **Signal tone** | The High / Medium / Low / Cold classification derived from the Heng Score |
| **Transition matrix** | Markov table of probabilities of moving from one draw state to the next |
| **Survival rate** | Share of Monte Carlo simulations in which a candidate persisted into the top ranks |
| **Ensemble** | The weighted blend of the four model families into one calibrated score |
| **AI Scorecard** | The append-only record of published predictions versus actual results |
