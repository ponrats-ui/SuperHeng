import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { getCountdown, pad2 } from '@/lib/draw';

export type CountdownProps = {
  target: Date;
  /** Diminutive variant for compact rows. */
  compact?: boolean;
};

type Unit = { label: string; value: number };

/** Live ticking countdown to the next draw. */
export function Countdown({ target, compact = false }: CountdownProps) {
  const { colors } = useAppTheme();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const units = useMemo(() => toUnits(target, new Date(now)), [target, now]);

  return (
    <View style={styles.row}>
      {units.map((unit, index) => (
        <View key={unit.label} style={styles.unitGroup}>
          <View
            style={[
              compact ? styles.boxCompact : styles.box,
              { backgroundColor: colors.backgroundElement, borderColor: colors.cardBorder },
            ]}>
            <ThemedText
              style={[
                compact ? styles.valueCompact : styles.value,
                { color: index === 0 ? colors.primary : colors.text },
              ]}>
              {pad2(unit.value)}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textMuted" style={styles.label}>
            {unit.label}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

function toUnits(target: Date, from: Date): Unit[] {
  const { days, hours, minutes, seconds } = getCountdown(target, from);
  return [
    { label: 'DAYS', value: days },
    { label: 'HRS', value: hours },
    { label: 'MIN', value: minutes },
    { label: 'SEC', value: seconds },
  ];
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  unitGroup: {
    alignItems: 'center',
    gap: Spacing.half,
  },
  box: {
    minWidth: 46,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  boxCompact: {
    minWidth: 34,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.one,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  value: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  valueCompact: {
    fontSize: 15,
    lineHeight: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  label: {
    fontSize: 9,
    letterSpacing: 0.8,
    fontWeight: '600',
  },
});
