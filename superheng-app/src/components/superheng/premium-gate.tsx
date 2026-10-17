import { router } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { PremiumAuthForm } from '@/components/superheng/premium-auth-form';
import { LegalDisclaimer } from '@/components/superheng/legal-disclaimer';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { getCheckoutPlans, type ApiError, type CheckoutCatalogue } from '@/lib/api';
import { apiErrorText } from '@/lib/api-error';
import { useAuth } from '@/lib/auth';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/** Text color for the filled gold CTA — dark on both themes, since gold is light in each. */
const ON_GOLD = '#101422';

export type PremiumGateProps = {
  /** Rendered only when the signed-in account has an active subscription. */
  children: ReactNode;
};

/**
 * The value proposition shown above the form, in display order.
 *
 * Keys rather than strings so the list is translated at render and the TH/EN toggle
 * swaps it in place. A fifth selling point is a dictionary entry plus one line here.
 */
const FEATURE_KEYS: readonly TranslationKey[] = [
  'premium.valueMarkets',
  'premium.valueModels',
  'premium.valuePositions',
  'premium.valueRealtime',
];

/**
 * The door in front of the Premium panel — now a real one.
 *
 * REPLACES A CLIENT-SIDE PASSWORD, AND WHY THAT MATTERED
 *   This used to check a username/password pair against a digest compiled into the
 *   bundle and remember the answer in `localStorage`. `src/lib/premium-access.ts`
 *   was candid about it: the digest shipped to every visitor, and the endpoint it
 *   guarded answered unauthenticated callers, so the gate stopped a curious tester
 *   and nothing else. It is deleted.
 *
 *   Now the panel is opened by a Supabase session, and the decision is the
 *   **server's**: `/api/predict/premium` validates the bearer token and reads the
 *   account's `user_profiles` row through RLS (`backend/auth.py`). This component
 *   renders that verdict; it cannot produce one. If it gets it wrong, the request is
 *   refused anyway — which is the property the old gate could not have.
 *
 * FIVE STATES, EACH RENDERED HONESTLY
 *   1. Accounts not configured on this build — says so, rather than showing a form
 *      that could never work.
 *   2. Session still being read — a spinner, so a returning subscriber does not see
 *      the sign-in form flash before their panel appears.
 *   3. Signed out — the value proposition and the sign-in / create-account form,
 *      which is shared with the paywall (`premium-auth-form.tsx`).
 *   4. Signed in, no active subscription — who they are, what is locked, the price,
 *      and one "Upgrade to Premium" button that opens `/premium`, where the purchase
 *      actually happens. Expired reads differently from never-subscribed, because
 *      "renew" and "subscribe" are different asks.
 *   5. Signed in and entitled — the panel, plus what they are signed in as and a way
 *      out.
 *
 * ONE FUNNEL, NOT TWO
 *   This component used to run the checkout itself. `/premium` runs the same one, and
 *   it is the screen Stripe sends a customer back to, so it is the copy that survives.
 *   The gate's job is the gate: let people in, tell them what they have, and point the
 *   ones who do not at the paywall.
 *
 * The subscription state comes from `useAuth()`, which reads it from `/api/me`. This
 * component deliberately does not re-derive "is the subscription still valid" from
 * the expiry date: two implementations of that boundary is two chances to disagree,
 * and the one the API enforces is the one that counts.
 */
