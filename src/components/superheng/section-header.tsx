import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { ThemedText } from '@/components/themed-text';
import { useAppTheme } from '@/hooks/use-app-theme';

export type SectionHeaderProps = {
  title: string;
  subtitle?: string;
  /** Rendered flush right — usually a link or compact action. */
  action?: React.ReactNode;
};

/** Title row used above each dashboard panel. */
export function SectionHeader({ title, subtitle, action }: SectionHeaderProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <View style={styles.titleRow}>
          <View style={[styles.rule, { backgroundColor: colors.primary }]} />
          <ThemedText type="smallBold" style={styles.title}>
            {title}
          </ThemedText>
        </View>
        {subtitle ? (
          <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  left: {
    flexShrink: 1,
    gap: Spacing.half,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  rule: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  title: {
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  subtitle: {
    marginLeft: Spacing.two + 3,
  },
});
