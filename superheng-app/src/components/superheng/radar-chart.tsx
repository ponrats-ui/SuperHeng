import { StyleSheet, View } from 'react-native';

import { Segment, type Point } from '@/components/superheng/chart-primitives';
import { useAppTheme } from '@/hooks/use-app-theme';

export type RadarChartProps = {
  /** Values in the 0..1 range, one per axis. */
  values: number[];
  /** Outer diameter in px. */
  size?: number;
  /** Stroke color for the data polygon. */
  color: string;
  /** Optional axis labels rendered around the ring. */
  labels?: readonly string[];
  /** Overrides the grid + spoke color (useful on gradient surfaces). */
  gridColor?: string;
};

/**
 * Minimal radar/spider chart built entirely from Views.
 *
 * Values above 1 are clamped, so callers can pass percentages safely.
 */
export function RadarChart({ values, size = 132, color, labels, gridColor }: RadarChartProps) {
  const { colors } = useAppTheme();

  const center = size / 2;
  const maxRadius = size / 2 - (labels ? 18 : 4);
  const count = Math.max(3, values.length);

  const pointAt = (index: number, radius: number): Point => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    return {
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    };
  };

  const dataPoints = values.map((raw, index) => {
    const value = Math.max(0, Math.min(1, raw));
    return pointAt(index, maxRadius * value);
  });

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      {/* Concentric grid rings */}
      {[0.34, 0.67, 1].map((factor) => {
        const r = maxRadius * factor;
        return (
          <View
            key={factor}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: center - r,
              top: center - r,
              width: r * 2,
              height: r * 2,
              borderRadius: r,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: gridColor ?? colors.cardBorder,
            }}
          />
        );
      })}

      {/* Axis spokes */}
      {values.map((_, index) => {
        const end = pointAt(index, maxRadius);
        return (
          <Segment
            key={`spoke-${index}`}
            x1={center}
            y1={center}
            x2={end.x}
            y2={end.y}
            color={gridColor ?? colors.cardBorder}
            thickness={StyleSheet.hairlineWidth}
          />
        );
      })}

      {/* Data polygon */}
      {dataPoints.map((point, index) => {
        const next = dataPoints[(index + 1) % dataPoints.length];
        return (
          <Segment
            key={`edge-${index}`}
            x1={point.x}
            y1={point.y}
            x2={next.x}
            y2={next.y}
            color={color}
            thickness={2}
          />
        );
      })}

      {/* Data vertices */}
      {dataPoints.map((point, index) => (
        <View
          key={`dot-${index}`}
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: point.x - 3,
            top: point.y - 3,
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
