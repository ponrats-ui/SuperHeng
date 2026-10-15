import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTranslation } from '@/lib/i18n';

export type LegalDisclaimerProps = {
  /**
   * Outer spacing, supplied by the call site rather than baked in here.
   *
   * The two surfaces this renders on separate it from their neighbours differently —
   * the paywall adds its own margin, the page footer relies on the scaffold's flex
   * `gap` — and a margin inside the component would be *added* to whichever spacing
   * the parent already applies instead of defining it once.
   */
  style?: StyleProp<TextStyle>;
};

/**
 * The app's legal notice: this is a statistical analysis tool, not a gambling
 * platform.
 *
 * Rendered in two places — the footer of every main screen, and directly beneath the
 * call to action on the premium paywall — from a single dictionary key, so the Thai
 * and English builds cannot fall out of step with each other, and neither can fall
 * out of step with the wording that was actually reviewed.
 *
 * ## Styling
 *
 * The brief specified Tailwind classes (`text-xs text-muted-foreground text-center
 * mt-4`, `text-gray-400`). **This app has no Tailwind and no NativeWind** — it is
 * Expo / React Native, styled with `StyleSheet` and the `Colors` palette, and the one
 * `.css` file in the tree only declares font stacks. So the same intent is expressed
 * in the tokens every other component uses, class by class:
 *
 * | Tailwind | Here |
 * |---|---|
 * | `text-xs` | `fontSize: 12` |
 * | `text-center` | `textAlign: 'center'` |
 * | `text-gray-400` / `text-muted-foreground` | `themeColor="textMuted"` |
 * | `mt-4` | `Spacing.three` (16px) at the call site |
 *
 * `text-gray-400` and `text-muted-foreground` are deliberately *not* a literal grey.
 * A hard-coded hex would be legible in one theme and invisible in the other, whereas
 * `textMuted` is the palette's own second-tier text colour and resolves per scheme.
 *
 * ## Why the line height is not Tailwind's
 *
 * `text-xs` pairs with a 16px line box. This uses 20px instead: Thai stacks vowel and
 * tone marks above the base character, and at 12px a 16px line box clips them — the
 * same reason `featureText` in `premium-gate.tsx` and `copyright` in `about.tsx`
 * already set an explicit line height at small sizes.
 */
export function LegalDisclaimer({ style }: LegalDisclaimerProps) {
  const { t } = useTranslation();

  return (
    <ThemedText type="small" themeColor="textMuted" style={[styles.notice, style]}>
      {t('legal.disclaimer')}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  notice: {
    // Smaller than the 14px `small` body type this inherits from, so it reads as a
    // notice rather than as content, but still legible for the Thai script.
    fontSize: 12,
    lineHeight: 20,
    textAlign: 'center',
  },
});
