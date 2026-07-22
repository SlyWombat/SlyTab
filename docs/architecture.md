# SlySplit — Architecture

**Date:** 2026-07-22 · **Status:** Design approved, pre-implementation

## 1. Overview

SlySplit departs from CaseMaker/SlyLED in one important way: expense sharing
is inherently **multi-user shared state**, so it needs a backend. Everything
else follows family conventions — TypeScript strict, token-first CSS, cPanel
hosting at a path-based URL, gitignored `.env` secrets, no telemetry.

```
┌─────────────┐  ┌──────────────┐  ┌──────────────┐
│  Web SPA    │  │  iOS app     │  │  Android app │
│ React 19 +  │  │  React Native + Expo (one app) │
│ Vite        │  └──────┬───────┴───────┬─────────┘
└──────┬──────┘         │               │
       │      HTTPS  REST /api/v1 (JSON, Zod-validated)
       └────────────────┼───────────────┘
                ┌───────┴────────┐
                │   PHP 8 API    │  Slim 4, native PHP on cPanel
                │  api/          │  electricrv.ca/slysplit/api
                ├────────────────┤
                │ MySQL/MariaDB  │  PDO + SQL migrations
                │ receipts/ dir  │  uploaded images (outside web root)
                └───┬────────┬───┘
                    │        │ server-side only
          ┌─────────┴──┐  ┌──┴──────────────┐
          │ Claude API │  │ frankfurter.dev │
          │ receipt    │  │ ECB daily FX    │
          │ parsing    │  │ rates (cached)  │
          └────────────┘  └─────────────────┘
```

## 2. Repository layout

Monorepo (npm workspaces), repo `github.com/SlyWombat/SlySplit`:

```
SlySplit/
├── README.md  CHANGELOG.md  CONTRIBUTING.md  LICENSE  .env (gitignored)
├── docs/                      # this documentation + design/
├── packages/core/             # shared TS domain logic (no I/O)
│   ├── src/
│   │   ├── schemas/           # Zod: User, Group, Expense, Settlement, …
│   │   ├── money.ts           # minor-unit arithmetic, formatting
│   │   ├── split.ts           # equal/exact/shares/percent/adjustment
│   │   ├── balance.ts         # net balances from expenses+settlements
│   │   ├── simplify.ts        # greedy min-transfer settlement
│   │   ├── currency.ts        # conversion with stored rates
│   │   └── tokens.ts          # design tokens as TS constants (mobile)
│   └── test-vectors/          # JSON fixtures asserted by BOTH Vitest & PHPUnit
├── api/                       # PHP 8.2 API (Slim 4 + PDO/MySQL)
│   ├── public/index.php       # front controller → /slysplit/api
│   ├── src/
│   │   ├── Routes/            # auth, groups, expenses, settlements,
│   │   │                      # receipts, rates, export
│   │   ├── Domain/            # split/balance/simplify — PHP twin of core
│   │   ├── Db/                # PDO wrapper + migrations/NNN_*.sql
│   │   ├── Services/          # ReceiptParser (Claude), FxRates, Mailer
│   │   └── Middleware/        # auth, rate-limit, error envelope
│   ├── tests/                 # PHPUnit (runs the shared test vectors)
│   └── composer.json
├── apps/web/                  # React 19 + Vite SPA
│   └── src/{components,screens,store,styles,api}/
├── apps/mobile/               # Expo (React Native), Expo Router
│   └── src/{screens,components,api}/  app.json  eas.json
├── scripts/
│   ├── deploy-cpanel.mjs      # adapted from CaseMaker (UAPI token upload)
│   └── backup.mjs             # nightly snapshot + export
└── tests/e2e/                 # Playwright (web golden path)
```

`packages/core` is the heart: pure functions, zero I/O, 100% branch coverage
on money paths. Web, mobile, and server all import it, so split math cannot
diverge between platforms.

## 3. Backend

- **Runtime:** PHP 8.2+, **Slim 4** (routing + middleware, PSR-7),
  Composer-managed, running natively on the electricrv.ca cPanel host.
  Chosen over Node because the host has no Passenger/Node support (§3.1) —
  PHP + MySQL is what this hosting does first-class.
