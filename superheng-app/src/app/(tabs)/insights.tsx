import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import {
  AppHeader,
  Card,
  HEATMAP_MARKET_LABEL_KEYS,
  HeatmapPanel,
  PageScaffold,
  SectionHeader,
  SegmentedControl,
  TrendChart,
} from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { DataColors, Radius, Spacing, TabletContentWidth } from '@/constants/theme';
import { AI_LOG, TREND_SERIES } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatLocalizedDate } from '@/lib/format';
import { HEATMAP_MARKETS, type HeatmapMarket } from '@/lib/heatmap-market';
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
  /** Which market's heat map the card is showing. Thai is the free default. */
  const [market, setMarket] = useState<HeatmapMarket>('thai');

  const twoColumn = width >= TWO_COLUMN_BREAKPOINT;

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

            {/*
              The market switcher scopes the whole card. The panel refetches the
              ledger named by the selected tab, so the tab — not a shared cache — is
              what decides which draws are modelled.
            */}
            <View
              style={styles.marketRow}
              accessibilityRole="tablist"
              accessibilityLabel={t('insights.marketFilter')}>
              <SegmentedControl
                options={HEATMAP_MARKETS.map((kind) => ({
                  key: kind,
                  label: t(HEATMAP_MARKET_LABEL_KEYS[kind]),
                }))}
                value={market}
                onChange={setMarket}
              />
            </View>

            <HeatmapPanel
              lotteryType={market}
              /*
                Tapping a cell opens `My Number`, which analyses a code against the
                Thai models. Only the Thai board may hand it a code; doing so from a
                Laos or Hanoi board would show one ledger's number under another
                ledger's analysis.
              */
              onSelect={
                market === 'thai'
                  ? (code) => router.push({ pathname: '/my-number', params: { code } })
                  : undefined
              }
            />
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
  marketRow: {
    marginTop: Spacing.three,
    alignItems: 'flex-start',
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
