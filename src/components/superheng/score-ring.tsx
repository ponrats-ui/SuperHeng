import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useAppTheme } from '@/hooks/use-app-theme';

export type ScoreRingProps = {
  /** Heng score, 0-100. */
  score: number;
  /** Outer diameter in px. */
  size?: number;
  /** Tick thickness in px. */
  thickness?: number;
  color: string;
  /** Inactive tick color; defaults to the card border. */
  trackColor?: string;
  label?: string;
  /** Text color for the score + label; defaults to theme text. */
  textColor?: string;
};

const TICKS = 44;

/**
 * Circular gauge drawn from discrete ticks.
 *
 * Using rotated full-size layers (rather than SVG arcs) keeps this identical on
 * iOS, Android and web with zero dependencies.
 */
export function ScoreRing({
  score,
  size = 148,
  thickness = 4,
  color,
  trackColor,
  label,
  textColor,
}: ScoreRingProps) {
  const { colors } = useAppTheme();
  const clamped = Math.max(0, Math.min(100, score));
  const tickLength = Math.max(6, size * 0.1);
  const activeTicks = Math.round((clamped / 100) * TICKS);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {Array.from({ length: TICKS }, (_, index) => (
        <View
          key={index}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            StyleSheet.absoluteFill,
            styles.tickLayer,
            { transform: [{ rotate: `${(360 / TICKS) * index}deg` }] },
          ]}>
          <View
            style={{
              width: thickness,
              height: tickLength,
              borderRadius: thickness / 2,
              backgroundColor: index < activeTicks ? color : (trackColor ?? colors.cardBorder),
            }}
          />
        </View>
      ))}

      <View style={styles.center}>
        <View style={styles.scoreRow}>
          <ThemedText style={[styles.score, { color }]}>{Math.round(clamped)}</ThemedText>
          <ThemedText type="small" style={[styles.outOf, { color: textColor ?? colors.textMuted }]}>
            /100
          </ThemedText>
        </View>
        {label ? (
          <ThemedText type="small" style={[styles.label, { color: textColor ?? colors.textSecondary }]}>
            {label}
          </ThemedText>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickLayer: {
    alignItems: 'center',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 2,
  },
  score: {
    fontSize: 40,
    lineHeight: 44,
    fontWeight: '800',
    letterSpacing: -1,
  },
  outOf: {
    fontSize: 12,
  },
  label: {
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop: 2,
  },
});
