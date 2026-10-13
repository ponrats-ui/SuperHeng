import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

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
import { AI_LOG, TREND_SERIES, buildHeatmap } from '@/data/mock';
import { useAppTheme } from '@/hooks/use-app-theme';
import { formatDate } from '@/lib/format';

type TrendMode = 'parity' | 'range';

const TREND_OPTIONS = [
  { key: 'parity' as const, label: 'Even / Odd' },
  { key: 'range' as const, label: 'High / Low' },
];

/** Widest layout switches to two columns. */
const TWO_COLUMN_BREAKPOINT = 760;

export default function InsightsScreen() {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const [mode, setMode] = useState<TrendMode>('parity');

  const twoColumn = width >= TWO_COLUMN_BREAKPOINT;
  const cells = buildHeatmap();

  // Chart reads oldest -> newest left to right.
  const chronological = [...TREND_SERIES].reverse();
  const series =
    mode === 'parity'
      ? [{ label: 'Odd %', color: colors.primary, values: chronological.map((p) => p.odd) }]
      : [{ label: 'High (5-9) %', color: colors.gold, values: chronological.map((p) => p.high) }];
  const xLabels = chronological.map((p) => `${p.draw}`);

  return (
    <PageScaffold maxWidth={TabletContentWidth}>
      <AppHeader
        subtitle="Deep insights"
        right={
          <View style={[styles.badge, { backgroundColor: colors.backgroundElement }]}>
            <ThemedText type="small" style={[styles.badgeText, { color: colors.textSecondary }]}>
              00–99 GRID
            </ThemedText>
          </View>
        }
      />

      <View style={twoColumn ? styles.columns : styles.stack}>
        {/* Heatmap */}
        <View style={styles.column}>
          <Card>
            <SectionHeader
              title="Probability heatmap"
              subtitle="Tap a cell to analyse that number"
            />
            <View style={styles.heatmapWrap}>
              <Heatmap
                cells={cells}
                onSelect={(code) => router.push({ pathname: '/my-number', params: { code } })}
              />
            </View>
            <View style={styles.legend}>
              <ThemedText type="small" themeColor="textMuted" style={styles.legendLabel}>
                Low
              </ThemedText>
              {[DataColors.cold, DataColors.low, DataColors.medium, DataColors.high].map((color) => (
                <View key={color} style={[styles.legendSwatch, { backgroundColor: color }]} />
              ))}
              <ThemedText type="small" themeColor="textMuted" style={styles.legendLabel}>
                High
              </ThemedText>
            </View>
          </Card>
        </View>

        {/* Charts + log */}
        <View style={styles.column}>
          <Card>
            <SectionHeader title="Trends" subtitle="Last 10 draws" />
            <View style={styles.controlRow}>
              <SegmentedControl options={TREND_OPTIONS} value={mode} onChange={setMode} />
            </View>
            <View style={styles.chartWrap}>
              <TrendChart series={series} xLabels={xLabels} height={176} />
            </View>
            <ThemedText type="small" themeColor="textMuted" style={styles.chartNote}>
              {mode === 'parity'
                ? 'Share of odd digits per draw. Spikes above 50% suggest a parity tilt.'
                : 'Share of high digits (5-9) per draw. Useful for band selection.'}
            </ThemedText>
          </Card>

          <Card>
            <SectionHeader title="AI reasoning log" subtitle="Why the model predicts what it predicts" />
            <View style={styles.logList}>
              {AI_LOG.map((entry) => {
                const tone =
                  entry.confidence === 'High'
                    ? DataColors.high
                    : entry.confidence === 'Medium'
                      ? DataColors.medium
                      : DataColors.cold;
                return (
                  <View key={entry.id} style={[styles.logItem, { borderLeftColor: tone }]}>
                    <View style={styles.logTop}>
                      <View style={[styles.logTag, { backgroundColor: `${tone}22` }]}>
                        <ThemedText type="small" style={[styles.logTagText, { color: tone }]}>
                          {entry.tag}
                        </ThemedText>
                      </View>
                      <ThemedText type="small" themeColor="textMuted" style={styles.logConfidence}>
                        {entry.confidence}
                      </ThemedText>
                    </View>
                    <ThemedText type="smallBold">{entry.headline}</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.logBody}>
                      {entry.detail}
                    </ThemedText>
                  </View>
                );
              })}
            </View>
            <ThemedText type="small" themeColor="textMuted" style={styles.logFooter}>
              Log generated {formatDate(new Date().toISOString())} · updates each draw cycle
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
  logFooter: {
    fontSize: 10,
    marginTop: Spacing.three,
  },
});
