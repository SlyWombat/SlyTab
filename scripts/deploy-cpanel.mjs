#!/usr/bin/env node
// SlyTab SPA deploy — adapted from CaseMaker's deploy-cpanel.mjs.
//
// Builds apps/web and uploads dist/ to the cPanel host via UAPI
// Fileman::upload_files over HTTPS token auth. No FTP, no SSH.
//
// .env required keys: CPANEL_HOST, CPANEL_PORT (default 2083), CPANEL_USER,
// CPANEL_TOKEN, WEB_ROOT (e.g. /home/USER/public_html/slytab).
//
// Usage:
//   npm run deploy                    # build + upload
//   npm run deploy -- --skip-build    # upload existing dist/ as-is
//   npm run deploy -- --dry-run       # walk + log without uploading
//
// The API (api/) deploys separately — see docs/architecture.md §9.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'web');
const DIST_DIR = join(APP_DIR, 'dist');
const ENV_PATH = join(REPO_ROOT, '.env');

function loadEnv(path) {
  if (!existsSync(path)) {
    console.error(`error: .env not found at ${path}`);
    process.exit(1);
  }
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const args = process.argv.slice(2);
const SKIP_BUILD = args.includes('--skip-build');
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

const env = loadEnv(ENV_PATH);
for (const k of ['CPANEL_HOST', 'CPANEL_USER', 'CPANEL_TOKEN', 'WEB_ROOT']) {
  if (!env[k]) {
    console.error(`error: ${k} missing from .env`);
    process.exit(1);
  }
}

// Refuse to deploy into the site root (CaseMaker issue #81's guard).
const SITE_ROOT_TAILS = new Set(['public_html', 'www', 'htdocs', 'html']);
const tail = env.WEB_ROOT.replace(/\/+$/, '').split('/').pop() ?? '';
if (SITE_ROOT_TAILS.has(tail)) {
  console.error(
    `error: WEB_ROOT (${env.WEB_ROOT}) looks like the site root.\n` +
    `       Use a subdirectory like ${env.WEB_ROOT}/slytab. Update .env and rerun.`,
  );
  process.exit(2);
}
const PORT = env.CPANEL_PORT || '2083';

console.log(`Deploying to ${env.CPANEL_USER}@${env.CPANEL_HOST}:${PORT}`);
console.log(`Remote path: ${env.WEB_ROOT}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${SKIP_BUILD ? ' (skip build)' : ''}\n`);

// Derive the Vite base from WEB_ROOT: /home/U/public_html/slytab → /slytab/
const m = env.WEB_ROOT.match(/\/public_html(\/.*)?$/);
const sub = (m?.[1] ?? '').replace(/\/+$/, '');
const DEPLOY_BASE = sub ? `${sub}/` : '/';
console.log(`▸ Vite base for this deploy: ${DEPLOY_BASE}`);

if (!SKIP_BUILD) {
  console.log('▸ Building apps/web/dist/...');
  const result = spawnSync('npm', ['run', 'build', '-w', '@slytab/web'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DEPLOY_BASE },
  });
  if (result.status !== 0) {
    console.error('error: build failed');
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(DIST_DIR)) {
  console.error(`error: ${DIST_DIR} doesn't exist — run without --skip-build first`);
  process.exit(1);
}

// Stamp version + git sha (visible confirmation of what's live).
const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
let gitSha = 'nogit';
try {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT });
  gitSha = (r.stdout?.toString() ?? '').trim() || gitSha;
} catch { /* */ }
await writeFile(join(DIST_DIR, 'VERSION.txt'), `${pkg.version}+${gitSha}\n${new Date().toISOString()}\n`);
console.log(`▸ Stamped: ${pkg.version}+${gitSha}`);

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else if (entry.isFile()) out.push({ full, rel: relative(base, full), size: (await stat(full)).size });
  }
  return out;
}

const files = await walk(DIST_DIR);
console.log(`▸ Found ${files.length} files, ${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(2)} MB`);

if (DRY_RUN) {
  for (const f of files) console.log(`  ${f.rel} (${f.size} B)`);
  console.log('\nDRY RUN complete — nothing uploaded.');
  process.exit(0);
}

const baseUrl = `https://${env.CPANEL_HOST}:${PORT}`;
const auth = `cpanel ${env.CPANEL_USER}:${env.CPANEL_TOKEN}`;

async function ensureDir(remoteDir) {
  const url = new URL('/execute/Fileman/mkdir', baseUrl);
  url.searchParams.set('path', dirname(remoteDir));
  url.searchParams.set('name', remoteDir.split('/').pop() ?? '');
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok && VERBOSE) console.warn(`mkdir ${remoteDir}: HTTP ${r.status}`);
}

async function uploadOne(localPath, remoteDir, name) {
  const buf = await readFile(localPath);
  const fd = new FormData();
  fd.append('dir', remoteDir);
  fd.append('overwrite', '1');
  fd.append('file-1', new Blob([buf]), name);
  const url = new URL('/execute/Fileman/upload_files', baseUrl);
  const r = await fetch(url, { method: 'POST', headers: { Authorization: auth }, body: fd });
  if (!r.ok) throw new Error(`upload ${name}: HTTP ${r.status} ${await r.text()}`);
  const body = await r.json();
  if (body.errors && body.errors.length) throw new Error(`upload ${name}: ${JSON.stringify(body.errors)}`);
}

const remoteDirs = new Set([env.WEB_ROOT]);
for (const f of files) {
  const s = dirname(f.rel);
  if (s && s !== '.') remoteDirs.add(`${env.WEB_ROOT}/${s.replace(/\\/g, '/')}`);
}
console.log(`▸ Ensuring ${remoteDirs.size} remote directories...`);
for (const d of remoteDirs) await ensureDir(d);

console.log(`▸ Uploading ${files.length} files...`);
let done = 0;
for (const f of files) {
  const s = dirname(f.rel).replace(/\\/g, '/');
  const remoteDir = s === '.' ? env.WEB_ROOT : `${env.WEB_ROOT}/${s}`;
  await uploadOne(f.full, remoteDir, f.rel.split(/[\\/]/).pop() ?? '');
  done++;
  if (done % 10 === 0 || done === files.length) process.stdout.write(`\r  ${done}/${files.length}`);
}
process.stdout.write('\n');

// .htaccess: asset caching + SPA fallback (client routes exist in SlyTab).
const htaccess = `# Auto-generated by scripts/deploy-cpanel.mjs — do not hand-edit on the host.

<IfModule mod_headers.c>
  <FilesMatch "\\.(js|css|map|svg|woff2)$">
    Header set Cache-Control "max-age=31536000, immutable"
  </FilesMatch>
  <FilesMatch "\\.html$">
    Header set Cache-Control "no-cache, must-revalidate"
  </FilesMatch>
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE application/javascript text/css application/json image/svg+xml
</IfModule>

# SPA fallback — /api is real (the PHP front controller), everything else
# that isn't a file resolves to index.html.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase ${DEPLOY_BASE}
  RewriteCond %{REQUEST_URI} !${DEPLOY_BASE}api/
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
`;
const tmpHt = join(DIST_DIR, '.htaccess');
await writeFile(tmpHt, htaccess);
await uploadOne(tmpHt, env.WEB_ROOT, '.htaccess');

console.log(`\n✓ Deploy complete. Live at https://electricrv.ca${DEPLOY_BASE}`);
console.log(`  Version: ${pkg.version}+${gitSha}`);
