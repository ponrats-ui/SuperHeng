import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { useAuth, type AuthErrorCode } from '@/lib/auth';
import { useTranslation, type TranslationKey } from '@/lib/i18n';

/**
 * The one sign-in / create-account form, shared by every surface that needs it.
 *
 * WHY IT IS ITS OWN COMPONENT
 *   Two screens need to let somebody sign in: the Premium card on the dashboard
 *   (`PremiumGate`) and the paywall at `/premium`, which is where Stripe sends a
 *   customer back after paying. Both used to reach for this differently — the gate
 *   had the form, and the paywall had no way in at all, so a customer who returned
 *   to `/premium` with an expired session was told to "sign in on the dashboard"
 *   with no way to do it. One form, two placements, one set of behaviours to keep
 *   correct.
 *
 * WHY THE MODE IS A RADIO GROUP AND NOT A LINK
 *   The mode changes what the submit button *does*: `signIn` exchanges an existing
 *   account, `register` creates one. A sign-in form that silently registered an
 *   account would be the worst possible surprise, so the choice is a visible
 *   two-option control with the current one selected, and the submit button is
 *   labelled with the same word that is selected.
 *
 * WHAT HAPPENS AFTER A SUCCESSFUL SIGN-IN
 *   Nothing here, deliberately. Entitlement is read by `AuthProvider`, which is
 *   subscribed to Supabase's own auth events: signing in publishes a session event,
 *   the provider defers a `GET /api/me` out of the auth client's lock, and the
 *   account — `subscription_tier`, `is_premium`, `refusal_status` — arrives as new
 *   context. This component must not call `refreshAccount()` itself: the provider's
 *   callback would still be holding its previous session at that moment, so the
 *   read would go out with a stale (or absent) token and clear the account it just
 *   fetched. The tier check is immediate because every surface re-renders from that
 *   one context.
 */
export function PremiumAuthForm() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const auth = useAuth();

  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** A code plus the raw text, so an unknown failure still says something real. */
  const [failure, setFailure] = useState<{ code: AuthErrorCode; message: string } | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);

  async function submit() {
    const address = email.trim();
    if (!address || !password) {
      setFailure({ code: 'invalid_email', message: '' });
      return;
    }
    if (mode === 'register' && password.length < MIN_PASSWORD_LENGTH) {
      setFailure({ code: 'weak_password', message: '' });
      return;
    }

    setSubmitting(true);
    setFailure(null);
    setNotice(null);

    if (mode === 'signIn') {
      const result = await auth.signIn(address, password);
      setSubmitting(false);
      if (result) {
        setFailure({ code: result.code, message: result.message });
        return;
      }
      // Never keep the password in memory once it has been exchanged for a session.
      setPassword('');
      return;
    }

    const result = await auth.signUp(address, password);
    setSubmitting(false);
    if (result.failure) {
      setFailure({ code: result.failure.code, message: result.failure.message });
      return;
    }

    setPassword('');
    if (result.needsConfirmation) {
      // The account exists and the user is not in it yet. Saying "signed in" here
      // would be false, and the panel below would look broken.
      setNotice('premium.checkEmail');
      setMode('signIn');
    }
  }

  function failureText(): string | null {
    if (!failure) return null;
    // An empty `message` means the check was local (an empty field, a short
    // password) and there is no server sentence to prefer over the translation.
    if (!failure.message) return t(AUTH_ERROR_KEYS[failure.code]);
    const translated = t(AUTH_ERROR_KEYS[failure.code]);
    return failure.code === 'unknown' ? failure.message : translated;
  }

  return (
    <>
      {/* Two radio-style buttons rather than a link: the mode changes what the
          submit button does, and a sign-in form that silently registers an
          account would be the worst possible surprise. */}
      <View accessibilityRole="radiogroup" style={styles.modeRow}>
        {MODE_OPTIONS.map((option) => {
          const selected = option.key === mode;
          return (
            <Pressable
              key={option.key}
              accessibilityRole="radio"
              // `aria-checked` rather than `accessibilityState={{ selected }}`: a
              // radio's state attribute is `aria-checked`, `selected` maps to
              // `aria-selected`, and react-native-web emits neither from
              // `accessibilityState` on this element — so both options were
              // announced as unselected whichever one was active. The `aria-*` form
              // is understood by RN on native and passed through on web.
              aria-checked={selected}
              accessibilityLabel={t(option.labelKey)}
              onPress={() => {
                setMode(option.key);
                setFailure(null);
                setNotice(null);
              }}
              style={({ pressed }) => [
                styles.modeButton,
                {
                  borderColor: selected ? colors.primary : colors.cardBorder,
                  backgroundColor: selected ? `${colors.primary}1F` : 'transparent',
                },
                pressed && styles.pressed,
              ]}>
              <ThemedText
                type="smallBold"
                style={[styles.modeText, selected ? { color: colors.primary } : undefined]}>
                {t(option.labelKey)}
              </ThemedText>
            </Pressable>
          );
        })}
      </View>

      <Field
        label={t('premium.email')}
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="next"
      />
      <Field
        label={t('premium.newPassword')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
        textContentType={mode === 'register' ? 'newPassword' : 'password'}
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        hint={mode === 'register' ? t('premium.passwordHint') : undefined}
      />

      {failureText() ? (
        <ThemedText
          type="small"
          accessibilityLiveRegion="polite"
          style={[styles.error, { color: colors.danger }]}>
          {failureText()}
        </ThemedText>
      ) : null}

      {notice ? (
        <View
          accessibilityRole="alert"
          style={[styles.notice, { borderColor: `${colors.gold}66`, backgroundColor: `${colors.gold}14` }]}>
          <ThemedText type="small" style={[styles.noticeText, { color: colors.accent }]}>
            {t(notice)}
          </ThemedText>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={mode === 'signIn' ? t('premium.modeSignIn') : t('premium.modeRegister')}
        accessibilityState={{ busy: submitting }}
        disabled={submitting}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.submit,
          { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 },
          pressed && styles.pressed,
        ]}>
        {submitting ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <ThemedText type="smallBold" style={[styles.submitText, { color: colors.onPrimary }]}>
            {mode === 'signIn' ? t('premium.modeSignIn') : t('premium.modeRegister')}
          </ThemedText>
        )}
      </Pressable>
    </>
  );
}

