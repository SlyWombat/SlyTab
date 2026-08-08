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

/**
 * The domain whose document root IS this directory (slytab.com).
 *
 * Set it and the app is built for the root of that domain instead of for a
 * subdirectory of the old one. Both hostnames still resolve here — that is the
 * point, and the reason this is not simply a move. The phone apps have
 * https://electricrv.ca/slytab/api/v1 compiled into every installed copy, so
 * that path has to keep answering until every one of them has been replaced,
 * which is a store release away and outside this script's control.
 *
 * So: same directory, two doors. slytab.com serves the app; electricrv.ca
 * keeps serving the API and sends everything else next door.
 */
// Command line wins over the env file, so this can be tried once before it is
// written down — the first deploy under a new domain is the one you most want
// to be able to take back.
const PRIMARY_HOST = process.env.PRIMARY_HOST || env.PRIMARY_HOST || '';
const LEGACY_BASE = sub ? `${sub}/` : '/';
const DEPLOY_BASE = PRIMARY_HOST ? '/' : LEGACY_BASE;
console.log(`▸ Vite base for this deploy: ${DEPLOY_BASE}`);
if (PRIMARY_HOST) {
  console.log(`▸ Primary host: ${PRIMARY_HOST} (legacy ${LEGACY_BASE} keeps serving the API)`);
}

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

# Force HTTPS.
#
# The apex redirects, but this directory did not: a security review on
# 2026-08-02 found http://electricrv.ca/slytab/api/v1/health answering 200 in
# cleartext. Turning RewriteEngine on here replaces the inherited rules rather
# than adding to them, which is how the redirect was lost. Session tokens are
# long-lived bearer tokens, so anyone who could get a client onto http:// read
# them off the wire.
#
# X-Forwarded-Proto is checked too: %{HTTPS} is not reliably set behind a
# terminating proxy, and without it this rule can loop.
# ...except the ACME challenge path. A certificate authority proving a new
# domain fetches over http, and sending it to https for a certificate that does
# not exist yet is how a domain never gets one. Nothing secret lives under
# .well-known/acme-challenge; it is a nonce the CA just handed out.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</IfModule>

# ...and having forced it, tell the browser not to try plaintext again.
# Deliberately no includeSubDomains and no preload: this domain hosts other
# projects, a subdomain still served over http would break, and preload is
# effectively irreversible. Both are worth adding once every subdomain is
# confirmed HTTPS-only.
<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=31536000"
</IfModule>

${PRIMARY_HOST ? `# One directory, two hostnames.
#
# The app is built for the root of ${PRIMARY_HOST}, so its assets are at
# /assets/… — correct there, and wrong under the old ${LEGACY_BASE} path where
# the same index.html would look for them at the domain root. Rather than keep
# two builds, requests on the old host are sent here.
#
# The API is the exception, and not a small one: every installed copy of the
# phone app has ${LEGACY_BASE}api/v1 compiled in and cannot be changed without
# a store release. Redirecting it would break every phone at once, so it is
# excluded before anything else and keeps answering on the old host forever.
#
# 302, not 301. A permanent redirect is cached by browsers for a long time and
# would have to be un-taught if the arrangement ever changes.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteCond %{REQUEST_URI} !^${LEGACY_BASE}api/
  RewriteCond %{HTTP_HOST} !^(www\\.)?${PRIMARY_HOST.replace(/\./g, '\\.')}$ [NC]
  RewriteRule ^(.*)$ https://${PRIMARY_HOST}/$1 [R=302,L]
</IfModule>

` : ''}# SPA fallback — /api is real (the PHP front controller), everything else
# that isn't a file resolves to index.html.
#
# .well-known is excluded, and that is not housekeeping. Apple verifies a
# domain by fetching /.well-known/apple-developer-domain-association.txt; with
# the fallback catching it, that request got 200 and a page of HTML instead of
# a 404 or the token. Apple reads that as a failed verification and then
# silently refuses to save the domain — which presents as settings that will
# not stick, with nothing anywhere saying why (#117). The same applies to every
# other well-known probe: an SPA should not be answering for paths reserved by
# RFC 8615.
<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase ${DEPLOY_BASE}
  RewriteCond %{REQUEST_URI} !${DEPLOY_BASE}api/
  RewriteCond %{REQUEST_URI} !/\.well-known/
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME} !-d
  RewriteRule ^ index.html [L]
</IfModule>
`;
const tmpHt = join(DIST_DIR, '.htaccess');
await writeFile(tmpHt, htaccess);
await uploadOne(tmpHt, env.WEB_ROOT, '.htaccess');

console.log(`\n✓ Deploy complete. Live at ${PRIMARY_HOST
  ? `https://${PRIMARY_HOST}/  (API also on https://electricrv.ca${LEGACY_BASE}api/v1 for installed apps)`
  : `https://electricrv.ca${DEPLOY_BASE}`}`);
console.log(`  Version: ${pkg.version}+${gitSha}`);
