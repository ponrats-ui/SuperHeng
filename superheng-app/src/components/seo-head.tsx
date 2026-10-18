import Head from 'expo-router/head';

import {
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_URL,
  OG_IMAGE_WIDTH,
  OG_LOCALE,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
} from '@/lib/seo';

/**
 * The site's `<title>`, description, Open Graph and Twitter Card tags.
 *
 * ## Why these are not in `+html.tsx`
 *
 * They were, and the exported HTML showed why that is wrong. Expo Router wraps
 * the app in `react-helmet-async` for `expo-router/head`, and static rendering
 * writes helmet's own `<title data-rh="true">` into the document **before** any
 * tag the custom document renders. With the title typed into `+html.tsx` the page
 * ended up with two `<title>` elements, the first one empty:
 *
 *   <head><title data-rh="true"></title>…<title>SuperHeng - …</title>…
 *
 * Browsers and crawlers use the *first* title in the document, so the tab would
 * have read blank and search results would have had nothing to show. Rendering
 * through `Head` fills helmet's placeholder instead of competing with it, which
 * leaves exactly one title in exactly one place.
 *
 * ## Why it is in the root layout
 *
 * `Head` renders per route, and this is mounted above the navigator, so every
 * page gets the same tags without each screen remembering to ask. On SDK 57
 * helmet's output is part of the initial static HTML (SDK 58 moved this to
 * `generateMetadata()`); on native the component renders nothing.
 *
 * There is no canonical or `og:url` on purpose — see `lib/seo.ts` and
 * `DEPLOY.md` §7.4: one shared component cannot name eight different pages.
 */
export function SeoHead() {
  return (
    <Head>
      <title>{SITE_TITLE}</title>
      <meta name="description" content={SITE_DESCRIPTION} />
      <meta name="application-name" content={SITE_NAME} />
      <meta name="robots" content="index, follow, max-image-preview:large" />

      {/* Open Graph: LINE, Facebook, and X's fallback. */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content={SITE_NAME} />
      <meta property="og:title" content={SITE_TITLE} />
      <meta property="og:description" content={SITE_DESCRIPTION} />
      <meta property="og:image" content={OG_IMAGE_URL} />
      <meta property="og:image:secure_url" content={OG_IMAGE_URL} />
      <meta property="og:image:type" content="image/png" />
      <meta property="og:image:width" content={String(OG_IMAGE_WIDTH)} />
      <meta property="og:image:height" content={String(OG_IMAGE_HEIGHT)} />
      <meta property="og:image:alt" content={OG_IMAGE_ALT} />
      <meta property="og:locale" content={OG_LOCALE} />

      {/* Twitter / X reads its own tags first and falls back to Open Graph. */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={SITE_TITLE} />
      <meta name="twitter:description" content={SITE_DESCRIPTION} />
      <meta name="twitter:image" content={OG_IMAGE_URL} />
      <meta name="twitter:image:alt" content={OG_IMAGE_ALT} />
    </Head>
  );
}
