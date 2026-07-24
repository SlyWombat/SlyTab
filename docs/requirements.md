# SlyTab — Requirements

**Version:** 1.0 draft · **Date:** 2026-07-22 · **Status:** Approved scope

## 1. Product summary

SlyTab is a shared-expense tracker for personal use: family, couples, and
friend groups. It answers one question well — *who owes whom, and how much* —
and makes the two surrounding chores painless: getting expenses in (receipt
scanning, fast entry) and getting money moving (simplified debts, payment
deep links). It is explicitly **not** a payment processor and never holds
funds.

### Target users (v1.0)

Personal/family + friends first. Tens of users, not thousands. Design
decisions favour simplicity and privacy over horizontal scale.

## 2. Functional requirements

Requirements are numbered `FR-x.y`. **MUST** = v1.0 blocker, **SHOULD** =
v1.0 if time allows, **MAY** = post-1.0 candidate.

### 2.1 Accounts & auth

- **FR-1.1 (MUST)** Users register with email + password. Passwords hashed
  with argon2id. No third-party OAuth in v1.0 (privacy-first, no external
  identity dependency).
- **FR-1.2 (MUST)** Long-lived per-device sessions (opaque token, revocable
  from settings). Users stay signed in on their own devices.
- **FR-1.3 (MUST)** Password reset via emailed one-time link (sent through
  the cPanel mail server).
- **FR-1.4 (MUST)** A user profile holds display name, avatar colour/emoji,
  default currency, and optional payment handles (Interac e-Transfer email,
  PayPal.Me username, Venmo username).
- **FR-1.5 (SHOULD)** Account deletion: removes the user's personal data;
  their shares in historical expenses are anonymized ("Deleted user"), not
  deleted, so other members' balances stay correct.

### 2.2 Groups & membership

- **FR-2.1 (MUST)** Users create groups (name, emoji, home currency). Every
  expense belongs to exactly one group.
- **FR-2.2 (MUST)** *Friends are two-person groups.* Adding a "friend" creates
  (or reuses) a direct group between the two users. The UI presents these as
  people, not groups, but the data model is uniform. This is a deliberate
  simplification — one balance engine, one expense model.
- **FR-2.3 (MUST)** Members join via invite link or QR code (signed,
  expiring token). No email lookup/directory — you can't discover users you
  haven't been invited by.
- **FR-2.4 (MUST)** A member can leave a group only when their net balance in
  it is zero; otherwise the app prompts to settle first.
- **FR-2.5 (SHOULD)** Group archive (read-only) once a trip/household ends.

### 2.3 Expenses & splitting

- **FR-3.1 (MUST)** An expense records: description, total amount + currency,
  date, payer(s), category, optional notes, optional receipt photo, and how
  it splits across members.
- **FR-3.2 (MUST)** Split methods: **equal**, **exact amounts**, **shares**
  (2:1:1), **percentages**, and **adjustment** (equal after fixed offsets).
  Sums must reconcile to the total exactly; remainder cents distribute
  deterministically (largest-remainder, ordered by member id).
- **FR-3.3 (MUST)** Multiple payers on one expense (e.g. two people split the
  deposit).
- **FR-3.4 (MUST)** Any group member can add or edit any expense; every edit
  is recorded in the activity feed with who/when/what changed.
- **FR-3.5 (MUST)** Expenses can be deleted (soft delete, visible in
  activity feed, restorable for 30 days).
- **FR-3.6 (SHOULD)** Recurring expenses (rent, subscriptions): template +
  monthly auto-post.
