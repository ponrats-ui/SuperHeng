# SuperHeng 📊

**SuperHeng** is a mobile **Data Analytics and Probability** application for lottery draw
analysis. It is *not* a gambling app: it ingests historical draw results and applies
statistical and machine-learning models to surface measurable structure — temporal
seasonality, transition probabilities, distributional balance and sequence dependencies —
then publishes an explainable **Heng Score** (0–100) per candidate number.

The interface is deliberately designed like a financial analytics terminal rather than a
casino: a deep-navy dark theme (the only theme), crimson and premium-gold accents, and
green–amber–grey data tones.

> **📐 For the philosophy behind the product and a full specification of the predictive
> models (ARIMA & Prophet, Markov Chains, Monte Carlo, LSTM), see [VISION.md](VISION.md).**

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Design System](#design-system)
- [Data Layer & API Integration](#data-layer--api-integration)
- [Documentation](#documentation)
- [Responsible Play](#responsible-play)

---

## Features

The app is organised into four bottom-tab screens:

| Tab | Route | What it does |
|---|---|---|
| **Dashboard** | [`src/app/(tabs)/index.tsx`](src/app/%28tabs%29/index.tsx) | Live countdown to the next draw, the **AI Top Pick** hero (Heng Score gauge + radar profile), top-5 rankings for the 2-digit Top / Bottom positions with probability bars, and the active model ensemble |
| **My Number** | [`src/app/(tabs)/my-number.tsx`](src/app/%28tabs%29/my-number.tsx) | Analyse any 2–3 digit number (e.g. a licence plate): Heng Score, historical appearance data, radar signal profile and model-derived advice |
| **Insights** | [`src/app/(tabs)/insights.tsx`](src/app/%28tabs%29/insights.tsx) | Tablet-optimised: tappable **00–99 four-model ensemble heatmap** (Markov · frequency · momentum · Monte Carlo, adaptively weighted from each model's last 10 draws), even/odd vs high/low **trend chart** over the last 10 draws, and the **AI reasoning log** |
| **Performance** | [`src/app/(tabs)/performance.tsx`](src/app/%28tabs%29/performance.tsx) | Transparency & trust: accuracy scorecard, **prize checker**, and an append-only history of published predictions vs actual results |

- 🌘 **Dark by design** — the deep-navy palette is the product, not a preference: the app
  pins `userInterfaceStyle` and ignores the system's light setting. A light palette still
  exists in `src/constants/theme.ts` if it is ever needed again.
- 📱 **Responsive** — single column on phones, multi-column heatmap + charts on tablets.
- 🔍 **Explainable** — every prediction is accompanied by the reasoning that produced it.

---

## Tech Stack

### Frontend

| Layer | Technology |
|---|---|
| Framework | [React Native](https://reactnative.dev/) + [Expo](https://expo.dev) (SDK 57) |
| Navigation | [Expo Router](https://docs.expo.dev/router/introduction/) (file-based routing, typed routes) |
| Language | TypeScript (strict) |
| Styling | React Native `StyleSheet` + a central design-token system |
| Icons | `expo-symbols` (SF Symbols on iOS, Material Symbols elsewhere) |
| Charts | Custom dependency-free components (no `react-native-svg` required) |

> This project includes an [`AGENTS.md`](AGENTS.md) with project conventions. Note that
> `@expo/vector-icons` is **not** used — Expo now recommends
> icon-pack-specific packages and `expo-symbols` instead.

### Backend — *planned*

The analytics engine is a separate service; the app is currently wired to a deterministic
mock layer (see [Data Layer](#data-layer--api-integration)).

| Layer | Technology |
|---|---|
| API | Python — [FastAPI](https://fastapi.tiangolo.com/) (REST) |
| Database | [PostgreSQL](https://www.postgresql.org/) |
| Managed platform | [Supabase](https://supabase.com/) (Postgres, auth, storage) |
| Modelling | `statsmodels` / Prophet · NumPy (Monte Carlo) · PyTorch (`LSTM`) |
| ML Ops / Infrastructure | Google Cloud / AWS (training, serving, scheduling, monitoring) |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm
- A physical device ([Expo Go](https://expo.dev/go)), or an
  [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/) /
  [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)

### Installation

```bash
# 1. Enter the app directory
cd superheng-app

# 2. Install dependencies
npm install

# 3. Start the development server
npm start
# or: npx expo start
```

From the interactive terminal output, press:

- `w` — open in the web browser
- `a` — open in an Android emulator
- `i` — open in the iOS simulator
- `r` — reload the app · `m` — toggle the dev menu

### All available scripts

```bash
npm start          # start the Expo dev server
npm run web        # start directly on web
npm run ios        # start and open the iOS simulator
npm run android    # start and open the Android emulator
npm run lint       # ESLint (expo lint)
npm run reset-project   # move the starter scaffolding aside and start blank
```

### Recommended checks before committing

```bash
npx tsc --noEmit   # typecheck
npm run lint       # lint
npx expo-doctor    # diagnose dependency / config issues
```

> **Adding dependencies?** Always use
> `npx expo install <package>` instead of `npm install <package>` so Expo resolves an
> SDK-compatible version.

---

## Project Structure

```
superheng-app/
├── app.json                    # Expo config (name, icons, plugins, typed routes)
├── package.json
├── tsconfig.json               # "@/*" -> ./src/* path alias
├── eslint.config.js
├── VISION.md                   # ⭐ product philosophy + algorithm specification
├── AGENTS.md                   # project conventions for contributors/agents
│
├── assets/                     # icons, splash screen, images
│
└── src/
    ├── app/                    # 📍 routes only — every file here is a screen
    │   ├── _layout.tsx         # root Stack (theme, status bar, splash)
    │   └── (tabs)/
    │       ├── _layout.tsx     # bottom tab navigator (the 4 tabs)
    │       ├── index.tsx       # Tab 1 — Dashboard
    │       ├── my-number.tsx   # Tab 2 — My Number (analysis)
    │       ├── insights.tsx    # Tab 3 — Deep Insights (tablet-optimised)
    │       └── performance.tsx # Tab 4 — Performance & trust
    │
    ├── components/
    │   ├── superheng/          # the app's UI kit
    │   │   ├── index.ts        # barrel export
    │   │   ├── app-header.tsx          # brand header
    │   │   ├── card.tsx                # surface primitive
    │   │   ├── section-header.tsx      # titled section row
    │   │   ├── page-scaffold.tsx       # safe-area + centered content column
    │   │   ├── score-ring.tsx          # circular Heng Score gauge
    │   │   ├── radar-chart.tsx         # 5-axis signal profile
    │   │   ├── chart-primitives.tsx    # shared line-segment primitive
    │   │   ├── trend-chart.tsx         # multi-series line chart
    │   │   ├── heatmap.tsx             # 00–99 ensemble grid
    │   │   ├── probability-bar.tsx     # probability meter
    │   │   ├── rank-row.tsx            # ranking list item
    │   │   ├── segmented-control.tsx   # pill switcher
    │   │   ├── signal-chip.tsx         # model pill + stat tile
    │   │   └── countdown.tsx           # live draw countdown
    │   ├── themed-text.tsx     # typography primitives
    │   ├── themed-view.tsx
    │   ├── animated-icon.tsx   # splash overlay
    │   └── …                   # a few unused components remain from the
    │                           # Expo starter (hint-row, web-badge, ui/collapsible)
    │
    ├── constants/
    │   └── theme.ts            # 🎨 the single source of truth for colors, spacing, radii
    │
    ├── data/
    │   └── mock.ts             # 🧪 mock analytics payloads (shaped like the future API)
    │
    ├── hooks/
    │   ├── use-app-theme.ts    # active palette
    │   ├── use-color-scheme.ts # always 'dark' — the system preference is ignored
    │   └── use-theme.ts        # palette only, for the typed primitives
    │
    ├── lib/
    │   ├── draw.ts             # draw schedule + countdown math
    │   └── format.ts           # number/date/percentage formatting
    │
    └── global.css              # web font variables
```

**Convention:** only routes live in `src/app/`. Everything else (components, hooks,
utilities, data) lives outside it so route files stay thin.

---

## Design System

All design tokens live in [`src/constants/theme.ts`](src/constants/theme.ts) — the single
source of truth. Both palettes expose an identical key set, so `Colors[scheme]` is
interchangeable everywhere.

The app renders in **dark only**. `ForcedColorScheme` in that file is the one switch:
`app.json` pins `userInterfaceStyle: "dark"` for native, and `useColorScheme()` returns the
constant so web (where the app.json setting has no effect) cannot boot light either. The
static export is therefore already dark, and `<html>` carries a dark `color-scheme` plus a
dark `body` so there is no white flash before hydration.

```ts
import { Brand, DataColors, probabilityColor } from '@/constants/theme';

Brand.crimson        // '#C8102E'  primary / brand accent
Brand.gold           // '#D4AF37'  premium accent
DataColors.high      // '#2ECC71'  high probability  (Heng score >= 75)
DataColors.medium    // '#F2C13B'  medium            (55 - 74)
DataColors.low       // '#E0524A'  low               (35 - 54)
DataColors.cold      // '#7C8497'  no signal         (< 35)

probabilityColor(92) // -> '#2ECC71'
```

Reading the active palette in a component:

```tsx
import { useAppTheme } from '@/hooks/use-app-theme';

const { scheme, colors } = useAppTheme();
// colors.background · colors.card · colors.text · colors.primary · colors.gold …
```

Signal tones are consistent across every screen: **🟢 high (≥75) · 🟡 medium (55–74) ·
🔴 low (35–54) · ⚪ cold (<35)**. See [VISION.md](VISION.md#25-the-ensemble--the-heng-score)
for how the Heng Score is derived.

The **00–99 heatmap is the deliberate exception**: it colours cells by a fixed quota
rather than those thresholds — green is the 12 best-ranked codes, gold the next 18, red
the next 30, grey the bottom 40 — so "HIGH" stays rare and the green band cannot drift
with the shape of the board. `HEATMAP_BAND_COUNTS` in [`src/lib/heatmap.ts`](src/lib/heatmap.ts)
is the single source, and the legend prints its numbers.

---

## Data Layer & API Integration

Most screens run on a **deterministic mock analytics layer** in
[`src/data/mock.ts`](src/data/mock.ts), deliberately shaped like the payloads the FastAPI
backend will return, so swapping it for real HTTP calls should not require any UI changes.

The **Insights heatmap** is the exception: it is computed on-device from the published
draws by [`src/lib/heatmap.ts`](src/lib/heatmap.ts), which blends Markov transitions,
historical frequency, recency-weighted momentum and a 10,000-path Monte Carlo simulation
with weights refit from each model's recent walk-forward log score — a 10% floor, a 40%
ceiling, and the remaining 60% split by skill. The weights it actually used are printed
under the grid. It therefore needs `/api/latest-draws` to answer, and it says so when it
cannot.

```ts
// src/data/mock.ts — the seam to replace
export const TOP_PICK: TopPick            // hero pick + radar axes + confidence
export const RANKINGS: Record<'top' | 'bottom', RankEntry[]>
export const TREND_SERIES: TrendPoint[]           // last 10 draws
export const AI_LOG: AiLogEntry[]                 // reasoning log
export const SCORECARD: ScorecardEntry[]          // published vs actual
export function analyzeNumber(code: string): NumberAnalysis  // My Number screen
```

To integrate the backend, replace these exports with `fetch`/React Query calls and add
loading, error and empty states. The route params already support deep links — for example
the Insights heatmap pushes `/my-number?code=48`, which auto-runs the analysis.

---

## Documentation

| Document | Contents |
|---|---|
| **[VISION.md](VISION.md)** | ⭐ Project vision, the four core algorithms (ARIMA & Prophet, Markov Chains, Monte Carlo, LSTM), the ensemble & Heng Score definition, data pipeline, roadmap and limitations |
| [AGENTS.md](AGENTS.md) | Project conventions and commands for contributors and coding agents |

---

## Responsible Play

SuperHeng is an analytics and education tool.

- No model can guarantee a lottery outcome. A fair draw is independent, and any structure
  the models detect may be noise.
- The **AI Scorecard** is append-only: predictions are published before the draw and are
  never edited afterwards, so the reported accuracy — including misses — stays honest.
- Gambling carries a real risk of loss. Play responsibly and never stake more than you can
  afford to lose.

---

## Learn more

- [Expo documentation](https://docs.expo.dev/) — fundamentals and advanced guides
- [Expo Router](https://docs.expo.dev/router/introduction/) — file-based routing
- [Development builds](https://docs.expo.dev/develop/development-builds/introduction/) ·
  [Expo Go](https://expo.dev/go)
- [Expo on GitHub](https://github.com/expo/expo) ·
  [Discord community](https://chat.expo.dev)
