import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type SignalChipProps = {
  label: string;
  detail?: string;
  active?: boolean;
};

/** Model/engine pill, e.g. "ARIMA · Time-series drift". */
export function SignalChip({ label, detail, active = true }: SignalChipProps) {
  const { colors } = useAppTheme();

  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: active ? `${colors.primary}1A` : colors.backgroundElement,
          borderColor: active ? `${colors.primary}66` : colors.cardBorder,
        },
      ]}>
      <View
        style={[
          styles.dot,
          { backgroundColor: active ? colors.success : colors.neutral },
        ]}
      />
      <ThemedText type="small" style={styles.chipLabel}>
        {label}
      </ThemedText>
      {detail ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.chipDetail}>
          {detail}
        </ThemedText>
      ) : null}
    </View>
  );
}

export type StatTileProps = {
  label: string;
  value: string;
  hint?: string;
  color?: string;
};

/** Small labelled metric used in hero strips and summary grids. */
export function StatTile({ label, value, hint, color }: StatTileProps) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.tile, { backgroundColor: colors.backgroundElement }]}>
      <ThemedText type="small" themeColor="textMuted" style={styles.tileLabel}>
        {label}
      </ThemedText>
      <ThemedText style={[styles.tileValue, color ? { color } : undefined]}>{value}</ThemedText>
      {hint ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.tileHint}>
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one + 1,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  chipLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  chipDetail: {
    fontSize: 10,
  },
  tile: {
    flex: 1,
    minWidth: 90,
    padding: Spacing.two,
    borderRadius: Radius.md,
    gap: 2,
  },
  tileLabel: {
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  tileValue: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  tileHint: {
    fontSize: 10,
  },
});
