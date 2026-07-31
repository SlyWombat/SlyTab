#!/usr/bin/env node
/**
 * The staleness gate (issue #104).
 *
 * Generated screenshots can never be stale — they are rebuilt from the app.
 * The *prose* can, and silently: someone renames a button, ships it, and the
 * manual keeps describing the old one. Nothing in a normal test suite notices,
 * because nothing in a test suite reads English.
 *
 * So this compares three fingerprints per documented screen:
 *
 *   uiHash    what the screen says and contains, taken at capture time
 *             (normalised text + element skeleton — not pixels, which change
 *             when Chromium changes its rasteriser)
 *   srcHash   the files that render it (shots.mjs `sources`)
 *   proseHash the section of the manual that explains it
 *
 * docs/user-guide/docs-state.json records, per screen, the uiHash and srcHash
 * that a human last accepted the prose against. The gate fails when either
 * has moved and the prose has not been re-accepted since:
 *
 *     ✗ group-balances: the screen changed and its documentation did not
 *         uiHash  a91f… → 4c02…
 *         read    docs/user-guide/manual.md#group-balances, then:
 *                 node scripts/docs/check-docs.mjs --accept group-balances
 *
 * `--accept` is deliberately per-screen and deliberately manual. A blanket
 * "accept everything" would turn the gate into a rubber stamp, which is the
 * same as not having one.
 *
 * It also checks the two things that make a manual quietly incomplete:
 *   - every screen in ui_requirements.md §4 (v1.0 checklist) has a shot;
 *   - every shot's prose anchor actually exists in the manual.
 *
 * Exit 0 = the docs are current. Non-zero = someone has reading to do.
 *
 * Usage:
 *   node scripts/docs/check-docs.mjs                 # gate
 *   node scripts/docs/check-docs.mjs --accept <id>   # re-stamp one screen
 *   node scripts/docs/check-docs.mjs --accept-all    # after a bulk rewrite
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, UNSHOT } from './shots.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = join(REPO, 'docs', 'user-guide');
const STATE_FILE = join(GUIDE, 'docs-state.json');
const UI_REQS = join(REPO, 'docs', 'design', 'ui_requirements.md');

const argv = process.argv.slice(2);
const acceptAll = argv.includes('--accept-all');
const acceptIds = argv.reduce((acc, a, i) => (argv[i - 1] === '--accept' ? [...acc, a] : acc), []);
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

function loadCaptures() {
  const out = new Map();
  for (const f of ['shots.web.json', 'shots.android.json']) {
    const p = join(GUIDE, f);
    if (!existsSync(p)) continue;
    for (const s of JSON.parse(readFileSync(p, 'utf8')).shots ?? []) out.set(s.id, s);
  }
  return out;
}

/** Hash the files that render a screen. Globs are one level of `**` only. */
async function srcHash(patterns) {
  const files = [];
  for (const pat of patterns) {
    if (pat.includes('**')) {
      const base = join(REPO, pat.split('**')[0]);
      if (!existsSync(base)) continue;
      for (const e of await readdir(base, { withFileTypes: true, recursive: true })) {
        if (e.isFile()) files.push(join(e.parentPath ?? e.path, e.name));
      }
    } else if (existsSync(join(REPO, pat))) {
      files.push(join(REPO, pat));
    } else {
      // A source file that no longer exists is itself news: the screen was
      // rewritten or moved and the shot list was not updated.
      files.push(`MISSING:${pat}`);
    }
  }
  const parts = [];
  for (const f of files.sort()) {
    parts.push(f.startsWith('MISSING:') ? f : `${relative(REPO, f)}:${sha(await readFile(f, 'utf8'))}`);
  }
  return { hash: sha(parts.join('\n')), missing: parts.filter((p) => p.startsWith('MISSING:')) };
}

/**
 * The prose for a screen: everything under the heading carrying
 * `<a id="anchor">` (or a matching `{#anchor}`), up to the next heading of
 * the same or higher level.
 */
