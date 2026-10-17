/**
 * Palette for the active theme, for the primitives (`ThemedText`, `ThemedView`)
 * and charts that only need colours.
 *
 * The scheme is fixed to dark, so the old `'unspecified' → 'light'` fallback is
 * gone: it existed because `useColorScheme()` could hand back `null` before the
 * platform answered, and a forced value never does.
 *
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  return Colors[useColorScheme()];
}