- **FR-3.7 (MAY)** Expense comments.
- **FR-3.8 (MUST)** Adding an expense is the primary action on the home
  screen: one tap opens the Add Expense sheet directly (single group) or a
  group picker defaulting to the most recently used group. Group creation
  is secondary to expense entry (issue #20).

### 2.4 Receipt scanning (OCR)

- **FR-4.1 (MUST)** From the add-expense screen, the user photographs (or
  uploads) a receipt. The server parses it via the **Claude API**
  (`claude-opus-4-8`, vision + structured output) into: merchant, date,
  currency, line items (name, quantity, price), subtotal, tax, tip, total.
- **FR-4.2 (MUST)** Parsed results are always presented for review — the user
  confirms/edits before anything is saved. Parsing failures degrade
  gracefully to manual entry with the photo attached.
- **FR-4.3 (MUST)** Item assignment: the user taps items to assign them to
  members (an item can be shared). Tax and tip prorate across members in
  proportion to their assigned item subtotals. The result is saved as an
  **exact-amounts** split, with the itemization stored for reference.
- **FR-4.4 (MUST)** The receipt image is stored with the expense and viewable
  later. Images are stored server-side, scoped to the group.
- **FR-4.5 (SHOULD)** Cost guard: per-user daily scan cap (default 50) so a
  runaway client can't burn API budget.
- **FR-4.6 (MUST)** A previously scanned expense offers *View receipt* and
  *Rescan* from its detail/edit view. Rescan re-parses the stored photo
  server-side (no re-photographing) and feeds the normal review flow;
  it shares the FR-4.5 cost guard.

### 2.5 Multi-currency

- **FR-5.1 (MUST)** Each group has a home currency; each expense has its own
  currency. Same-currency expenses never touch an exchange rate.
- **FR-5.2 (MUST)** Foreign-currency expenses convert to the group home
  currency using the ECB daily reference rate for the **expense date**
  (fetched from the free frankfurter API and cached server-side). The rate is
  stored on the expense and never silently re-fetched — balances don't drift.
- **FR-5.3 (MUST)** The UI always shows the original amount + currency, with
  the converted amount secondary.
- **FR-5.4 (MUST)** Users can override the applied rate on an expense (e.g.
  the card's actual FX rate).
- **FR-5.5 (MUST)** Supported currencies: the ~30 in the ECB feed. CAD is the
  app-wide default.

### 2.6 Balances & debt simplification

- **FR-6.1 (MUST)** Per group, each member sees their net balance and the
  pairwise breakdown. Across groups, the home screen shows a total net
  position per person.
- **FR-6.2 (MUST)** "Simplify debts": a greedy max-flow settlement that
  minimizes the number of transfers (within the group, in the home currency).
  Simplification is a *suggestion layer* — underlying pairwise data is never
  destroyed.
- **FR-6.3 (MUST)** Balances are computed, never stored — derived on demand
  from expenses + settlements. (At this scale, correctness beats caching.)

### 2.7 Settling up (payment integration)

- **FR-7.1 (MUST)** SlyTab records settlements ("Alice paid Dave $40 on
  July 3") which offset balances exactly like expenses do.
- **FR-7.2 (MUST)** Payment deep links, generated from the payee's saved
  handles: Interac e-Transfer (mailto with amount/memo prefilled), PayPal.Me
  (`paypal.me/<user>/<amount><currency>`), Venmo
  (`venmo://paycharge?...` / web fallback). Tapping "I sent it" records the
  settlement as pending; the payee confirms receipt.
- **FR-7.3 (MUST)** **No money custody, no payment processing, no stored
  banking credentials.** This is a hard product boundary, not a deferral.
- **FR-7.4 (SHOULD)** Unconfirmed settlements nag the payee after 3 days.

### 2.8 Activity & notifications

- **FR-8.1 (MUST)** Per-group and global activity feeds: expenses
  added/edited/deleted, members joined, settlements recorded/confirmed.
- **FR-8.2 (SHOULD)** Mobile push notifications (Expo push service) for:
  added to an expense, settlement received, settlement confirmed. Off by
  default; opt-in per category.
- **FR-8.3 (MAY)** Email digests.

### 2.9 Data export

- **FR-9.1 (MUST)** Any member can export a group's full history as CSV.
- **FR-9.2 (SHOULD)** JSON export of everything a user can see (data
  portability / PIPEDA access requests).

### 2.10 Feedback

- **FR-10.1 (MUST)** Any signed-in user can report a bug from their
  profile page: a free-text comment plus an optional screenshot. Reports
  are stored server-side (screenshot alongside the comment, like receipt
  images) and reviewable together via the token-guarded internal API;
  the owner is notified by email when configured (`BUG_REPORT_EMAIL`).
  Rate-limited (10/day/user) like other upload endpoints.

## 3. Non-functional requirements

- **NFR-1 Privacy.** No analytics/telemetry SDKs anywhere (family
  convention). The only third-party calls are: Claude API (receipt images,
  server-side), frankfurter (currency codes only), and Expo push (device
  tokens). A privacy policy at `electricrv.ca/slytab/marketing/privacy/`
  names Electric RV (Ontario, Canada) as data controller, per PIPEDA.
- **NFR-2 Security.** All traffic over HTTPS. Argon2id password hashing,
  opaque session tokens (hashed at rest), per-group authorization checks on
  every endpoint, rate limiting on auth and receipt endpoints. Secrets in a
  gitignored `.env`, never in the repo.
- **NFR-3 Correctness of money.** Integer minor-unit arithmetic only. Split
  math and conversion live in one shared package with exhaustive tests.
  Every mutation is validated by the same Zod schema on client and server.
- **NFR-4 Scale target.** ≤100 users, ≤50 groups, ≤50k expenses. MySQL on
  the existing cPanel account comfortably covers this; the API design
  doesn't preclude moving databases later.
- **NFR-5 Offline behaviour (v1.0).** Mobile caches the last-synced state for
  read-only viewing offline. Writes require connectivity (clear inline
  error). Full offline queueing is explicitly deferred.
- **NFR-6 Performance.** Group screen interactive < 1s on LTE; balance
  computation < 100ms server-side at the v1.0 scale target.
- **NFR-7 Backups.** Nightly `mysqldump` + JSON export retained 30 days on
  the host (cPanel cron); weekly copy pulled off-host.
- **NFR-8 Versioned persistence.** Database schema is migration-versioned;
  API is versioned under `/api/v1`; exports embed a `schemaVersion`
  (family convention — reject old data loudly, never misread it).

## 4. Non-goals for v1.0

- Holding or moving money (permanent non-goal).
- Budgeting, spending analytics, charts.
- Bank/credit-card transaction import.
- Public user directory or social discovery.
- Full offline-first sync with conflict resolution.
- Localization beyond English (currency/date formatting is locale-aware).

## 5. Release criteria

v1.0 ships when: all MUSTs implemented and tested; E2E golden path green on
web + both mobile platforms; iOS build in TestFlight and Android APK
side-loadable/Play-internal; privacy policy live; backup cron verified
restoring; CHANGELOG cut to `1.0.0`.
