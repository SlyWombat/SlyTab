#!/usr/bin/env node
/**
 * Build the documentation demo world through the real API (issue #104).
 *
 * Why the API and not SQL: a fixture written in SQL is a second, private
 * definition of the data model, and it rots the first time a column moves.
 * Every row here is created by the same endpoints the app calls, so if the
 * contract changes this script fails loudly at the next docs rebuild — which
 * is the whole point of the exercise.
 *
 * Idempotent: accounts are namespaced by SEED_REV, and a group that already
 * exists with the right name is reused rather than duplicated. Re-running is
 * cheap and safe.
 *
 * NEVER point this at production. It refuses any base URL that is not
 * localhost unless DOCS_ALLOW_REMOTE=1 is set, and even then it will not
 * touch electricrv.ca.
 *
 * Usage:  node scripts/docs/seed-demo.mjs [--base http://localhost:8000]
 * Output: JSON on stdout — { token, userId, groups: {key: id} } — consumed
 *         by capture-web.mjs.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_PASSWORD, FRIENDS, GROUPS, PEOPLE, READER, SEED_REV } from './demo-world.mjs';

const argBase = process.argv.indexOf('--base');
const BASE = (argBase > -1 ? process.argv[argBase + 1] : 'http://localhost:8000').replace(/\/$/, '');
const API = `${BASE}/api/v1`;

if (/electricrv\.ca/i.test(BASE)) {
  console.error('refusing to seed against production');
  process.exit(2);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(BASE) && process.env.DOCS_ALLOW_REMOTE !== '1') {
  console.error(`refusing non-local base ${BASE} (set DOCS_ALLOW_REMOTE=1 if you really mean it)`);
  process.exit(2);
}

const log = (...a) => console.error('  ', ...a);

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `${method} ${path} → ${res.status}`);
    err.code = json?.error?.code ?? String(res.status);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Tokens from the last seed, if they still work.
 *
 * Every login opens a session, and the Profile screen lists them — so a seed
 * that logs in on every run makes the "signed-in devices" list grow forever
 * and the Profile screenshot different every time. Reusing a live token keeps
 * the world genuinely idempotent instead of merely idempotent-looking.
 */
const CACHE = fileURLToPath(new URL('.seed-tokens.json', import.meta.url));
const cached = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};

async function reuseToken(person) {
  const token = cached[person.email];
  if (!token) return null;
  try {
    const user = await call('GET', '/me', { token });
    return { token, user };
  } catch {
    return null;
  }
}

/** Register, or sign in if this SEED_REV has been seeded before. */
async function account(person) {
  const kept = await reuseToken(person);
  if (kept) { log(`reused session for ${person.displayName}`); return kept; }
  try {
    const r = await call('POST', '/auth/register', {
      body: { email: person.email, password: DEMO_PASSWORD, displayName: person.displayName },
    });
    log(`created ${person.displayName}`);
    return r;
  } catch (e) {
    if (e.code !== 'EMAIL_TAKEN') throw e;
    const r = await call('POST', '/auth/login', { body: { email: person.email, password: DEMO_PASSWORD } });
    log(`reused ${person.displayName}`);
    return r;
  }
}

