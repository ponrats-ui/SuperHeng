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
| **2** | Backend & Database Setup | Ingestion ✅ · FastAPI + schema ✅ · seeded database ⬜ | 🟡 partial |
| **3** | Basic Statistical Models | Frequency + Markov Chain API (`/api/predict/basic`) | 🟡 models ✅ · security/caching ⬜ |
| **4** | Frontend–Backend Integration | Screens driven by live API, loading/error states | ⬜ |
| **5** | Advanced Models & Heng Score | ARIMA/Prophet + Monte Carlo, weighted Heng Score API | ⬜ |
| **6** | Personalized Feature & Testing | "My Number" end-to-end + device/viewport testing | ⬜ |
| **7** | Review & Deployment Prep | Performance Check feature, bug fixes, deploy prep | ⬜ |

**Overall progress: Days 1-2 delivered; Day 3's models and `/api/predict/basic` are built and
verified. Outstanding across Days 2-3: API-key auth, rate limiting, response caching, and the
`draws` / `draw_positions` / `numbers` ledger. The pipeline has still never run against the
live Supabase project — no `SUPABASE_KEY` has been supplied — so every verification to date is
against the official GLO API and local stubs.**

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

## Day 2 — Backend & Database Setup 🟡

**Objective:** Initialize Python FastAPI (`main.py`), set up a PostgreSQL/SQLite database for
historical data, and create a script to seed past draw results.

### Tasks

