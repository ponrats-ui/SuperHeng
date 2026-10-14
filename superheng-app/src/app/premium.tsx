import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import type { ScrollView } from 'react-native';

import { Card, ModalScaffold } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/** Text color for the filled gold CTA — dark on both themes, since gold is light in each. */
const ON_GOLD = '#101422';

/**
 * Gold text uses `colors.accent`, not `colors.gold`: in the light theme `gold`
 * is the decorative #D4AF37, which measures 1.8:1 against a light surface and
 * fails WCAG AA badly. Fills and borders keep `gold`, where contrast does not
 * apply.
 */

/** The benefit list, as keys: rows re-render in the other language without remounting. */
const BENEFIT_KEYS: readonly TranslationKey[] = [
  'paywall.benefit1',
  'paywall.benefit2',
  'paywall.benefit3',
];

/**
 * Premium paywall placeholder.
 *
 * Nothing is purchasable yet: "Subscribe Now" only explains that the tier is
 * coming. Native shows the system alert the spec asks for; **React Native Web
 * does not implement `Alert`**, so on web the same message is rendered inline
 * instead — otherwise the button would silently do nothing on the web target,
 * which is the one this project actually verifies against.
 */
export default function PremiumScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [comingSoon, setComingSoon] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  function handleSubscribe() {
    if (Platform.OS === 'web') {
      setComingSoon(true);
      return;
    }
    Alert.alert(t('paywall.title'), t('paywall.comingSoon'));
  }

  // The panel is height-capped, so the confirmation can appear below the fold.
  // Reveal it rather than rendering feedback the user never sees.
  useEffect(() => {
    if (comingSoon) scrollRef.current?.scrollToEnd({ animated: true });
  }, [comingSoon]);

  return (
    <ModalScaffold eyebrow={t('paywall.eyebrow')} scrollRef={scrollRef}>
      <View style={styles.titleBlock}>
        <ThemedText style={styles.titleEmoji}>🔓</ThemedText>
        <View style={styles.titleText}>
          {/* One headline in the chosen language, not a Thai title with an English
              translation beneath it. The tint is the header text colour, which is
              what the theme's high-contrast rollover expects here. */}
          <ThemedText style={[styles.title, { color: colors.accent }]}>
            {t('paywall.title')}
          </ThemedText>
        </View>
      </View>

      <Card>
        <View style={[styles.pillRow]}>
          <View style={[styles.pill, { backgroundColor: `${colors.gold}1F` }]}>
            <ThemedText type="small" style={[styles.pillText, { color: colors.accent }]}>
              {t('paywall.comingSoonPill')}
            </ThemedText>
          </View>
        </View>
        <ThemedText style={styles.features}>{t('paywall.features')}</ThemedText>
      </Card>

      <Card>
        <ThemedText type="smallBold" themeColor="textMuted" style={styles.sectionLabel}>
          {t('paywall.benefitsTitle')}
        </ThemedText>
        <View style={styles.benefits}>
          {BENEFIT_KEYS.map((key) => (
            <View key={key} style={styles.benefitRow}>
              <ThemedText type="small" style={[styles.check, { color: colors.accent }]}>
                ✓
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.benefitText}>
                {t(key)}
              </ThemedText>
            </View>
          ))}
        </View>
      </Card>

      <Card>
        <View style={styles.priceBlock}>
          <ThemedText style={[styles.price, { color: colors.accent }]}>
            {t('paywall.price')}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.priceSub}>
            {t('paywall.priceSub')}
          </ThemedText>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('paywall.subscribeHint')}
          onPress={handleSubscribe}
          style={({ pressed }) => [
            styles.subscribe,
            { backgroundColor: colors.gold },
            pressed && styles.pressed,
          ]}>
          <ThemedText style={[styles.subscribeText, { color: ON_GOLD }]}>
            {t('paywall.subscribe')}
          </ThemedText>
        </Pressable>

        {comingSoon ? (
          <View
            accessibilityRole="alert"
            style={[
              styles.notice,
              { borderColor: `${colors.gold}66`, backgroundColor: `${colors.gold}14` },
            ]}>
            <ThemedText type="small" style={[styles.noticeText, { color: colors.accent }]}>
              {t('paywall.comingSoon')}
            </ThemedText>
          </View>
        ) : null}

        <ThemedText type="small" themeColor="textMuted" style={styles.finePrint}>
          {t('paywall.noCharge')}
        </ThemedText>
      </Card>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('paywall.dismissHint')}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        style={({ pressed }) => [styles.dismiss, pressed && styles.pressed]}>
        <ThemedText type="small" themeColor="textMuted" style={styles.dismissText}>
          {t('paywall.dismiss')}
        </ThemedText>
      </Pressable>

      <ThemedText type="small" themeColor="textMuted" style={styles.note}>
        {t('paywall.disclaimer')}
      </ThemedText>
    </ModalScaffold>
  );
}

const styles = StyleSheet.create({
  // Title -----------------------------------------------------------------
  titleBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  titleEmoji: {
    fontSize: 32,
    lineHeight: 40,
  },
  titleText: {
    flexShrink: 1,
    gap: 2,
  },
  title: {
    // Thai stacks tone marks above and vowel marks below the baseline, so the
    // default line box clips them; this needs a taller line height than Latin.
    // English copy inherits the extra height harmlessly.
    fontSize: 20,
    lineHeight: 34,
    fontWeight: '800',
  },

  // Features --------------------------------------------------------------
  pillRow: {
    flexDirection: 'row',
  },
  pill: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
  },
  features: {
    fontSize: 14,
    lineHeight: 28,
    fontWeight: '600',
    marginTop: Spacing.two,
  },

  // Benefits --------------------------------------------------------------
  sectionLabel: {
    fontSize: 10,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  benefits: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  benefitRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  check: {
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 22,
  },
  benefitText: {
    flex: 1,
    lineHeight: 22,
  },

  // Price + CTA -----------------------------------------------------------
  priceBlock: {
    alignItems: 'center',
    gap: Spacing.half,
  },
  price: {
    fontSize: 26,
    lineHeight: 40,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  priceSub: {
    fontSize: 11,
  },
  subscribe: {
    alignItems: 'center',
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    borderRadius: Radius.xl,
    marginTop: Spacing.three,
  },
  subscribeText: {
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  notice: {
    marginTop: Spacing.two,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noticeText: {
    fontSize: 12,
    lineHeight: 20,
    textAlign: 'center',
    fontWeight: '700',
  },
  finePrint: {
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
    marginTop: Spacing.three,
  },

  // Dismiss + note --------------------------------------------------------
  dismiss: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  dismissText: {
    fontSize: 12,
    textDecorationLine: 'underline',
  },
  pressed: {
    opacity: 0.7,
  },
  note: {
    fontSize: 11,
    lineHeight: 22,
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
});