export function PremiumGate({ children }: PremiumGateProps) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const auth = useAuth();

  const [catalogue, setCatalogue] = useState<CheckoutCatalogue | null>(null);

  const needsCheckout = auth.signedIn && !auth.isPremium;
  /** Whether a gateway is actually connected — see `CheckoutCatalogue.live`. */
  const live = catalogue?.live === true;
  /** The live price, when the catalogue answered. Nothing is claimed without it. */
  const price = catalogue?.plans[0]
    ? `${catalogue.plans[0].amount_display} / ${t(
        catalogue.plans[0].interval === 'year' ? 'premium.perYear' : 'premium.perMonth'
      )}`
    : null;

  /**
   * Plans are fetched only when a purchase is actually on the table.
   *
   * The premium card renders on every dashboard load, so fetching the catalogue
   * unconditionally would add a request for every visitor including the ones who are
   * already subscribed. A signed-out visitor sees the value proposition; the price
   * they need is on the paywall.
   */
  useEffect(() => {
    if (!needsCheckout) return;
    let cancelled = false;

    void getCheckoutPlans().then(
      (result) => {
        if (!cancelled) setCatalogue(result);
      },
      () => {
        // Silently absent: without the catalogue the CTA stops naming card and
        // PromptPay and the price is omitted. A price list that failed to load is
        // not worth an error card over the product itself.
        if (!cancelled) setCatalogue(null);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [needsCheckout]);

  /**
   * Sends a signed-in free account to the paywall.
   *
   * The gate used to host the checkout itself and duplicate the whole flow —
   * catalogue, session creation, the `http://` refusal — that `/premium` already
   * implements. One of those copies would eventually drift, and the paywall is the
   * one Stripe returns customers to, so it is the one that keeps the flow. What
   * stays here is the decision the gate is responsible for: this account is signed
   * in and not entitled, so the way forward is the paywall.
   */
  function openPaywall() {
    router.push('/premium');
  }

  // -------------------------------------------------------------------------
  // 1. No Supabase configuration on this build
  // -------------------------------------------------------------------------
  if (!auth.configured) {
    return (
      <Panel>
        <Pill>{t('premium.lockedPill')}</Pill>
        <ThemedText style={styles.title}>{t('premium.notConfiguredTitle')}</ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
          {t('premium.notConfiguredBody')}
        </ThemedText>
      </Panel>
    );
  }

  // -------------------------------------------------------------------------
  // 2. Still reading the stored session
  // -------------------------------------------------------------------------
  if (!auth.ready) {
    return (
      <Panel>
        <View style={styles.centerRow}>
          <ActivityIndicator color={colors.primary} />
          <ThemedText type="small" themeColor="textMuted">
            {t('common.loading')}
          </ThemedText>
        </View>
      </Panel>
    );
  }

  // -------------------------------------------------------------------------
  // 5. Signed in and entitled
  // -------------------------------------------------------------------------
  if (auth.isPremium) {
    const expiry = auth.account?.subscription_expiry;
    return (
      <View style={styles.unlockedWrap}>
        {children}
        <View style={styles.accountRow}>
          <ThemedText type="small" themeColor="textMuted" style={styles.accountText}>
            {t('premium.signedInAs', { email: auth.email ?? '' })}
            {expiry ? ` · ${t('premium.activeUntil', { date: expiry.slice(0, 10) })}` : ''}
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('premium.signOut')}
            onPress={() => void auth.signOut()}
            style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
            <ThemedText type="small" style={[styles.linkText, { color: colors.accent }]}>
              {t('premium.signOut')}
            </ThemedText>
          </Pressable>
        </View>
      </View>
    );
  }

  // -------------------------------------------------------------------------
  // 3. Signed out — the form
  // -------------------------------------------------------------------------
  if (!auth.signedIn) {
    return (
      <Panel rendered={false}>
        <Pill>{t('premium.loginPill')}</Pill>
        <ThemedText style={styles.title}>{t('premium.accessTitle')}</ThemedText>
        <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
          {t('premium.accessSubtitle')}
        </ThemedText>

        <PremiumBenefits />

        <View style={[styles.divider, { backgroundColor: `${colors.gold}33` }]} />

        {/* The sign-in / create-account form is shared with the paywall at
            `/premium`, so both surfaces behave identically — see
            `premium-auth-form.tsx` for what it does and what it deliberately does
            not do. */}
        <PremiumAuthForm />

        {/*
          Directly beneath the sign-in / create-account button. This is the moment a
          visitor decides whether to engage with a paid product, so it is where the
          "statistics, not betting" statement needs to be — before the account is
          created, not only in a footer they have not scrolled to.
        */}
        <LegalDisclaimer style={styles.disclaimer} />

        <ThemedText type="small" themeColor="textMuted" style={styles.note}>
          {t('premium.gateNote')}
        </ThemedText>
      </Panel>
    );
  }

  // -------------------------------------------------------------------------
  // 4. Signed in without an active subscription
  // -------------------------------------------------------------------------
  const lapsed = auth.account?.refusal_status === 402;

  return (
    <Panel>
      <Pill>{t('premium.loginPill')}</Pill>
      <ThemedText style={styles.title}>
        {lapsed ? t('premium.lapsedTitle') : t('premium.noSubscriptionTitle')}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
        {lapsed ? t('premium.lapsedBody') : t('premium.noSubscriptionBody')}
      </ThemedText>

      {/*
        The same value proposition the signed-out card carries. It belongs here too:
        this is the reader who has an account and no subscription, so "what would I
        actually get" is the question standing between them and the upgrade button —
        and the answer used to be missing on precisely this card.
      */}
      <PremiumBenefits />

      {/*
        Signed in but the entitlement could not be read — a cold backend, or the
        `user_profiles` table not yet created. Reported as its own state rather than
        as "no subscription", because the two need different actions from the user
        and from the operator.
      */}
      {auth.accountFailure ? (
        <AccountProblem
          failure={auth.accountFailure}
          onRetry={() => void auth.refreshAccount()}
        />
      ) : null}

      {auth.account?.profile_missing ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.profileMissing}>
          {t('premium.profileMissing')}
        </ThemedText>
      ) : null}

      {/*
        The price, when the catalogue answered. Shown next to the CTA rather than on
        the paywall alone: somebody deciding whether to create an account is deciding
        whether the product is worth this number, and making them tap through to find
        out is the kind of thing that ends the session.
      */}
      {price ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.upgradePrice}>
          {price}
        </ThemedText>
      ) : null}

      {/*
        The upgrade CTA — one button, and it opens the paywall rather than starting a
        checkout from here. `/premium` is where the plan, the payment methods and
        Stripe's return URL already live, so the funnel has one destination instead of
        two that could disagree.

        The wording follows the catalogue: naming card and PromptPay is only honest
        once a gateway exists to offer them, and before that the same button says
        "Upgrade to Premium" and the paywall explains that it is not open yet.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(live ? 'premium.upgradeCta' : 'premium.upgradeCtaComingSoon')}
        onPress={openPaywall}
        style={({ pressed }) => [
          styles.upgrade,
          { backgroundColor: colors.gold },
          pressed && styles.pressed,
        ]}>
        <ThemedText style={[styles.upgradeText, { color: ON_GOLD }]}>
          {t(live ? 'premium.upgradeCta' : 'premium.upgradeCtaComingSoon')}
        </ThemedText>
      </Pressable>

      {/*
        Directly beneath the CTA, which is this branch's way forward. This is the
        moment a user decides whether to engage with a paid product, so it is where
        the "statistics, not betting" statement needs to be — before the account is
        created, not only in a footer they have not scrolled to.
      */}
      <LegalDisclaimer style={styles.disclaimer} />

      <View style={styles.accountRow}>
        <ThemedText type="small" themeColor="textMuted" style={styles.accountText}>
          {t('premium.signedInAs', { email: auth.email ?? '' })}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('premium.signOut')}
          onPress={() => void auth.signOut()}
          style={({ pressed }) => [styles.linkButton, pressed && styles.pressed]}>
          <ThemedText type="small" style={[styles.linkText, { color: colors.accent }]}>
            {t('premium.signOut')}
          </ThemedText>
        </Pressable>
      </View>
    </Panel>
  );
}