- [x] Create an isolated virtualenv (`backend/.venv`) and prove the dependency set installs
      in it (see [Dependency baseline](#dependency-baseline))
- [ ] Pin the interpreter explicitly (`requires-python` / `.python-version`) — currently implicit
- [x] **Build the GLO Data Ingestion Engine** (`backend/data_ingestion.py`) so historical data
      comes from GLO's own published source rather than a third-party mirror, guaranteeing
      data integrity (see [GLO data source](#glo-data-source-verified))
- [x] Ingestion resilience: request timeouts, exponential backoff with jitter on 429/5xx and
      connection drops, per-date failure isolation, and an on-disk cache so a re-run resumes
      without re-hitting GLO
- [x] Ingestion integrity: prize numbers kept as zero-padded **strings**; the derived
      "trailing digits of the 1st prize" kept strictly separate from GLO's **separately drawn**
      `last2` / `last3b` prizes
- [x] Add an automated integrity assertion over the ingested snapshot (1st prize is 6 digits,
      exactly 5 second-prize numbers, 100 fifth-prize numbers, `last2` is 2 digits) and fail
      loudly on drift — implemented as `assert_glo_integrity()` in `backend/scraper.py`. The
      cardinalities were confirmed against four real draws *before* being turned into
      assertions, so they test GLO rather than a guess
- [x] Build the HTML-archive ingestion path (`backend/scraper.py`, requests + BeautifulSoup)
      as the fallback for when the API is unreachable — see
      [The draw schedule is irregular](#the-draw-schedule-is-irregular-verified)
- [x] Create `backend/main.py` and `.env.example`
- [x] Add `GET /api/health` returning service name, version and model status
- [x] Create `backend/schema.sql` for the `lottery_draws` ledger
- [x] Add idempotent ingestion — `upsert(..., on_conflict="draw_date")`, proven not to
      duplicate a draw by re-running the same window
- [ ] Define the draw ledger schema: `draws`, `draw_positions`, `numbers` (immutable, append-only)
- [ ] Decide the runtime: **SQLite** for local dev, **PostgreSQL** for deployed environments
      (Supabase), with the schema kept dialect-neutral
- [ ] Add migrations (Alembic) and a `seed_draws.py` script that loads historical results
- [ ] Add `GET /api/results?limit=&offset=` returning the paginated draw ledger
- [ ] Add `GET /api/draws/next` returning the next draw datetime + schedule
- [ ] **Security — API key auth:** require a key on every non-public route via an `X-API-Key`
      header, reject missing/invalid keys with `401`, and source the key from the environment
      (never committed, never a build-time constant)
- [ ] **Security — rate limiting:** add **`slowapi`** and cap expensive endpoints at **20
      requests/minute per IP**, returning `429` with `Retry-After`; use a tighter bucket for ML
      routes than for cheap read-only ones
- [ ] **Security — CORS:** allow only the Expo app's own origins (dev server + production
      origin) so arbitrary browser origins are not granted access
- [ ] Document how to run the API locally in `backend/README.md`

### Artifacts

✅ built: **`backend/data_ingestion.py`** · **`backend/scraper.py`** · **`backend/main.py`** ·
**`backend/schema.sql`** · **`backend/.env.example`** · `backend/requirements.txt` ·
`backend/.venv/`

⬜ planned: `backend/models.py` · `backend/schemas.py` · `backend/db.py` · `backend/seed_draws.py` ·
`backend/README.md` · Alembic migrations

### Schema reality check

**One table shipped, not three.** `schema.sql` creates a single flat
`public.lottery_draws(draw_date, first_prize, bottom_two)`, not the normalised
`draws` / `draw_positions` / `numbers` ledger the task list describes.

The flat table is the right call for Day 2 and the wrong call for Day 5:

- It is sufficient for everything Days 3-4 need — a per-draw sequence of two numbers, which is
  exactly what frequency analysis and a Markov chain consume.
- It **cannot** represent the full draw (five second prizes, 100 fifth prizes, the near-1 pair)
  and has no append-only structure, so it cannot back a provably immutable settled-prediction
  ledger. Those are Day 5/7 requirements; revisit before the scorecard exists.
- `draw_date` is `UNIQUE` deliberately: it is the `ON CONFLICT` target of the ingestion upsert,
  and PostgREST fails with `42P10` without it. The constraint and the script are a matched pair.
- `created_at` is `TIMESTAMPTZ`, not the bare `TIMESTAMP` the Day 2 spec asked for — a
  zone-less timestamp renders as a different instant per reader, and these draw dates are
  Thailand-local. This is the one deliberate deviation from the requested schema.
- CHECK constraints pin `first_prize` to `^[0-9]{6}$` and `bottom_two` to `^[0-9]{2}$`, so a
  parser bug or a source format change fails at write time instead of quietly corrupting the
  historical ledger.

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

**Resolved on 2026-10-13 — obligation discharged for the Day 2 half.** The whole service and
ingestion stack was installed into `backend/.venv` on **CPython 3.14.4** with no build step and
no source compilation: `fastapi 0.143.0`, `uvicorn 0.54.0`, `supabase 2.32.0`,
`requests 2.34.2`, `beautifulsoup4 4.15.0`, `python-dotenv 1.2.4`, `pandas 3.0.6`. R2's
instruction to "install-validate the whole stack at the start of Day 2, not on Day 5" is
satisfied for this half, and **3.14 is confirmed viable here**. The ML half (torch,
statsmodels, Prophet, scikit-learn) is still unverified and remains Day 3-5 work — do not
extrapolate from this result. Pin the interpreter explicitly before then.

### GLO data source (verified)

**The data source is settled: GLO's own API, not a third-party mirror.** Probed live on
2026-10-12:

| Endpoint | Request | Purpose |
|---|---|---|
| `https://www.glo.or.th/api/checking/getLotteryResult` | `POST {date, month, year}` | Historical draw by date |
| `https://www.glo.or.th/api/lottery/getLatestLottery` | `POST {}` | Most recent draw |

Both are documented in GLO's open-data catalogue at
<https://gdcatalog.glo.or.th/dataset/dataset_c4-9_01>, so we consume the same JSON the official
site itself renders instead of scraping HTML.

Verified behaviours the ingestion engine depends on:

- **A date with no draw returns HTTP 200 with `{"response": null}`** — a "no data" signal,
  not an HTTP error. Non-draw dates are therefore safe to probe in bulk, and a postponed draw
  is found by widening the probe window (`--date-mode draw-window`, the `scraper.py` default;
  `all-days` is exhaustive but roughly 30x the requests).
- **The envelope differs per endpoint**: prize data sits at `response` for `getLatestLottery`
  but at `response.result` for `getLotteryResult`.
- **Coverage** was re-probed more precisely on 2026-10-13: `2010-01-16` returns `null` while
  `2010-03-01` returns real data, so the archive actually starts between those two dates —
  earlier than the 2014 first recorded here. A 10-year window sits comfortably inside it, but
  the *complete* archive is only ~199 months; see the row-count correction in the
  [Definition of Done](#definition-of-done-1).
- Numbers are **zero-padded strings** (`"001973"`) and are kept as strings end to end.
- A dead third-party mirror (`lotto.api.rayriffy.com`) was probed and **does not resolve**,
  confirming the decision to depend only on GLO.

> ⚠️ **Prize semantics — a correction that changes the model inputs.**
> GLO's 2-digit prize (`last2`, เลขท้าย 2 ตัว) and 3-digit prize (`last3b`) are **separately
> drawn numbers, NOT the trailing digits of the first prize.** Live proof: draw `2024-03-01`
> has first prize `253603` but official `last2` = **`79`** (not `03`); draw `2026-10-01` has
> first prize `402701` but official `last2` = **`70`** (not `01`). The ingestion engine
> therefore exports both channels distinctly — `bottom2` (official) versus `top2` (derived) —
> and the prediction models must be built on the correct one for the position being predicted.

> ⚖️ **Licence:** GLO's catalogue is published under **Creative Commons Non-Commercial
> (Any)**. Non-commercial use is fine; **commercial reuse needs GLO's permission.** Ingestion
> rate-limits to ~1 request/second and caches raw responses locally rather than
> redistributing a raw dump.

### The draw schedule is irregular (verified)

The two draws a month are **not** reliably on the 1st and the 16th. Probed live on 2026-10-13:

| Probe | Result |
|---|---|
| `2025-06-01`, `2025-06-16` | on schedule |
| `2025-05-01` | actually drawn **`2025-05-02`** (+1 day) |
| `2026-01-01`, `2025-01-01`, `2024-01-01`, `2023-01-01` | all `null` — January's first draw is **not** on the 1st |
| `2025-01-02`, `2026-01-02` | real draws (January's first draw, +1 day) |
| `2023-01-16`, `2024-01-16`, `2025-01-16`, `2026-01-16` | all `null` — January's mid-month draw moves to the **17th** |
| `2023-01-17`, `2024-01-17`, `2025-01-17`, `2026-01-17` | real draws, every year, no exception |
| `2024-01-03` … `2024-01-10` | all `null` — January 2024 genuinely had a **single** draw |

Two consequences, both load-bearing:

- **A fixed 1st/16th probe silently loses real draws.** January's mid-month draw is only
  reached because `data_ingestion.KNOWN_SPECIAL_DRAW_DAYS` happens to list `(1, 17)`;
  January's *first* draw sits on the **2nd** and was being missed outright. Every move observed
  was exactly **+1 day** — nothing appeared at ±2 or ±3, so the fix is cheap. `scraper.py`
  therefore defaults to `--date-mode draw-window`, widening the schedule by one day each way.
  Measured effect on `2025-12-25 → 2026-01-20`: `draw-days` finds **1** draw, `draw-window`
  finds **2**.
- **"24 draws a year" is an over-estimate.** At least one month on record has only one draw,
  so the usable series is shorter than 2 × 12 per year. The Day 3-5 models should read the real
  row count rather than assume it — this is the same data-volume constraint that Phase 2's
  6-digit analysis runs into.

### Security posture (and its limits)

The three controls above are all worth building, but each has a hard ceiling. Recorded here so
this plan is never mistaken for more protection than it actually delivers:

- **An API key shipped in a mobile app is not a secret.** Anything compiled into the bundle can
  be extracted from the installed app — Expo's own docs state there is "no secure way" to keep a
  secret in client code. Key validation therefore deters casual abuse and off-the-shelf scanners,
  not a determined attacker. The enforcement point that actually matters is **server-side**
  (quota, rate limiting, abuse detection); the client key is only a gate, not a credential.
- **CORS is a browser policy, not an access control.** Browsers enforce it; `curl`, scraping
  scripts, bots and the native iOS/Android app are all unaffected, and the native app sends no
  `Origin` header at all. CORS is defence-in-depth against malicious *web pages* — it is **not**
  an anti-scraping measure, and should not be described as one.
- **Per-IP rate limiting is the control that actually bites**, but it is imperfect in both
  directions: a distributed scraper spreads across many IPs, while legitimate users behind
  carrier NAT/CGNAT share a single one. Pair it with per-key quotas and anomaly detection before
  depending on it for anti-scraping.
- **Hermes bytecode is a speed bump, not obfuscation.** Hermes compiles JS to bytecode at build
  time, and public tools (`hermes-dec`, `hbctool`, `hermes_rs`) disassemble it into readable
  pseudocode, with property names preserved. Assume the client bundle is inspectable and keep
  the genuine IP — model weights, historical dataset, ensemble weighting — server-side.

### JavaScript engine & app config

No frontend change is required here, and the commonly suggested one is a no-op at best:

- **Hermes is already the default** JS engine on iOS and Android and has been since SDK 50;
  `react-native/sdks/hermes-engine` is present in this project.
- **`expo.jsEngine` was deprecated in SDK 53** and is absent from the SDK 57 app-config schema.
  Adding it makes `npx expo-doctor` **fail** with `should NOT have additional property
  'jsEngine'` — verified on this project, so the field is deliberately **not** set.
- **`eas.json` has no engine field.** It exists in this project's plan for build profiles
  (Day 7), not for engine selection.

### Definition of Done

- [x] `uvicorn main:app --reload` serves `/docs` (OpenAPI) locally — verified against a live
      server across three configurations: `GET /` returns the exact documented payload and
      nothing else, `GET /api/health` reports the service and its Supabase status, and
      `GET /openapi.json` returns `200`
- [ ] Seeding a fresh database produces ≥ 500 historical draw rows and is idempotent —
      **the row target is unreachable and must be revised.** The archive spans roughly 199
      months (from ~2010-02) at at most two draws a month, capping the whole source at about
      **~400 rows**. No backfill window reaches 500. Replace the target with "the complete
      archive" and assert *coverage* (oldest draw present, no unexpected gaps) instead of a
      round number that cannot be met
- [x] Re-running the same window never duplicates a draw — verified against a local PostgREST
      stub: the request carries `on_conflict=draw_date` and
      `Prefer: resolution=merge-duplicates`, and a second run sends the same conflict target
- [ ] `/api/results` returns valid JSON matching the documented ledger shape
- [x] No database credentials committed; `.env.example` documents required variables — and
      states which key ingestion needs (`service_role`, because `schema.sql` deliberately
      grants no write policy, so the `anon` key is refused with `42501`)
- [ ] A request with a missing or invalid `X-API-Key` is rejected with `401`
- [ ] A burst above the limit returns `429` with a `Retry-After` header
- [ ] A request from a non-allow-listed `Origin` is not granted CORS access

---

## Day 3 — Basic Statistical Models 🟡

**Objective:** Develop Frequency Analysis and a basic Markov Chain model in Python. Expose an
API endpoint (e.g. `/api/predict/basic`) to return predictions.

**Status:** the models and the endpoint ship and are verified; the caching and security tasks
are not done, so the endpoint is unauthenticated and recomputes per request (cheap today at
~400 rows — see [Performance](#performance)).

### Tasks

- [x] Frequency analysis: per-number occurrence counts against the uniform baseline
      (`count`, `share`, `expected`, `lift`) — no longer just a raw count
- [ ] Frequency rolling windows (e.g. last 25 draws) — **not done**; deliberately deferred,
      because a windowed rate is the Day 5 **Momentum** radar axis and building it twice would
      give the app two disagreeing definitions of "recent"
- [x] Inter-draw gaps, as `lastSeenDays` (draws since the code last appeared)
- [x] Per-position frequency (Top / Bottom) rather than pooled counts — the two are separate
      channels end to end
- [x] Markov chain: encode draw states, build the transition matrix with add-k smoothing
- [x] Expose observed conditional lift (`P(b|a) / P(b)`) so predictions stay explainable
- [ ] Choose chain order via AIC/BIC — **not done, by design.** Order 1 is the only order the
      sample can support; see [Markov state design](#markov-state-design) for why order 2-3 is
      not merely "less good" here but untestable
- [x] Add `GET /api/predict/basic` returning per-number probability + score for each position
- [x] Add unit tests (`pytest`) for frequency counts and matrix row-sums ≈ 1 — `49` tests in
      `backend/tests/`, run with `.venv/Scripts/python -m pytest -q`
- [ ] Cache the computed matrix per draw; recompute only when new results land
- [ ] Put `/api/predict/basic` behind API key auth **and** the `slowapi` limit (≈20 req/min/IP)
- [ ] Return `429` + `Retry-After` under burst so clients back off instead of retrying hard

### Artifacts

✅ built: **`backend/services.py`** (frequency + Markov + Heng Score) ·
**`backend/tests/test_services.py`** · **`backend/conftest.py`** · updated `backend/main.py`

⬜ planned, not built: `backend/models/frequency.py` · `backend/models/markov.py` ·
`backend/api/predict.py`

> **Naming deviation.** Both models live in a single `backend/services.py` rather than
> `backend/models/`. The Day 2 request offered `models.py` *or* `services.py`, and
> `models.py` would shadow the `backend/models/` **package** that Day 5 plans for
> `timeseries.py`, `montecarlo.py` and `ensemble.py` — a module and a package cannot share a
> name. `services.py` avoids the collision. Split it into the package when Day 5 arrives.

### Markov state design

**The state is the channel's own 2-digit code, and the question is order 1:** *given that the
last draw's 2-digit Top was `01`, what came next?*

- A whole-draw state (6-digit first prize plus 2-digit last prize) spans 10^8 combinations. In
  a ~400-draw archive it would essentially never repeat, so the conditional estimate would
  have zero support on every single request. That is not a modelling trade-off; it is
  unlearnable at this sample size.
- Higher-order chains (order 2-3) have the same problem one level down: with 100 states, order
  2 has 10,000 cells to estimate from ~400 transitions. An AIC/BIC comparison over a matrix
  that sparse picks noise, so the order is fixed at 1 and recorded here rather than "chosen".
- VISION §2.2 anticipates exactly this and suggests coarser buckets (parity band, high/low,
  digit-sum class) to keep the state space populated. That is the right next step for a
  higher-order chain and is **not** done.

### Honest scoring

Three properties are deliberate and should survive future edits:

- **`status: "limited"` is the expected steady state, not an edge case.** With 100 states and
  ~400 draws, the most recent code has usually appeared about 4 times, so its conditional
  estimate rests on ~3 observed transitions. `MIN_MARKOV_STRONG = 10` flags that in
  `warnings`; without it the API would report `ok` for a ranking built on three observations.
- **A dropped signal is redistributed, never zeroed.** If Markov support falls below its
  usability floor, its weight is renormalised onto Frequency and the response says so. Feeding
  a missing signal a constant would flatten every candidate onto one score.
- **Rank normalisation with heavy ties pulls scores toward the middle.** A lightly-smoothed
  Markov row has ~95 indistinguishable codes, whose average rank lands near 0.5 rather than 0.
  A narrow score spread therefore means *the models cannot separate these candidates*, which is
  the honest reading — it is documented in `rank_normalise()` so it is not later "fixed".

### Performance

No caching layer exists, so every request recomputes from scratch. Measured on a synthetic
ledger over real HTTP against a local PostgREST stub (12 sequential requests, medians):

| Measurement | 400 rows | 1000 rows |
|---|---|---|
| Model computation only (`analyse_draws`) | **65 ms** | 99 ms |
| End-to-end request, warm | **100 ms** (75–111) | 146 ms |
| Cold first request | 269 ms | — |

The 100×100 transition matrix and the blend are the bulk. 100 ms is comfortably inside budget,
which is why the caching task is still open rather than urgent — it becomes load-bearing on
Day 5, when Monte Carlo runs 100k simulations per request. Revisit then, not before.

Note the cold request costs ~2.7x the warm one. That gap is connection setup to the database,
not the models, and it is the figure a user actually meets on the first request after a deploy.

### Definition of Done

- [x] `/api/predict/basic` returns rankings for both positions, deterministically
- [x] Unit tests pass; transition matrix rows are normalised — `49` tests, including an
      explicit all-100-rows-sum-to-1 assertion
- [x] Response shape matches the `RankEntry` contract in the frontend mock layer — asserted
      per pick (`code`, `probability`, `score`, `delta`, `lastSeenDays`), with `tone`, `reason`
      and `evidence` added on top. Tone boundaries mirror `probabilityTone()` in
      `src/constants/theme.ts` exactly, so client and API cannot disagree
- [x] Re-running a prediction on unchanged data returns identical output — asserted at unit
      level and over two real HTTP calls
- [ ] Unauthenticated and over-limit requests to the prediction endpoint are rejected (401 / 429)

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
- [ ] **Draw Cycle Management:** a scheduled job that detects the draw instant (**16:00 on the
      1st and 16th**) and runs the whole cycle — archive the previous predictions → fetch the
      new winning numbers from GLO → verify them → recompute the ledger and `Next_Draw_Date` →
      trigger the ML pipeline for fresh Heng Scores
- [ ] Archive **before** regenerating: a settled prediction is append-only and must never be
      mutated, which is what keeps the Performance scorecard honest
- [ ] Make the cycle idempotent per draw, so a restart or a missed run catches up exactly once
- [ ] Expose the schedule from the API and assert it matches the frontend's `DRAW_SCHEDULE`, so
      the countdown and the cron can never disagree about the next draw date

### Artifacts

`backend/models/timeseries.py` · `backend/models/montecarlo.py` · `backend/models/ensemble.py`
· `backend/api/predict.py` · `backend/jobs/draw_cycle.py`

### Definition of Done

- [ ] `/api/predict/heng` returns hero pick + rankings + radar in the documented shape
- [ ] The same seed reproduces a byte-identical score (reproducibility test in CI)
- [ ] Confidence label degrades to `Medium`/`Low` when model disagreement is high
- [ ] p95 response time for `/api/predict/heng` stays under the agreed budget with caching
- [ ] The ensemble weights are config, not hard-coded constants
- [ ] The draw-cycle job archives then regenerates for a simulated draw instant, exactly once
- [ ] `/api/draws/next` and the frontend countdown report the same next draw date

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
- [ ] Correct the Performance screen's prize tiers to GLO's real structure — the current mock
      uses 3/2/1-digit tiers that do not match GLO, where the 2-digit result is **separately
      drawn** and pays ฿2,000 (see [GLO data source](#glo-data-source-verified))
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
| **R1** | ~~Historical draw data unobtainable~~ — **resolved** | No longer blocking | **Resolved 2026-10-12:** GLO's official JSON API is live and returns real draws back to at least 2014; `backend/data_ingestion.py` is built and verified. **Residual risk: the catalogue is licensed CC Non-Commercial (Any)** — commercial reuse needs GLO's permission |
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

> **Both gaps on this list come back in Phase 2:** user accounts *and* payments are the whole
> substance of [Phase 2 — Monetization & Advanced AI](#phase-2--monetization--advanced-ai-).
> They are excluded from *this sprint*, not from the product.

---

## Progress Tracker

- [x] **Day 1** — Foundation & Scaffolding (Frontend)
- [ ] **Day 2** — Backend & Database Setup
- [~] **Day 3** — Basic Statistical Models (models + endpoint done; caching and auth open)
- [ ] **Day 4** — Frontend–Backend Integration
- [ ] **Day 5** — Advanced Models & Heng Score
- [ ] **Day 6** — Personalized Feature & Testing
- [ ] **Day 7** — Review & Deployment Prep

---

## Phase 2 — Monetization & Advanced AI ⬜

**Status:** planning only. Nothing here is implemented. The frontend currently ships a
**presentational** lock and a paywall that cannot charge anyone (see
[What already exists](#what-already-exists-frontend-placeholder)).

**Objective:** turn the free MVP into a paid product — a **Premium tier at ฿99/month**
unlocking 3-digit (3 ตัว) and 6-digit (รางวัลที่ 1) analysis — backed by a server-side
entitlement system and a genuinely more capable model family.

### What already exists (frontend placeholder)

| Piece | Path |
|---|---|
| Locked tier teasers (3-digit · 6-digit) | [`src/components/superheng/locked-panel.tsx`](src/components/superheng/locked-panel.tsx) |
| Paywall modal (`/premium`) | [`src/app/premium.tsx`](src/app/premium.tsx) |
| Dashboard premium section | [`src/app/(tabs)/index.tsx`](src/app/%28tabs%29/index.tsx) |

Two rules this placeholder establishes, both of which must survive into Phase 2:

- **The lock is a sales surface, not an access control.** Hiding a card client-side is
  cosmetic — anyone can hide it. Every premium endpoint must be gated **server-side** on a
  verified entitlement, and the client's claim must never be the thing that grants access.
- **No placeholder digits, ever.** A ghosted fake number is indistinguishable from a real
  prediction at a glance, so locked tiers render masked glyphs only.

---

### 2.1 Payments — three stores, not one

**The most important finding in this phase: a ฿99/month digital subscription cannot be sold on
iOS or Android through Stripe.** Apple's App Review Guidelines (§3.1.1) require In-App Purchase
to unlock digital content or functionality, and Google Play's payments policy requires Play
Billing for in-app subscriptions. **Thailand is not covered by the 2025–2026 US
external-link exceptions or the EEA DMA programs**, so for this product's primary market the
store rails are mandatory:

| Platform | Required rail | Commission | Notes |
|---|---|---|---|
| iOS (TH) | StoreKit IAP | **30%** year 1 → **15%** after | Small Business Program = 15% from the start if ≤ US$1M proceeds in the prior calendar year |
| Android (TH) | Google Play Billing | **15%** for auto-renewing subscriptions in markets not yet on the new schedule | New schedule rolling out from 2026-06-30: service fee from 10%, **plus** a 5% billing fee when Play processes the payment |
| Web | Stripe Billing | Stripe TH pricing | Thailand and THB presentment are both supported |

**Unit economics:** ฿99 less 30% is roughly **฿69** gross per iOS subscriber in year one, before
tax and before infrastructure. Revisit the price or the tier mix against that number rather
than assuming ฿99 is net.

**Legal position is genuinely in flux.** The US external-purchase-link allowance rests on the
2025 Epic injunction and the Ninth Circuit's December 2025 decision narrowing the remedy, with
the Supreme Court having agreed to hear Apple's challenge and commission proceedings ongoing
through 2026. Do **not** design a US-only external-link flow into the core architecture; treat
it as an optional decoration that can disappear.

### 2.2 Stripe — implementation notes (the web rail)

- Backend creates the Checkout Session; **Stripe Billing** owns recurring invoices, retries,
  dunning and cancellation. Env: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET` — the publishable key is public by design, the other two are
  server-only secrets and must never reach the client bundle.
- **PCI compliance** is the reason to use a hosted flow: with Checkout (or PaymentSheet) the
  card details travel from the customer straight to Stripe, so the server never sees a PAN and
  the app stays in the lightest **SAQ-A** scope. Hand-rolled card inputs would drag the project
  into a far heavier compliance obligation for no benefit.
- **Webhooks are the source of truth.** Grant entitlement on a signature-verified webhook —
  never on the client's "payment succeeded" redirect, which is both forgeable and skippable
  (users close the tab).
- **In FastAPI, verify against the raw body:**

  ```python
  payload = await request.body()
  signature = request.headers.get("stripe-signature", "")
  event = stripe.Webhook.construct_event(payload, signature, endpoint_secret)
  ```

  Re-serialising parsed JSON changes the bytes and breaks the signature — the classic bug in
  this integration. Reject on verification error, then process idempotently and return 2xx
  promptly.
- Dedupe on `event.id`; handle `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, and `invoice.payment_failed|paid`.
- Client side, if a native Stripe flow is ever used: `@stripe/stripe-react-native` via
  `npx expo install`. It is **not** the web integration (use hosted Checkout on web), and
  **Apple Pay / Google Pay require a development build, not Expo Go** — which this project
  cannot currently produce (no JDK, no AVD; see [Native verification status](#native-verification-status)).

### 2.3 User accounts & entitlements

- **Use Supabase Auth.** Day 2 already selected Supabase Postgres, so auth adds **no second
  vendor** and lets entitlements live in the same database as the draw ledger, under RLS.
  Firebase Auth would mean a second vendor *and* entitlements still needing to live in Postgres.
- One `entitlements` table, three payment sources (`apple`, `google`, `stripe`), and a single
  `is_premium` truth derived **server-side**.
- FastAPI verifies the Supabase access token (`Authorization: Bearer <jwt>`) against the
  project's JWKS at `…/auth/v1/.well-known/jwks.json` — verify the signature, `exp` and `iss`,
  then authorise on the verified `sub`. **Decoding a JWT without verifying it is not
  authentication.**
- Never ship the Supabase service-role key in the client; pair the client with RLS.
- Store receipts must be validated server-side for IAP and Play Billing too — a
  client-reported subscription is not evidence of one.

### 2.4 Advanced AI — the 6-digit tier

The premise is correct that 6-digit prediction needs a more complex model family than 2-digit.
There is a harder constraint underneath it, and it should shape the plan:

| Target | Outcome space | Draws/year | Rows after ~10 years of history |
|---|---|---|---|
| 2-digit (today) | 100 | 24 | ~240 |
| 3-digit | 1,000 | 24 | ~240 |
| 6-digit (1st prize) | 1,000,000 | 24 | ~240 |

**The binding constraint is data volume, not compute.** Roughly 240 observations against 10⁶
outcomes cannot train a Transformer to predict anything: it will memorise the training set and
generalise to noise, however much GPU is thrown at it. The honest product framing for this tier
is **ranking, structure and visualisation over the number space** — never an accuracy promise.
This is the same rule as risk **R5**: word the copy as *model agreement*, never as a chance of
winning.

Planned work, in order of expected value:

- [ ] Ship **3-digit first**. 1,000 states is tractable with the Markov + Monte Carlo + ARIMA
      ensemble already planned for Day 5, and it is the tier that can be defended honestly
- [ ] For 6-digit, begin with **structured decomposition** — per-digit-position models,
      sum/parity/band distributions, positional-independence tests — which stand up on small
      samples, rather than an end-to-end deep model
- [ ] Attempt sequence models (Transformer / GRU) **only** once the dataset supports them, and
      gate them behind an out-of-sample backtest that beats the trivial uniform baseline. If it
      cannot beat uniform, it does not ship
- [ ] Build the backtest harness with a strictly time-ordered split, and print the baseline
      beside every headline number
- [ ] Budget compute honestly: inference is cheap, training is not. Precompute per draw cycle
      and cache, exactly as Day 5 already does for the 2-digit ensemble
- [ ] **Publish the 6-digit miss rate.** A premium tier that hides its misses is the fastest way
      to destroy the trust the free tier is built on

### 2.5 Blocking legal item — GLO licence

Risk **R1** already records that GLO's catalogue is **Creative Commons Non-Commercial (Any)**.
Selling a subscription that depends on that data is commercial use, so **charging for this
product requires GLO's permission** or a differently-licensed data source. This sits *before*
all of the engineering above: resolve the licence before building a paywall on top of the data.

### 2.6 Target API surface (Phase 2)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/billing/checkout` | Create a Stripe Checkout Session |
| `POST` | `/api/billing/webhook` | Verify the signature, upsert the entitlement |
| `GET` | `/api/me/entitlement` | Server-side premium status for the signed-in user |
| `GET` | `/api/predict/three-digit` | Premium 3-digit rankings |
| `GET` | `/api/predict/six-digit` | Premium 6-digit analysis (once it exists) |

`/api/me/entitlement` is the only thing the client is allowed to trust, and only to decide what
to **render** — never what to allow.

### Definition of Done

- [ ] A premium endpoint returns `403` for a signed-in free user, proven with a real token
- [ ] Subscription state reaches the database **only** through a signature-verified webhook
- [ ] Replaying the same webhook event twice leaves exactly one entitlement row
- [ ] A cancelled or failed subscription loses premium access within the grace policy
- [ ] A modified client that claims premium still receives `403` from the API
- [ ] No secret other than publishable keys is present in the client bundle
- [ ] The 6-digit model publishes its out-of-sample hit rate next to the uniform baseline
- [ ] GLO licensing is resolved in writing before the tier is sold
