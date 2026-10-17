import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';

import {
  AppHeader,
  Card,
  Heatmap,
  PageScaffold,
  SectionHeader,
  SegmentedControl,
  TrendChart,
} from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { DataColors, Radius, Spacing, TabletContentWidth } from '@/constants/theme';
import { AI_LOG, TREND_SERIES } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { getLatestDraws } from '@/lib/api';
import { apiErrorText, type ApiErrorText } from '@/lib/api-error';
import { formatCount, formatLocalizedDate } from '@/lib/format';
import {
  HEATMAP_ACCURACY_WINDOW,
  HEATMAP_BAND_COUNTS,
  HEATMAP_SIMULATIONS,
  HEATMAP_TIERS,
  MIN_HEATMAP_DRAWS,
  buildHeatmapBoard,
  weightPercents,
  type HeatmapBoard,
  type HeatmapModel,
  type HeatmapTier,
} from '@/lib/heatmap';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

type TrendMode = 'parity' | 'range';

/** Widest layout switches to two columns. */
const TWO_COLUMN_BREAKPOINT = 760;

/**
 * Where each hand-written log entry's copy lives.
 *
 * The log stays keyed by `id` in `mock.ts` while its text lives in the dictionaries,
 * because the alternative — translating in the data module — would import the i18n
 * layer into mock data and make one string unrenderable in the other language. A
 * missing id falls back to the entry's own `id`, which is visibly wrong on screen
 * rather than silently reusing another entry's words.
 */
const LOG_COPY: Record<string, { headline: TranslationKey; detail: TranslationKey }> = {
  'log-1': { headline: 'insights.log.log1.headline', detail: 'insights.log.log1.detail' },
  'log-2': { headline: 'insights.log.log2.headline', detail: 'insights.log.log2.detail' },
  'log-3': { headline: 'insights.log.log3.headline', detail: 'insights.log.log3.detail' },
  'log-4': { headline: 'insights.log.log4.headline', detail: 'insights.log.log4.detail' },
};

/**
 * The four models under the grid, in the order the copy lists them.
 *
 * Every line here describes what the code in `lib/heatmap.ts` actually does — the
 * shrinkage, the decay half-life, the simulation count. Marketing copy that outran the
 * model would be the same problem as a fake probability, only in prose.
 *
 * `label` is the short name the weight sentence uses; it stays untranslated because
 * these are model names, not prose.
 */
