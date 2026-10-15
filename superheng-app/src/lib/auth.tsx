/**
 * Session state for the app: who is signed in, what they are entitled to, and the
 * bearer token every gated API call needs.
 *
 * WHAT THIS REPLACES
 *   A client-side password gate. `src/lib/premium-access.ts` held a digest of one
 *   username/password pair and wrote a boolean to `localStorage`; the web bundle
 *   shipped the digest, the panel was open to anyone who read it, and the API it
 *   unlocked answered unauthenticated callers. It is deleted. Entitlement is now
 *   decided by the server (`backend/auth.py`) from a row the client cannot write
 *   (`backend/schema_profiles.sql`), and this provider is what supplies the identity
 *   that makes the decision possible.
 *
 * WHY THE ACCOUNT COMES FROM `/api/me` AND NOT FROM SUPABASE
 *   Supabase can tell us *who* a session belongs to. It cannot tell us what they are
 *   entitled to — that is our `user_profiles` row, and the only party that should
 *   interpret it is the backend that will act on it. So the flow is: Supabase
 *   authenticates, then the backend is asked what that means. The token is the bridge.
 *
 *   The payoff is that `isPremium` here is the *server's* verdict, produced by the
 *   same function that gates the data. The UI cannot promise something the API will
 *   then refuse, which is exactly what a client-side re-implementation of "is this
 *   subscription still valid" would eventually do.
 *
 * THE OTHER SUBTLE THING: THE FIRST RENDER MUST MATCH THE PRERENDERED HTML
 *   The web build is prerendered in Node, so the markup React hydrates against was
 *   produced without a session, without `window`, and without Supabase. The first
 *   browser render therefore has to agree with the server's, or React reports a
 *   hydration mismatch (#418) — the failure the i18n module already works around
 *   for the language, for the same reason.
 *
 *   So `ready` is deliberately **false** for that first render and only becomes true
 *   from an effect, and `hasRuntime` is read through `useSyncExternalStore` with a
 *   `false` server snapshot. Reading a client-only fact with `useState` + an effect
 *   that sets it would render the loading state on the server and the resolved state
 *   on the client in the same pass, which is exactly the mismatch.
 *
 * THE ONE SUBTLE THING: NO SUPABASE CALLS INSIDE THE AUTH CALLBACK
 *   `onAuthStateChange` invokes its callback while the auth client holds an internal
 *   lock. Awaiting another `supabase.auth.*` call from inside it deadlocks — the
 *   documented hazard of that API. This provider breaks the rule safely: the only
 *   work it does in the callback is `setSession`, and the account fetch is deferred
 *   with `setTimeout(…, 0)` so it runs after the callback returns. It would probably
 *   work without the deferral today because `/api/me` is our own API and not
 *   Supabase's; "probably works" is not a good reason to leave a known deadlock
 *   shape in the one code path every signed-in screen depends on.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';

import { ApiError, getAccount, isApiError, type AccountStatus } from '@/lib/api';
import { getSupabase, isAuthConfigured } from '@/lib/supabase';

/**
 * Why a sign-in attempt failed, as a code rather than a sentence.
 *
 * The UI translates the code. Supabase's own messages are English sentences built
 * for developers ("Invalid login credentials", "Email not confirmed") and showing
 * them raw in a Thai UI would be a visible regression from the hand-written copy it
 * replaces. The original message is still carried as `message`, because for an
 * unrecognised failure a real sentence from the backend beats a generic apology —
 * and it is what makes an unexpected error diagnosable from a screenshot.
 */
export type AuthErrorCode =
  | 'unconfigured'
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'already_registered'
  | 'weak_password'
  | 'rate_limited'
  | 'invalid_email'
  | 'network'
  | 'unknown';

export type AuthFailure = { code: AuthErrorCode; message: string };

