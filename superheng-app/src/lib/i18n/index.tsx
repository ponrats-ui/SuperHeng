import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { en, type TranslationKey } from './en';
import { th } from './th';

/**
 * Tiny hand-rolled i18n — no dependency, no build step, compile-time key safety.
 *
 * **Why not `i18next`.** This app has one locale pair, no plural rules beyond
 * one/other, and ships as a static web export plus a native bundle. `i18next` would
 * add two runtime packages and still need hand-written types to make `t('...')`
 * typo-safe, whereas a flat dictionary gives that for free: keys come from `en.ts`
 * and `th.ts` is a `Record` over them, so a missing Thai string is a `tsc` error.
 *
 * **Hydration is the one subtle part.** Pages prerenders this app, so the first
 * client render must match the prerendered HTML exactly. The chosen language is
 * therefore read through `useSyncExternalStore`, whose *server* snapshot is always
 * the default: React renders the prerendered language during hydration and only
 * then switches to the stored one. Reading `localStorage` during the first render
 * instead would make the markup differ from the server's for anyone who chose
 * English — precisely the failure already visible as a React #418 error on the live
 * site, and not a second one worth adding.
 */

export type Language = 'th' | 'en';

/** The languages the toggle offers, in display order. */
export const LANGUAGES: readonly Language[] = ['th', 'en'];

/** Thai first: it is the primary audience and the app's original copy. */
export const DEFAULT_LANGUAGE: Language = 'th';

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, th };

/** Where the choice is remembered on web. */
const STORAGE_KEY = 'superheng.language';

/** `{name}` placeholders, and the only interpolation this app needs. */
const PLACEHOLDER = /\{(\w+)\}/g;

type Params = Record<string, string | number>;

/** A translator bound to one language. */
export type Translate = (key: TranslationKey, params?: Params) => string;

export type { TranslationKey };

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in params ? String(params[name]) : match
  );
}

/**
 * Resolves one key.
 *
 * Order of preference: a `_one` variant when `count` is exactly 1, the key itself,
 * then English, then the raw key. The last two are unreachable while the dictionary
 * types hold — they exist so a bad key degrades to something visible and diagnosable
 * in production instead of rendering `undefined`.
 */
function translate(language: Language, key: TranslationKey, params?: Params): string {
  const table = DICTIONARIES[language];
  const singular = `${key}_one` as TranslationKey;
  const chosen = params?.count === 1 && singular in table ? singular : key;
  const template = table[chosen] ?? DICTIONARIES.en[chosen] ?? key;
  return interpolate(template, params);
}

/**
 * The slice of `localStorage` this module uses, declared structurally rather than
 * as the DOM `Storage` type, so the file stays valid in the native project too,
 * which has no DOM lib.
 */
type WebStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function storage(): WebStorage | null {
  return (globalThis as { localStorage?: WebStorage }).localStorage ?? null;
}

/** Reads the stored preference, falling back to the default on any failure. */
export function readStoredLanguage(): Language {
  try {
    const stored = storage()?.getItem(STORAGE_KEY);
    return stored === 'en' || stored === 'th' ? stored : DEFAULT_LANGUAGE;
  } catch {
    // Private mode or storage disabled — the default is the honest answer.
    return DEFAULT_LANGUAGE;
  }
}

function writeStoredLanguage(language: Language): void {
  try {
    storage()?.setItem(STORAGE_KEY, language);
  } catch {
    // Private mode or storage disabled. The DOM language below still applies for
    // this load; the preference simply does not survive a reload.
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------
//
// The language lives in `localStorage` (the single source of truth) and is read
// through an external store rather than mirrored into component state. That keeps
// the hydration-safe behaviour above and means the header toggle and every screen
// observe the same value without prop-drilling or a second copy to keep in sync.

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Client snapshot. A string, so React's equality check is by value. */
function getSnapshot(): Language {
  return readStoredLanguage();
}

/** Server/hydration snapshot: the prerendered language, always. */
function getServerSnapshot(): Language {
  return DEFAULT_LANGUAGE;
}

/**
 * Sets the language everywhere: storage, every subscribed component, and the
 * document. Exported so non-React code can change it, which is why it is not a
 * closure inside the provider.
 */
export function setStoredLanguage(next: Language): void {
  writeStoredLanguage(next);
  listeners.forEach((listener) => listener());
}

/**
 * Keeps the document in step with the chosen language.
 *
 * Screen readers pick their pronunciation rules from this attribute, and it is what
 * tells the browser which fonts and line-breaking to use for Thai — so it is set in
 * an effect (after hydration) rather than during render.
 */
function applyDocumentLanguage(language: Language): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
}

type LanguageContextValue = {
  language: Language;
  setLanguage: (next: Language) => void;
  /** Flips between the two supported languages. */
  toggle: () => void;
  /** Translate a key into the current language. */
  t: Translate;
};

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * Provides the current language and a bound translator.
 *
 * Mount once, at the root layout, so every screen and modal shares one language —
 * the toggle would be pointless if each screen kept its own state.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const language = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // A side effect on an external system (the document), not state being derived:
  // it runs after hydration and on every change, and touches nothing React owns.
  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage: setStoredLanguage,
      toggle: () => setStoredLanguage(language === 'th' ? 'en' : 'th'),
      t: (key, params) => translate(language, key, params),
    }),
    [language]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

/** The current language and a translator. Throws outside the provider. */
export function useTranslation(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) {
    throw new Error('useTranslation() needs a <LanguageProvider> above it — see app/_layout.tsx.');
  }
  return value;
}
