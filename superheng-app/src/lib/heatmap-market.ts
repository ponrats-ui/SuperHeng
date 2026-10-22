/**
 * The markets the 00-99 heat map can be built for, and the ledger behind each.
 *
 * **The maths is not per-country.** `buildHeatmapBoard` in `lib/heatmap.ts` only
 * ever sees a list of `{ date, code }`; what has to change per market is where
 * that list comes from. That fetch is this module's whole job: `getLatestDraws`
 * is called with the ledger belonging to the requested market, so a Laos board is
 * fitted on Laos draws and a Hanoi board on Hanoi draws, and no market can be
 * scored on another market's results.
 *
 * **Hanoi is the `vietnam` ledger.** `backend/main.py::LotteryType` names the
 * ledger `vietnam` and documents it as Hanoi's XSMB draw; the stored rows, the
 * scraper and the `lottery_type` CHECK constraint all use that value. This module
 * keeps the product's name (`hanoi`) and maps it to the ledger at the one place a
 * request is built, rather than adding a fourth lottery type the database does not
 * have — a duplicated enum is how two names for one ledger start to disagree.
 *
 * Both international ledgers publish a two-digit column the board can read:
 * Laos's เลขท้าย 2 ตัว and, for Vietnam, the last two digits of the special prize
 * (`scripts/scrape_international.py` documents both). So the same 100-code
 * ensemble applies unchanged.
 */

import { getLatestDraws, type LotteryType, type RequestOptions } from './api';
import { buildHeatmapBoard, type HeatmapBoard } from './heatmap';

/** Display order of the heat map's market tabs, and the value the panel takes. */
export type HeatmapMarket = 'thai' | 'laos' | 'hanoi';

/** Every market the heat map knows, Thai first because it is the free one. */
export const HEATMAP_MARKETS: readonly HeatmapMarket[] = ['thai', 'laos', 'hanoi'];

/**
 * The ledger each market reads.
 *
 * The only place the product's market names meet the API's `lottery_type`
 * values; everything above this line speaks `HeatmapMarket`.
 */
export const HEATMAP_MARKET_LEDGERS: Record<HeatmapMarket, LotteryType> = {
  thai: 'thai',
  laos: 'laos',
  hanoi: 'vietnam',
};

/**
 * How much ledger the board reads: the endpoint's maximum, 100 draws.
 *
 * The window is stated under the grid rather than left implicit, because the
 * frequency and transition estimates are only as wide as these draws — quoting a
 * score without its sample is the habit this screen exists to avoid.
 */
export const HEATMAP_DRAW_WINDOW = 100;

/**
 * Whether a market's board is sold rather than free.
 *
 * Thai stays accessible on its current rules; the two international markets are
 * the Premium feature. The paywall is a UI gate over this answer and never a
 * substitute for a server-side check on anything that costs money — the ledger
 * endpoints themselves are public, exactly as they are for Thailand.
 */
export function heatmapRequiresPremium(market: HeatmapMarket): boolean {
  return market !== 'thai';
}

/**
 * Fetches one market's ledger and builds its board.
 *
 * `null` means the ledger is too thin to model (`MIN_HEATMAP_DRAWS`), which is a
 * successful answer rather than an error — the caller shows the "needs N draws"
 * state. A request failure rejects with the API's own `ApiError` so the panel can
 * render the same error copy it uses everywhere else.
 *
 * @param market Which market's heat map to build.
 * @param options Per-request budgets, plus `onRetry` to announce a cold server.
 */
export async function buildHeatmapForMarket(
  market: HeatmapMarket,
  options?: RequestOptions
): Promise<HeatmapBoard | null> {
  const rows = await getLatestDraws(
    HEATMAP_DRAW_WINDOW,
    HEATMAP_MARKET_LEDGERS[market],
    options
  );

  return buildHeatmapBoard(rows.map((row) => ({ date: row.date, code: row.bottomTwo })));
}
