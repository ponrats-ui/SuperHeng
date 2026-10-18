import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import type { ScrollView } from 'react-native';

import { Card, ModalScaffold, PremiumAuthForm } from '@/components/superheng';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import {
  createCheckoutSession,
  getCheckoutPlans,
  getPaywallDiagnostics,
  isApiError,
  type CheckoutCatalogue,
  type PaywallDiagnostics,
} from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isCheckoutUrlOpenable, openCheckout, returnOrigin } from '@/lib/checkout';
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
 * The ways to pay, in display order.
 *
 * Rendered only when the catalogue reports a live gateway, so the screen never
 * advertises PromptPay on a build that has nothing to offer it with.
 */
const METHOD_KEYS: readonly TranslationKey[] = [
  'paywall.methodsCard',
  'paywall.methodsPromptPay',
];

/**
 * How long to keep re-asking the server once Stripe has sent the customer back.
 *
 * Stripe's webhook is a separate request from Stripe's servers, so it can land a
 * moment after the browser returns. Polling briefly is the difference between a
 * paying customer seeing their new subscription and seeing "not subscribed" and
 * reaching for support. Five attempts over ten seconds covers the usual case
 * without leaving a spinner up for someone whose payment actually failed.
 */
const PAYMENT_POLL_ATTEMPTS = 5;
const PAYMENT_POLL_INTERVAL_MS = 2_000;

/**
 * Premium paywall.
 *
 * "Upgrade with card or PromptPay" calls the real `POST /api/checkout/create-session`
 * and then **leaves the app** for Stripe's own hosted page. Two things follow, and
 * both are load-bearing:
 *
 * 1. **This screen never claims a payment succeeded.** Creating a session produces
 *    a URL, not money: the response is explicit that `charged` and
 *    `subscription_granted` are false, and the app does not have to be trusted to
 *    honour that — the only success wording it can show is driven by `/api/me`,
 *    which the webhook updates. Returning from Stripe is a *hint*; the redirect is
 *    what the customer's browser does on instructions from Stripe's servers, and a
 *    customer who closes the tab instead loses nothing.
 * 2. **The come-back is polled, not assumed.** Stripe's webhook can land a second
 *    or two after the browser returns, so the screen re-asks the server for a few
 *    seconds rather than showing "not subscribed" to someone who just paid. If it
 *    still has not landed, the wording stays in the present tense —
 *    "Stripe is confirming your payment" — rather than inventing an outcome.
 *
 * A half-configured deployment is honest about it. With no gateway, `checkout_url`
 * is null, the response says nothing was charged, and that message is shown as-is;
 * the payment-method block is not rendered at all, because advertising PromptPay on
 * a build that cannot offer it would be a claim the button cannot keep.
 *
 * **Half**-configured is the state that needed saying out loud, and now does:
 * `GET /api/diagnostics/paywall` reports which dependency is missing, and a
 * `degraded` answer renders a banner naming the environment variable. That exists
 * because a real deployment was silently unable to sell — a wildcard `CORS_ORIGINS`
 * with no named return origin refused every browser checkout with a 403 — and from
 * this screen that was indistinguishable from a customer deciding not to pay. It is
 * shown only when something is configured *and* something else is missing: a build
 * that never had payments set up already says "coming soon", and repeating that as a
 * warning would cry wolf on every visit.
 *
 * The price comes from `GET /api/checkout/plans` when it can be fetched, falling
 * back to the translated copy. Two prices that can disagree is the drift this
 * avoids: the number shown here and the number the server would charge have one
 * source, and the fallback only applies when the catalogue is unreachable.
 *
 * Everything is rendered inline. This used to branch on `Platform.OS` because
 * **React Native Web does not implement `Alert`** — the button would silently do
 * nothing on the web target, which is the one this project verifies against. The
 * one platform branch left is in `lib/checkout.ts`, where it belongs, and it is
 * about *navigating* rather than about how anything is drawn.
 */
