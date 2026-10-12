# SuperHeng — 7-Day MVP Sprint Roadmap

**Sprint goal:** ship a working end-to-end MVP — a React Native (Expo Router) client backed by
a Python (FastAPI) prediction service running real statistical models — in seven focused
work blocks.

**Stack:** React Native · Expo Router · TypeScript (frontend) — Python · FastAPI · PostgreSQL
/ SQLite · ARIMA/Prophet · Markov Chains · Monte Carlo · LSTM (backend).

**Companion docs:** [README.md](README.md) (setup & structure) · [VISION.md](VISION.md)
(algorithm specification & philosophy) · [AGENTS.md](AGENTS.md) (conventions).

---

## How to read this document

- `- [x]` = done and verified · `- [ ]` = not started · `- [~]` = in progress
- Every day has an **Objective**, a **Task checklist**, **Artifacts** (what should exist on
  disk) and a **Definition of Done**. A day is *not* complete until its DoD passes.
- Days are focused work blocks, not guaranteed calendar days.

## Status legend

| Symbol | Meaning |
|---|---|
| ✅ | Day complete — DoD met |
| 🟡 | Partially complete — see unchecked items |
| ⬜ | Not started |

---

## Sprint at a Glance

| Day | Theme | Primary output | Status |
|---|---|---|---|
| **1** | Foundation & Scaffolding (Frontend) | 4-tab Expo Router app + design system + mock data | 🟡 ~90% |
| **2** | Backend & Database Setup | FastAPI service + seeded draw database | ⬜ |
| **3** | Basic Statistical Models | Frequency + Markov Chain API (`/api/predict/basic`) | ⬜ |
| **4** | Frontend–Backend Integration | Screens driven by live API, loading/error states | ⬜ |
| **5** | Advanced Models & Heng Score | ARIMA/Prophet + Monte Carlo, weighted Heng Score API | ⬜ |
| **6** | Personalized Feature & Testing | "My Number" end-to-end + device/viewport testing | ⬜ |
| **7** | Review & Deployment Prep | Performance Check feature, bug fixes, deploy prep | ⬜ |

**Overall progress: 1 of 7 days complete (≈13%).**

---

