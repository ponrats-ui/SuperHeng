import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';

import { AnalyticsTracker } from '@/components/analytics-tracker';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { SeoHead } from '@/components/seo-head';
import { ActiveUsersProvider } from '@/hooks/use-active-users';
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
  const { colors } = useAppTheme();

  /**
   * Always `DarkTheme`.
   *
   * React Navigation's `DefaultTheme` is what used to reach the navigator when
   * the OS reported light, and it paints its own near-white `background`/
   * `card` under every screen — so the app looked light even where our palette
   * was applied. Picking the dark base outright removes that path instead of
   * recolouring the light one, and keeps the header/card defaults dark too.
   */
  const navigationTheme = {
    ...DarkTheme,
    dark: true,
    colors: {
      ...DarkTheme.colors,
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
        Presence sits above the navigator so the app joins its Realtime channel
        exactly once. The count is rendered by the header, and the header exists on
        every tab; a per-screen connection would count one visitor several times.
        It needs nothing from auth — a visitor is tracked anonymously — so it is a
        sibling of `AuthProvider`, not a child of it.
      */}
      <ActiveUsersProvider>
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
            {/* Light content on the dark background, pinned rather than derived. */}
            <StatusBar style="light" />
            <AnimatedSplashOverlay />
            {/* Title / description / Open Graph / Twitter Card, for every route. */}
            <SeoHead />
            {/*
              GA4 pageviews. Rendered above the navigator so tab and modal
              transitions are counted from one place; it draws nothing and does
              nothing unless `EXPO_PUBLIC_GA_ID` was set at build time.
            */}
            <AnalyticsTracker />
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
      </ActiveUsersProvider>
    </LanguageProvider>
  );
}