/**
 * The entitlement could not be read — reported as its own state, in Thai.
 *
 * It used to print `ApiError.message`, which is an English sentence written for a
 * developer, on a screen the rest of which is translated. The classification now
 * comes from `lib/api-error.ts`; the raw status stays visible because it is what an
 * operator looks for first.
 */
function AccountProblem({ failure, onRetry }: { failure: ApiError; onRetry: () => void }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const text = apiErrorText(failure);

  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.notice,
        { borderColor: `${colors.danger}66`, backgroundColor: `${colors.danger}14` },
      ]}>
      <ThemedText type="small" style={styles.noticeText}>
        {t('premium.accountUnreadable')}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.noticeDetail}>
        {t(text.key, text.params)}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('common.retry')}
        onPress={onRetry}
        style={({ pressed }) => [styles.retryInline, pressed && styles.pressed]}>
        <ThemedText type="small" style={[styles.linkText, { color: colors.accent }]}>
          {t('common.retry')}
        </ThemedText>
      </Pressable>
    </View>
  );
}

/**
 * The value proposition, on every locked card.
 *
 * One component rather than a copy in each branch: the signed-out card used to be the
 * only place it appeared, and the signed-in-without-a-subscription card — the one where
 * it is actually decisive — did not carry it at all. Extracting it means the two cannot
 * drift back apart.
 */
