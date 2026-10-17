#!/usr/bin/env node
/**
 * Rename node_modules-sourced assets so Cloudflare Pages will actually upload
 * them.
 *
 * WHY THIS EXISTS
 *
 * `expo export -p web` mirrors the *source* path of every bundled asset into
 * `dist/assets/`. Assets that come from a dependency therefore land under
 * `dist/assets/node_modules/...` — the Material Symbols icon font and
 * expo-router's navigation icons do exactly that.
 *
 * Cloudflare Pages will not upload those files. Its migration guide says so
 * directly:
 *
 *   "Pages would automatically exclude some files and folders from being
 *    uploaded as static assets such as node_modules, .DS_Store, and .git."
 *   https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/
 *
 * The failure is quiet and misleading. The build SUCCEEDS, the log reports
 * fewer files uploaded than the output directory contains, and every excluded
 * URL then falls through to Pages' single-page-app fallback — so a request for
 * a `.ttf` returns `index.html` with HTTP 200. The browser reports it as
 * `Failed to decode downloaded font: ... invalid sfntVersion: 1008813235`
 * (that number is `<!DO`, the start of `<!DOCTYPE html>`), and the icon font
 * silently renders as empty boxes rather than erroring.
 *
 * There is no Pages setting to opt these paths back in: the exclusion applies
 * to Git-integrated builds and to `wrangler pages deploy` alike, and
 * `.assetsignore` is a Workers Static Assets feature, not a Pages one. So the
 * fix has to be on our side of the upload: move the files to a path Pages is
 * willing to serve, and rewrite the references to match.
 *
 * WHAT IT DOES
 *
 *   dist/assets/**\/node_modules  ->  dist/assets/**\/vendor
 *
 * then rewrites every reference to the old path in the text files Pages serves
 * (the bundle stores them as absolute literals, e.g.
 * `m.exports={uri:"/assets/node_modules/expo-router/assets/back-icon.png"}`).
 *
 * It is deliberately idempotent (a second run is a no-op) and it exits
 * non-zero if any excluded path is still referenced afterwards, so a future
 * Expo or Pages change fails the build loudly instead of quietly shipping a
 * site with broken fonts again.
 *
 * WHAT THE CHECK LOOKS FOR, AND WHY IT IS NOT A SUBSTRING SEARCH
 *
 * The first version of this guard failed the build if `/node_modules/`
 * appeared anywhere in a served text file. That is wrong, and it broke every
 * Pages deploy for a week: bundlers inline dependency *metadata*, and a
 * package.json can legitimately contain that text without referencing an asset
 * at all. Two real examples from this project's own bundle:
 *
 *   "testPathIgnorePatterns":["/node_modules/","./platforms/"]
 *   NODE_PATH="${PATH%%/node_modules/.bin*}/node_modules" node scripts/...
 *
 * Neither is a file Pages is asked for. The invariant that actually matters is
 * "no *asset reference* points into an excluded directory", so the guard now
 * looks for that specifically: an excluded segment followed by a path ending in
 * a web-asset extension, which is how Expo spells every bundled asset. A stray
 * string in inlined metadata has no extension and no longer fails the build,
 * while a genuine survivor — `/assets/node_modules/x/back-icon.png` — still
 * does.
 *
 * The check runs on every invocation, including one where there was nothing to
 * move, so re-running it against an already-processed `dist/` still verifies
 * the post-condition instead of reporting success by doing nothing.
 */

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');
const EXCLUDED_SEGMENT = 'node_modules';
const REPLACEMENT_SEGMENT = 'vendor';

/** Only these are rewritten; a binary asset can contain the byte sequence by chance. */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.map']);

/**
 * File types Expo serves as bundled assets. An excluded path only breaks the
 * site if it is a reference to one of these; see the header note.
 */
const ASSET_EXTENSIONS =
  'ttf|otf|ttc|woff2?|eot|png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|webm|mov|mp3|wav|m4a|json|wasm|db';

/**
 * A reference into an excluded directory of something Pages will be asked to
 * serve: `node_modules/` (optionally with more directories after it) ending in
 * an asset extension. Deliberately not anchored to a leading slash or a quote,
 * so it also catches relative spellings; the extension anchor is what keeps it
 * from matching prose in inlined metadata.
 */
