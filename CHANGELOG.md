# Changelog

All notable changes to SlyTab are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Settling up from either end** (#120): only the person who *owed* money
  could record a payment, so anyone who was owed had no way to close a
  balance — the app just told them to wait. Tapping someone's balance now
  opens what you can do about it, including recording money they handed
  you. A payment recorded by the person who received it counts immediately
  (they are the one who would have confirmed it) and stays deletable by
  either side, which is the correction path it needs. Part payments are
  first-class: "here is $20 toward my tab" is a normal thing to say.
- **Lock a trip for settling up** (#120): freezes expenses so the numbers
  hold still while everyone pays up, while settlements, reminders and
  late-arriving invitees carry on. Archiving could never do this — an
  archived group refuses settlements too — so it stays what it always was,
  the thing you do once everyone is square. Any member can lock or unlock.
- **Remind someone what they owe** (#120): one tap from a locked trip's
  member sheet. The automatic reminder sweep still never tells you to chase
  a friend; this one you ask for. It cools off for a few days, respects
  notification preferences, and says out loud when it did not send.

## [1.0.1] — 2026-07-27

### Fixed

- **Receipt scans lost thousands separators** (#75): a Chilean receipt for
  `$88.930` imported as 89 CLP. Amounts now cross the vision-model boundary
  as printed text and the currency decides what a separator means — in a
  zero-decimal currency (CLP, JPY, KRW…) sub-units do not exist, so every
  separator groups.
- **Duplicate expenses** (#76): saving twice created two identical
  expenses, silently doubling someone's spending. Save is disabled while a
  create is in flight, an identical expense is refused with a warning you
  can override deliberately, and re-running an import drops rows the group
  already has instead of filing them again.
- **The Android download was serving an APK that could not be installed.**
  cPanel's upload appends the multipart boundary to the stored file; a zip
  survives that, an APK does not, and Android rejected it with
  INSTALL_PARSE_FAILED_NOT_APK. APKs are now published by uploading a zip,
  extracting server-side, and verifying the served sha256 against the
  build — `scripts/ops/upload-apk.sh`.

### Changed

- **Simpler expense entry**: scanning a receipt fills in the merchant,
  total, currency and date and leaves the split on equal, so the next thing
  you do is press Save. It used to drop you straight into item assignment,
  which meant every receipt cost a decision before it could be saved.
  Splitting item by item is now an optional "Split by item" button.

## [1.0.0] — 2026-07-26

First stable release: both mobile apps and the web app ship together.

### Added

- **Per-group categories** (#18): the five headings gain subcategories
  (`travel.taxi`, `dining.groceries`, …), and each group can rename any
  label, hide what it never uses and reorder the headings from a Categories
  page. Only the differences are stored, so groups keep inheriting
  improvements to the shipped defaults. Totals roll subcategories up under
  their heading; filtering by a heading sweeps up its leaves.
- Profile now shows the app version and build (spec §2.10).

### Fixed

- **Splitwise import money bug** (#54): both importers converted decimals
  with a hardcoded x100, so every row in a zero-decimal currency (CLP, JPY,
  KRW, VND, ISK, HUF) imported 100x too large — self-consistently, so
  balances still reconciled and nothing looked wrong until you read an
  amount.
- **Splitwise import crash** (#55): a spreadsheet or a Windows-1252 CSV (what
  Excel writes when you re-save the export) returned a 500 instead of a
  clear message.
- **Accessibility pass, web** (#65-#73): the group tab strip pushed
  "Activity" off screen at larger fonts with no way to scroll to it; long
  member names printed over the balance amounts; the group header collapsed
  at 200% zoom and took the only route to group settings with it; lists
  claimed to be empty while still loading; two colour pairs failed WCAG AA;
  sheets ignored Escape and never moved focus; several targets were under
  44px; the FAB covered the last row.
- **Accessibility pass, mobile** (#45-#64): at large system font scales the
  group screen lost its expense list entirely and the action row was drawn
  under the Android gesture bar, and Home's list was squeezed to a sliver —
  both because screen chrome sat outside the list rather than scrolling with
  it. Sign-in had no working keyboard handling on either platform. Also
  fixed: the iOS tab bar leaving a mismatched band under the home indicator,
  Profile's keyboard avoidance and off-screen notification options, iPhone
  sessions labelled "Android app", light system chrome over the dark UI,
  clipped split-editor inputs, sub-44pt targets, a misaligned Profile tab
  label, and Android's system Back leaving the app from a group screen.
- Bug reports from the app carry the real version again (#45): the
  per-platform version split moved the numbers to `versions.json` but the
  app still read `app.json`, so every report arrived stamped `v?(?)`.

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

- Android APK startup crash: the monorepo carried two React copies (web
  ^19.2 vs React Native's required 19.1), so hooks dispatched on null the
  moment the app rendered. React/react-dom are now pinned tree-wide to
  19.1.0 via a root npm override; diagnosed and the fix verified on a
  headless Android emulator (zero fatal exceptions, sign-in screen
  renders). Fixed APK republished (2026-07-22).


- Production Bearer auth: shared-hosting Apache strips the Authorization
  header from FastCGI PHP, so every authenticated endpoint 401'd in
  production. Fixed with `CGIPassAuth On` + `SetEnvIf` in the API
  .htaccess (found by the production receipt end-to-end test).

### Added (earlier the same day)

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
