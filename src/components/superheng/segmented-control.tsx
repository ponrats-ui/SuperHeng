import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type SegmentedOption<T extends string> = {
  key: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (key: T) => void;
};

/** Compact pill switcher used for ranking markets and chart ranges. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: SegmentedControlProps<T>) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundElement }]}>
      {options.map((option) => {
        const selected = option.key === value;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [
              styles.segment,
              selected && { backgroundColor: colors.primary },
              pressed && !selected && { opacity: 0.6 },
            ]}>
            <ThemedText
              type="small"
              style={[
                styles.label,
                { color: selected ? colors.onPrimary : colors.textSecondary },
                selected && styles.labelSelected,
              ]}>
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: Spacing.half,
    borderRadius: Radius.pill,
    gap: Spacing.half,
  },
  segment: {
    paddingVertical: Spacing.one + 2,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.pill,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
  labelSelected: {
    fontWeight: '700',
  },
});