export type SignUpResult = {
  failure: AuthFailure | null;
  /**
   * True when Supabase created the account but returned no session, which is what
   * happens while "Confirm email" is on. The UI has to say "check your inbox"
   * rather than "you are signed in" — the account exists and the user is not in it.
   */
  needsConfirmation: boolean;
};

/**
 * Maps a Supabase error message to a code.
 *
 * Substring matching on the message is the only option the client library leaves:
 * the error object carries `status` and a `code` too, but the mapping from those to
 * the cases that need different copy is not one-to-one, and the messages are stable
 * enough that this is what the Supabase docs themselves show. Ordered most specific
 * first — "Email not confirmed" and "Invalid login credentials" are distinct causes
 * that are easy to collapse into one unhelpful "sign-in failed".
 */
export function classifyAuthError(message: string): AuthErrorCode {
  const text = message.toLowerCase();

  if (text.includes('email not confirmed') || text.includes('not confirmed')) {
    return 'email_not_confirmed';
  }
  if (text.includes('already registered') || text.includes('already been registered')) {
    return 'already_registered';
  }
  if (text.includes('invalid login credentials') || text.includes('invalid credentials')) {
    return 'invalid_credentials';
  }
  if (text.includes('rate limit') || text.includes('too many requests')) {
    return 'rate_limited';
  }
  if (text.includes('password') && (text.includes('at least') || text.includes('should be'))) {
    return 'weak_password';
  }
  if (text.includes('unable to validate email') || text.includes('invalid email')) {
    return 'invalid_email';
  }
  if (text.includes('fetch') || text.includes('network') || text.includes('failed to fetch')) {
    return 'network';
  }
  return 'unknown';
}

