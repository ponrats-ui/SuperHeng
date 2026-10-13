import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, probabilityColor } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import type { HeatCell } from '@/data/mock';

export type HeatmapProps = {
  cells: HeatCell[];
  /** Called when a cell is tapped (used to jump into "My Number"). */
  onSelect?: (code: string) => void;
};

/** Converts a 0-100 probability into a 2-char hex alpha channel. */
function alphaFor(probability: number): string {
  const alpha = Math.round((0.14 + (Math.min(100, probability) / 100) * 0.8) * 255);
  return alpha.toString(16).padStart(2, '0').toUpperCase();
}

/** 10x10 grid of numbers colored by model probability. */
export function Heatmap({ cells, onSelect }: HeatmapProps) {
  const { colors } = useAppTheme();

  const rows = Array.from({ length: 10 }, (_, row) => cells.slice(row * 10, row * 10 + 10));

  return (
    <View style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((cell) => {
            const base = probabilityColor(cell.probability);
            const alpha = alphaFor(cell.probability);
            const strong = cell.probability >= 60;
            return (
              <Pressable
                key={cell.code}
                accessibilityLabel={`Number ${cell.code}, probability ${cell.probability} percent`}
                onPress={() => onSelect?.(cell.code)}
                style={({ pressed }) => [
                  styles.cell,
                  {
                    backgroundColor: `${base}${alpha}`,
                    borderColor: strong ? base : colors.cardBorder,
                  },
                  pressed && styles.pressed,
                ]}>
                <ThemedText
                  style={[styles.code, { color: strong ? '#FFFFFF' : colors.textSecondary }]}>
                  {cell.code}
                </ThemedText>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: 3,
  },
  row: {
    flexDirection: 'row',
    gap: 3,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  code: {
    fontSize: 11,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
});