- **Validation:** the Zod schemas in `packages/core` are the contract's
  source of truth. A build step exports them to JSON Schema
  (`zod-to-json-schema`), and the PHP API validates every request/response
  against those generated schemas (`opis/json-schema`) — so the wire
  contract cannot drift between TS clients and the PHP server.
- **Money math parity:** the three money-critical algorithms (split
  reconciliation, balance derivation, debt simplification) are implemented
  twice — TS in `packages/core` (client previews/optimistic UI) and PHP in
  `api/src/Domain/`. Both run the identical fixtures in
  `packages/core/test-vectors/` (Vitest + PHPUnit); CI fails if they ever
  disagree.
- **Database:** MySQL/MariaDB (already provisioned on the account) via PDO,
  prepared statements only, forward-only numbered SQL migrations applied by
  the deploy step. Amounts are `BIGINT` minor units; all money invariants
  re-checked in the service layer.
- **Files:** receipt images stored under a `slysplit-data/receipts/<groupId>/`
  directory **above** `public_html` (never web-servable directly), streamed
  through an authenticated route, resized to ≤2000px longest edge on upload.

### 3.1 Hosting the API on cPanel — VERIFIED 2026-07-22

Checked against the live electricrv.ca cPanel via UAPI (using the CaseMaker
deploy credentials):

- ❌ **No Passenger/Node.js support** — `PassengerApps` returns *"You do not
  have the feature passengerapps"*. The Node-on-cPanel plan is **not viable**
  on this host.
- ✅ **MySQL/MariaDB available** (account already has databases).
- ✅ PHP and cron are standard on the account.

