import { Colors, type ColorScheme, type Theme } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Resolves the active theme.
 *
 * The scheme is forced (see `ForcedColorScheme`), so this is really "give me the
 * dark palette" plus the scheme for the few places that label it — the navigation
 * theme and the status-bar style. Still routed through `useColorScheme` so the
 * components never learn where the decision is made.
 */
export function useAppTheme(): { scheme: ColorScheme; colors: Theme } {
  const scheme = useColorScheme();
  return { scheme, colors: Colors[scheme] };
}
