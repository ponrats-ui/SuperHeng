import { FontAwesome } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { DataColors, Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useAuth } from '@/lib/auth';
import { apiErrorText, type ApiErrorText } from '@/lib/api-error';
import { formatCount, formatLocalizedDate } from '@/lib/format';
import {
  HEATMAP_ACCURACY_WINDOW,
  HEATMAP_BAND_COUNTS,
  HEATMAP_SIMULATIONS,
  HEATMAP_TIERS,
  MIN_HEATMAP_DRAWS,
  weightPercents,
  type HeatmapBoard,
  type HeatmapModel,
  type HeatmapTier,
} from '@/lib/heatmap';
import {
  buildHeatmapForMarket,
  heatmapRequiresPremium,
  type HeatmapMarket,
} from '@/lib/heatmap-market';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

import { Heatmap } from './heatmap';

/** Dark ink for text on a gold fill, in both themes. Same constant as the paywall. */
const ON_GOLD = '#101422';

/**
 * DOM id used as the web hook for the locked blur.
 *
 * React Native Web's style compiler drops RN's `filter` property (verified: the
 * computed value stays `none`), so the web build gets its real `blur(8px)` from
 * the `#superheng-heatmap-locked-grid` rule in `global.css`. `nativeID` is what
 * RNW renders as the element's `id`, which makes this a supported bridge rather
 * than a styled-components workaround. One id is safe because only one heat map
 * panel is mounted at a time — the Insights card.
 */
const LOCKED_GRID_ID = 'superheng-heatmap-locked-grid';

/** Localised tab label per market. */
export const HEATMAP_MARKET_LABEL_KEYS: Record<HeatmapMarket, TranslationKey> = {
  thai: 'insights.marketThai',
  laos: 'insights.marketLaos',
  hanoi: 'insights.marketHanoi',
};

/**
 * The four models under the grid, in the order the copy lists them.
 *
 * Every line here describes what the code in `lib/heatmap.ts` actually does — the
 * shrinkage, the decay half-life, the simulation count. Marketing copy that
 * outran the model would be the same problem as a fake probability, only in prose.
 *
 * `label` is the short name the weight sentence uses; it stays untranslated
 * because these are model names, not prose.
 */
const HEATMAP_MODEL_ROWS: readonly {
  model: HeatmapModel;
  label: string;
  name: TranslationKey;
  body: TranslationKey;
}[] = [
  {
    model: 'markov',
    label: 'Markov',
    name: 'insights.heatmapMarkovName',
    body: 'insights.heatmapMarkovBody',
  },
  {
    model: 'frequency',
    label: 'Frequency',
    name: 'insights.heatmapFrequencyName',
    body: 'insights.heatmapFrequencyBody',
  },
  {
    model: 'momentum',
    label: 'Momentum',
    name: 'insights.heatmapMomentumName',
    body: 'insights.heatmapMomentumBody',
  },
  {
    model: 'montecarlo',
    label: 'Monte Carlo',
    name: 'insights.heatmapMontecarloName',
    body: 'insights.heatmapMontecarloBody',
  },
];

/**
 * The legend, in band order.
 *
 * Colours here mirror `components/superheng/heatmap.tsx`; the **sizes come from
 * the board code** (`HEATMAP_BAND_COUNTS`), so "top 12" in the legend is the
 * same 12 the grid paints green. The earlier legend showed a colour ramp with no
 * band at all, which is how a quarter of the grid ended up reading as a signal.
 */
const LEGEND_KEYS = {
  high: 'insights.legendStrong',
  medium: 'insights.legendMedium',
  low: 'insights.legendLow',
  ignore: 'insights.legendIgnore',
} as const satisfies Record<HeatmapTier, TranslationKey>;

const LEGEND_COLORS: Record<HeatmapTier, string> = {
  high: DataColors.high,
  medium: DataColors.medium,
  low: DataColors.low,
  ignore: DataColors.cold,
};

type HeatmapState =
  | { status: 'loading' }
  | { status: 'ready'; market: HeatmapMarket; board: HeatmapBoard }
  | { status: 'empty'; market: HeatmapMarket }
  | { status: 'failed'; market: HeatmapMarket; text: ApiErrorText };

export type HeatmapPanelProps = {
  /** Which market's ledger to model. The panel refetches whenever this changes. */
  lotteryType: HeatmapMarket;
  /** Called when an unlocked cell is tapped (used to jump into "My Number"). */
  onSelect?: (code: string) => void;
};

