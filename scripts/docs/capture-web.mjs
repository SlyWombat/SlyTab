#!/usr/bin/env node
/**
 * Generate the web screenshots for the user manual (issue #104).
 *
 * Determinism is the entire point. A manual whose images wobble between runs
 * teaches everyone to ignore the diff, and then it goes stale unnoticed. So
 * every source of variation is nailed down here:
 *
 *   data     the seeded demo world (scripts/docs/demo-world.mjs) — fixed
 *            names, fixed amounts, pinned FX rate
 *   clock    frozen to demo-world TODAY, so "this month", relative dates and
 *            any date default never move
 *   viewport fixed per device (scripts/docs/shots.mjs), deviceScaleFactor 2
 *   theme    forced (default dark), colour-scheme forced to match
 *   locale   en-CA / America/Toronto, so currency and date formatting are the
 *            same on any machine and in CI
 *   motion   prefers-reduced-motion + transitions/animations/caret disabled,
 *            so nothing is captured mid-fade
 *   fonts    web fonts waited on before the shutter
 *
 * Alongside each PNG it records a `uiHash`: a normalised signature of the
 * visible text and the element skeleton of the captured screen. That is what
 * the staleness gate compares — pixels differ across Chromium builds and
 * would cry wolf, whereas a changed label, a new button or a reordered
 * section is exactly what the manual needs to be re-read for.
 *
 * Usage:
 *   node scripts/docs/capture-web.mjs --seed <seed.json> [--theme dark|light]
 *                                     [--only id,id] [--out docs/user-guide]
 */

import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { DEVICES, SHOTS } from './shots.mjs';
import { TODAY } from './demo-world.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const seed = JSON.parse(readFileSync(arg('seed', join(REPO, 'scripts/docs/.seed.json')), 'utf8'));
const THEME = arg('theme', 'dark');
const OUT = resolve(REPO, arg('out', 'docs/user-guide'));
const IMG_DIR = join(OUT, 'img', 'web');
const only = arg('only', '')?.split(',').filter(Boolean) ?? [];
const shots = only.length ? SHOTS.filter((s) => only.includes(s.id)) : SHOTS;

/** Kill every source of visual jitter that is not the app's actual design. */
const FREEZE_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
    caret-color: transparent !important;
  }
