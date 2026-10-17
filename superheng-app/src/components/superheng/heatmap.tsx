import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { DataColors, Radius } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { type HeatmapCell, type HeatmapTier } from '@/lib/heatmap';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

export type HeatmapProps = {
  cells: HeatmapCell[];
  /** Called when a cell is tapped (used to jump into "My Number"). */
  onSelect?: (code: string) => void;
};

/**
 * Band → colour.
 *
 * Deliberately **not** `probabilityColor(score)`: that helper bands a 0-100 score by
 * absolute thresholds (75/55/35), which is what put a quarter of this grid in green.
 * Here the band is a quota assigned by `lib/heatmap.ts`, and the colour simply reports
 * which quota a cell landed in. The two must stay separate or the grid quietly goes
 * back to threshold banding.
 */
const TIER_COLORS: Record<HeatmapTier, string> = {
  high: DataColors.high,
  medium: DataColors.medium,
  low: DataColors.low,
  ignore: DataColors.cold,
};

const BAND_KEYS = {
  high: 'heatmap.bandHigh',
  medium: 'heatmap.bandMedium',
  low: 'heatmap.bandLow',
  ignore: 'heatmap.bandIgnore',
} as const satisfies Record<HeatmapTier, TranslationKey>;

/**
 * Converts a cell's 0-100 score into a 2-char hex alpha channel.
 *
 * Shading stays continuous inside a band so the grid is still readable as a heatmap,
 * while the *hue* — the thing a reader acts on — is a strict quota.
 */
function alphaFor(score: number): string {
  const alpha = Math.round((0.14 + (Math.min(100, score) / 100) * 0.8) * 255);
  return alpha.toString(16).padStart(2, '0').toUpperCase();
}

/** 10x10 grid of numbers coloured by quota band, shaded by percentile. */
export function Heatmap({ cells, onSelect }: HeatmapProps) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  const rows = Array.from({ length: 10 }, (_, row) => cells.slice(row * 10, row * 10 + 10));

  return (
    <View style={styles.grid}>
      {rows.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((cell) => {
            const base = TIER_COLORS[cell.tier];
            const strong = cell.tier === 'high';
            return (
              <Pressable
                key={cell.code}
                accessibilityLabel={t('heatmap.cellA11y', {
                  code: cell.code,
                  rank: cell.rank,
                  band: t(BAND_KEYS[cell.tier]),
                })}
                onPress={() => onSelect?.(cell.code)}
                style={({ pressed }) => [
                  styles.cell,
                  {
                    backgroundColor: `${base}${alphaFor(cell.score)}`,
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