/**
 * Supabase's own errors, as translated copy.
 *
 * The library reports failures as English sentences written for developers
 * ("Invalid login credentials"). Rendering those in a Thai UI would be a visible
 * regression from the hand-written copy this replaces, so the message is mapped to
 * a code in `lib/auth.tsx` and translated here. An unrecognised code falls back to
 * the server's sentence, which is more useful than a generic apology when something
 * genuinely unexpected happened.
 */
const AUTH_ERROR_KEYS: Record<AuthErrorCode, TranslationKey> = {
  unconfigured: 'premium.authError.unconfigured',
  invalid_credentials: 'premium.authError.invalidCredentials',
  email_not_confirmed: 'premium.authError.emailNotConfirmed',
  already_registered: 'premium.authError.alreadyRegistered',
  weak_password: 'premium.authError.weakPassword',
  rate_limited: 'premium.authError.rateLimited',
  invalid_email: 'premium.authError.invalidEmail',
  network: 'premium.authError.network',
  unknown: 'premium.authError.unknown',
};

/** Matches Supabase's default minimum. Checked here so the error is instant. */
const MIN_PASSWORD_LENGTH = 6;

const MODE_OPTIONS = [
  { key: 'signIn' as const, labelKey: 'premium.modeSignIn' as TranslationKey },
  { key: 'register' as const, labelKey: 'premium.modeRegister' as TranslationKey },
];

type Mode = 'signIn' | 'register';

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: 'email-address' | 'default';
  autoComplete?: 'email' | 'password' | 'new-password' | 'current-password';
  textContentType?: 'emailAddress' | 'password' | 'newPassword';
  returnKeyType?: 'next' | 'go';
  onSubmitEditing?: () => void;
  hint?: string;
};

/** One labelled text input. */
function Field({
  label,
  value,
  onChangeText,
  secureTextEntry,
  keyboardType = 'default',
  autoComplete,
  textContentType,
  returnKeyType = 'next',
  onSubmitEditing,
  hint,
}: FieldProps) {
  const { colors } = useAppTheme();

  return (
    <View style={styles.field}>
      <ThemedText type="small" themeColor="textMuted" style={styles.label}>
        {label}
      </ThemedText>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={label}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        textContentType={textContentType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        accessibilityLabel={label}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.backgroundElement,
            borderColor: colors.cardBorder,
          },
        ]}
      />
      {hint ? (
        <ThemedText type="small" themeColor="textMuted" style={styles.hint}>
          {hint}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.7,
  },

  // Mode switch -----------------------------------------------------------
  modeRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginTop: Spacing.one,
  },
  modeButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.two,
  },
  modeText: {
    fontSize: 12,
    fontWeight: '700',
  },

  // Fields ----------------------------------------------------------------
  field: {
    gap: Spacing.half,
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  input: {
    // 44 minimum: measured against the other controls on this screen, which the
    // UAT found as small as 24px, and the reason this one is not.
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 14,
  },
  hint: {
    fontSize: 10,
    lineHeight: 15,
  },

  error: {
    fontSize: 12,
    fontWeight: '700',
  },

  submit: {
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
  },
  submitText: {
    fontSize: 13,
    fontWeight: '700',
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
});