export type AuthContextValue = {
  /** False until the stored session has been read; gates the first paint of gated UI. */
  ready: boolean;
  /** False when this build has no Supabase variables — accounts are not enabled. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  userId: string | null;
  /** The bearer token for gated API calls, or null. */
  accessToken: string | null;
  account: AccountStatus | null;
  /** Set when the session is valid but the entitlement could not be read. */
  accountFailure: ApiError | null;
  /** The server's verdict. False while the account is unknown. */
  isPremium: boolean;
  signIn(email: string, password: string): Promise<AuthFailure | null>;
  signUp(email: string, password: string): Promise<SignUpResult>;
  signOut(): Promise<void>;
  /** Re-reads `/api/me`. Used after a checkout returns and after a manual retry. */
  refreshAccount(): Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function failure(code: AuthErrorCode, message: string): AuthFailure {
  return { code, message };
}

/**
 * A store that never changes, for a value that is simply *different* on the server.
 *
 * `useSyncExternalStore` requires a `subscribe`; there is nothing to subscribe to,
 * so it returns a no-op unsubscribe. This is the documented shape for reading a
 * client-only fact without a hydration mismatch.
 */
const subscribeToNothing = () => () => {};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  /** True once the stored session has been read. Never set from the effect body. */
  const [sessionRead, setSessionRead] = useState(false);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountFailure, setAccountFailure] = useState<ApiError | null>(null);
  const live = useRef(true);

  /** False during the Node prerender, true in a browser or on a device. */
  const hasRuntime = useSyncExternalStore(subscribeToNothing, () => true, () => false);

  /**
   * Whether the gate may stop showing its spinner.
   *
   * Derived rather than stored, and that is the point: a build with no Supabase
   * configuration is ready immediately, a configured one is ready once the stored
   * session has been read, and the prerender is never ready — which is the state the
   * server-rendered HTML already shows. Nothing has to be written to state for the
   * first two cases, so there is no cascading render and no hydration mismatch.
   */
  const ready = hasRuntime && (!isAuthConfigured || sessionRead);

  /**
   * Reads `/api/me` with `token`.
   *
   * A failure here does **not** sign the user out: a 503 from a cold backend or a
   * missing `user_profiles` table says nothing about whether the session is good,
   * and dropping a paying subscriber's session because our API was briefly down
   * would be the same class of mistake the backend refuses to make with 402/403.
   * The session is kept and the failure is exposed for the UI to report.
   */
  const loadAccount = useCallback(async (token: string | null) => {
    if (!token) {
      if (!live.current) return;
      setAccount(null);
      setAccountFailure(null);
      return;
    }

    try {
      const next = await getAccount(token, { deadlineMs: 15_000 });
      if (!live.current) return;
      setAccount(next);
      setAccountFailure(null);
    } catch (error) {
      if (!live.current) return;
      setAccount(null);
      setAccountFailure(
        isApiError(error)
          ? error
          : new ApiError('network', 'Could not read the account state.')
      );
    }
  }, []);

  useEffect(() => {
    live.current = true;

    // Null in the prerender and in an unconfigured build. `ready` accounts for both
    // without a state write — see its definition.
    const supabase = getSupabase();
    if (!supabase) return;

    // Assigned so the cleanup below can close over it; `let` rather than `const`
    // because the subscription is created after an await-like promise chain.
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    // The stored session first, so a returning user paints as signed in without a
    // round trip to Supabase.
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session ?? null);
      setSessionRead(true);
      void loadAccount(data.session?.access_token ?? null);
    });

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (cancelled) return;
      setSession(next);
      // Deferred out of the auth client's lock — see the file header. The token is
      // captured now so the deferred call cannot read a session that moved on.
      const token = next?.access_token ?? null;
      setTimeout(() => {
        if (!cancelled) void loadAccount(token);
      }, 0);
    });

    unsubscribe = () => data.subscription.unsubscribe();

    return () => {
      cancelled = true;
      live.current = false;
      unsubscribe?.();
    };
  }, [loadAccount]);

  const signIn = useCallback(async (email: string, password: string): Promise<AuthFailure | null> => {
    const supabase = getSupabase();
    if (!supabase) {
      return failure('unconfigured', 'This build has no Supabase configuration.');
    }

    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (!error) return null;
    return failure(classifyAuthError(error.message), error.message);
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    const supabase = getSupabase();
    if (!supabase) {
      return {
        failure: failure('unconfigured', 'This build has no Supabase configuration.'),
        needsConfirmation: false,
      };
    }

    const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });

    if (error) {
      return { failure: failure(classifyAuthError(error.message), error.message), needsConfirmation: false };
    }

    // No session and a user means the account was created and is waiting for the
    // address to be confirmed. Reported so the UI can say so instead of rendering an
    // empty premium panel and letting the user conclude it is broken.
    return { failure: null, needsConfirmation: Boolean(data.user) && data.session === null };
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Local scope: the refresh token is dropped from this device. A global scope
      // would end the session on the user's other devices too, which is a decision
      // for a settings screen, not for a button that says "Sign out".
      await getSupabase()?.auth.signOut({ scope: 'local' });
    } finally {
      if (live.current) {
        setSession(null);
        setAccount(null);
        setAccountFailure(null);
      }
    }
  }, []);

  const refreshAccount = useCallback(async () => {
    await loadAccount(session?.access_token ?? null);
  }, [loadAccount, session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ready,
      configured: isAuthConfigured,
      signedIn: ready && session !== null,
      email: account?.email ?? session?.user.email ?? null,
      userId: session?.user.id ?? null,
      accessToken: session?.access_token ?? null,
      account,
      accountFailure,
      // Deliberately `account?.is_premium === true` and not a recomputation: while
      // the account is unknown this is false, so the UI shows the locked state until
      // the server says otherwise rather than optimistically unlocking and then
      // having the request refused.
      isPremium: account?.is_premium === true,
      signIn,
      signUp,
      signOut,
      refreshAccount,
    }),
    [ready, session, account, accountFailure, signIn, signUp, signOut, refreshAccount]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** The auth state for the current tree. Throws if there is no provider above it. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside <AuthProvider> — see src/app/_layout.tsx.');
  }
  return value;
}