## Global Definition of Done (applies to every day)

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run lint` passes with no errors
- [ ] New behaviour was exercised through the real interface (not just "it compiled")
- [ ] No secrets, API keys or credentials committed to the repository
- [ ] `README.md` / `ROADMAP.md` updated if the contract or setup changed
- [ ] Work committed on a branch for that day (e.g. `day-3-markov`)

---

## Day 1 — Foundation & Scaffolding (Frontend) 🟡

**Objective:** Initialize Expo Router structure, build the 4 main UI tabs (Dashboard,
MyNumber, Insights, Performance) using the financial-analytics design system, and inject
mock data.

### Tasks

- [x] Initialise Expo Router file-based routing — root `Stack` with a `(tabs)` group
- [x] Build the four main tabs in the bottom tab navigator (Dashboard, My Number, Insights,
      Performance) with branded crimson/gold tab bar
- [x] Build the financial-analytics design system (deep-navy dark / clean-white light,
      crimson + premium-gold accents, green/amber/grey signal tones, tabular numerals)
- [x] Build a reusable UI kit (cards, section headers, score ring, radar chart, trend chart,
      00–99 heatmap, probability bars, rankings, countdown, segmented control)
- [x] Inject mock data via a deterministic analytics layer shaped like the future API
- [x] Wire a deep link from the Insights heatmap into "My Number" (`/my-number?code=48`)
- [x] Verify responsive layout at phone (420px) and tablet (1100px) widths, in dark **and**
      light mode, with zero overflowing elements
- [x] Ensure `tsc --noEmit` and `expo lint` both pass clean
- [ ] Verify native-only behaviour on a real iOS/Android device or simulator (tab-bar
      icons and the hero background gradient were only confirmed on the web target) — see
      **Native verification status** below
- [x] Typecheck, lint and web verification green; baseline committed on `day-1-foundation`

### Artifacts

| Path | Contents |
|---|---|
| [`src/app/_layout.tsx`](src/app/_layout.tsx) | Root Stack, theme provider, status bar, splash |
| [`src/app/(tabs)/_layout.tsx`](src/app/%28tabs%29/_layout.tsx) | Bottom tab navigator (4 tabs) |
| [`src/app/(tabs)/index.tsx`](src/app/%28tabs%29/index.tsx) | **Dashboard** — countdown, Top-Pick hero, rankings |
| [`src/app/(tabs)/my-number.tsx`](src/app/%28tabs%29/my-number.tsx) | **My Number** — analysis screen |
| [`src/app/(tabs)/insights.tsx`](src/app/%28tabs%29/insights.tsx) | **Insights** — heatmap, trends, AI log |
| [`src/app/(tabs)/performance.tsx`](src/app/%28tabs%29/performance.tsx) | **Performance** — scorecard, prize checker |
| [`src/constants/theme.ts`](src/constants/theme.ts) | Design tokens (colors, spacing, radii, signal tones) |
| [`src/components/superheng/`](src/components/superheng/index.ts) | The app's UI kit |
| [`src/data/mock.ts`](src/data/mock.ts) | 🧪 Mock analytics payloads |
| [`src/lib/draw.ts`](src/lib/draw.ts) | Draw schedule + countdown math |

### Definition of Done

- [x] App boots and all four tabs navigate correctly
- [x] Dashboard renders countdown, hero pick, radar profile and top-5 rankings from mock data
- [x] Dark and light themes both render correctly, following the system scheme
- [x] Tablet viewport reflows to a multi-column layout on Insights
- [ ] Native device/simulator smoke test recorded

### Native verification status

Checked on this machine, honest result:

| Capability | State |
|---|---|
| Android SDK | ✅ present (`%LOCALAPPDATA%\Android\Sdk`) |
| `adb` | ⚠️ present (1.0.41) but **not on PATH** |
| Attached device / emulator | ❌ `adb devices` is empty |
| Configured AVD | ❌ none (`emulator -list-avds` returns nothing) |
| JDK (needed for `expo run:android`) | ❌ not found on PATH |
| iOS simulator | ❌ impossible — this is a Windows machine |

**Recommended path: Expo Go on a physical Android device.** No JDK or local native build is
required — `expo-symbols`, Expo Router's JS `Tabs` navigator and Reanimated 4 / Worklets are
all bundled in Expo Go for SDK 57. A local dev build would first require installing a JDK
and creating an AVD.

**Reduced-risk note on icons:** `expo-symbols` declares an **Apple-only** native module
(`expo-module.config.json` → `"platforms": ["apple"]`), and ships no
`SymbolView.android.js` / `.web.js`. On Android and web the icons therefore render through
the shared `materialImageSource` path — which is exactly the path already confirmed working
on the web target. So the tab icons are unlikely to be the failure mode; the genuinely
unverified item is the **hero gradient** (`experimental_backgroundImage`), which React Native
Web drops entirely. It already has a solid-crimson fallback, so a miss would be cosmetic,
not a correctness bug.

> **Day 1 remainder is non-blocking:** native smoke test only. Day 2 (backend) does not
> depend on it.

---

## Day 2 — Backend & Database Setup ⬜

**Objective:** Initialize Python FastAPI (`main.py`), set up a PostgreSQL/SQLite database for
historical data, and create a script to seed past draw results.

### Tasks

- [ ] Create an isolated virtualenv and pin the Python version (see [Dependency baseline](#dependency-baseline))
- [ ] Prove the full dependency set installs cleanly in that venv **before** writing any model code
- [ ] Create `backend/` with `main.py`, `requirements.txt`, `.env.example`
- [ ] Add `GET /api/health` returning service name, version and model status
- [ ] Define the draw ledger schema: `draws`, `draw_positions`, `numbers` (immutable, append-only)
- [ ] Decide the runtime: **SQLite** for local dev, **PostgreSQL** for deployed environments
      (Supabase), with the schema kept dialect-neutral
- [ ] Add migrations (Alembic) and a `seed_draws.py` script that loads historical results
- [ ] Add `GET /api/results?limit=&offset=` returning the paginated draw ledger
- [ ] Add `GET /api/draws/next` returning the next draw datetime + schedule
- [ ] Document how to run the API locally in `backend/README.md`

### Artifacts

`backend/main.py` · `backend/models.py` · `backend/schemas.py` · `backend/db.py` ·
`backend/seed_draws.py` · `backend/requirements.txt` · `backend/README.md`

### Dependency baseline

Verified against current releases: **numpy, pandas, scikit-learn, statsmodels, PyTorch and
Prophet all publish CPython 3.14 wheels**, and FastAPI / SQLAlchemy ship pure-Python wheels
usable on 3.14. So the locally installed **Python 3.14 is a viable choice**.

Still pin an explicit interpreter in `requirements.txt` / `.python-version`, and prefer
**3.13 as the conservative default** unless the entire stack — including the deployment
target — installs and runs cleanly on 3.14. Two caveats worth checking on Day 2:

- Wheels are published **per architecture/OS**, not universally; torch's GPU builds depend
  on the matching CUDA/ROCm build.
- The **free-threaded `3.14t`** variant is a separate story from standard CPython 3.14.

References: [torch on PyPI](https://pypi.org/project/torch/) ·
[pandas 2.3.3 release notes](https://pandas.pydata.org/docs/whatsnew/v2.3.3.html) ·
[Prophet on PyPI](https://pypi.org/project/prophet/).

### Definition of Done

- [ ] `uvicorn main:app --reload` serves `/docs` (OpenAPI) locally
- [ ] Seeding a fresh database produces ≥ 500 historical draw rows and is idempotent
- [ ] `/api/results` returns valid JSON matching the documented ledger shape
- [ ] No database credentials committed; `.env.example` documents required variables

---

## Day 3 — Basic Statistical Models ⬜

**Objective:** Develop Frequency Analysis and a basic Markov Chain model in Python. Expose an
API endpoint (e.g. `/api/predict/basic`) to return predictions.

### Tasks

- [ ] Frequency analysis: per-number occurrence counts, rolling windows, inter-draw gaps
- [ ] Per-position frequency (Top / Bottom) rather than pooled counts
- [ ] Markov chain: encode draw states, build the transition matrix with add-k smoothing
- [ ] Expose observed conditional lift (`P(b|a) / P(b)`) so predictions stay explainable
- [ ] Choose chain order via AIC/BIC; guard against overfitting a sparse matrix
- [ ] Add `GET /api/predict/basic` returning per-number probability + score for each position
- [ ] Add unit tests (`pytest`) for frequency counts and matrix row-sums ≈ 1
- [ ] Cache the computed matrix per draw; recompute only when new results land

### Artifacts

`backend/models/frequency.py` · `backend/models/markov.py` · `backend/api/predict.py` ·
`backend/tests/`

### Definition of Done

- [ ] `/api/predict/basic` returns rankings for both positions, deterministically
- [ ] Unit tests pass; transition matrix rows are normalised
- [ ] Response shape matches the `RankEntry` contract in the frontend mock layer
- [ ] Re-running a prediction on unchanged data returns identical output

---

## Day 4 — Frontend–Backend Integration ⬜

**Objective:** Use `fetch`/`axios` in React Native to connect the frontend Dashboard and
Insights screens to the FastAPI endpoints. Replace mock data with real data. Add loading
states.

### Tasks

- [ ] Add a typed API client in `src/api/` (prefer **`fetch`** — no new dependency needed on
      React Native or web)
- [ ] Move the base URL into config (`EXPO_PUBLIC_API_URL`) with a documented `.env`
- [ ] Add runtime validation of API responses so a malformed payload fails loudly, not silently
- [ ] Introduce a data-fetching hook with `loading` / `error` / `empty` / `refetch` states
- [ ] Point **Dashboard** at `/api/predict/basic` (rankings + top pick)
- [ ] Point **Insights** at the heatmap and trend endpoints
- [ ] Build skeleton loaders and error/retry UI; keep the design system consistent
- [ ] Keep the mock layer available behind a flag so the UI still runs without a backend
- [ ] Handle the physical-device case (localhost is not the dev machine) in the docs

### Artifacts

`src/api/client.ts` · `src/api/types.ts` · `src/hooks/use-api.ts` · skeleton components

### Definition of Done

- [ ] Dashboard and Insights render live data with the backend running
- [ ] Stopping the backend produces a clear error state with a working retry — no blank screen
- [ ] Loading, error and empty states are all reachable and visually verified
- [ ] No component imports `src/data/mock.ts` directly except behind the fallback flag

---

## Day 5 — Advanced Models & Heng Score ⬜

**Objective:** Implement advanced models (ARIMA/Prophet or Monte Carlo) in the backend. Create
a weighted algorithm to generate the final "Heng Score". Expose this via API.

### Tasks

- [ ] ARIMA `(p,d,q)` per number with automatic order selection (AIC) on a differenced series
- [ ] Prophet decomposition for trend + seasonality (or justify choosing one of the two)
- [ ] Monte Carlo simulation: 100,000+ draws sampled from historical model weights
- [ ] Record and expose the simulation **seed** for reproducibility
- [ ] Normalise each model's output (rank-based) to a common 0–1 scale
- [ ] Weighted ensemble → Heng Score 0–100, documented default weights
      (Time Series 0.30 · Markov 0.30 · Monte Carlo 0.25 · LSTM 0.15)
- [ ] Derive the five radar axes: Frequency, Recency, Seasonality, Balance, Momentum
- [ ] Map score → signal tone using the existing thresholds (≥75 / 55–74 / 35–54 / <35)
- [ ] Expose `GET /api/predict/heng` returning the hero pick, rankings, heatmap, radar and
      confidence label
- [ ] Add a response cache so simulations run per draw cycle, not per request

### Artifacts

`backend/models/timeseries.py` · `backend/models/montecarlo.py` · `backend/models/ensemble.py`
· `backend/api/predict.py`

### Definition of Done

- [ ] `/api/predict/heng` returns hero pick + rankings + radar in the documented shape
- [ ] The same seed reproduces a byte-identical score (reproducibility test in CI)
- [ ] Confidence label degrades to `Medium`/`Low` when model disagreement is high
- [ ] p95 response time for `/api/predict/heng` stays under the agreed budget with caching
- [ ] The ensemble weights are config, not hard-coded constants

---

## Day 6 — Personalized Feature & Testing ⬜

**Objective:** Build the API and Frontend logic for the "My Number" feature (allowing users to
input a 2-3 digit number to get its specific probability score). Test on mobile and tablet
viewports.

### Tasks

- [ ] Add `GET /api/number/{code}` returning score, verdict, confidence, appearance history,
      last-won data, radar axes and model-derived advice
- [ ] Validate input server-side: 2–3 digits only, reject or normalise anything else
- [ ] Wire the "My Number" screen to the endpoint with loading/error states
- [ ] Preserve the existing deep link: tapping a heatmap cell opens `/my-number?code=48`
- [ ] Add request debouncing so typing a number doesn't spam the API
- [ ] Add a per-number disclaimer/uncertainty note in the UI
- [ ] Manual test matrix: phone + tablet, dark + light, iOS + Android + web
- [ ] Add frontend tests for the analysis result component (render + empty + error)

### Artifacts

`backend/api/number.py` · updated `src/app/(tabs)/my-number.tsx` · component tests

### Definition of Done

- [ ] Entering `48`, `512` or `093` returns a populated analysis screen
- [ ] Invalid input (empty, 1 digit, letters, >3 digits) shows a clear message, never a crash
- [ ] Layout verified on phone and tablet viewports with no overflow or clipped content
- [ ] Backend validates input; the frontend is not the only guard

---

## Day 7 — Review & Deployment Prep ⬜

**Objective:** Implement the "Performance Check" feature (comparing AI predictions to actual
results for transparency). Fix UI/UX bugs, clean up code, and prepare for deployment.

### Tasks

- [ ] Persist every published prediction **before** the draw (append-only, never edited)
- [ ] Add `GET /api/scorecard` returning predictions vs actual outcomes + hit rate
- [ ] Add a job/endpoint that settles predictions once a draw result is published
- [ ] Wire the **Performance** screen to live scorecard data + working prize checker
- [ ] Display the hit rate *including misses* — no cherry-picking
- [ ] Bug sweep: empty states, long numbers, small screens, slow network, dark mode contrast
- [ ] Remove dead code and unused starter components; delete leftover mock fixtures
- [ ] Add `expo-doctor` + typecheck + lint + `pytest` to a single CI check
- [ ] Configure EAS build profiles (`development`, `preview`, `production`)
- [ ] Generate app icon + splash assets and set them in `app.json`
- [ ] Write the release checklist and a rollback note

### Artifacts

`backend/api/scorecard.py` · updated `src/app/(tabs)/performance.tsx` · `eas.json` ·
`app.json` assets · `CHANGELOG.md`

### Definition of Done

- [ ] Performance screen shows real hit rate and history from the API
- [ ] Scorecard is provably append-only (a settled prediction cannot be mutated)
- [ ] Full check suite green: `tsc`, `lint`, `pytest`, `expo-doctor`
- [ ] A development build runs on a physical device
- [ ] Reproduction steps documented so a teammate can run the whole stack from a clean clone

---

## Target API Surface (built across Days 2–7)

| Method | Endpoint | Purpose | Day |
|---|---|---|---|
| `GET` | `/api/health` | Service + model status | 2 |
| `GET` | `/api/results?limit=&offset=` | Historical draw ledger | 2 |
| `GET` | `/api/draws/next` | Next draw datetime + schedule | 2 |
| `GET` | `/api/predict/basic` | Frequency + Markov rankings | 3 |
| `GET` | `/api/predict/heng` | Ensemble, Heng Score, radar, heatmap | 5 |
| `GET` | `/api/number/{code}` | Single-number analysis | 6 |
| `GET` | `/api/scorecard` | Published predictions vs actuals | 7 |

These shapes intentionally mirror the existing frontend fixtures in
[`src/data/mock.ts`](src/data/mock.ts) so Day 4 is a swap, not a rewrite.

---

## Cross-Cutting Risks & Mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| **R1** | **Historical draw data may not be legally/practically obtainable** before Day 3 | Blocks Days 3–5 entirely | Seed Day 2 with a **synthetic but realistic** dataset (already mirrored by the mock layer) so modelling proceeds; swap in real results later without changing the schema |
| **R2** | **Python dependency compatibility** — the local interpreter is Python 3.14, and brand-new CPython releases sometimes lag on wheel coverage | Blocks installing numpy / pandas / statsmodels / torch / Prophet for Days 3–5 | Core libraries now ship CPython 3.14 wheels, so 3.14 is viable — but pin an explicit version in a venv and install-validate the *whole* stack at the start of Day 2, not on Day 5 (see [Dependency baseline](#dependency-baseline)) |
| **R3** | **Scope vs. schedule** — 4 model families in 7 days | Slipping the whole sprint | Ship ARIMA + Markov + Monte Carlo first; keep **LSTM** behind a flag and defer to the Phase 4 work in [VISION.md](VISION.md). LSTM is explicitly the lowest-weighted contributor |
| **R4** | **Cold-start latency** — 100k simulations per request | Slow, expensive endpoints | Precompute per draw cycle and cache; expose a seed for reproducibility; never simulate per keystroke |
| **R5** | **Statistical honesty** — a 7-day MVP cannot validate predictive accuracy | Erodes the product's core trust promise | Keep the scorecard append-only and publish the miss rate; word all UI copy as *model agreement*, never as a chance of winning |
| **R6** | **No test infrastructure exists yet** | Regressions go unnoticed as the surface grows | Add `pytest` on Day 3 and frontend component tests on Day 6; wire both into the Day 7 CI check |
| **R7** | **Device networking** — a physical device cannot reach `localhost` | Day 4 integration "works on web only" | Document LAN IP / tunnel setup on Day 4, and test on a device before declaring integration done |
| **R8** | **Legal / responsible-play compliance** | Product risk, store-review risk | Keep the tool non-transactional (no wagers, no funds); retain the responsible-play disclaimer in-app and in the docs |

---

## Explicit Non-Goals for This Sprint

Deliberately out of scope so the MVP ships:

- User accounts, authentication and multi-device sync
- Payments, wallets or any mechanism for staking money
- Push notifications and scheduled job automation
- LSTM in production traffic (flagged/deferred)
- Managed MLOps, model registry and automated retraining (Phase 5 in [VISION.md](VISION.md))
- Localisation/i18n beyond the English UI
- App Store / Play Store submission

---

## Progress Tracker

- [x] **Day 1** — Foundation & Scaffolding (Frontend)
- [ ] **Day 2** — Backend & Database Setup
- [ ] **Day 3** — Basic Statistical Models
- [ ] **Day 4** — Frontend–Backend Integration
- [ ] **Day 5** — Advanced Models & Heng Score
- [ ] **Day 6** — Personalized Feature & Testing
- [ ] **Day 7** — Review & Deployment Prep
