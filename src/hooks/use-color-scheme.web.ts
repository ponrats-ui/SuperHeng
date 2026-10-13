import { useSyncExternalStore } from 'react';

type WebColorScheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribe(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia(DARK_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

/**
 * Reads the browser's preference straight from the media query.
 *
 * The previous implementation waited for a hydration flag before asking
 * react-native-web for the scheme; when a page loaded with dark mode already
 * active that path stayed on `light` until the preference changed. Reading the
 * media query here means the correct scheme is available on the first client
 * render, while `getServerSnapshot` keeps static rendering deterministic.
 */
function getSnapshot(): WebColorScheme {
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches
    ? 'dark'
    : 'light';
}

function getServerSnapshot(): WebColorScheme {
  return 'light';
}

export function useColorScheme(): WebColorScheme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
