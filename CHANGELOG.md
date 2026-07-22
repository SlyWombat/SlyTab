# Changelog

All notable changes to SlyTab are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Splitwise import** (2026-07-22): upload a group's Splitwise CSV export
  — dry-run detects the member names for a mapping step, then every row
  imports balance-exactly (borrower shares verbatim, payer consumption
  distributed proportionally with largest-remainder rounding). Payments
  become confirmed settlements; personal expenses are skipped and
  reported; foreign-currency rows lock on-demand historical ECB rates.
  Two-step web UI with auto-suggested mapping. Deployed to production.
- **Android APK** (2026-07-22): a manual CI workflow builds a sideloadable
  APK, published at electricrv.ca/slytab/downloads/slytab.apk and linked
  from the sign-in screen. (Monorepo fixes along the way: explicit expo
  entry point, Metro resolver shim for the core package's NodeNext
  imports.)

- **Local receipt recognition** (2026-07-22): receipts are now itemized by
  a self-hosted vision model (qwen2.5vl:7b on kdocker2's Ollama, reached
  through the rathole tunnel at VM:3308) — photos never leave our
  hardware, ~6s per scan, zero per-scan cost. `RECEIPT_ENGINE=auto`
  prefers local and falls back to Claude only when a key is configured;
  amounts are transcribed as printed and converted to minor units
  server-side, with confidence recomputed deterministically (2%
  reconciliation rule). Privacy policy updated accordingly. Verified end
  to end in dev and production.

### Fixed

- Production Bearer auth: shared-hosting Apache strips the Authorization
  header from FastCGI PHP, so every authenticated endpoint 401'd in
  production. Fixed with `CGIPassAuth On` + `SetEnvIf` in the API
  .htaccess (found by the production receipt end-to-end test).

- **Production launch** (2026-07-22): live at electricrv.ca/slytab. Web +
  PHP API on cPanel; the database runs at home on kdocker2 through the
  SlyTesla rathole tunnel (VM :3307, TLS with pinned CA, IP-restricted at
  the OCI and iptables layers). Nightly backups + daily ECB refresh run
  from kdocker2 cron. `scripts/deploy-api.sh` + `npm run deploy` redeploy
  everything; docs/deployment.md has the full runbook.
- Playwright E2E golden path (sign up → group → expense → balances →
  profile → invite) running locally and as a CI job with MySQL + PHP; it
  caught a real bug (receipts rate-limiter closure capture) now fixed and
  redeployed.
- Mobile app v0 (Expo): sign in/up, home balances with settlement
  confirmation, group expenses/balances with suggested settlements,
  equal-split add-expense, settle sheet with Interac/PayPal deep links,
  invite links — talking to the production API, typechecked against
  SDK 54.
- Web: profile/payment-handles editor, password-reset flow, receipt
  scan→review→assign UI; API: PATCH /me, password reset, rate limiting,
  admin endpoints (earlier today, see entries below).

- Full money API (2026-07-22): groups with signed invite links and
  zero-balance-guarded leave; expenses with server-revalidated splits, FX
  locking (ECB or manual), soft delete/restore; balances with simplified
  settlement plans; pending→confirmed settlements; receipt upload +
  Claude itemization (Anthropic PHP SDK); activity feed; CSV export;
  /me/balances rollup; ECB rate cron. 22 PHP integration tests green.
- Web app MVP (2026-07-22): sign in/up, Home (net position, group list,
  pending-settlement confirmations), group screen (expenses + balances +
  suggested settlements), add-expense sheet with equal/unequal splits
  computed by @slytab/core, invite links with in-app join, settle-up sheet
  with Interac/PayPal.Me deep links, CSV export — all on the Ledger tokens.

- Monorepo scaffold (2026-07-22): npm workspaces with `packages/core`
  (money/split/balance/simplify/currency implemented + Zod schemas + design
  tokens, 28 Vitest tests green), `api/` (Slim 4 skeleton, health route,
  MySQL schema v1 migration, PHP twins of the split/simplify algorithms
  with the PHPUnit parity suite), `apps/web` (React 19 + Vite welcome
  screen on Ledger tokens, builds clean), `apps/mobile` (Expo SDK 54
  placeholder), `scripts/deploy-cpanel.mjs` (adapted from CaseMaker), and
  GitHub Actions CI (JS + PHP parity gate).

- Initial project documentation: requirements, architecture, design
  specification, and UI requirements (2026-07-22).
- Brand identity: "split coin" logo mark, app icon master, and light/dark
  wordmarks in `assets/brand/`; brand usage rules in
  `docs/design/DESIGN.md` §2 (2026-07-22).
- High-fidelity UI mockups (`docs/design/mockups.html`) covering Home,
  Group balances, Add expense, Receipt assignment, and Settle up
  (2026-07-22).

- Auth slice (2026-07-22): register/login/logout with argon2id password
  hashing, opaque peppered session tokens with 180-day rolling expiry,
  `GET/DELETE /me/sessions` device management, `GET /me`, consistent
  `{error:{code,message}}` envelope, and a forward-only migration runner
  (`api/bin/migrate.php`, `npm run db:migrate`). Covered by MySQL-backed
  integration tests (PHPUnit, 21 tests) run locally against kdocker2 and in
  CI against a MySQL 8.4 service container.
- Local dev environment (2026-07-22): MySQL 8.4 container (`slytab-mysql`)
  on kdocker2 with schema v1 applied and verified; PHP 8.2 + Composer run in
  local Docker containers via `npm run dev:api` / `test:php` / `php:install`
  (no native PHP install). Documented in `docs/dev-environment.md`.

### Changed

- **Project renamed SlySplit → SlyTab** (2026-07-22) — easier to say, and
  "the tab" is the better money metaphor. Renamed everywhere: GitHub repo
  (`SlyWombat/SlyTab`), PHP namespace (`SlyTab\`), npm packages
  (`@slytab/*`), bundle IDs (`com.slywombat.slytab` /
  `ca.electricrv.slytab`), URL (`electricrv.ca/slytab`), brand assets, dev
  MySQL (container `slytab-mysql`, db `slytab_dev`/`slytab_test`, user
  `slytab`), and all documentation. The split-coin mark is unchanged — the
  S-seam reads as the S in Sly.

- Architecture §3.1: verified via cPanel UAPI that the electricrv.ca host
  has **no Passenger/Node.js support** but **does** offer MySQL. Backend
  decision now Option A (PHP 8 + MySQL on cPanel, recommended) vs Option B
  (Node on a VPS) (2026-07-22).
- **Backend decided: Option A — PHP 8.2 (Slim 4) + MySQL on cPanel.**
  Architecture, README, requirements, and contributing docs updated:
  `server/` (Node/Fastify/SQLite) replaced by `api/` (PHP/PDO/MySQL), wire
  contract single-sourced from the Zod schemas via generated JSON Schema,
  money-math parity enforced by a shared test-vector suite (Vitest +
  PHPUnit) (2026-07-22).
