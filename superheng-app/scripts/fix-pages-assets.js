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
 */

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');
const EXCLUDED_SEGMENT = 'node_modules';
const REPLACEMENT_SEGMENT = 'vendor';

/** Only these are rewritten; a binary asset can contain the byte sequence by chance. */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.html', '.json', '.txt', '.map']);

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
    console.log(`[fix-pages-assets] nothing to do: no "${EXCLUDED_SEGMENT}" directory under dist/.`);
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

  // Post-condition: nothing served by Pages may still point at an excluded path.
  const stillReferenced = [];
  for (const file of walk(DIST)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    if (fs.readFileSync(file, 'utf8').includes(`/${EXCLUDED_SEGMENT}/`)) {
      stillReferenced.push(path.relative(DIST, file));
    }
  }

  if (stillReferenced.length > 0) {
    console.error(
      `[fix-pages-assets] FAILED: these files still reference "/${EXCLUDED_SEGMENT}/", which Pages will not serve:\n` +
        stillReferenced.map((f) => `  - ${f}`).join('\n')
    );
    process.exit(1);
  }

  console.log('[fix-pages-assets] OK: no remaining references to an excluded path.');
}

main();
