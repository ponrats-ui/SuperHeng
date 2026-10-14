import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';
import { isPremiumCredential, readPremiumUnlock, writePremiumUnlock } from '@/lib/premium-access';

export type PremiumGateProps = {
  /** Rendered only while unlocked — normally `<PremiumInsightsPanel />`. */
  children: ReactNode;
};

/**
 * Beta gate in front of the premium-mode panel.
 *
 * The panel used to be open on purpose, so the math and layout could be checked
 * on device. It is now behind a password while the beta runs, which means the
 * question a user asks shifts from "what does this number mean" to "may I look",
 * and this component's only job is to answer that without pretending to be more
 * than it is.
 *
 * **It is not access control.** The web build is a static export and the premium
 * endpoint is unauthenticated, so the credentials are readable in the bundle and
 * the data is one request away. `src/lib/premium-access.ts` states the limits in
 * full. Treat the panel as public until the API enforces an entitlement.
 *
 * Presentation follows `LockedPanel`: gold-tinted border, `colors.accent` for
 * gold text (never `colors.gold`, which fails contrast on a light surface), and
 * a pill labelled with what the door actually is.
 */
export function PremiumGate({ children }: PremiumGateProps) {
  const { colors } = useAppTheme();
  const [unlocked, setUnlocked] = useState(readPremiumUnlock);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  /**
   * Checks the pair and opens the door.
   *
   * A failure keeps what was typed and reports the reason, rather than clearing
   * the fields and leaving the user to wonder which half was wrong.
   */
  function submit() {
    if (!isPremiumCredential(username, password)) {
      setError('Invalid credentials');
      return;
    }
    writePremiumUnlock(true);
    setUnlocked(true);
    setError(null);
    // Do not keep the password in memory once the door is open.
    setPassword('');
  }

  /** Lets the account holder close the panel again before handing the device over. */
  function lock() {
    writePremiumUnlock(false);
    setUnlocked(false);
    setUsername('');
    setPassword('');
    setError(null);
  }

  if (unlocked) {
    return (
      <View style={styles.unlockedWrap}>
        {children}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="ล็อก Premium insights อีกครั้ง"
          onPress={lock}
          style={({ pressed }) => [styles.lockAgain, pressed && styles.pressed]}>
          <ThemedText type="small" themeColor="textMuted" style={styles.lockAgainText}>
            🔒 ล็อกอีกครั้ง (Lock)
          </ThemedText>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.form, { borderColor: `${colors.gold}66` }]}>
      <View style={[styles.pill, { borderColor: `${colors.gold}80` }]}>
        <ThemedText type="small" style={[styles.pillText, { color: colors.accent }]}>
          🔒 PREMIUM LOGIN
        </ThemedText>
      </View>

      <ThemedText style={styles.title}>Premium Access</ThemedText>
      <ThemedText type="small" themeColor="textMuted" style={styles.subtitle}>
        โหมด Premium สำหรับทดสอบเบต้า — เข้าสู่ระบบเพื่อดูการวิเคราะห์รายตำแหน่ง
      </ThemedText>

      <View style={styles.field}>
        <ThemedText type="small" themeColor="textMuted" style={styles.label}>
          Username
        </ThemedText>
        <TextInput
          value={username}
          onChangeText={setUsername}
          placeholder="username"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          returnKeyType="next"
          accessibilityLabel="Premium username"
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.backgroundElement,
              borderColor: colors.cardBorder,
            },
          ]}
        />
      </View>

      <View style={styles.field}>
        <ThemedText type="small" themeColor="textMuted" style={styles.label}>
          Password
        </ThemedText>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="••••••"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          returnKeyType="go"
          onSubmitEditing={submit}
          accessibilityLabel="Premium password"
          style={[
            styles.input,
            {
              color: colors.text,
              backgroundColor: colors.backgroundElement,
              borderColor: colors.cardBorder,
            },
          ]}
        />
      </View>

      {error ? (
        <ThemedText
          type="small"
          accessibilityLiveRegion="polite"
          style={[styles.error, { color: colors.danger }]}>
          {error}
        </ThemedText>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="เข้าสู่ระบบ Premium mode"
        onPress={submit}
        style={({ pressed }) => [
          styles.submit,
          { backgroundColor: colors.primary },
          pressed && styles.pressed,
        ]}>
        <ThemedText type="smallBold" style={[styles.submitText, { color: colors.onPrimary }]}>
          เข้าสู่ระบบ (Unlock)
        </ThemedText>
      </Pressable>

      <ThemedText type="small" themeColor="textMuted" style={styles.note}>
        เป็นเพียงประตูหน้าแบบเบต้า: เว็บนี้เป็น static build และข้อมูลชุดเดียวกับที่ API
        สาธารณะ — ไม่ใช่การป้องกันระดับ production
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: Radius.lg,
    borderWidth: 1,
    // The border colour is applied inline from `colors.gold` (theme-dependent),
    // so a locked premium panel reads as the same kind of door as the
    // gold-bordered LockedPanel used for the other premium tiers.
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
    fontSize: 18,
    lineHeight: 30,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 11,
    lineHeight: 18,
  },

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

  error: {
    fontSize: 12,
    fontWeight: '700',
  },

  submit: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.four,
  },
  submitText: {
    fontSize: 13,
    fontWeight: '700',
  },

  note: {
    fontSize: 10,
    lineHeight: 16,
  },

  unlockedWrap: {
    gap: Spacing.two,
  },
  lockAgain: {
    alignSelf: 'flex-end',
    // Tap target, not a caption: padding rather than relying on the text box.
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
  },
  lockAgainText: {
    fontSize: 11,
    fontWeight: '700',
  },
});
