import { usePathname } from 'expo-router';
import { useEffect } from 'react';

import { isAnalyticsEnabled, loadAnalytics, trackPageView } from '@/lib/analytics';

/**
 * Reports one GA4 pageview per route, and nothing at all when analytics is off.
 *
 * Mounted once in the root layout, above the navigator, so it survives every tab
 * and modal transition — a per-screen tracker would miss routes that are pushed
 * without remounting, and would double-count the ones that are.
 *
 * ## Why two effects
 *
 * The first runs on mount and only injects the tag; the second runs on mount and
 * on every pathname change and sends the hit. They are separate so the ordering
 * is explicit: effects in one component run in declaration order, so the queue
 * and the `config` call always exist before the first `page_view` is pushed.
 * Both are no-ops on native, where `isAnalyticsEnabled` is false.
 *
 * `usePathname()` deliberately excludes the query string, so a paywall return
 * (`?checkout=success`) keeps the same path — the page really is the same page,
 * and `page_location` in the hit still carries the full URL for anyone who needs
 * the difference.
 *
 * Renders nothing, on every platform.
 */
export function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!isAnalyticsEnabled) return;
    loadAnalytics();
  }, []);

  useEffect(() => {
    if (!isAnalyticsEnabled) return;
    trackPageView(pathname || '/');
  }, [pathname]);

  return null;
}
