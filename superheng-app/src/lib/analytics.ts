/**
 * Google Analytics 4, loaded only when the build was given a measurement ID.
 *
 * ## The gate
 *
 * `EXPO_PUBLIC_GA_ID` is inlined at build time, like every `EXPO_PUBLIC_*`
 * value. When it is absent — which is the default for `npx expo start`, for
 * `npm run build` without a `.env`, and for any deploy that has not set it —
 * *nothing is injected*: no `<script>`, no `window.gtag`, no collection. Local
 * testing and preview builds therefore cannot pollute the property, and that is
 * enforced by the absence of the variable rather than by a checkbox somebody has
 * to remember.
 *
 * The ID is also shape-checked. `G-XXXXXXXXXX` or a truncated paste would load
 * `gtag.js` against a property that does not exist, which fails silently in the
 * browser and looks identical to "analytics is broken" — so an invalid value is
 * treated as "not configured", and the reason is visible here instead.
 *
 * ## Why pageviews are manual
 *
 * GA4's default `config` call sends one `page_view` on load. This app is a
 * single-page application: moving between `/` and `/performance` changes the URL
 * with `history.pushState` and no document load, so the default would report one
 * pageview per *visit* instead of one per *page*. `send_page_view: false` turns
 * the automatic one off, and `trackPageView` (driven by `usePathname` in
 * `components/analytics-tracker.tsx`) is the only source of pageviews — every
 * route, including the first.
 *
 * ## Why the queue exists
 *
 * `gtag.js` arrives asynchronously. Everything pushed to `window.dataLayer`
 * before it lands is replayed by the library once it does, which is what the
 * standard inline snippet relies on. Calling `loadAnalytics()` before the first
 * `trackPageView` keeps that ordering explicit, so a slow network delays the hit
 * rather than dropping it.
 *
 * Everything here was checked against the built site in a browser, not just
 * reasoned about: `dist/` served locally with `EXPO_PUBLIC_GA_ID=G-TEST123456`
 * produced one `config` call with `send_page_view: false`, one `page_view` for
 * `/`, and a second for `/performance` after a tab click — with exactly one
 * `gtag.js` tag in the document.
 */

import { Platform } from 'react-native';

/** GA4 measurement IDs: `G-` followed by at least six upper-case alphanumerics. */
const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{6,}$/i;

/** The DOM id of the injected tag, so a remount cannot add a second one. */
const SCRIPT_ID = 'superheng-ga4';

/** Inlined at build time; empty string when the variable is not set. */
export const GA_MEASUREMENT_ID = (process.env.EXPO_PUBLIC_GA_ID ?? '').trim();

/**
 * One flag every caller can use without repeating the platform and shape checks.
 *
 * `Platform.OS === 'web'` matters even though the tracker is only mounted once:
 * the value is evaluated on native too, where `window` and `document` do not
 * exist, and where loading a web analytics script would be meaningless.
 */
export const isAnalyticsEnabled =
  Platform.OS === 'web' && MEASUREMENT_ID_PATTERN.test(GA_MEASUREMENT_ID);

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** Set once the tag and the queue exist, so a route change does not re-inject. */
let initialised = false;

/**
 * Puts `gtag` and `dataLayer` on `window` and appends `gtag.js`.
 *
 * Safe to call repeatedly, and safe to call during server rendering: the
 * `window`/`document` guards return before touching either.
 */
export function loadAnalytics(): void {
  if (initialised || !isAnalyticsEnabled) return;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  initialised = true;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag =
    window.gtag ??
    function gtag() {
      // `gtag.js` reads array-like entries; the official snippet pushes
      // `arguments` itself, which is not an Array.
      window.dataLayer?.push(arguments as unknown as unknown[]);
    };

  window.gtag('js', new Date());
  // No automatic pageview — `trackPageView` owns them, including the first one.
  window.gtag('config', GA_MEASUREMENT_ID, { send_page_view: false });

  if (document.getElementById(SCRIPT_ID)) return;

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/**
 * Records one GA4 `page_view` for `pagePath`.
 *
 * `page_location` is **built from `pagePath`**, not read from
 * `window.location.href`. Reading the live URL was the obvious implementation and
 * it was wrong: the router's own effect that pushes the new URL runs after this
 * one in the same commit, so the hit carried the *previous* page's address. The
 * measured result was a `page_view` for `/performance` whose `page_location`
 * still said `/` — a mismatch GA4 resolves in favour of `page_location`, i.e.
 * every tab switch credited to the landing page.
 *
 * Deriving both fields from the same argument makes them agree by construction.
 * The cost is that query strings are not carried: `?checkout=success` and the
 * bare paywall report the same `page_path`, which is also what `usePathname`
 * means by "the page" (see `analytics-tracker.tsx`).
 */
export function trackPageView(pagePath: string): void {
  if (!isAnalyticsEnabled) return;
  if (typeof window === 'undefined') return;

  loadAnalytics();

  window.gtag?.('event', 'page_view', {
    page_path: pagePath,
    page_location: `${window.location.origin}${pagePath}`,
    page_title: typeof document === 'undefined' ? undefined : document.title,
  });
}