`;

/**
 * A signature of what the screen *says and contains*, not what it looks like.
 * Pixel hashes change when Chromium changes its text rasteriser; this changes
 * when the UI changes. Whitespace is collapsed and the token stream is capped
 * so an infinite list cannot make the hash depend on scroll position.
 */
function uiSignature() {
  const root = document.querySelector('#root') ?? document.body;
  const parts = [];
  const walk = (el, depth) => {
    if (depth > 14 || parts.length > 4000) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    // Genuinely per-device content (session labels, "last active 4 minutes
    // ago") is masked in the image and collapsed here, so it cannot make an
    // unchanged screen look changed. Everything masked must be justified in
    // shots.mjs — the escape hatch is small on purpose.
    if (el.hasAttribute('data-docs-mask')) { parts.push('<masked/>'); return; }
    const role = el.getAttribute('role') ?? '';
    const label = el.getAttribute('aria-label') ?? '';
    parts.push(`<${el.tagName.toLowerCase()}${role ? `:${role}` : ''}${label ? `[${label}]` : ''}`);
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.replace(/\s+/g, ' ').trim();
        if (t) parts.push(t);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        walk(node, depth + 1);
      }
    }
    parts.push('>');
  };
  walk(root, 0);
  return parts.join('');
}

async function main() {
  await mkdir(IMG_DIR, { recursive: true });
  const browser = await chromium.launch();
  const results = [];

  for (const shot of shots) {
    const device = DEVICES[shot.device];
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile ?? false,
      hasTouch: device.hasTouch ?? false,
      locale: 'en-CA',
      timezoneId: 'America/Toronto',
      colorScheme: THEME,
      reducedMotion: 'reduce',
      baseURL: seed.base,
    });
    // Sign the demo user in and pin the theme before the app boots, so no
    // login screen and no system-theme guess ever reaches the shutter.
    await context.addInitScript(
      ([token, theme]) => {
        if (token) localStorage.setItem('slytab.token', token);
        localStorage.setItem('slytab.theme', theme);
      },
      [shot.signedOut ? '' : seed.token, THEME],
    );

    const page = await context.newPage();

    // Count in-flight requests ourselves. `waitForLoadState('networkidle')` is
    // scoped to a navigation, so after an in-app click — which is every click
    // in a SPA — it returns instantly and the shutter fires on a screen whose
    // data has not arrived. That is exactly how the first run of this
    // pipeline produced a blank Balances tab.
    let inflight = 0;
    page.on('request', () => { inflight++; });
    page.on('requestfinished', () => { inflight--; });
    page.on('requestfailed', () => { inflight--; });

    await page.clock.install({ time: new Date(TODAY) });
    await page.goto('/');
    await page.addStyleTag({ content: FREEZE_CSS });

    const settle = async () => {
      // Quiet means *stayed* quiet: a render that fires a follow-up fetch
      // must not be mistaken for a finished screen.
      const deadline = Date.now() + 15_000;
      let quietFor = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(100); // driver-side, unaffected by the frozen page clock
        quietFor = inflight === 0 ? quietFor + 100 : 0;
        if (quietFor >= 500) break;
      }
      // Skeletons are the app saying "not yet" — never photograph one.
      await page.locator('.skeleton, [aria-busy="true"]').first()
        .waitFor({ state: 'detached', timeout: 5_000 }).catch(() => {});
      await page.evaluate(() => document.fonts?.ready);
      await page.waitForTimeout(150);
    };
    const dest = async (label) => {
      await page.getByRole('button', { name: label, exact: true }).first().click();
    };
    const openGroup = async (name) => {
      await dest('Groups');
      await page.getByText(name, { exact: true }).first().click();
      await page.getByRole('tab', { name: 'Expenses' }).waitFor();
    };

    try {
      await settle();
      await shot.steps({ page, dest, openGroup, settle });
      // A shot list is a claim about what each screen shows. `expect` makes
      // the claim checkable, so a screen that silently lost its content
      // fails the build instead of quietly shipping an empty picture.
      for (const want of shot.expect ?? []) {
        await page.getByText(want, { exact: false }).first().waitFor({ timeout: 5_000 });
      }
      await page.mouse.move(0, 0); // no stray hover state in the image

      // Tag the volatile regions once; both the image and the signature then
      // agree on what is being left out.
      const masks = [];
      for (const m of shot.mask ?? []) {
        const loc = m.hasText
          ? page.locator(m.selector).filter({ hasText: m.hasText })
          : page.locator(m.selector);
        for (let i = 0; i < await loc.count(); i++) {
          await loc.nth(i).evaluate((el) => el.setAttribute('data-docs-mask', ''));
        }
        masks.push(page.locator('[data-docs-mask]'));
      }

      const file = join(IMG_DIR, `${shot.id}.png`);
      await page.screenshot({
        path: file,
        animations: 'disabled',
        scale: 'device',
        fullPage: shot.fullPage ?? false,
        mask: masks,
        maskColor: '#141b28',
      });
      const sig = await page.evaluate(uiSignature);
      results.push({
        id: shot.id,
        screen: shot.screen,
        title: shot.title,
        device: shot.device,
        theme: THEME,
        image: `img/web/${shot.id}.png`,
        sources: shot.sources,
        doc: shot.doc,
        uiHash: createHash('sha256').update(sig).digest('hex').slice(0, 16),
      });
      console.error(`  ✓ ${shot.id}`);
    } catch (e) {
      console.error(`  ✗ ${shot.id}: ${e.message.split('\n')[0]}`);
      // A shot that cannot be taken means the UI moved out from under the
      // shot list. That is a docs failure, not a warning to scroll past.
      results.push({ id: shot.id, screen: shot.screen, error: e.message.split('\n')[0] });
    } finally {
      await context.close();
    }
  }

  await browser.close();
  await writeFile(join(OUT, 'shots.web.json'), JSON.stringify({
    generatedFor: { seedRev: seed.seedRev, today: TODAY, theme: THEME },
    shots: results,
  }, null, 2) + '\n');

  const failed = results.filter((r) => r.error);
  console.error(`${results.length - failed.length}/${results.length} web shots captured → ${IMG_DIR}`);
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
