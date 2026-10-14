/**
 * Premium-mode access for the Premium Insights panel — a beta door, not a lock.
 *
 * **What this is:** a client-side gate so the Bayesian positional panel can go to
 * a closed beta without every tester reading it. It is deliberately small, has no
 * dependency, and stores nothing but a boolean.
 *
 * **What this is not:** access control. The app is a static export, so this file —
 * digest and all — is readable by anyone who opens the bundle in a browser, and
 * `/api/predict/premium` is unauthenticated, so the same numbers sit one `curl`
 * away regardless. The gate stops a curious tester, not an attacker. When the
 * panel becomes a paid tier, the gate has to move server-side (an entitlement
 * check the API enforces); until then, treat everything behind it as public.
 *
 * The credentials are not written in plain text on purpose: the check compares a
 * non-cryptographic digest of `<salt>:<username>:<password>`, so the bundle
 * cannot simply be grep'd for the password. That raises the bar from "search the
 * file" to "brute-force two short words" — which is not a high bar, see above.
 *
 * To rotate the credentials, change the two strings and recompute the digest
 * (`node -e` with the same FNV-1a used below):
 *
 *   node -e "const s='superheng:founder:v1',d=v=>{let h=0x811c9dc5;for(const c of v){h^=c.charCodeAt(0);h=Math.imul(h,0x01000193)}return (h>>>0).toString(16).padStart(8,'0')};console.log(d(s+':Commy:Admin'))"
 */

/**
 * Salt for the credential digest.
 *
 * A fixed versioning string, not a label: changing it changes every digest, so a
 * rename here silently locks the account out. Rotate it only together with the
 * digest below.
 */
const ACCESS_SALT = 'superheng:founder:v1';

/**
 * Digest of `<salt>:<username>:<password>` for the one accepted pair — the
 * premium-tier credentials, `Commy` / `Admin`.
 *
 * Case-sensitive and untrimmed by design: `commy`/`Admin` and `Commy`/`admin`
 * both digest differently and are rejected, so a typo fails instead of being
 * helpfully corrected.
 */
const PREMIUM_ACCESS_DIGEST = '5b694a3c';

/** Where the unlocked flag is remembered on web. */
const STORAGE_KEY = 'superheng.premium.unlocked';

/**
 * The slice of `localStorage` this module uses.
 *
 * Declared structurally rather than as the DOM `Storage` type so the file stays
 * valid in the native TypeScript project too, and so the optional access below
 * does not depend on the DOM lib being configured.
 */
type WebStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** FNV-1a, 32-bit, as 8 hex characters. Not a password hash — see the file header. */
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Whether a username/password pair may open Premium mode. */
export function isPremiumCredential(username: string, password: string): boolean {
  return digest(`${ACCESS_SALT}:${username}:${password}`) === PREMIUM_ACCESS_DIGEST;
}

/**
 * Survives navigation on every platform, including the ones without storage.
 *
 * The dashboard unmounts when the user visits another tab, so without this the
 * account holder would retype the password every time they came back — the annoyance
 * the web storage below exists to fix, in the cases where it is unavailable.
 */
let unlockedThisSession = false;

function storage(): WebStorage | null {
  const candidate = (globalThis as { localStorage?: WebStorage }).localStorage;
  return candidate ?? null;
}

/**
 * Whether Premium mode was already unlocked.
 *
 * Web remembers it in `localStorage`, so a refresh does not ask again. Native
 * intentionally has no storage here: `AsyncStorage` and `expo-secure-store` are
 * both dependencies this project does not have yet, and adding a native module
 * for a beta door would force a development build. Add `expo-secure-store` when
 * native persistence is worth that; the session flag already covers navigation.
 */
export function readPremiumUnlock(): boolean {
  if (unlockedThisSession) return true;
  try {
    return storage()?.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private mode or storage disabled: fall back to the session flag.
    return false;
  }
}

/** Records the unlocked flag. Locking clears it everywhere it was set. */
export function writePremiumUnlock(unlocked: boolean): void {
  unlockedThisSession = unlocked;
  try {
    if (unlocked) storage()?.setItem(STORAGE_KEY, '1');
    else storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — the flag still holds for this session.
  }
}
