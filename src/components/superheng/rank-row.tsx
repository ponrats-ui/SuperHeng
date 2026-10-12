import { StyleSheet, View } from 'react-native';

import { ProbabilityBar } from '@/components/superheng/probability-bar';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing, probabilityColor } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import type { RankEntry } from '@/data/mock';
import { formatDelta, formatRelativeDays } from '@/lib/format';

export type RankRowProps = {
  rank: number;
  entry: RankEntry;
};

/** One row of a top-5 ranking list: code, signal delta, and probability meter. */
export function RankRow({ rank, entry }: RankRowProps) {
  const { colors } = useAppTheme();
  const tone = probabilityColor(entry.score);
  const positive = entry.delta >= 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={[styles.rankBadge, { backgroundColor: colors.backgroundElement }]}>
          <ThemedText type="smallBold" style={{ color: rank <= 3 ? colors.primary : colors.textMuted }}>
            {rank}
          </ThemedText>
        </View>

        <View style={styles.info}>
          <View style={styles.codeRow}>
            <ThemedText style={styles.code}>{entry.code}</ThemedText>
            <View
              style={[
                styles.deltaChip,
                { backgroundColor: positive ? `${colors.success}22` : `${colors.danger}22` },
              ]}>
              <ThemedText
                type="small"
                style={[styles.deltaText, { color: positive ? colors.success : colors.danger }]}>
                {positive ? '▲' : '▼'} {formatDelta(entry.delta)}
              </ThemedText>
            </View>
          </View>
          <ThemedText type="small" themeColor="textMuted" style={styles.meta}>
            Heng {entry.score} · {formatRelativeDays(entry.lastSeenDays ?? 0)}
          </ThemedText>
        </View>

        <View style={[styles.scorePill, { borderColor: tone }]}>
          <ThemedText style={[styles.scoreText, { color: tone }]}>{entry.probability.toFixed(1)}%</ThemedText>
        </View>
      </View>

      <ProbabilityBar value={entry.probability} color={tone} height={5} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rankBadge: {
    width: 26,
    height: 26,
    borderRadius: Radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  codeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  code: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '800',
    letterSpacing: 1,
    fontVariant: ['tabular-nums'],
  },
  deltaChip: {
    paddingHorizontal: Spacing.one + 2,
    paddingVertical: 1,
    borderRadius: Radius.sm,
  },
  deltaText: {
    fontSize: 10,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  meta: {
    fontSize: 11,
  },
  scorePill: {
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    minWidth: 58,
    alignItems: 'center',
  },
  scoreText: {
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
