import { Colors, type ColorScheme, type Theme } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Resolves the active light/dark theme.
 *
 * Collapses `null | undefined | 'unspecified'` to `'light'` so consumers always
 * get a concrete palette without repeating the same guard everywhere.
 */
export function useAppTheme(): { scheme: ColorScheme; colors: Theme } {
  const scheme: ColorScheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: Colors[scheme] };
}
