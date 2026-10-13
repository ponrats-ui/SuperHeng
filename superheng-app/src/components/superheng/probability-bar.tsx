import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { DataColors, Spacing, probabilityColor } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type ProbabilityBarProps = {
  /** Probability 0-100. */
  value: number;
  /** Bar height in px. */
  height?: number;
  /** Overrides the tone-derived color. */
  color?: string;
  /** Renders the percentage to the right of the track. */
  showValue?: boolean;
};

/** Horizontal probability meter, colored by signal strength. */
export function ProbabilityBar({
  value,
  height = 6,
  color,
  showValue = false,
}: ProbabilityBarProps) {
  const { colors } = useAppTheme();
  const clamped = Math.max(0, Math.min(100, value));
  const fill = color ?? probabilityColor(clamped);

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.track,
          { height, borderRadius: height / 2, backgroundColor: colors.backgroundElement },
        ]}>
        <View
          style={{
            width: `${clamped}%`,
            height: '100%',
            borderRadius: height / 2,
            backgroundColor: fill,
          }}
        />
      </View>
      {showValue ? (
        <ThemedText type="small" style={[styles.value, { color: colors.textSecondary }]}>
          {clamped.toFixed(1)}%
        </ThemedText>
      ) : null}
    </View>
  );
}

/** Tone color helper re-exported for callers that render their own meters. */
export const signalColors = DataColors;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flex: 1,
  },
  track: {
    flex: 1,
    overflow: 'hidden',
    minWidth: 40,
  },
  value: {
    fontVariant: ['tabular-nums'],
    minWidth: 44,
    textAlign: 'right',
    fontSize: 12,
  },
});