export default function PremiumScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const auth = useAuth();
  // What Stripe put on the return URL. Read as a *hint* only — see the docstring:
  // the redirect is the browser doing as it was told, and the entitlement is
  // decided by the webhook.
  //
  // Both spellings are accepted on purpose: the server writes `checkout=success`
  // and `checkout=cancelled` alongside `success=true` / `cancel=true`, so a link
  // produced by either generation of the client, or a hand-written integration
  // guide's URL, lands on the same state.
  const params = useLocalSearchParams<{
    checkout?: string;
    success?: string;
    cancel?: string;
  }>();
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<CheckoutCatalogue | null>(null);
  const [diagnostics, setDiagnostics] = useState<PaywallDiagnostics | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const returningFromStripe = params.checkout === 'success' || params.success === 'true';
  const cancelledAtStripe = params.checkout === 'cancelled' || params.cancel === 'true';
  const live = catalogue?.live === true;

  // Public and cheap, but failure is silent: a missing price falls back to the
  // translated copy rather than putting an error card on the marketing screen.
  useEffect(() => {
    let cancelled = false;
    void getCheckoutPlans().then(
      (result) => {
        if (!cancelled) setCatalogue(result);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Also public and also silent on failure. An unreachable diagnostics endpoint says
  // nothing about whether a purchase would work, so it must never be what stops one —
  // this is a report, not a gate. Asked alongside the catalogue rather than inside the
  // checkout attempt, because the state it describes is visible before anyone taps.
  useEffect(() => {
    let cancelled = false;
    void getPaywallDiagnostics().then(
      (result) => {
        if (!cancelled) setDiagnostics(result);
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // `refreshAccount` is a new function whenever the session changes, so reading it
  // through a ref keeps the polling effect below from restarting every time an
  // account update arrives — which is exactly what each poll tick produces.
  const refreshAccountRef = useRef(auth.refreshAccount);
  useEffect(() => {
    refreshAccountRef.current = auth.refreshAccount;
  }, [auth.refreshAccount]);

  // Derived rather than copied into state. The return URL is an input to this
  // render, and storing it would mean an effect that sets state on mount — a second
  // render for information that was already available, which is both slower and the
  // pattern React's own guidance warns against. `notice` (from a checkout attempt)
  // still wins, because that is the user's most recent action.
  const returnNotice: TranslationKey | null = returningFromStripe
    ? 'paywall.paymentReturning'
    : cancelledAtStripe
      ? 'paywall.paymentCancelled'
      : null;
  const visibleNotice = notice ?? returnNotice;

  // The webhook may not have landed yet when the browser gets back, so ask again a
  // few times. A failure is ignored on purpose: this is a convenience, and the
  // dashboard already surfaces real account errors. Stopping early once `isPremium`
  // is true avoids five pointless requests in the common case.
  useEffect(() => {
    if (!returningFromStripe || !auth.signedIn) return;

    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      attempts += 1;
      await refreshAccountRef.current().catch(() => undefined);
      if (stopped || attempts >= PAYMENT_POLL_ATTEMPTS) return;
      timer = setTimeout(() => void poll(), PAYMENT_POLL_INTERVAL_MS);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [returningFromStripe, auth.signedIn]);

  async function handleSubscribe() {
    setDetail(null);

    if (!auth.configured) {
      setNotice('premium.notConfiguredTitle');
      return;
    }
    if (!auth.signedIn) {
      // The sign-in form lives on the dashboard's Premium card, one screen back.
      setNotice('paywall.signInRequired');
      return;
    }
    if (auth.isPremium) {
      setNotice('premium.alreadyPremium');
      return;
    }

    const plan = catalogue?.plans[0];
    if (!plan || !auth.accessToken) {
      setNotice('paywall.checkoutUnavailable');
      return;
    }

    setBusy(true);
    setNotice('premium.checkoutOpening');

    try {
      const session = await createCheckoutSession(plan.id, auth.accessToken, {
        // The browser knows its own origin — hosted deployment, preview deployment
        // and local dev server all differ, and the server cannot tell which is
        // calling. It validates whatever is sent against the same allow-list CORS
        // uses, so this is a request rather than a decision. On native there is no
        // origin and `returnOrigin()` is `undefined`, leaving the server's
        // configured default to apply.
        returnOrigin: returnOrigin(),
      });

      if (session.already_premium) {
        setNotice('premium.alreadyPremium');
        return;
      }

      const url = session.checkout_url;
      if (!url) {
        // No gateway on this server. It said so explicitly rather than failing, and
        // its own sentence is more specific than anything translated here.
        setNotice('paywall.checkoutUnavailable');
        setDetail(session.message);
        return;
      }

      if (!isCheckoutUrlOpenable(url)) {
        // Refused rather than followed: an `http://` checkout page would collect
        // card details in clear text. Nothing has been charged at this point.
        setNotice('paywall.checkoutRedirectFailed');
        setDetail(url);
        return;
      }

      // `charged` and `subscription_granted` are false here and always will be —
      // this created a payment page, it did not take a payment. There is nothing to
      // confirm yet, so the navigation *is* the feedback.
      await openCheckout(url);
    } catch (caught) {
      setNotice('paywall.checkoutFailed');
      setDetail(isApiError(caught) ? caught.message : null);
    } finally {
      setBusy(false);
    }
  }

  // The panel is height-capped, so the confirmation can appear below the fold.
  // Reveal it rather than rendering feedback the user never sees.
  useEffect(() => {
    if (visibleNotice) scrollRef.current?.scrollToEnd({ animated: true });
  }, [visibleNotice]);

  /** The live price when the catalogue answered, the translated copy otherwise. */
  const priceLabel = catalogue?.plans[0]?.amount_display ?? t('paywall.price');

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

      {/*
        The deployment's own state, when the server reports that something is
        configured and something else is missing — see the docstring. Above the offer
        rather than below it because it changes what the rest of the screen means: a
        price with no way to pay for it is the thing this is telling the reader.
      */}
      {diagnostics?.status === 'degraded' ? (
        <Card>
          <View accessibilityRole="alert" style={styles.diagHeader}>
            <View style={[styles.diagRule, { backgroundColor: colors.warning }]} />
            <ThemedText type="smallBold" style={[styles.diagTitle, { color: colors.warning }]}>
              {t('paywall.diagnosticsTitle')}
            </ThemedText>
          </View>
          <ThemedText type="small" themeColor="textSecondary" style={styles.diagBody}>
            {/* The names come from the server, so this cannot go stale when a
                variable is renamed or a fifth check is added. */}
            {t('paywall.diagnosticsBody', { missing: diagnostics.missing.join(', ') })}
          </ThemedText>
          {diagnostics.details.map((sentence) => (
            <ThemedText
              key={sentence}
              type="small"
              themeColor="textMuted"
              style={styles.diagDetail}>
              {sentence}
            </ThemedText>
          ))}
        </Card>
      ) : null}

      <Card>
        <View style={[styles.pillRow]}>
          <View style={[styles.pill, { backgroundColor: `${colors.gold}1F` }]}>
            {/* Driven by the catalogue rather than hard-coded: "coming soon" on a
                live build would understate it, and a live pill on a build with no
                gateway would promise a purchase the button cannot open. */}
            <ThemedText type="small" style={[styles.pillText, { color: colors.accent }]}>
              {t(live ? 'paywall.livePill' : 'paywall.comingSoonPill')}
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

      {/*
        How to pay. Only rendered when a gateway is connected, and only naming the
        methods the server said it would offer — the `live` flag comes from the
        catalogue, so this block appearing is itself the guarantee that the button
        below can open a real payment page.
      */}
      {live ? (
        <Card>
          <ThemedText type="smallBold" themeColor="textMuted" style={styles.sectionLabel}>
            {t('paywall.methodsTitle')}
          </ThemedText>
          <View style={styles.methods}>
            {METHOD_KEYS.map((key) => (
              <View key={key} style={styles.methodRow}>
                <ThemedText type="small" style={[styles.methodDot, { color: colors.accent }]}>
                  ●
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary" style={styles.methodText}>
                  {t(key)}
                </ThemedText>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {/*
        The way in, on the paywall itself.

        This screen is where Stripe sends a customer back after paying, and until now
        it answered a signed-out visitor with "sign in on the dashboard first" — a dead
        end on a screen they had just been sent to, with no form and no way back to one.
        The same form the Premium card uses is rendered here, so whoever lands on this
        screen can create an account or sign into one without leaving it.
      */}
      {!auth.configured ? (
        <Card>
          <ThemedText type="smallBold" themeColor="textMuted" style={styles.sectionLabel}>
            {t('premium.notConfiguredTitle')}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.authBody}>
            {t('premium.notConfiguredBody')}
          </ThemedText>
        </Card>
      ) : auth.ready && !auth.signedIn ? (
        <Card>
          <ThemedText type="smallBold" themeColor="textMuted" style={styles.sectionLabel}>
            {t('paywall.authTitle')}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.authBody}>
            {t('paywall.authBody')}
          </ThemedText>
          <View style={styles.authForm}>
            <PremiumAuthForm />
          </View>
        </Card>
      ) : null}

      <Card>
        <View style={styles.priceBlock}>
          <ThemedText style={[styles.price, { color: colors.accent }]}>
            {priceLabel}
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.priceSub}>
            {t('paywall.priceSub')}
          </ThemedText>
        </View>

        {/*
          Entitled accounts get a statement, not a button. The server would refuse a
          second purchase anyway (`already_premium`), and offering one to somebody who
          has already paid is the kind of thing that ends in a support email.
        */}
        {auth.isPremium ? (
          <View
            accessibilityRole="alert"
            style={[
              styles.notice,
              { borderColor: `${colors.gold}66`, backgroundColor: `${colors.gold}14` },
            ]}>
            <ThemedText type="small" style={[styles.noticeText, { color: colors.accent }]}>
              {t('premium.alreadyPremium')}
            </ThemedText>
          </View>
        ) : auth.signedIn ? (
          /*
            The label follows the catalogue, not the product: naming the two payment
            methods is only honest once a gateway exists to offer them. Before that,
            the same button says "Subscribe" and the tap produces the server's own
            "not open yet" sentence.

            Rendered only for a signed-in account. Signed out, there is nothing to buy
            with yet — the sign-in card above is the next step, and a purchase button
            that produced "sign in first" would be a worse answer than no button.
          */
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              live ? 'paywall.subscribeHint' : 'paywall.subscribeComingSoonHint'
            )}
            accessibilityState={{ busy }}
            disabled={busy}
            onPress={() => void handleSubscribe()}
            style={({ pressed }) => [
              styles.subscribe,
              { backgroundColor: colors.gold, opacity: busy ? 0.6 : 1 },
              pressed && styles.pressed,
            ]}>
            {busy ? (
              <ActivityIndicator color={ON_GOLD} />
            ) : (
              <ThemedText style={[styles.subscribeText, { color: ON_GOLD }]}>
                {t(live ? 'paywall.subscribe' : 'paywall.subscribeComingSoon')}
              </ThemedText>
            )}
          </Pressable>
        ) : null}

        {/*
          Rendered from the checkout answer, never from the tap. `charged` is the
          field that decides the wording, so a request that sold nothing cannot
          produce a success message.
        */}
        {visibleNotice ? (
          <View
            accessibilityRole="alert"
            style={[
              styles.notice,
              { borderColor: `${colors.gold}66`, backgroundColor: `${colors.gold}14` },
            ]}>
            <ThemedText type="small" style={[styles.noticeText, { color: colors.accent }]}>
              {t(visibleNotice)}
            </ThemedText>
            {detail ? (
              <ThemedText type="small" themeColor="textMuted" style={styles.noticeDetail}>
                {detail}
              </ThemedText>
            ) : null}
          </View>
        ) : null}

        <ThemedText type="small" themeColor="textMuted" style={styles.finePrint}>
          {t(live ? 'paywall.noCharge' : 'paywall.noChargeComingSoon')}
        </ThemedText>
      </Card>

      {/*
        Who is signed in, and the way out. Shown here as well as on the Premium card
        because this screen can be the first thing a returning customer sees: an
        account they do not recognise should be fixable without hunting for it.
      */}
      {auth.signedIn ? (
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
      ) : null}

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

  // Diagnostics banner -----------------------------------------------------
  // Laid out like the dashboard's error card (a coloured rule beside the title)
  // rather than like the gold notices below, because this is not a message about the
  // customer's payment — it is a message about the deployment.
  diagHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  diagRule: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  diagTitle: {
    letterSpacing: 0.4,
  },
  diagBody: {
    fontSize: 12,
    lineHeight: 20,
    marginTop: Spacing.two,
  },
  diagDetail: {
    fontSize: 10,
    lineHeight: 16,
    marginTop: Spacing.one,
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

  // Sign-in card ----------------------------------------------------------
  authBody: {
    fontSize: 12,
    lineHeight: 20,
    marginTop: Spacing.one,
  },
  authForm: {
    gap: Spacing.two,
    marginTop: Spacing.three,
  },

  // Signed-in row ---------------------------------------------------------
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
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  linkText: {
    fontSize: 11,
    fontWeight: '700',
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

  // Payment methods --------------------------------------------------------
  methods: {
    gap: Spacing.two,
    marginTop: Spacing.two,
  },
  methodRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  methodDot: {
    fontSize: 8,
    lineHeight: 22,
  },
  methodText: {
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
  noticeDetail: {
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: Spacing.one,
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
