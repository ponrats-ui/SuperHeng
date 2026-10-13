import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Segment, type Point } from '@/components/superheng/chart-primitives';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type TrendSeries = {
  label: string;
  color: string;
  /** Values 0-100, oldest first. */
  values: number[];
};

export type TrendChartProps = {
  series: TrendSeries[];
  /** X-axis tick labels, one per data point. */
  xLabels: string[];
  height?: number;
};

const Y_TICKS = [0, 25, 50, 75, 100];

/**
 * Lightweight multi-series line chart built from Views.
 *
 * Placeholder for the real charts once the API is live; it measures itself via
 * `onLayout` so it stays responsive from phone to tablet.
 */
export function TrendChart({ series, xLabels, height = 170 }: TrendChartProps) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);

  const paddingLeft = 24;
  const paddingRight = 8;
  const paddingTop = 8;
  const paddingBottom = 18;

  const plotWidth = Math.max(0, width - paddingLeft - paddingRight);
  const plotHeight = Math.max(0, height - paddingTop - paddingBottom);
  const count = Math.max(1, series[0]?.values.length ?? 1);

  const toPoint = (value: number, index: number): Point => ({
    x: paddingLeft + (plotWidth * index) / Math.max(1, count - 1),
    y: paddingTop + plotHeight * (1 - Math.max(0, Math.min(100, value)) / 100),
  });

  return (
    <View style={styles.wrapper}>
      <View style={styles.legend}>
        {series.map((item) => (
          <View key={item.label} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: item.color }]} />
            <ThemedText type="small" themeColor="textSecondary" style={styles.legendLabel}>
              {item.label}
            </ThemedText>
          </View>
        ))}
      </View>

      <View style={[styles.plot, { height }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width > 0 ? (
          <>
            {/* Y grid + labels */}
            {Y_TICKS.map((tick) => {
              const y = paddingTop + plotHeight * (1 - tick / 100);
              return (
                <View key={tick}>
                  <View
                    style={{
                      position: 'absolute',
                      left: paddingLeft,
                      right: paddingRight,
                      top: y,
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: colors.cardBorder,
                    }}
                  />
                  {/* The baseline value is omitted so it cannot collide with
                      the first x-axis label. */}
                  {tick > 0 ? (
                    <ThemedText type="small" themeColor="textMuted" style={[styles.yLabel, { top: y - 6 }]}>
                      {tick}
                    </ThemedText>
                  ) : null}
                </View>
              );
            })}

            {/* Series polylines */}
            {series.map((item) => {
              const points = item.values.map((value, index) => toPoint(value, index));
              return (
                <View key={item.label}>
                  {points.slice(0, -1).map((point, index) => (
                    <Segment
                      key={`${item.label}-${index}`}
                      x1={point.x}
                      y1={point.y}
                      x2={points[index + 1].x}
                      y2={points[index + 1].y}
                      color={item.color}
                      thickness={2}
                    />
                  ))}
                  {points.map((point, index) => (
                    <View
                      key={`${item.label}-dot-${index}`}
                      style={{
                        position: 'absolute',
                        left: point.x - 3,
                        top: point.y - 3,
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors.card,
                        borderWidth: 2,
                        borderColor: item.color,
                      }}
                    />
                  ))}
                </View>
              );
            })}

            {/* X labels */}
            {xLabels.map((label, index) => {
              const point = toPoint(50, index);
              return (
                <ThemedText
                  key={label}
                  type="small"
                  themeColor="textMuted"
                  style={[styles.xLabel, { left: point.x - 12 }]}>
                  {label}
                </ThemedText>
              );
            })}
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: Spacing.two,
  },
  legend: {
    flexDirection: 'row',
    gap: Spacing.three,
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + 2,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
  },
  plot: {
    width: '100%',
    borderRadius: Radius.sm,
  },
  yLabel: {
    position: 'absolute',
    left: 0,
    width: 20,
    textAlign: 'right',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  xLabel: {
    position: 'absolute',
    bottom: 0,
    width: 24,
    textAlign: 'center',
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
});