function proseSection(markdown, anchor) {
  const lines = markdown.split('\n');
  const idx = lines.findIndex((l) =>
    l.includes(`id="${anchor}"`) || l.includes(`{#${anchor}}`) || l.includes(`<!-- anchor:${anchor} -->`));
  if (idx === -1) return null;
  let start = idx;
  while (start > 0 && !/^#{1,6} /.test(lines[start])) start--;
  const level = (lines[start].match(/^#+/) ?? ['#'])[0].length;
  const body = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6}) /);
    if (m && m[1].length <= level) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

/** Screens named in ui_requirements.md §4 — the "did we document everything" list. */
function checklistScreens() {
  if (!existsSync(UI_REQS)) return [];
  const md = readFileSync(UI_REQS, 'utf8');
  const sect = md.split(/^## 4\. /m)[1];
  if (!sect) return [];
  return [...sect.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

async function main() {
  const captures = loadCaptures();
  const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { screens: {} };
  state.screens ??= {};

  const problems = [];
  const notes = [];

  for (const shot of SHOTS) {
    const cap = captures.get(shot.id);
    if (!cap) {
      problems.push(`${shot.id}: no capture — run scripts/docs/make-docs.sh before the gate`);
      continue;
    }
    if (cap.error) {
      problems.push(`${shot.id}: capture failed (${cap.error}) — the shot list no longer matches the UI`);
      continue;
    }

    const src = await srcHash(shot.sources);
    for (const m of src.missing) {
      problems.push(`${shot.id}: ${m.replace('MISSING:', 'source no longer exists: ')} (fix shots.mjs)`);
    }

    const docPath = join(REPO, shot.doc.file);
    const md = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
    const section = md ? proseSection(md, shot.doc.anchor) : null;
    if (section === null) {
      problems.push(`${shot.id}: ${shot.doc.file} has no section anchored '${shot.doc.anchor}'`);
      continue;
    }
    if (!section.includes(cap.image)) {
      problems.push(`${shot.id}: the '${shot.doc.anchor}' section does not embed ${cap.image}`);
    }

    const now = { uiHash: cap.uiHash, srcHash: src.hash, proseHash: sha(section) };
    const was = state.screens[shot.id];

    if (acceptAll || acceptIds.includes(shot.id) || !was) {
      state.screens[shot.id] = { ...now, acceptedAt: new Date().toISOString().slice(0, 10) };
      notes.push(`${was ? 'accepted' : 'first record'}: ${shot.id}`);
      continue;
    }
    if (was.uiHash !== now.uiHash || was.srcHash !== now.srcHash) {
      const what = [
        was.uiHash !== now.uiHash ? `  uiHash   ${was.uiHash} → ${now.uiHash}  (what the screen says changed)` : null,
        was.srcHash !== now.srcHash ? `  srcHash  ${was.srcHash} → ${now.srcHash}  (the code that draws it changed)` : null,
      ].filter(Boolean).join('\n');
      problems.push(
        `${shot.id}: the screen changed and its documentation did not\n${what}\n` +
        `  read     ${shot.doc.file}#${shot.doc.anchor}, update it if needed, then:\n` +
        `           node scripts/docs/check-docs.mjs --accept ${shot.id}`,
      );
    } else if (was.proseHash !== now.proseHash) {
      // Prose edited on its own — fine, just re-stamp it.
      state.screens[shot.id] = { ...was, proseHash: now.proseHash };
    }
  }

  // Coverage: a screen on the v1.0 checklist with no shot at all.
  const covered = SHOTS.map((s) => s.screen.toLowerCase());
  for (const screen of checklistScreens()) {
    const key = screen.toLowerCase().split(/[(/]/)[0].trim();
    const head = key.split(/\s+/)[0];
    if (covered.some((c) => c.includes(head))) continue;
    if (UNSHOT[screen]) {
      notes.push(`no shot for "${screen}" — ${UNSHOT[screen]}`);
    } else {
      problems.push(`coverage: ui_requirements.md §4 lists "${screen}" but no shot in shots.mjs covers it`);
    }
  }

  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  for (const n of notes) console.log(`  · ${n}`);

  if (problems.length) {
    console.error(`\nuser documentation is stale — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`✗ ${p}\n`);
    process.exit(1);
  }
  console.log(`docs current: ${SHOTS.length} screens, all prose accepted against the shipped UI`);
}

main().catch((e) => { console.error(e); process.exit(1); });
