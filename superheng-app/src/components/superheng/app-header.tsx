import { StyleSheet, View } from 'react-native';

import { LanguageToggle } from '@/components/superheng/language-toggle';
import { ThemedText } from '@/components/themed-text';
import { Brand, Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type AppHeaderProps = {
  subtitle?: string;
  /** Trailing content, usually a live badge or an action button. */
  right?: React.ReactNode;
};

/**
 * Branded screen header: monogram + wordmark + optional trailing slot.
 *
 * The **language switch lives here**, not in each screen: it belongs on every tab,
 * and four copies of it would drift — one screen would eventually be added without
 * it. The wordmark and monogram are deliberately not translated; "SuperHeng" is the
 * product name and reads the same in both languages.
 */
export function AppHeader({ subtitle, right }: AppHeaderProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.container}>
      <View style={styles.identity}>
        <View style={styles.monogram}>
          <ThemedText style={styles.monogramText}>H</ThemedText>
        </View>
        <View style={styles.identityText}>
          <View style={styles.wordmarkRow}>
            <ThemedText style={styles.wordmark}>Super</ThemedText>
            <ThemedText style={[styles.wordmark, { color: colors.gold }]}>Heng</ThemedText>
          </View>
          {subtitle ? (
            <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
              {subtitle}
            </ThemedText>
          ) : null}
        </View>
      </View>

      <View style={styles.trailing}>
        {right}
        <LanguageToggle />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  identityText: {
    flexShrink: 1,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 0,
  },
  monogram: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Brand.crimson,
    alignItems: 'center',
    justifyContent: 'center',
    experimental_backgroundImage: `linear-gradient(135deg, ${Brand.crimsonBright}, ${Brand.crimsonDeep})`,
  },
  monogramText: {
    color: Brand.goldBright,
    fontSize: 20,
    fontWeight: '900',
  },
  wordmarkRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  wordmark: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 11,
    letterSpacing: 0.4,
  },
});