**✅ DECIDED 2026-07-22: Option A — PHP 8 + MySQL on cPanel** (user's call).

- API lives at `public_html/slysplit/api/public/` (front controller only;
  `src/`, vendor, config, and data directories sit above the web root),
  deployed with the same UAPI upload script as the SPA. Zero new
  infrastructure, zero monthly cost. FX-rate refresh and backups run as
  cPanel cron jobs. Receipt parsing uses the official Anthropic PHP SDK
  (`anthropic-ai/sdk`).
- Trade-off accepted: the server doesn't execute the TypeScript
  `packages/core` code. Mitigations are structural (see §3): generated
  JSON Schemas keep the wire contract single-sourced, and the shared
  test-vector suite keeps the duplicated money algorithms provably
  identical in CI.
- *Rejected alternative* (recorded for posterity): Node/Fastify/SQLite on a
  VPS or tunneled home server — kept one language but added a machine to
  run, patch, and pay for.

### 3.2 Auth model

- Register/login → argon2id verify → opaque 256-bit session token, stored
  **hashed** in `sessions`, sent as `Authorization: Bearer` (mobile) or
  `HttpOnly; Secure; SameSite=Strict` cookie (web). 180-day rolling expiry;
  revocable per device.
- Group authorization: every group-scoped route checks membership in one
  shared middleware. No cross-group data can leak through IDs.
- Rate limits: 10/min on auth routes, 20/day default on receipt parsing
  (per FR-4.5), 120/min general.
- Invites: `slysplit://join/<token>` + web equivalent; token = signed
  (HMAC), single-group, 7-day expiry, revocable.

## 4. Data model

All amounts are **integer minor units** in the row's own `currency`.
Converted values are computed with the stored `fx_rate`, never stored twice.

```
users        id, email (unique), password_hash, display_name, avatar,
             default_currency, payment_handles (JSON: interac/paypal/venmo),
             created_at, deleted_at
sessions     id, user_id, token_hash, device_label, created_at, last_seen_at,
             expires_at, revoked_at
groups       id, name, emoji, home_currency, is_direct (bool: friend pair),
             created_by, created_at, archived_at
memberships  group_id, user_id, joined_at, left_at        (PK group+user)
invites      id, group_id, token_hash, created_by, expires_at, used_by
expenses     id, group_id, description, amount, currency, fx_rate,
             fx_rate_source (ecb|manual), expense_date, category,
             notes, receipt_id, created_by, created_at, updated_at,
             deleted_at
expense_payers  expense_id, user_id, amount                (PK exp+user)
expense_shares  expense_id, user_id, amount, split_method,
                split_input (JSON: shares/pct/adjustment as entered)
receipts     id, group_id, image_path, parsed (JSON: merchant, items[],
             subtotal, tax, tip, total, currency), created_by, created_at
settlements  id, group_id, from_user, to_user, amount, currency, fx_rate,
             method (interac|paypal|venmo|cash|other), note,
             status (pending|confirmed), created_at, confirmed_at
fx_rates     date, base, quote, rate                       (PK date+base+quote)
activity     id, group_id, user_id, verb, entity_type, entity_id,
             diff (JSON), created_at
```

Invariants enforced in `packages/core` and re-checked in the DB layer:
`sum(expense_payers.amount) == expenses.amount`;
`sum(expense_shares.amount) == expenses.amount`; settlement participants are
both group members.

## 5. API surface (`/api/v1`)

Error envelope: `{ error: { code, message } }`. All success bodies are
Zod-schema'd objects; lists are `{ items, nextCursor }`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` · `POST /auth/reset-request` · `POST /auth/reset` · `GET/PATCH /me` · `GET/DELETE /me/sessions` |
| Groups | `GET/POST /groups` · `GET/PATCH/DELETE /groups/:id` · `POST /groups/:id/invites` · `POST /join/:token` · `POST /groups/:id/leave` |
| Expenses | `GET/POST /groups/:id/expenses` (cursor-paginated) · `GET/PATCH/DELETE /expenses/:id` · `POST /expenses/:id/restore` |
| Balances | `GET /groups/:id/balances` (net + pairwise + simplified plan) · `GET /me/balances` (across groups) |
| Settlements | `POST /groups/:id/settlements` · `POST /settlements/:id/confirm` · `DELETE /settlements/:id` |
| Receipts | `POST /groups/:id/receipts` (multipart image → parsed JSON) · `GET /receipts/:id/image` |
| Rates | `GET /rates?date=&base=&quote=` (served from cache) |
| Export | `GET /groups/:id/export.csv` · `GET /me/export.json` |
| Activity | `GET /groups/:id/activity` · `GET /me/activity` |

Clients poll activity with `If-None-Match` etags for cheap refresh; no
websockets in v1.0 (shared-hosting-friendly, and the update cadence doesn't
need them).

## 6. Receipt parsing service (Claude API)

Server-side only — the API key never reaches a client. Implemented in
`api/src/Services/ReceiptParser.php` with the official Anthropic PHP SDK
(`anthropic-ai/sdk`).

- Model: **`claude-opus-4-8`** (vision). Request: the receipt image
  (base64, downscaled to ≤1568px before sending to control image tokens) +
  a fixed instruction prompt, with **structured outputs**
  (`output_config.format`, `json_schema`) so the response is guaranteed
  parseable:

```jsonc
// receipt schema (abridged)
{
  "type": "object",
  "properties": {
    "merchant": {"type": ["string","null"]},
    "date": {"type": ["string","null"], "format": "date"},
    "currency": {"type": ["string","null"]},
    "items": {"type": "array", "items": {"type": "object", "properties": {
      "name": {"type":"string"}, "quantity": {"type":"number"},
      "unitPriceMinor": {"type":"integer"}, "totalMinor": {"type":"integer"}},
      "required": ["name","quantity","unitPriceMinor","totalMinor"],
      "additionalProperties": false}},
    "subtotalMinor": {"type": ["integer","null"]},
    "taxMinor": {"type": ["integer","null"]},
    "tipMinor": {"type": ["integer","null"]},
    "totalMinor": {"type": ["integer","null"]},
    "confidence": {"type": "string", "enum": ["high","medium","low"]}
  },
  "required": ["merchant","date","currency","items","subtotalMinor",
               "taxMinor","tipMinor","totalMinor","confidence"],
  "additionalProperties": false
}
```

- Post-parse sanity check: if `sum(items) + tax + tip` differs from `total`
  by more than 2%, mark `confidence: low`; the review screen highlights the
  mismatch. The user always confirms before save (FR-4.2).
- Cost: an average receipt is roughly 1–2k input tokens (image) + ~500 output
  tokens ⇒ well under CA 5¢ per scan at Opus 4.8 pricing ($5/$25 per MTok).
  The per-user daily cap (FR-4.5) bounds worst-case spend.
- Failure handling: timeout 60s; on API error or `stop_reason` other than
  `end_turn`, return `RECEIPT_PARSE_FAILED` and let the client fall back to
  manual entry with the image attached.
- Key in server `.env` as `ANTHROPIC_API_KEY`.

## 7. FX rates service

A daily cPanel cron job (`php api/bin/fetch-rates.php`) pulls ECB reference
rates from `api.frankfurter.dev` into `fx_rates` (base EUR; cross rates
computed). Expense creation looks up the
rate for the expense date (falling back to the nearest prior business day),
stores it on the row, done. No client ever calls the rate API directly.

## 8. Frontend architecture

### Web (`apps/web`)

React 19 + Vite (dev port 8000), React Router, **Zustand** for client state,
TanStack Query for server state/caching. Plain CSS with `--ss-*` tokens
(see `docs/design/DESIGN.md`). Built SPA deploys to
`public_html/slysplit/` → `electricrv.ca/slysplit`, with `.htaccess` SPA
rewrite + immutable asset caching (CaseMaker pattern), `VERSION.txt` stamped
with version + git SHA.

### Mobile (`apps/mobile`)

Expo (managed workflow) + Expo Router; same Zustand/TanStack Query stack;
tokens consumed from `packages/core/src/tokens.ts`. IDs follow the family
convention: Android `com.slywombat.slysplit`, iOS `ca.electricrv.slysplit`
(SlyLED precedent). Camera via `expo-camera`/`expo-image-picker`; push via
Expo notifications (opt-in).

## 9. Build, CI, deploy

- **CI (GitHub Actions):** `ci.yml` — lint, typecheck, Vitest
  (`packages/core`), PHPUnit on PHP 8.2 (`api/`, including the shared
  test-vector suite — the parity gate), web build, Node 22.
  `playwright.yml` — web E2E against a seeded local API (`php -S`).
  `mobile.yml` — Expo prebuild + Android assembleRelease;
  iOS TestFlight workflow adapted from SlyLED's proven
  `ios-testflight.yml` playbook (manual signing, pinned provisioning
  profile, upload guard). Deploys are **manual/local**, per family
  convention.
- **Deploy web:** `npm run deploy` → build → `scripts/deploy-cpanel.mjs`
  (cPanel UAPI `Fileman::upload_files`, token auth from `.env`:
  `CPANEL_HOST/PORT/USER/TOKEN`, `WEB_ROOT`) — lifted from CaseMaker.
- **Deploy API:** same UAPI upload for `api/` — the front controller goes
  under `public_html/slysplit/api/`, everything else above the web root.
  The deploy script finishes by calling an admin-token-protected migrate
  endpoint to apply pending SQL migrations. PHP is stateless, so there is
  no restart step.
- **Signing:** Android keystore and Apple certs live outside the repo
  (SlyLED convention: irreplaceable keys in the local archive +
  base64-mirrored into GitHub Actions secrets).

## 10. Secrets

Gitignored root `.env`, hand-rolled loader (no dotenv dep):
`CPANEL_*` (deploy), `ANTHROPIC_API_KEY` (receipts), `DB_*` (MySQL),
`SESSION_PEPPER`, `INVITE_HMAC_KEY`, `MIGRATE_TOKEN`, `SMTP_*` (password
reset). On the host, the API's runtime config file lives **above**
`public_html` and is read by the front controller — never web-servable.
Parent-dir Infisical tooling exists but, matching CaseMaker/SlyLED
practice, plain `.env` is the v1.0 mechanism.

## 11. Risks & open items

| # | Risk / unknown | Mitigation |
|---|---|---|
| 1 | ~~cPanel may lack Node/Passenger~~ **Resolved 2026-07-22:** feature absent; §3.1 Option A (PHP + MySQL) chosen | — |
| 2 | Receipt parse quality on crumpled/faded receipts | Mandatory review step; confidence flag; manual fallback |
| 3 | Venmo deep-link format churn | Behind one `paymentLinks.ts` module; degrade to copyable handle |
| 4 | TS/PHP duplicated money algorithms drift apart | Shared JSON test vectors run by both Vitest and PHPUnit; CI fails on divergence |
| 5 | Expo push requires Expo's service (external call) | Opt-in only; documented in privacy policy |
