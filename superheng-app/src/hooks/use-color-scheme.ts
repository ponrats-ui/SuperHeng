import { ForcedColorScheme, type ColorScheme } from '@/constants/theme';

/**
 * The colour scheme the app renders in.
 *
 * Deliberately *not* React Native's `useColorScheme`: the exact same call used
 * to return whatever the OS reported, so a phone or browser set to light mode
 * dropped the whole app into the light palette. Dark is the brand, so the answer
 * is fixed at `ForcedColorScheme` and the system preference is ignored.
 *
 * Kept as a hook with the same shape as the RN one (`'light' | 'dark'`) so every
 * consumer — `useTheme`, `useAppTheme` — keeps working unchanged, and so the
 * theme stays a single decision rather than a prop threaded through the tree.
 *
 * There is also no `.web.ts` counterpart any more: the answer no longer depends
 * on the platform, and the old web override had to read `prefers-color-scheme`
 * live, which is precisely the thing being overridden.
 */
export function useColorScheme(): ColorScheme {
  return ForcedColorScheme;
}