const EXCLUDED_ASSET_REFERENCE = new RegExp(
  `${EXCLUDED_SEGMENT}/(?:[^"'\\s]*/)?[^"'\\s]*\\.(?:${ASSET_EXTENSIONS})\\b`,
  'g'
);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Every directory named `node_modules` at any depth under dist/. */
function findExcludedDirs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === EXCLUDED_SEGMENT) out.push(full);
    else out.push(...findExcludedDirs(full));
  }
  return out;
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`[fix-pages-assets] no dist/ at ${DIST} — run this after 'expo export -p web'.`);
    process.exit(1);
  }

  // Deepest first, so that renaming a parent never invalidates a child path.
  const dirs = findExcludedDirs(DIST).sort((a, b) => b.length - a.length);

  if (dirs.length === 0) {
    console.log(
      `[fix-pages-assets] nothing to move: no "${EXCLUDED_SEGMENT}" directory under dist/.`
    );
    assertNoExcludedAssetReferences();
    return;
  }

  // Map the old path prefix to the new one, as the exported code spells it:
  // an absolute URL rooted at the site, e.g. "/assets/node_modules/".
  const replacements = [];

  for (const from of dirs) {
    const to = path.join(path.dirname(from), REPLACEMENT_SEGMENT);
    const relFrom = path.relative(DIST, from).split(path.sep).join('/');
    const relTo = path.relative(DIST, to).split(path.sep).join('/');

    if (fs.existsSync(to)) {
      console.error(
        `[fix-pages-assets] refusing to merge: ${relTo} already exists.\n` +
          `Move or remove it, or pick a different replacement name.`
      );
      process.exit(1);
    }

    fs.renameSync(from, to);
    replacements.push([`/${relFrom}/`, `/${relTo}/`]);
    console.log(`[fix-pages-assets] ${relFrom}/ -> ${relTo}/`);
  }

  let rewritten = 0;
  let occurrences = 0;

  for (const file of walk(DIST)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

    const before = fs.readFileSync(file, 'utf8');
    let after = before;
    for (const [from, to] of replacements) {
      const hits = after.split(from).length - 1;
      if (hits === 0) continue;
      occurrences += hits;
      after = after.split(from).join(to);
    }
    if (after === before) continue;

    fs.writeFileSync(file, after);
    rewritten += 1;
    console.log(`[fix-pages-assets] rewrote ${path.relative(DIST, file)}`);
  }

  console.log(
    `[fix-pages-assets] moved ${dirs.length} directory(s), rewrote ${occurrences} reference(s) in ${rewritten} file(s).`
  );

  assertNoExcludedAssetReferences();
}

/**
 * The post-condition: nothing Pages is asked to serve may point into an
 * excluded directory. Fails the build (non-zero) rather than shipping a broken
 * font or image, and prints the offending excerpt so the next reader does not
 * have to re-derive which asset survived.
 */
function assertNoExcludedAssetReferences() {
  const offenders = [];

  for (const file of walk(DIST)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

    const text = fs.readFileSync(file, 'utf8');
    const found = [...text.matchAll(EXCLUDED_ASSET_REFERENCE)];
    if (found.length === 0) continue;

    offenders.push({
      file: path.relative(DIST, file),
      excerpt: found[0][0].slice(0, 120),
    });
  }

  if (offenders.length > 0) {
    console.error(
      `[fix-pages-assets] FAILED: these files still reference an asset under "${EXCLUDED_SEGMENT}/", ` +
        'which Pages will not serve:\n' +
        offenders.map((o) => `  - ${o.file}\n      ${o.excerpt}`).join('\n')
    );
    process.exit(1);
  }

  // No directory named node_modules may remain either: Pages excludes the path
  // itself, so an asset still sitting there would 404 even if unreferenced.
  const leftovers = findExcludedDirs(DIST);
  if (leftovers.length > 0) {
    console.error(
      `[fix-pages-assets] FAILED: these directories are still named "${EXCLUDED_SEGMENT}" ` +
        'and Pages will not upload them:\n' +
        leftovers.map((d) => `  - ${path.relative(DIST, d)}`).join('\n')
    );
    process.exit(1);
  }

  console.log(
    `[fix-pages-assets] OK: no asset reference and no directory uses an excluded "${EXCLUDED_SEGMENT}" path.`
  );
}

main();
