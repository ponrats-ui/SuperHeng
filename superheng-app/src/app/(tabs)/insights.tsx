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
  HEATMAP_SIMULATIONS,
  HEATMAP_WEIGHTS,
  MIN_HEATMAP_DRAWS,
  buildHeatmapBoard,
  type HeatmapBoard,
  type HeatmapModel,
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
 * The four models under the grid, in the order the weights are listed.
 *
 * Every line here describes what the code in `lib/heatmap.ts` actually does — the
 * shrinkage, the decay half-life, the simulation count. Marketing copy that outran the
 * model would be the same problem as a fake probability, only in prose.
 */
const HEATMAP_MODELS: readonly {
  model: HeatmapModel;
  name: TranslationKey;
  body: TranslationKey;
}[] = [
  {
    model: 'markov',
    name: 'insights.heatmapMarkovName',
    body: 'insights.heatmapMarkovBody',
  },
  {
    model: 'frequency',
    name: 'insights.heatmapFrequencyName',
    body: 'insights.heatmapFrequencyBody',
  },
  {
    model: 'momentum',
    name: 'insights.heatmapMomentumName',
    body: 'insights.heatmapMomentumBody',
  },
  {
    model: 'montecarlo',
    name: 'insights.heatmapMontecarloName',
    body: 'insights.heatmapMontecarloBody',
  },
];

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
                  <ThemedText type="small" themeColor="textMuted" style={styles.legendLabel}>
                    {t('insights.legendLow')}
                  </ThemedText>
                  {[DataColors.cold, DataColors.low, DataColors.medium, DataColors.high].map(
                    (color) => (
                      <View
                        key={color}
                        style={[styles.legendSwatch, { backgroundColor: color }]}
                      />
                    )
                  )}
                  <ThemedText type="small" themeColor="textMuted" style={styles.legendLabel}>
                    {t('insights.legendHigh')}
                  </ThemedText>
                </View>

                {/*
                  What the score is, model by model. The weights are printed from the
                  same table the arithmetic uses (`HEATMAP_WEIGHTS`), so the panel cannot
                  promise a blend the code does not apply.
                */}
                <View style={[styles.models, { borderTopColor: colors.cardBorder }]}>
                  <ThemedText type="smallBold">{t('insights.heatmapBlend')}</ThemedText>
                  {HEATMAP_MODELS.map((model) => (
                    <View key={model.name} style={styles.modelRow}>
                      <View style={[styles.modelWeight, { backgroundColor: `${colors.gold}1F` }]}>
                        <ThemedText
                          type="small"
                          style={[styles.modelWeightText, { color: colors.accent }]}>
                          {`${Math.round(HEATMAP_WEIGHTS[model.model] * 100)}%`}
                        </ThemedText>
                      </View>
                      <View style={styles.modelText}>
                        <ThemedText type="smallBold">
                          {t(model.name, { paths: formatCount(HEATMAP_SIMULATIONS) })}
                        </ThemedText>
                        <ThemedText
                          type="small"
                          themeColor="textSecondary"
                          style={styles.modelBody}>
                          {t(model.body, { paths: formatCount(HEATMAP_SIMULATIONS) })}
                        </ThemedText>
                      </View>
                    </View>
                  ))}

                  <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
                    {t('insights.heatmapScale', {
                      probability: topCell.probability.toFixed(2),
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
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  legendLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  legendSwatch: {
    width: 22,
    height: 8,
    borderRadius: 4,
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