const HEATMAP_MODELS: readonly {
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
 * Colours here mirror `components/superheng/heatmap.tsx`; the **sizes come from the
 * board code** (`HEATMAP_BAND_COUNTS`), so "top 12" in the legend is the same 12 the
 * grid paints green. The earlier legend showed a colour ramp with no band at all, which
 * is how a quarter of the grid ended up reading as a signal.
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
  | { status: 'ready'; board: HeatmapBoard }
  | { status: 'empty' }
  | { status: 'failed'; text: ApiErrorText };

/**
 * How much ledger the board reads: the endpoint's maximum, 100 draws.
 *
 * The window is stated under the grid rather than left implicit, because the frequency
 * and transition estimates are only as wide as these draws — quoting a score without
 * its sample is the habit this screen exists to avoid.
 */
const HEATMAP_DRAW_WINDOW = 100;

const CONFIDENCE_KEYS = {
  High: 'confidence.high',
  Medium: 'confidence.medium',
  Low: 'confidence.low',
} as const satisfies Record<string, TranslationKey>;

export default function InsightsScreen() {
  const { colors } = useAppTheme();
  const { t, language } = useTranslation();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<TrendMode>('parity');
  const [heatmap, setHeatmap] = useState<HeatmapState>({ status: 'loading' });

  const twoColumn = width >= TWO_COLUMN_BREAKPOINT;

  useEffect(() => {
    let cancelled = false;

    void getLatestDraws(HEATMAP_DRAW_WINDOW, 'thai').then(
      (rows) => {
        if (cancelled) return;
        const board = buildHeatmapBoard(
          rows.map((row) => ({ date: row.date, code: row.bottomTwo }))
        );
        setHeatmap(board ? { status: 'ready', board } : { status: 'empty' });
      },
      (caught: unknown) => {
        if (cancelled) return;
        setHeatmap({ status: 'failed', text: apiErrorText(caught) });
      }
    );

    return () => {
      cancelled = true;
    };
  }, []);

  const board = heatmap.status === 'ready' ? heatmap.board : null;
  const topCell = useMemo(
    () => (board ? board.byCode[board.signals.top1] : null),
    [board]
  );

  // The weight sentence and the badges read from one table of whole numbers, so the
  // headline can never disagree with the rows under it.
  const percents = useMemo(() => (board ? weightPercents(board.weights) : null), [board]);
  const weightDetail = useMemo(() => {
    if (!board || !percents) return '';
    return [...HEATMAP_MODELS]
      .sort((a, b) => board.weights[b.model] - board.weights[a.model])
      .map((entry) => `${entry.label} ${percents[entry.model]}%`)
      .join(', ');
  }, [board, percents]);

  const trendOptions = [
    { key: 'parity' as const, label: t('insights.parity') },
    { key: 'range' as const, label: t('insights.range') },
  ];

  // Chart reads oldest -> newest left to right.
  const chronological = [...TREND_SERIES].reverse();
  const series =
    mode === 'parity'
      ? [
          {
            label: t('insights.odd'),
            color: colors.primary,
            values: chronological.map((p) => p.odd),
          },
        ]
      : [
          {
            label: t('insights.high'),
            color: colors.gold,
            values: chronological.map((p) => p.high),
          },
        ];
  const xLabels = chronological.map((p) => `${p.draw}`);

  return (
    <PageScaffold maxWidth={TabletContentWidth}>
      <AppHeader
        subtitle={t('insights.subtitle')}
        right={
          <View style={[styles.badge, { backgroundColor: colors.backgroundElement }]}>
            <ThemedText type="small" style={[styles.badgeText, { color: colors.textSecondary }]}>
              {t('insights.gridBadge')}
            </ThemedText>
          </View>
        }
      />

      <View style={twoColumn ? styles.columns : styles.stack}>
        {/* Heatmap */}
        <View style={styles.column}>
          <Card>
            <SectionHeader
              title={t('insights.heatmapTitle')}
              subtitle={t('insights.heatmapSubtitle')}
            />

            {heatmap.status === 'loading' ? (
              <View style={styles.stateRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <ThemedText type="small" themeColor="textMuted">
                  {t('insights.heatmapLoading')}
                </ThemedText>
              </View>
            ) : null}

            {heatmap.status === 'failed' ? (
              <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                {t(heatmap.text.key, heatmap.text.params)}
              </ThemedText>
            ) : null}

            {heatmap.status === 'empty' ? (
              <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                {t('insights.heatmapThin', { draws: MIN_HEATMAP_DRAWS })}
              </ThemedText>
            ) : null}

            {board && topCell ? (
              <>
                <View style={styles.heatmapWrap}>
                  <Heatmap
                    cells={board.cells}
                    onSelect={(code) => router.push({ pathname: '/my-number', params: { code } })}
                  />
                </View>
                <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                  {t('insights.heatmapHint')}
                </ThemedText>
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
                  What the score is, model by model. The weights are printed from the
                  same table the arithmetic used (`board.weights`), so the panel cannot
                  promise a blend the code did not apply. Each row also carries that
                  model's own recent form, which is the evidence behind its share.
                */}
                <View style={[styles.models, { borderTopColor: colors.cardBorder }]}>
                  <ThemedText type="smallBold">{t('insights.heatmapBlend')}</ThemedText>
                  <ThemedText
                    type="small"
                    themeColor="textSecondary"
                    style={styles.modelBody}>
                    {t('insights.heatmapAdaptive', {
                      draws: HEATMAP_ACCURACY_WINDOW,
                      detail: weightDetail,
                    })}
                  </ThemedText>

                  {HEATMAP_MODELS.map((entry) => {
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
              </>
            ) : null}
          </Card>
        </View>

        {/* Charts + log */}
        <View style={styles.column}>
          <Card>
            <SectionHeader title={t('insights.trendTitle')} subtitle={t('insights.trendSubtitle')} />
            <View style={styles.controlRow}>
              <SegmentedControl options={trendOptions} value={mode} onChange={setMode} />
            </View>
            <View style={styles.chartWrap}>
              <TrendChart series={series} xLabels={xLabels} height={176} />
            </View>
            <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
              {mode === 'parity' ? t('insights.parityNote') : t('insights.rangeNote')}
            </ThemedText>
          </Card>

          <Card>
            <SectionHeader
              title={t('insights.aiLogTitle')}
              subtitle={t('insights.aiLogSubtitle')}
            />
            <View style={styles.logList}>
              {AI_LOG.map((entry) => {
                const tone =
                  entry.confidence === 'High'
                    ? DataColors.high
                    : entry.confidence === 'Medium'
                      ? DataColors.medium
                      : DataColors.cold;
                const copy = LOG_COPY[entry.id];
                return (
                  <View key={entry.id} style={[styles.logItem, { borderLeftColor: tone }]}>
                    <View style={styles.logTop}>
                      <View style={[styles.logTag, { backgroundColor: `${tone}22` }]}>
                        <ThemedText type="small" style={[styles.logTagText, { color: tone }]}>
                          {entry.tag}
                        </ThemedText>
                      </View>
                      <ThemedText type="small" themeColor="textMuted" style={styles.logConfidence}>
                        {t(CONFIDENCE_KEYS[entry.confidence])}
                      </ThemedText>
                    </View>
                    <ThemedText type="smallBold">
                      {copy ? t(copy.headline) : entry.id}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.logBody}>
                      {copy ? t(copy.detail) : ''}
                    </ThemedText>
                  </View>
                );
              })}
            </View>
            <ThemedText type="small" themeColor="textMuted" style={styles.logSample}>
              {t('insights.aiLogSample')}
            </ThemedText>
            <ThemedText type="small" themeColor="textMuted" style={styles.logFooter}>
              {t('insights.logGenerated', {
                date: formatLocalizedDate(new Date(), language),
              })}
            </ThemedText>
          </Card>
        </View>
      </View>
    </PageScaffold>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
  },
  columns: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.three,
  },
  stack: {
    gap: Spacing.three,
  },
  column: {
    flex: 1,
    gap: Spacing.three,
  },
  heatmapWrap: {
    marginTop: Spacing.three,
  },
  stateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
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
  controlRow: {
    marginTop: Spacing.three,
    alignItems: 'flex-start',
  },
  chartWrap: {
    marginTop: Spacing.three,
  },
  chartNote: {
    fontSize: 11,
    lineHeight: 16,
    marginTop: Spacing.two,
  },
  logList: {
    gap: Spacing.three,
    marginTop: Spacing.three,
  },
  logItem: {
    borderLeftWidth: 3,
    paddingLeft: Spacing.two,
    gap: Spacing.one,
  },
  logTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  logTag: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
  },
  logTagText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  logConfidence: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  logBody: {
    lineHeight: 19,
  },
  logSample: {
    fontSize: 10,
    lineHeight: 15,
    marginTop: Spacing.three,
  },
  logFooter: {
    fontSize: 10,
    marginTop: Spacing.one,
  },
});
