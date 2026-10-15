import { Linking, Platform } from 'react-native';

/**
 * Opening Stripe's hosted Checkout page, and knowing where we came from.
 *
 * WHY THIS IS NOT JUST `Linking.openURL`
 * --------------------------------------
 * The redirect happens *after* an `await` — the app has to ask the API for a
 * Checkout Session first. By then the original tap is over, so the browser no
 * longer treats this as a user gesture, and a new window or tab opened at that
 * point is blocked by the popup blocker in most browsers. The failure is silent:
 * the promise resolves, nothing appears, and the user taps again.
 *
 * A top-level navigation cannot be blocked, and it is also what Stripe expects for
 * hosted Checkout — the customer should leave the app's page, not get a second tab.
 * So the web target navigates and the native targets hand the URL to the system
 * browser, which is where a payment should happen on a phone anyway: it keeps the
 * card details out of this app's process and out of its WebView.
 */

/** A URL we are willing to send someone to pay on. */
const HTTPS_URL = /^https:\/\//i;

/**
 * Loopback, in the spellings a local test server uses.
 *
 * Only here so a locally-mocked gateway can be exercised. Real Stripe Checkout is
 * always `https://checkout.stripe.com/...`.
 */
const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

/**
 * Whether a `checkout_url` from the API is safe to navigate to.
 *
 * The URL comes from this project's own API over HTTPS, so this is a second line
 * rather than the first. It is worth having anyway because the failure it prevents
 * is severe and cheap to rule out: an `http://` checkout page would take card
 * details in clear text, and that is exactly the sort of thing a misconfigured
 * endpoint or a downgraded proxy produces. A refusal is visible in the app as
 * "the checkout could not be started" rather than as a silently insecure form.
 */
export function isCheckoutUrlOpenable(url: string): boolean {
  return HTTPS_URL.test(url) || LOOPBACK_HTTP.test(url);
}

/**
 * The origin to be returned to after paying, or `undefined` to let the server decide.
 *
 * On the web the browser already knows this, and it is the only value that is
 * guaranteed correct — a hosted deployment, a preview deployment and a local dev
 * server all differ, and the server cannot tell which one is calling. The server
 * validates whatever is sent against the same allow-list CORS uses, refusing
 * anything outside it, so this is a request rather than a decision.
 *
 * On native there is no origin: the app is not served from one. Returning
 * `undefined` leaves the server's configured `FRONTEND_BASE_URL` (or its first
 * allowed origin) to decide, which is what we want — the customer should land on
 * the hosted web app, not on a dead `exp://` deep link they cannot act on.
 */
export function returnOrigin(): string | undefined {
  if (Platform.OS !== 'web') return undefined;
  if (typeof window === 'undefined') return undefined;

  const origin = window.location?.origin;
  // A `file://` or `null` origin is not something Stripe or the API can use; an
  // explicit `undefined` lets the server's default apply instead of sending a
  // value that is certain to be refused.
  return typeof origin === 'string' && /^https?:\/\//i.test(origin) ? origin : undefined;
}

/**
 * Leave the app to complete a payment.
 *
 * Never called with an unvalidated URL — see `isCheckoutUrlOpenable`. Resolves on
 * native once the external browser has been handed the URL; on the web the
 * navigation tears the page down, so nothing after the call is guaranteed to run.
 */
export async function openCheckout(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    window.location.assign(url);
    return;
  }

  await Linking.openURL(url);
}
