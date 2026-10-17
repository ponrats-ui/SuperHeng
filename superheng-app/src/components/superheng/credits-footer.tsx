import { FontAwesome } from '@expo/vector-icons';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/** The brand marks the credit links are drawn with, as `FontAwesome` glyph names. */
type ContactId = 'github' | 'facebook';

/**
 * Who made this, and where to reach them.
 *
 * The URLs live here rather than in the dictionaries: a link target is not copy, and
 * putting it in `th.ts`/`en.ts` would let the two languages drift onto different
 * profiles. Only the label and the spoken description are translated.
 */
const CONTACTS: readonly {
  id: ContactId;
  url: string;
  /** Visible button label — a model/brand name, so it reads the same in both locales. */
  label: string;
  /** Spoken description, which does need translating. */
  a11yKey: TranslationKey;
}[] = [
  {
    id: 'github',
    url: 'https://github.com/ponrats-ui/SuperHeng',
    label: 'GitHub',
    a11yKey: 'credits.githubA11y',
  },
  {
    id: 'facebook',
    url: 'https://www.facebook.com/phl.ratn.sa.ri.phanthu/?locale=th_TH',
    label: 'Facebook',
    a11yKey: 'credits.facebookA11y',
  },
];

/**
 * Opens a profile link.
 *
 * Web gets a normal new tab (`Linking.openURL` is `window.open(..., '_blank', 'noopener')`
 * on React Native Web), because a footer credit should behave like every other link on
 * the web. Native gets the **in-app browser** instead of kicking the reader out to
 * Safari or Chrome: there is a close button, and coming back to the app does not depend
 * on the user finding their way back from another app.
 *
 * `ExternalLink` in this repo would have been the obvious reuse, but it is unused
 * scaffolding from the Expo template: without `asChild` it renders a `Text`, and its
 * click path routes through Expo Router's internal navigation, which is the wrong
 * machinery for a third-party URL. A press handler that does the one thing a link does
 * is smaller than the component it would replace.
 */
async function openContact(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    await Linking.openURL(url);
    return;
  }
  await openBrowserAsync(url, {
    presentationStyle: WebBrowserPresentationStyle.AUTOMATIC,
  });
}

/**
 * One interactive profile link: an icon plus its name in a pill.
 *
 * Hover highlight is web-and-pointer only (React Native's `onHoverIn`/`onHoverOut` never
 * fire on touch), so the pressed state carries the same feedback — a touch user sees the
 * highlight on press, a mouse user sees it on hover, and neither sees a dead control.
 * The colour change is a tint plus a border, not a background fill: the point of this
 * footer is to sit quietly under the content until someone reaches for it.
 */
function ContactLink({
  id,
  url,
  label,
  a11yKey,
}: {
  id: ContactId;
  url: string;
  label: string;
  a11yKey: TranslationKey;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t(a11yKey)}
      onPress={() => {
        void openContact(url);
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={Spacing.two}
      style={({ pressed }) => {
        const active = hovered || pressed;
        return [
          styles.contact,
          {
            borderColor: active ? colors.primary : colors.cardBorder,
            backgroundColor: active ? `${colors.primary}1A` : colors.backgroundElement,
          },
          pressed && styles.pressed,
        ];
      }}>
      <FontAwesome
        name={id}
        size={15}
        color={hovered ? colors.primary : colors.textSecondary}
      />
      <ThemedText
        type="small"
        style={[styles.contactLabel, { color: hovered ? colors.primary : colors.textSecondary }]}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

/**
 * Developer credit and contact links, at the foot of every main screen.
 *
 * ## Why it renders here
 *
 * It is drawn by `PageScaffold`, next to `LegalDisclaimer`, for the same reason that
 * notice is: every main screen already goes through the scaffold, so the credit cannot
 * be forgotten on the next screen somebody adds. `about`, `donate` and `premium` render
 * through `ModalScaffold` instead and are excluded — `about` already carries its own
 * copyright footer, and stacking this under a paywall would trade trust for clutter.
 *
 * ## Styling
 *
 * The brief asked for "slate-400". That is a literal hex, and a literal hex is legible
 * in one theme and invisible in the other — the same trap `legal-disclaimer.tsx`
 * documents. `textSecondary` is the palette's own second-tier text colour and resolves
 * per scheme (dark `#A7AFC2`, light `#5B6478`), which is what "subtle but readable"
 * actually means in a two-theme app. `textMuted` is a step below and would read as
 * disabled next to the interactive pills.
 *
 * Line height is 22px rather than the 16px a 12px font would normally take: Thai stacks
 * vowel and tone marks above and below the baseline, and a tight box clips them. The
 * founder's Thai name is in the Thai dictionary for that reason, so the line is set in
 * the script it is written in.
 */
export function CreditsFooter() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <View style={styles.container}>
      <View style={[styles.divider, { backgroundColor: colors.cardBorder }]} />

      <ThemedText type="small" themeColor="textSecondary" style={styles.credit}>
        {t('credits.developedBy', { name: t('credits.name') })}
      </ThemedText>

      <View style={styles.links}>
        {CONTACTS.map((contact) => (
          <ContactLink
            key={contact.id}
            id={contact.id}
            url={contact.url}
            label={contact.label}
            a11yKey={contact.a11yKey}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingTop: Spacing.one,
  },
  divider: {
    width: 56,
    height: StyleSheet.hairlineWidth,
  },
  credit: {
    fontSize: 12,
    lineHeight: 22,
    textAlign: 'center',
  },
  links: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  contact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  contactLabel: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.7,
  },
});