async function main() {
  log(`seeding demo world ${SEED_REV} against ${BASE}`);
  const health = await call('GET', '/health');
  log(`api ok (schema v${health.schemaVersion})`);

  // --- accounts -------------------------------------------------------------
  const sess = {};
  for (const p of Object.values(PEOPLE)) {
    const r = await account(p);
    sess[p.key] = { token: r.token, user: r.user };
    // Profile fields the manual shows: currency, handles, and onboarded so the
    // first-run flow does not sit in front of every screenshot.
    await call('PATCH', '/me', {
      token: r.token,
      body: {
        displayName: p.displayName,
        defaultCurrency: p.defaultCurrency,
        paymentHandles: p.paymentHandles,
        onboarded: true,
      },
    });
  }
  const me = sess[READER.key];
  const idOf = (key) => sess[key].user.id;

  // --- groups ---------------------------------------------------------------
  const existing = (await call('GET', '/groups', { token: me.token })).items ?? [];
  const groupIds = {};

  for (const g of GROUPS) {
    let group = existing.find((x) => x.name === g.name && !x.isDirect);
    if (!group) {
      group = await call('POST', '/groups', {
        token: me.token,
        body: { name: g.name, emoji: g.emoji, homeCurrency: g.homeCurrency },
      });
      log(`created group ${g.name}`);
    } else {
      log(`reused group ${g.name}`);
    }
    groupIds[g.key] = group.id;

    // Members join through a real invite token — the same path a human takes.
    for (const key of g.members) {
      if (key === READER.key) continue;
      if (group.members?.some((m) => m.id === idOf(key))) continue;
      const invite = await call('POST', `/groups/${group.id}/invites`, { token: me.token, body: {} });
      await call('POST', `/join/${invite.token}`, { token: sess[key].token });
      log(`  ${PEOPLE[key].displayName} joined ${g.name}`);
    }

    await addExpenses(group.id, g.expenses, sess, idOf);
  }

  // --- 1:1 friends ----------------------------------------------------------
  for (const f of FRIENDS) {
    const other = PEOPLE[f.with];
    let direct = existing.find((x) => x.isDirect && x.members?.some((m) => m.id === idOf(f.with)));
    if (!direct) {
      direct = await call('POST', '/friends', {
        token: me.token,
        body: { email: other.email, homeCurrency: f.homeCurrency },
      });
      log(`created friend split with ${other.displayName}`);
    } else {
      log(`reused friend split with ${other.displayName}`);
    }
    groupIds[`friend:${f.key}`] = direct.id;
    await addExpenses(direct.id, f.expenses, sess, idOf);
  }

  // Keep the live sessions for next time, and retire every other one so the
  // Profile screen's devices list stays a single row instead of growing by
  // one every rebuild.
  writeFileSync(CACHE, JSON.stringify(
    Object.fromEntries(Object.values(PEOPLE).map((p) => [p.email, sess[p.key].token])), null, 2) + '\n');
  for (const s of (await call('GET', '/me/sessions', { token: me.token })).items ?? []) {
    if (!s.current) await call('DELETE', `/me/sessions/${s.id}`, { token: me.token }).catch(() => {});
  }

  markVerified();

  process.stdout.write(JSON.stringify({
    seedRev: SEED_REV,
    base: BASE,
    token: me.token,
    userId: me.user.id,
    email: READER.email,
    groups: groupIds,
  }, null, 2) + '\n');
}

/**
 * The two states the public API cannot put an account into from a script:
 * email-verified (there is no way to click the link in an email) and
 * is_test (owner-only flag from migration 019, so the demo accounts never
 * inflate the metrics dashboard).
 *
 * Without the first, an amber "Confirm your email" banner sits across the top
 * of every Home screenshot — a real part of the product, but not one the
 * manual is trying to teach, and not one Apple should be shown either.
 *
 * Two ways in, because there are two callers. Locally, devdb.sh: it reads the
 * repo config at runtime, reaches the dev database through docker, and refuses
 * to run against production. On a CI runner there is neither that file nor
 * docker, but the database credentials are already in the environment — so use
 * them directly. This used to be devdb.sh only, so the CI path warned and
 * carried on, and every screenshot it produced wore the banner.
 */
function markVerified() {
  const like = `demo-%-${SEED_REV}@example.com`;
  const sql = `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), is_test = 1
               WHERE email LIKE '${like}';`;
  const env = process.env;
  const direct = env.DB_HOST && env.DB_USER && env.DB_PASS;
  const r = direct
    // Through the environment rather than an argument, so it stays out of argv.
    ? spawnSync('mysql', [
      `--host=${env.DB_HOST}`, `--port=${env.DB_PORT || '3306'}`,
      `--user=${env.DB_USER}`, env.DB_NAME || 'slytab_dev',
    ], {
      input: sql, encoding: 'utf8',
      env: { ...env, MYSQL_PWD: env.DB_PASS },
    })
    : spawnSync('bash', [fileURLToPath(new URL('devdb.sh', import.meta.url))], {
      input: sql, encoding: 'utf8',
    });
  if (r.status !== 0) {
    log(`WARNING: could not mark demo accounts verified (${(r.stderr || '').trim().split('\n').pop()})`);
    log('         screenshots will carry the "Confirm your email" banner');
  } else {
    log('marked demo accounts verified + is_test');
  }
}

async function addExpenses(groupId, expenses, sess, idOf) {
  const have = (await call('GET', `/groups/${groupId}/expenses`, { token: sess[READER.key].token })).items ?? [];
  for (const e of expenses) {
    if (have.some((x) => x.description === e.description && x.amountMinor === e.amountMinor)) continue;
    const payerKey = e.payers[0].key;
    await call('POST', `/groups/${groupId}/expenses`, {
      token: sess[payerKey].token,
      body: {
        description: e.description,
        amountMinor: e.amountMinor,
        currency: e.currency,
        expenseDate: e.expenseDate,
        category: e.category,
        splitMethod: e.splitMethod,
        ...(e.fxRateOverride ? { fxRateOverride: e.fxRateOverride } : {}),
        payers: e.payers.map((p) => ({ userId: idOf(p.key), amountMinor: p.amountMinor })),
        shares: e.shares.map((s) => ({ userId: idOf(s.key), amountMinor: s.amountMinor })),
      },
    });
    log(`  + ${e.description} ${e.currency} ${e.amountMinor}`);
  }
}

main().catch((e) => {
  console.error(`seed failed: ${e.code ?? ''} ${e.message}`);
  process.exit(1);
});
