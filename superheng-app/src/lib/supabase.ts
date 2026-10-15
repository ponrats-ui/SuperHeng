/**
 * The Supabase client — identity for the app, and the source of every bearer token
 * the API accepts.
 *
 * WHY THE CLIENT IS CREATED LAZILY, AND NOT AT MODULE SCOPE
 *   This app is **prerendered**: `expo export -p web` renders every route in Node to
 *   produce the HTML Cloudflare Pages serves, and the dev server does the same pass
 *   on request. In Node there is no `window`.
 *
 *   `@react-native-async-storage/async-storage`'s web implementation is backed by
 *   `window.localStorage`, and `createClient(...)` reads the stored session
 *   *immediately* — so a module-scope `createClient` throws `ReferenceError: window
 *   is not defined` inside the prerender. That does not degrade gracefully: the
 *   render pass dies, and the dev server answers the page with a connection error
 *   rather than HTML. Not just the premium tab — the whole app.
 *
 *   So construction is deferred behind `getSupabase()`, which returns `null` in a
 *   runtime with no `window` (the prerender) and the real client everywhere else.
 *   `typeof window === 'undefined'` is the right test rather than `Platform.OS`:
 *   React Native defines `window` as an alias of its global object on iOS and
 *   Android, so native passes it, and only the Node render fails it.
 *
 * WHY THIS MODULE ALSO EXPORTS `isAuthConfigured`
 *   The hosted build is a static export whose `EXPO_PUBLIC_*` values are baked in at
 *   build time. A build made without them — which is every build from before this
 *   feature — cannot sign anyone in, and the UI needs to say that rather than render
 *   a form that could never work. `isAuthConfigured` is that flag.
 *
 * WHICH KEY GOES HERE
 *   The **publishable / anon** key, and nothing else. It is inlined into the bundle
 *   and is meant to be public; row-level security is what protects the data behind
 *   it. The service_role (secret) key must never reach this file — `backend/.env.example`
 *   says the same thing from the server's side.
 *
 * SESSION STORAGE
 *   `@react-native-async-storage/async-storage`, which is the adapter Supabase's
 *   React Native guide uses and which resolves to `localStorage` on web. One
 *   adapter, one code path, and the session survives an app restart on both
 *   platforms — which is what makes the premium gate usable at all: without
 *   persistence a paying subscriber would sign in again on every launch.
 *
 *   It is not encrypted. On a rooted or jailbroken device a session token is
 *   readable, and the mitigation (`expo-secure-store` holding a key, with the session
 *   encrypted in AsyncStorage) is worth doing before launch but needs a development
 *   build to verify, which this project has no way to test. Named here rather than
 *   left as an implicit assumption.
 *
 * `detectSessionInUrl` IS PLATFORM-DEPENDENT, AND THAT IS NOT COSMETIC
 *   On **web** it is true: following an email confirmation link returns the browser
 *   to the app with the session in the URL. Without it, confirming an address
 *   appears to do nothing.
 *   On **native** it is false: there is no page URL to read.
 *
 *   The consequence for native, stated because it blocks a launch: a confirmation
 *   link opens a browser, not the app, so a native signup cannot be confirmed
 *   without deep linking (`expo-linking`, a `superheng://` scheme, and
 *   `exchangeCodeForSession`). Until that exists, either turn off Supabase's
 *   "Confirm email" setting or expect native confirmation not to complete.
 */

import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

/**
 * Expo inlines `EXPO_PUBLIC_*` at **build** time, so these are baked into `dist/`
 * by `npm run build` and changing them afterwards has no effect until a rebuild —
 * the same rule `EXPO_PUBLIC_API_URL` follows. Neither is a secret.
 */
const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim();
const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();

/**
 * Whether a browser/native runtime exists.
 *
 * False only during the Node prerender. Used to withhold the client there instead of
 * letting it throw.
 */
const hasClientRuntime = typeof window !== 'undefined';

/** Whether this build can sign anyone in. */
export const isAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let client: SupabaseClient | null = null;
let appStateWired = false;

/**
 * Stop refreshing tokens while the app is in the background.
 *
 * Supabase's React Native guide calls for this, and the reason is concrete: a
 * refresh timer that keeps firing while the app is suspended burns battery and
 * network, and on iOS a timer scheduled during suspension can fire late and briefly
 * present a stale token. Pausing on `background` and resuming on `active` keeps
 * refresh tied to the app's actual lifecycle.
 *
 * Web is excluded: the browser already throttles background timers, and `AppState`
 * there reports visibility changes the client handles itself.
 */
function wireAppStateRefresh(supabase: SupabaseClient): void {
  if (appStateWired || Platform.OS === 'web') return;
  appStateWired = true;

  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      supabase.auth.startAutoRefresh();
    } else {
      supabase.auth.stopAutoRefresh();
    }
  });
}

/**
 * The shared client, or `null` when this build cannot sign in.
 *
 * `null` in three cases, and callers must handle all of them: no Supabase
 * configuration, the Node prerender, and — never, in practice — a construction
 * failure.
 *
 * One instance for the app: it holds the session and the refresh timer, and a
 * second client would mean two refresh loops racing over one stored token. The
 * cached `client` is per-process, which is what "one instance" means here; during
 * the prerender nothing is cached because nothing is built.
 */
export function getSupabase(): SupabaseClient | null {
  if (!isAuthConfigured || !hasClientRuntime) return null;
  if (client) return client;

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: AsyncStorage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: Platform.OS === 'web',
    },
  });

  wireAppStateRefresh(client);
  return client;
}
