/**
 * The site's public identity, in one place.
 *
 * Everything a crawler or a social preview reads — the title, the description,
 * the canonical host, the share image — is defined here rather than typed into
 * `+html.tsx`, so there is exactly one string to change when the copy or the
 * domain changes, and `robots.txt` / `sitemap.xml` / the document can be checked
 * against each other instead of drifting apart.
 *
 * ## Why the host is a build variable
 *
 * `EXPO_PUBLIC_SITE_URL` is inlined by Expo at build time, exactly like
 * `EXPO_PUBLIC_API_URL` (see `lib/api.ts`). The Pages build sets it in
 * `wrangler.toml`, and the fallback below is the real deployment, so a local
 * `npx expo export` produces the right absolute URLs without any setup. There is
 * no way to read the visitor's own origin instead: the document is rendered in
 * Node during export, where `window` does not exist.
 *
 * A trailing slash is stripped, because every consumer concatenates a path onto
 * this value (`${SITE_URL}/og-image.png`), and `https://host//og-image.png` is a
 * different URL to a crawler.
 *
 * ## Why the copy is Thai
 *
 * Thai is the product's default language (see `lib/i18n`), and search results,
 * LINE previews and Facebook cards are all generated for a Thai audience first.
 * The English UI is a toggle inside the app, not a second indexable site; there
 * is no `/en` route to give a second `<html lang>` to.
 */

/** Where the site actually lives. Cloudflare Pages, per `wrangler.toml`. */
const DEFAULT_SITE_URL = 'https://superheng-3yf.pages.dev';

/**
 * Turns the configured value into a bare origin, or rejects it.
 *
 * A malformed `EXPO_PUBLIC_SITE_URL` (`superheng.app`, a trailing path, an empty
 * string) would silently produce meta tags that point nowhere — and wrong
 * absolute URLs are worse than default ones, because they look authoritative to
 * every scraper that reads them. Anything that is not an `http(s)` origin falls
 * back to the real deployment.
 */
function resolveSiteUrl(raw: string | undefined): string {
  const candidate = (raw ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/i.test(candidate)) return DEFAULT_SITE_URL;
  return candidate;
}

export const SITE_NAME = 'SuperHeng';

/** Absolute origin, no trailing slash. */
export const SITE_URL = resolveSiteUrl(process.env.EXPO_PUBLIC_SITE_URL);

/**
 * The `<title>` and `og:title`. Deliberately the exact string the founder
 * supplied: it is the one line a search result shows, and "แพลตฟอร์ม" plus
 * "ระดับพรีเมียม" are the positioning words, not decoration.
 */
export const SITE_TITLE = 'SuperHeng - แพลตฟอร์มวิเคราะห์สถิติด้วย AI ระดับพรีเมียม';

/**
 * The `<meta name="description">` and `og:description`.
 *
 * 161 characters — under Google's ~160-character snippet cut-off, and it names
 * the four models because those are the query terms ("ARIMA", "Markov",
 * "Bayesian") a visitor would actually type.
 */
export const SITE_DESCRIPTION =
  'วิเคราะห์ความน่าจะเป็นและเจาะลึกสถิติด้วยโมเดล AI ขั้นสูง (ARIMA, Markov, Bayesian, Frequency) อัปเดตผลเรียลไทม์ แม่นยำระดับมืออาชีพ';

/** Served from `public/`, so it is copied to the site root on export. */
export const OG_IMAGE_PATH = '/og-image.png';

/** 1200×630 is the size Facebook, LINE and X crop against; 1.91:1. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const OG_IMAGE_ALT =
  'SuperHeng — แพลตฟอร์มวิเคราะห์สถิติด้วย AI ระดับพรีเมียม';

/**
 * Absolute, because scrapers do not resolve relative `og:image` paths: a
 * root-relative `/og-image.png` is shown as no image at all on several of them
 * (LINE and Facebook are the strict ones), which is the exact failure a share
 * card exists to prevent.
 */
export const OG_IMAGE_URL = `${SITE_URL}${OG_IMAGE_PATH}`;

/** Open Graph wants `ll_CC`; the document is Thai-first with an English toggle. */
export const OG_LOCALE = 'th_TH';
