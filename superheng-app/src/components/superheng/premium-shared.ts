/**
 * Label maps shared by the two Premium views.
 *
 * `premium-insights.tsx` and `latest-draw-accuracy.tsx` are siblings inside the same
 * card, and both render positions, a ledger and a model status. These tables live
 * here rather than in one of them for the obvious reason — a second copy is how the
 * two views would end up naming the same position differently — and here rather than
 * in the barrel so neither sibling has to import the other (which would be a cycle,
 * and would drag the whole panel into the accuracy card's module graph).
 */

import type { LotteryType, PositionKey, PredictionStatus } from '@/lib/api';
import type { TranslationKey } from '@/lib/i18n';

/**
 * Localised name for each modelled position.
 *
 * The panel deliberately **ignores** the API's own `label` field, which is a
 * bilingual concatenation like "Thousands (หลักพัน)" — the exact mixed-language
 * string the i18n rewrite exists to remove.
 */
export const POSITION_LABEL_KEYS: Record<PositionKey, TranslationKey> = {
  hundred_thousands: 'premium.positionHundredThousands',
  ten_thousands: 'premium.positionTenThousands',
  thousands: 'premium.positionThousands',
  hundreds: 'premium.positionHundreds',
  tens: 'premium.positionTens',
  units: 'premium.positionUnits',
};

/**
 * The endpoints' `status` values as dictionary keys.
 *
 * Mapped rather than interpolated so the raw enum never reaches the screen: the Thai
 * UI used to print `Model status: limited` in English.
 */
export const STATUS_KEYS: Record<PredictionStatus, TranslationKey> = {
  ok: 'status.ok',
  limited: 'status.limited',
  insufficient_data: 'status.insufficientData',
};

/**
 * Tab label per ledger.
 *
 * Country names rather than the ISO-ish codes the API uses, and translated: a reader
 * in Thai mode should not have to read "Laos" in Latin script to find the Lao
 * lottery. The header's TH/EN switch is a *language* control, so the ledger row
 * deliberately does not reuse its two-letter faces — the same "TH" meaning two
 * different things eight pixels apart is a usability trap.
 */
export const LOTTERY_LABEL_KEYS: Record<LotteryType, TranslationKey> = {
  thai: 'premium.lotteryThai',
  laos: 'premium.lotteryLaos',
  vietnam: 'premium.lotteryVietnam',
};
