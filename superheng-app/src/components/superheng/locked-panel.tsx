import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export type LockedPanelProps = {
  /** Small uppercase tier label, e.g. "3-DIGIT". */
  badge: string;
  /** Thai headline for the locked tier, e.g. "3 ตัว". */
  title: string;
  /** One-line explanation of what sits behind the lock. */
  subtitle: string;
  /** How many masked glyph slots to preview — 3 for a 3-digit code, 6 for a 6-digit one. */
  digits: number;
  onPress: () => void;
};

/**
 * A "locked" premium tier teaser.
 *
 * Deliberately does **not** render placeholder digits. A ghosted fake number is
 * indistinguishable from a real prediction at a glance, and this app never shows
 * a score it cannot stand behind — so the preview is masked glyphs only, and the
 * locked state is carried by the padlock, the frost and the CTA rather than by
 * implying content that does not exist yet.
 *
 * The `filter` blur is a progressive enhancement: React Native Web drops it
 * entirely (verified — react-native-web 0.21 has no `filter` in its style
 * compiler, so the computed value is `none`), which means the frosted scrim is
 * what actually guarantees the locked appearance. Same belt-and-braces approach
 * as the hero gradient.
 *
 * **Text uses `colors.accent`, not `colors.gold`.** They differ in the light
 * theme: `gold` is the decorative #D4AF37 (1.8:1 on a light surface — far below
 * WCAG AA) while `accent` is the darker goldDeep intended for text. Fills and
 * borders still use `gold`, where contrast does not apply.
 */
export function LockedPanel({ badge, title, subtitle, digits, onPress }: LockedPanelProps) {
  const { colors } = useAppTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} — ปลดล็อกด้วย Premium`}
      accessibilityHint="เปิดหน้าต่างสมัครสมาชิก Premium"
      onPress={onPress}
      style={({ pressed }) => [
        styles.panel,
        { borderColor: `${colors.gold}66`, backgroundColor: colors.backgroundElement },
        pressed && styles.pressed,
      ]}>
      <View style={styles.head}>
        <View style={[styles.badge, { borderColor: `${colors.gold}80` }]}>
          <ThemedText type="small" style={[styles.badgeText, { color: colors.accent }]}>
            {badge}
          </ThemedText>
        </View>
        <View style={[styles.lockPill, { backgroundColor: `${colors.gold}1F` }]}>
          <ThemedText type="small" style={[styles.lockText, { color: colors.accent }]}>
            🔒 PREMIUM
          </ThemedText>
        </View>
      </View>

      <ThemedText style={styles.title}>{title}</ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
        {subtitle}
      </ThemedText>

      {/* Masked preview. Decorative, so it is hidden from assistive tech. */}
      <View
        style={styles.previewWrap}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        <View style={styles.preview}>
          {Array.from({ length: digits }, (_, index) => (
            <View
              key={index}
              style={[
                styles.glyph,
                { borderColor: `${colors.gold}59`, backgroundColor: colors.card },
              ]}
            />
          ))}
        </View>
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.frost, { backgroundColor: `${colors.card}A6` }]}
        />
      </View>

      <View style={[styles.footer, { borderTopColor: colors.cardBorder }]}>
        <ThemedText type="small" style={[styles.cta, { color: colors.accent }]}>
          ปลดล็อกเพื่อดูการวิเคราะห์
        </ThemedText>
        <ThemedText type="small" style={[styles.arrow, { color: colors.accent }]}>
          →
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: Spacing.half,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.7,
  },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  badge: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 1,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  lockPill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
  },
  lockText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },

  title: {
    // Thai tone and vowel marks need a taller line box than the Latin default.
    fontSize: 18,
    lineHeight: 30,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 18,
  },

  previewWrap: {
    marginTop: Spacing.two,
    marginBottom: Spacing.two,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  preview: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Spacing.one + 2,
    // Blur is cosmetic only; the scrim below is the real lock treatment.
    filter: [{ blur: 3 }],
  },
  glyph: {
    width: 30,
    height: 40,
    borderRadius: Radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  frost: {
    borderRadius: Radius.md,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingTop: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  cta: {
    fontSize: 12,
    fontWeight: '700',
  },
  arrow: {
    fontSize: 14,
    fontWeight: '700',
  },
});