/**
 * The 00-99 heat map for one market, including its paywall.
 *
 * **Data is per ledger.** `buildHeatmapForMarket(lotteryType)` asks
 * `/api/latest-draws` for that market's `lottery_type` and hands only those rows
 * to the ensemble, so switching tabs really switches datasets — nothing is
 * recomputed from Thailand's numbers and relabelled.
 *
 * **The paywall blurs rather than hides.** A locked board is still the market's
 * real board: same grid, same quota colours, same shading, so the reader can see
 * the shape of what they would unlock. What they cannot do is read it — the grid
 * is behind an 8px blur, its cells are removed from the accessibility tree, and
 * taps are off. The Thai market is never gated.
 *
 * The board resets to its loading state on every market change: a stale Laos
 * board left under a Hanoi tab would attribute one ledger's numbers to another.
 */
export function HeatmapPanel({ lotteryType, onSelect }: HeatmapPanelProps) {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const auth = useAuth();
  const [state, setState] = useState<HeatmapState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void buildHeatmapForMarket(lotteryType).then(
      (board) => {
        if (cancelled) return;
        setState(
          board ? { status: 'ready', market: lotteryType, board } : { status: 'empty', market: lotteryType }
        );
      },
      (caught: unknown) => {
        if (cancelled) return;
        setState({ status: 'failed', market: lotteryType, text: apiErrorText(caught) });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [lotteryType]);

  // A response for a market the reader has already left is not shown: the state
  // carries the market it was built for, and the tab is the source of truth.
  const current: HeatmapState =
    state.status === 'loading' || state.market === lotteryType ? state : { status: 'loading' };

  const board = current.status === 'ready' ? current.board : null;
  const locked = heatmapRequiresPremium(lotteryType) && !auth.isPremium;

  const topCell = useMemo(
    () => (board ? board.byCode[board.signals.top1] : null),
    [board]
  );

  // The weight sentence and the badges read from one table of whole numbers, so the
  // headline can never disagree with the rows under it.
  const percents = useMemo(() => (board ? weightPercents(board.weights) : null), [board]);
  const weightDetail = useMemo(() => {
    if (!board || !percents) return '';
    return [...HEATMAP_MODEL_ROWS]
      .sort((a, b) => board.weights[b.model] - board.weights[a.model])
      .map((entry) => `${entry.label} ${percents[entry.model]}%`)
      .join(', ');
  }, [board, percents]);

  return (
    <>
      {current.status === 'loading' ? (
        <View style={styles.stateRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <ThemedText type="small" themeColor="textMuted">
            {t('insights.heatmapLoading')}
          </ThemedText>
        </View>
      ) : null}

      {current.status === 'failed' ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
          {t(current.text.key, current.text.params)}
        </ThemedText>
      ) : null}

      {current.status === 'empty' ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
          {t('insights.heatmapThin', { draws: MIN_HEATMAP_DRAWS })}
        </ThemedText>
      ) : null}

      {board && topCell ? (
        <>
          <View style={styles.board}>
            <View
              nativeID={locked && Platform.OS === 'web' ? LOCKED_GRID_ID : undefined}
              style={[styles.gridWrap, locked && styles.nativeBlur]}
              pointerEvents={locked ? 'none' : 'auto'}
              // Locked numbers are not content the account is entitled to, so they
              // are removed from the accessibility tree as well as blurred.
              // `aria-hidden` is what React Native Web actually forwards;
              // the two native props beside it are iOS/Android's spelling.
              aria-hidden={locked}
              accessibilityElementsHidden={locked}
              importantForAccessibility={locked ? 'no-hide-descendants' : 'auto'}>
              <Heatmap cells={board.cells} onSelect={locked ? undefined : onSelect} />
            </View>

            {locked ? (
              <HeatmapLockLottery
                market={lotteryType}
                onPress={() => router.push('/premium')}
              />
            ) : null}
          </View>

          {!locked && onSelect ? (
            <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
              {t('insights.heatmapHint')}
            </ThemedText>
          ) : null}

          {locked ? (
            <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
              {t('insights.heatmapLockedNote')}
            </ThemedText>
          ) : null}

          <View style={styles.legend}>
            {HEATMAP_TIERS.map((tier) => (
              <View key={tier} style={styles.legendItem}>
                <View
                  style={[styles.legendSwatch, { backgroundColor: LEGEND_COLORS[tier] }]}
                />
                <ThemedText type="small" themeColor="textMuted" style={styles.legendLabel}>
                  {t(LEGEND_KEYS[tier], { share: HEATMAP_BAND_COUNTS[tier] })}
                </ThemedText>
              </View>
            ))}
          </View>

          {/*
            What the score is, model by model. Withheld behind the lock: the
            weights are part of the same paid board, and printing them would hand
            a free reader most of what the blur is there to withhold. The legend
            stays visible because the colour scale must look identical to Thai's.
          */}
          {!locked ? (
            <View style={[styles.models, { borderTopColor: colors.cardBorder }]}>
              <ThemedText type="smallBold">{t('insights.heatmapBlend')}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.modelBody}>
                {t('insights.heatmapAdaptive', {
                  draws: HEATMAP_ACCURACY_WINDOW,
                  detail: weightDetail,
                })}
              </ThemedText>

              {HEATMAP_MODEL_ROWS.map((entry) => {
                const form = board.form.find((row) => row.model === entry.model);
                return (
                  <View key={entry.name} style={styles.modelRow}>
                    <View
                      style={[styles.modelWeight, { backgroundColor: `${colors.gold}1F` }]}>
                      <ThemedText
                        type="small"
                        style={[styles.modelWeightText, { color: colors.accent }]}>
                        {`${percents ? percents[entry.model] : 0}%`}
                      </ThemedText>
                    </View>
                    <View style={styles.modelText}>
                      <ThemedText type="smallBold">
                        {t(entry.name, { paths: formatCount(HEATMAP_SIMULATIONS) })}
                      </ThemedText>
                      <ThemedText
                        type="small"
                        themeColor="textSecondary"
                        style={styles.modelBody}>
                        {t(entry.body, { paths: formatCount(HEATMAP_SIMULATIONS) })}
                      </ThemedText>
                      {form ? (
                        <ThemedText type="small" themeColor="textMuted" style={styles.modelMeta}>
                          {t('insights.heatmapForm', {
                            draws: form.draws,
                            rank: Math.round(form.rank),
                          })}
                        </ThemedText>
                      ) : null}
                    </View>
                  </View>
                );
              })}

              <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                {t('insights.heatmapScale', {
                  probability: topCell.probability.toFixed(2),
                  high: HEATMAP_BAND_COUNTS.high,
                  medium: HEATMAP_BAND_COUNTS.medium,
                  low: HEATMAP_BAND_COUNTS.low,
                })}
              </ThemedText>
              <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                {t('insights.heatmapSample', {
                  draws: board.sample.draws,
                  from: formatLocalizedDate(board.sample.from, language),
                  to: formatLocalizedDate(board.sample.to, language),
                })}
              </ThemedText>
            </View>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The lock over a Premium market's board.
 *
 * Absolute over the grid, so the blurred cells stay exactly where they are: the
 * overlay is a lens, not a replacement panel. The CTA opens `/premium`, the one
 * place a purchase can be started — this component never runs a checkout itself.
 */
function HeatmapLockLottery({
  market,
  onPress,
}: {
  market: HeatmapMarket;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <View style={styles.lockOverlay}>
      <View
        style={[
          styles.lockCard,
          { backgroundColor: `${colors.card}F2`, borderColor: `${colors.gold}66` },
        ]}>
        <View
          style={[
            styles.lockIcon,
            { backgroundColor: `${colors.gold}1F`, borderColor: `${colors.gold}80` },
          ]}>
          <FontAwesome name="lock" size={16} color={colors.accent} />
        </View>
        <ThemedText type="smallBold" style={styles.lockTitle}>
          {t('insights.heatmapLockedTitle', {
            market: t(HEATMAP_MARKET_LABEL_KEYS[market]),
          })}
        </ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.lockBody}>
          {t('insights.heatmapLockedBody')}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('insights.heatmapLockedCta')}
          onPress={onPress}
          style={({ pressed }) => [
            styles.lockCta,
            { backgroundColor: colors.gold },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="smallBold" style={[styles.lockCtaText, { color: ON_GOLD }]}>
            {t('insights.heatmapLockedCta')}
          </ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  board: {
    marginTop: Spacing.three,
  },
  gridWrap: {
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  // Native only — React Native Web drops this property, so the web build is
  // blurred by `#superheng-heatmap-locked-grid` in `global.css` instead.
  nativeBlur: {
    filter: [{ blur: 8 }],
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  chartNote: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: Spacing.two,
  },
  pressed: {
    opacity: 0.7,
  },

  lockOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.three,
    backgroundColor: 'rgba(7, 11, 24, 0.45)',
  },
  lockCard: {
    alignItems: 'center',
    gap: Spacing.two,
    maxWidth: 320,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  lockIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
  },
  lockTitle: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  lockBody: {
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
  },
  lockCta: {
    marginTop: Spacing.one,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
  },
  lockCtaText: {
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },

  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minWidth: '46%',
  },
  legendLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    flexShrink: 1,
  },
  legendSwatch: {
    width: 14,
    height: 10,
    borderRadius: 3,
  },
  models: {
    marginTop: Spacing.three,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
  },
  modelRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  modelWeight: {
    minWidth: 40,
    alignItems: 'center',
    paddingHorizontal: Spacing.one,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  modelWeightText: {
    fontSize: 10,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  modelText: {
    flex: 1,
    gap: 1,
  },
  modelBody: {
    fontSize: 11,
    lineHeight: 16,
  },
  modelMeta: {
    fontSize: 10,
    lineHeight: 14,
    fontVariant: ['tabular-nums'],
  },
});
