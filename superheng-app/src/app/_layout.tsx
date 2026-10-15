import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { useAppTheme } from '@/hooks/use-app-theme';
import { AuthProvider } from '@/lib/auth';
import { LanguageProvider } from '@/lib/i18n';

SplashScreen.preventAutoHideAsync();

/**
 * Options shared by every full-screen modal route (see `ModalScaffold`).
 *
 * Expo Router renders `modal` as a plain stack route on web, so these use a
 * transparent modal there and draw the backdrop inside the screen itself.
 */
const MODAL_SCREEN_OPTIONS = {
  presentation: Platform.select({ web: 'transparentModal' as const, default: 'modal' as const }),
  animation: Platform.select({ web: 'none' as const, default: undefined }),
};

/**
 * Root navigator.
 *
 * A Stack sits above the tab navigator so future full-screen routes (draw
 * detail, settings, paywall) can be pushed over the tabs without restructuring.
 */
export default function RootLayout() {
  const { scheme, colors } = useAppTheme();

  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationTheme = {
    ...base,
    dark: scheme === 'dark',
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.text,
      border: colors.cardBorder,
    },
  };

  return (
    // Language sits above the navigator so every screen, modal and header shares one
    // language — a per-screen provider would let them disagree.
    <LanguageProvider>
      {/*
        Auth sits above the navigator too, and for a stronger reason than the
        language: it holds the one Supabase session and the one token-refresh
        subscription for the whole app. Two providers would mean two clients racing
        over one stored session, and a screen mounted outside the provider would
        throw on `useAuth()` — which is why this wraps every route rather than just
        the premium ones.
      */}
      <AuthProvider>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <AnimatedSplashOverlay />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="about" options={MODAL_SCREEN_OPTIONS} />
            <Stack.Screen name="donate" options={MODAL_SCREEN_OPTIONS} />
            <Stack.Screen name="premium" options={MODAL_SCREEN_OPTIONS} />
          </Stack>
        </ThemeProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
