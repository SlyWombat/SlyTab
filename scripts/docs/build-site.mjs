/**
 * Render the user documentation into the web app's public tree (#104, #105).
 *
 * The manual is written once, in `docs/user-guide/manual.md`, with anchors the
 * shot list already points at. This turns it into a page, drops the generated
 * screenshots in beside their sections, and copies the images across — so the
 * published manual is a *product* of the pipeline rather than a second copy of
 * the words that can drift from the first.
 *
 * Deliberately a small hand-rolled renderer rather than a markdown dependency:
 * the input is one file we control, the subset used is headings, paragraphs,
 * lists, tables, code and emphasis, and adding a toolchain to the web build for
 * that would cost more than it saves.
 *
 *   node scripts/docs/build-site.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const GUIDE = join(REPO, 'docs/user-guide');
const OUT = join(REPO, 'apps/web/public/guide');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline: `code`, **bold**, *italic*, [text](href). Escaped first. */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function render(md, shotsByAnchor) {
  const lines = md.split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  let inList = null;

  const closeList = () => { if (inList) { out.push(`</${inList}>`); inList = null; } };

  while (i < lines.length) {
    const line = lines[i];

    // heading, optionally carrying {#anchor}
    const h = /^(#{1,3})\s+(.*?)(?:\s*\{#([\w-]+)\})?\s*$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      const text = h[2];
      const id = h[3] ?? text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-|-$/g, '');
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      if (level === 2) toc.push({ id, text });

      // Every shot that names this anchor lands directly under its heading —
      // the join the shot list has been carrying all along.
      for (const shot of shotsByAnchor.get(id) ?? []) {
        out.push(
          `<figure class="shot">`
          + `<img src="${shot.image}" alt="${esc(shot.title)}" loading="lazy" decoding="async">`
          + `<figcaption>${inline(shot.title)}</figcaption></figure>`,
        );
      }
      i++;
      continue;
    }

    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }
    if (line.trim() === '') { closeList(); i++; continue; }

    // table
    if (line.startsWith('|') && /^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      closeList();
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      out.push('<div class="tablewrap"><table><thead><tr>');
      for (const c of cells(line)) out.push(`<th>${inline(c)}</th>`);
      out.push('</tr></thead><tbody>');
      i += 2;
      while (i < lines.length && lines[i].startsWith('|')) {
        out.push('<tr>' + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i++;
      }
      out.push('</tbody></table></div>');
      continue;
    }

    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const want = /^\d/.test(li[2]) ? 'ol' : 'ul';
      if (inList !== want) { closeList(); out.push(`<${want}>`); inList = want; }
      out.push(`<li>${inline(li[3])}</li>`);
      i++;
      continue;
    }

    closeList();
    const para = [line];
    while (i + 1 < lines.length && lines[i + 1].trim() !== ''
           && !/^[-*#|]|^\d+\./.test(lines[i + 1])) { para.push(lines[++i]); }
    out.push(`<p>${inline(para.join(' '))}</p>`);
    i++;
  }
  closeList();
  return { html: out.join('\n'), toc };
}

function page({ title, description, body, toc }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="./guide.css">
</head>
<body>
<div class="wrap">
  <div class="top">
    <a class="brand" href="../welcome/"><span class="mark" aria-hidden>S</span>
      <span class="wordmark">SlyTab</span></a>
    <span class="sp"></span>
    <a class="btn" href="../">Open the app</a>
  </div>
  <div class="cols">
    <nav class="toc" aria-label="Contents">
      <p class="tochead">Contents</p>
      ${toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('\n      ')}
    </nav>
    <main class="doc">
${body}
    </main>
  </div>
  <footer>
    <a href="../welcome/">About SlyTab</a>
    <a href="../marketing/support/">Support</a>
    <a href="../marketing/privacy/">Privacy</a>
    <a href="../">Open the app</a>
    <p>Screenshots on this page are generated from the running app, so they
       cannot fall out of date with it.</p>
  </footer>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------- build ----
mkdirSync(join(OUT, 'img/web'), { recursive: true });

const shots = JSON.parse(readFileSync(join(GUIDE, 'shots.web.json'), 'utf8')).shots ?? [];
const byAnchor = new Map();
for (const s of shots) {
  const a = s.doc?.anchor;
  if (!a) continue;
  if (!byAnchor.has(a)) byAnchor.set(a, []);
  byAnchor.get(a).push(s);
}

const md = readFileSync(join(GUIDE, 'manual.md'), 'utf8');
const { html, toc } = render(md, byAnchor);
writeFileSync(join(OUT, 'index.html'), page({
  title: 'SlyTab — the manual',
  description: 'How to use SlyTab: splitting expenses, several currencies, receipts, settling up.',
  body: html,
  toc,
}));

// Images, copied rather than referenced across trees so the published page is
// self-contained and `npm run deploy` needs no special case.
let copied = 0;
for (const f of readdirSync(join(GUIDE, 'img/web'))) {
  copyFileSync(join(GUIDE, 'img/web', f), join(OUT, 'img/web', f));
  copied++;
}

// A missing image is a broken manual, so say so loudly rather than shipping it.
const missing = shots.filter((s) => {
  try { readFileSync(join(OUT, s.image)); return false; } catch { return true; }
});
if (missing.length) {
  console.error(`  MISSING IMAGES: ${missing.map((m) => m.id).join(', ')}`);
  process.exit(1);
}

console.log(`  manual: ${toc.length} sections, ${shots.length} shots placed, ${copied} images copied`);
console.log(`  -> ${OUT}/index.html`);
