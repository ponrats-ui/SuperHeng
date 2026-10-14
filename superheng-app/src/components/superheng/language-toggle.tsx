import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { LANGUAGES, useTranslation, type Language } from '@/lib/i18n';

/** Short uppercase face for each language, as it appears on the switch. */
const FACE: Record<Language, string> = { th: 'TH', en: 'EN' };

/**
 * The TH/EN language switch.
 *
 * Two segments in one pill, in the app's existing segmented-control language, sized
 * for the header (the header already carries a status badge on the right, so this
 * has to stay small and quiet).
 *
 * Accessibility notes worth keeping:
 *
 * * The selected segment is announced with `accessibilityState.selected`, and the
 *   *other* segment carries the label of what tapping it will do ("Switch to
 *   English"), because "EN" alone tells a screen-reader user nothing about the
 *   action.
 * * `accessibilityRole="tab"` matches `SegmentedControl`, so both switchers in the
 *   app behave identically for assistive tech.
 * * The two-letter faces are deliberately **not** translated: "TH"/"EN" are the
 *   language codes a Thai or English reader both recognises, and translating them
 *   into "ไทย"/"อังกฤษ" would make the switch wider than the header allows.
 */
export function LanguageToggle() {
  const { colors } = useAppTheme();
  const { language, setLanguage, t } = useTranslation();

  return (
    <View
      accessibilityRole="tablist"
      style={[styles.container, { backgroundColor: colors.backgroundElement }]}>
      {LANGUAGES.map((option) => {
        const selected = option === language;
        return (
          <Pressable
            key={option}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={
              selected
                ? t('common.language')
                : option === 'en'
                  ? t('common.switchToEnglish')
                  : t('common.switchToThai')
            }
            onPress={() => setLanguage(option)}
            hitSlop={6}
            style={({ pressed }) => [
              styles.segment,
              selected && { backgroundColor: colors.primary },
              pressed && !selected && styles.pressed,
            ]}>
            <ThemedText
              type="small"
              style={[
                styles.label,
                { color: selected ? colors.onPrimary : colors.textMuted },
                selected && styles.labelSelected,
              ]}>
              {FACE[option]}
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
    padding: 2,
    borderRadius: Radius.pill,
    gap: 2,
  },
  segment: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    minWidth: 30,
    alignItems: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  label: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  labelSelected: {
    fontWeight: '900',
  },
});
