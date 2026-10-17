import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * The web document shell, wrapped around every statically rendered page.
 *
 * ## Why this file exists
 *
 * `expo.web.favicon` in `app.json` is what Expo uses to write the icon *files*
 * — it does not add `<link rel="icon">` tags. Without this document the served
 * page had no icon links at all, so the tab fell back to requesting
 * `/favicon.ico`, which the dev server answered with Expo's template icon rather
 * than SuperHeng's mark.
 *
 * The paths below are root-relative because they name files in `public/`, which
 * Expo serves from the site root in development and copies into `dist/` on
 * export — unlike anything under `assets/`, which is bundled under a hashed URL
 * and therefore cannot be named in a `<link href>`.
 *
 * `favicon.ico` is listed first and without a `type`: browsers that understand
 * only that file still get a correct icon, and the PNGs after it give modern
 * browsers a size-appropriate one instead of scaling a 16px bitmap.
 *
 * ## SDK note
 *
 * From SDK 58 a custom document must also render the values from
 * `useServerDocumentContext()`. This project is on Expo 57, where the document
 * is the plain component below.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/*
          Tints the browser chrome to the app's own dark background
          (`Colors.dark.background`) instead of leaving a white band above a dark
          app on Android Chrome.
        */}
        <meta name="theme-color" content="#070B18" />

        {/* Matches the app's full-height layout on web; see the Expo default document. */}
        <ScrollViewStyleReset />

        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
      </head>
      <body>{children}</body>
    </html>
  );
}