function PremiumBenefits() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <View
      style={[
        styles.value,
        { borderColor: `${colors.gold}40`, backgroundColor: `${colors.gold}0D` },
      ]}>
      <ThemedText style={[styles.valueTitle, { color: colors.accent }]}>
        {t('premium.benefitsTitle')}
      </ThemedText>
      {FEATURE_KEYS.map((key) => (
        <View key={key} style={styles.feature}>
          <View
            style={[
              styles.check,
              { borderColor: `${colors.gold}80`, backgroundColor: `${colors.gold}26` },
            ]}>
            <ThemedText type="small" style={[styles.checkMark, { color: colors.accent }]}>
              ✓
            </ThemedText>
          </View>
          <ThemedText type="small" style={styles.featureText}>
            {t(key)}
          </ThemedText>
        </View>
      ))}
    </View>
  );
}

/**
 * The gold-tinted container every locked state shares.
 *
 * `rendered` controls the glass layers rather than the border: the wash and the top
 * sheen read as "this is a purchase surface", which is right for the form and
 * wrong for "your subscription could not be checked".
 */
function Panel({ children, rendered = true }: { children: ReactNode; rendered?: boolean }) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.form, { borderColor: `${colors.gold}66`, backgroundColor: `${colors.card}F2` }]}>
      {rendered ? (
        <>
          {/*
            Glass, in layers that all degrade gracefully: a translucent fill, a faint
            gold wash, and a 1px highlight along the top edge. Plain Views rather than
            `expo-glass-effect`, which is iOS-only — a paywall that is glass on one
            platform and flat on another is worse than one that is consistently itself.
          */}
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[StyleSheet.absoluteFill, { backgroundColor: `${colors.gold}0A` }]}
          />
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.sheen, { backgroundColor: `${colors.gold}2E` }]}
          />
        </>
      ) : null}
      {children}
    </View>
  );
}

function Pill({ children }: { children: ReactNode }) {
  const { colors } = useAppTheme();

  return (
    <View style={[styles.pill, { borderColor: `${colors.gold}80`, backgroundColor: `${colors.gold}14` }]}>
      <ThemedText type="small" style={[styles.pillText, { color: colors.accent }]}>
        {children}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Radius.xl,
    borderWidth: 1,
    // Clips the wash and the sheen to the rounded corner, which is what makes the
    // translucent fill read as a pane instead of a tinted rectangle.
    overflow: 'hidden',
  },
  sheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
  },

  // Value proposition -----------------------------------------------------
  value: {
    gap: Spacing.two,
    marginTop: Spacing.one,
    padding: Spacing.three,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  valueTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  feature: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  check: {
    width: 18,
    height: 18,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    // Nudged onto the first line's optical centre rather than its box top.
    marginTop: 1,
  },
  checkMark: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
  },
  featureText: {
    flex: 1,
    fontSize: 12,
    // Thai tone and vowel marks need a taller line box than the Latin default.
    lineHeight: 20,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: Spacing.one,
  },
  pressed: {
    opacity: 0.7,
  },

  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderRadius: Radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },

  title: {
    // Thai tone and vowel marks need a taller line box than the Latin default.
    fontSize: 20,
    lineHeight: 32,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 18,
  },

  // Upgrade CTA -----------------------------------------------------------
  upgradePrice: {
    fontSize: 11,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: Spacing.one,
  },
  upgrade: {
    // 48 minimum: this is the one control on the card that has to be easy to hit.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
  },
  upgradeText: {
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 0.4,
  },

  notice: {
    gap: Spacing.one,
    padding: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noticeText: {
    fontSize: 12,
    lineHeight: 19,
    fontWeight: '700',
  },
  noticeDetail: {
    fontSize: 11,
    lineHeight: 17,
  },
  retryInline: {
    alignSelf: 'flex-start',
    paddingVertical: Spacing.one,
  },

  note: {
    fontSize: 10,
    lineHeight: 16,
  },

  disclaimer: {
    // The notice wants 16px of separation (`mt-4`). `styles.form` already applies an
    // 8px `gap`, so half of it is contributed here rather than doubling up to 24.
    marginTop: Spacing.two,
  },

  profileMissing: {
    fontSize: 11,
    lineHeight: 17,
  },

  // Signed-in footer ------------------------------------------------------
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  accountText: {
    flexShrink: 1,
    fontSize: 11,
  },
  linkButton: {
    // Tap target, not a caption: padding rather than relying on the text box.
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  linkText: {
    fontSize: 11,
    fontWeight: '700',
  },

  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.three,
  },

  unlockedWrap: {
    gap: Spacing.two,
  },
});
