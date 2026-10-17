/**
 * How many people are using the app right now.
 *
 * Live social proof, from Supabase Realtime **Presence** on a public channel. No
 * account is needed: the visitor is tracked under a throwaway session id generated
 * in the browser, so the number works for the whole public app rather than only for
 * signed-in subscribers.
 *
 * WHY THIS IS A PROVIDER AND NOT JUST A HOOK
 *   The badge sits in the header, and the header is rendered by *every* tab. React
 *   Navigation keeps tabs mounted once visited, so a hook that connected per
 *   component would open one socket per visited tab — and, worse, count each of them
 *   as a separate user. A single provider above the navigator means exactly one
 *   channel per app instance, which is what "active users" has to mean.
 *
 * WHY THE COUNT IS `null` RATHER THAN 0 BEFORE IT IS KNOWN
 *   The web build is prerendered, so the markup is produced with no browser, no
 *   socket and no presence. Rendering a placeholder count would either be a lie or
 *   hydrate against a different number (the #418 class of bug this codebase keeps
 *   running into). `null` means "unknown", the badge renders nothing, and the first
 *   count arrives after hydration. A count of 0 is never published either: a `sync`
 *   that lands before our own `track` has been acknowledged reports an empty room,
 *   and showing "0 people" for that instant would undercut the point of the feature.
 *
 * WHY THE PRESENCE KEY IS RANDOM AND NOT THE USER ID
 *   This is a public page, so most visitors have no identity at all. The key only
 *   has to be unique per connection: Supabase uses it to merge and expire presence
 *   entries. It is deliberately *not* derived from anything identifying, and it
 *   never leaves the channel.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { getSupabase } from '@/lib/supabase';

/**
 * The channel name.
 *
 * `public:` is Supabase's prefix for a channel that needs no Realtime authorization
 * policy. It matches the naming in the Realtime dashboard, which makes it obvious in
 * the project's logs what the traffic is.
 */
const PRESENCE_CHANNEL = 'public:online-users';

export type ActiveUsersStatus =
  /** No channel yet — the prerender, or the first paint before the effect runs. */
  | 'idle'
  /** Subscribed and tracking; `count` is the live figure. */
  | 'tracking'
  /** No Supabase configuration, or the socket failed. `count` is null. */
  | 'unavailable';

export type ActiveUsers = {
  /** Distinct live sessions, or null while unknown. Never 0. */
  count: number | null;
  status: ActiveUsersStatus;
};

/** The pre-connection state. A frozen module constant so it is reference-stable. */
const UNKNOWN: ActiveUsers = { count: null, status: 'idle' };

/**
 * A random v4-shaped key for this connection.
 *
 * `crypto.randomUUID` exists in every browser and in Node, but React Native's
 * Hermes runtime does not ship it — hence the fallback. `Math.random` is fine here
 * and worth being explicit about: this value is a presence key, not a token, and
 * guessing someone else's would only make the count wrong for a moment.
 */
function sessionKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const block = (length: number) => Array.from({ length }, hex).join('');
  // `4` and `8` fix the version/variant nibbles, so the string is a real UUID v4.
  return `${block(8)}-${block(4)}-4${block(3)}-8${block(3)}-${block(12)}`;
}

const ActiveUsersContext = createContext<ActiveUsers | null>(null);

/**
 * Owns the one presence channel for the app.
 *
 * Mount once, above the navigator (see `app/_layout.tsx`) — the same rule the
 * language and auth providers follow.
 */
export function ActiveUsersProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ActiveUsers>(UNKNOWN);

  useEffect(() => {
    // Null during the Node prerender and in a build with no Supabase variables.
    // Nothing to join, and the badge stays hidden rather than showing a number.
    const supabase = getSupabase();
    if (!supabase) return;

    let cancelled = false;

    const channel = supabase.channel(PRESENCE_CHANNEL, {
      config: { presence: { key: sessionKey() } },
    });

    /**
     * Recounts from the channel's own presence state.
     *
     * Every event recomputes the whole set instead of incrementing a counter: the
     * three events are notifications that the set changed, not deltas, and a missed
     * or duplicated one (reconnects make both possible) would drift a counter for
     * the rest of the session while a recount self-heals.
     */
    const recount = (status: ActiveUsersStatus) => {
      if (cancelled) return;
      const count = Object.keys(channel.presenceState()).length;
      if (count === 0) return;
      setState((previous) =>
        previous.count === count && previous.status === status ? previous : { count, status }
      );
    };

    channel
      .on('presence', { event: 'sync' }, () => recount('tracking'))
      .on('presence', { event: 'join' }, () => recount('tracking'))
      // `leave` carries the departed entries, but `presenceState()` has already
      // dropped them by the time this handler runs — so it reads like `sync`.
      .on('presence', { event: 'leave' }, () => recount('tracking'))
      .subscribe((status) => {
        if (cancelled) return;

        if (status === 'SUBSCRIBED') {
          // Publish ourselves. The first `sync` may already have arrived by now, and
          // this is what puts us in it.
          void channel.track({ joined_at: new Date().toISOString() });
          return;
        }

        // CHANNEL_ERROR and TIMED_OUT are recoverable — the client reconnects and
        // re-subscribes on its own, and the `SUBSCRIBED` branch re-tracks. Until
        // then the honest thing is to hide the number rather than leave a stale one
        // on screen claiming that ten people are still here.
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setState({ count: null, status: 'unavailable' });
        }
      });

    return () => {
      cancelled = true;
      // Untracks our entry and closes the channel — other clients see the `leave`.
      void supabase.removeChannel(channel);
    };
  }, []);

  return <ActiveUsersContext.Provider value={state}>{children}</ActiveUsersContext.Provider>;
}

/** The live count for the current tree. Throws outside the provider. */
export function useActiveUsers(): ActiveUsers {
  const value = useContext(ActiveUsersContext);
  if (!value) {
    throw new Error('useActiveUsers() must be used inside <ActiveUsersProvider> — see app/_layout.tsx.');
  }
  return value;
}
