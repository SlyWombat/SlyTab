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
  identity dependency); amended post-1.0 by FR-1.7.
- **FR-1.2 (MUST)** Long-lived per-device sessions (opaque token, revocable
  from settings). Users stay signed in on their own devices.
- **FR-1.3 (MUST)** Password reset via emailed one-time link (sent through
  the cPanel mail server).
- **FR-1.4 (MUST)** A user profile holds display name, avatar colour/emoji,
  default currency, and optional payment handles (Interac e-Transfer email,
  PayPal.Me username, Venmo username).
- **FR-1.6 (SHOULD)** First-run onboarding (issue #36): a new user is shown
  a one-screen welcome that captures their name and home currency (and
  optional payment handles) before entering the app, tracked by a
  server-side `onboarded_at` so it appears exactly once.
- **FR-1.5 (SHOULD)** Account deletion: removes the user's personal data;
  their shares in historical expenses are anonymized ("Deleted user"), not
  deleted, so other members' balances stay correct.
- **FR-1.7 (SHOULD)** Optional "Sign in with Google" / "Sign in with Apple"
  (post-1.0 amendment to FR-1.1): secretless ID-token verification maps the
  external identity onto a SlyTab account, linking by verified email when
  the address is already registered. On mobile (issue #39), Google sign-in
  runs in the system browser via a one-time handoff: the app keeps a secret
  verifier and polls to claim the session, so the browser page (and anything
  that sees its URL) never holds a session token. The button's availability
  is cached on-device so it renders immediately on later launches, and after
  the browser half completes the page bounces back via `slytab://signed-in`
  (with a manual "Open SlyTab" fallback); the app claims the session the
  moment it returns to the foreground (issue #40).

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
- **FR-2.6 (MUST)** *People you know are one tap away* (issue #24): the
  invite sheet lists everyone you share any group with, and adding them
  needs no email or invite round-trip. The shared-group requirement is the
  consent model — it never widens who can discover whom beyond FR-2.3.
- **FR-2.4 (MUST)** A member can leave a group only when their net balance in
  it is zero; otherwise the app prompts to settle first.
- **FR-2.5 (SHOULD)** Group archive (read-only) once a trip/household ends.
- **FR-2.7 (MUST)** *Lock a trip for settlement* (#120). A locked group takes
  no new expenses, edits, imports, renames or invitations — the balances hold
  still — but settlements and reminders carry on, and someone who was invited
  earlier can still join in order to settle. Any member can lock or unlock it,
  as with archiving, and the activity feed records who did. Archive is the
  wrong tool for this and always was: an archived group refuses settlements
  too, so archiving to "close" a trip would freeze the very payments the
  closing is for. Archive is what happens once everyone is square.

### 2.3 Expenses & splitting

- **FR-3.1 (MUST)** An expense records: description, total amount + currency,
  date, payer(s), category, optional notes, optional receipt photo, and how
  it splits across members.
- **FR-3.1a (MUST)** Categories are a **two-level taxonomy** shipped in
  `@slytab/core`: five headings (`drinks`, `dining`, `travel`, `adulting`,
  `other`) each with subcategories (`travel.taxi`, `dining.groceries`, …).
  Both levels are assignable, so expenses recorded before subcategories
  existed stay valid. Filtering by a heading includes everything under it,
  and the Totals view rolls subcategories up to their heading.
- **FR-3.1b (SHOULD)** Each group can **customise** that taxonomy on a
  *Categories* page: rename any entry (the labels carry the house style, so
  a group may add or drop the snark), hide entries it never uses, and
  reorder the headings. Only the differences are stored, so groups that
  change nothing keep inheriting improvements to the shipped defaults, and
  hiding a category never alters expenses already filed under it.
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
  uploads) a receipt. The server parses it with a **self-hosted vision model**
  (`LOCAL_LLM_URL`, currently `qwen2.5vl:7b` — see `docs/llm-requirements.md`),
  returning merchant, date, currency, line items, subtotal, tax, tip and
  total. A third-party path (Claude) remains in the code and is selected only
  when `LOCAL_LLM_URL` is empty; production deploys it disabled, with
  `ANTHROPIC_API_KEY` written empty by `scripts/deploy-api.sh`. Say this
  accurately rather than loosely: the privacy claim on the public site and in
  the App Store review notes rests on it (issue #108).
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
- **FR-4.7 (SHOULD)** The receipt photo's EXIF GPS supplies the currency
  hint (photographed-in-Chile → CLP), read client-side so location never
  leaves the device as anything but a currency code. A currency printed
  on the receipt still wins, but only one the receipt states explicitly
  (a code, currency name, or single-currency symbol) — the hint outranks
  a parser *guess* from an ambiguous "$"; line items the parser misreads from
  non-bill content (loyalty credits) are individually ignorable in the
  assign step.

- **FR-4.8 (MUST)** Receipt scanning is an **optional capability, advertised
  before it is used** (issue #123). `GET /api/v1/capabilities` reports
  `receiptScanning: {available, reason}`; the API answers it without touching
  the database, so a database blip cannot hide a working scanner. "Available"
  means the configured engine's front door answers **and** advertises the
  configured model (owner, 2026-09-01: *"if service is advertising then it is
  available"*) — no latency budget, because a slow answer is still an answer
  and the passing model's honest range is 3.5–8.0 s. A host that answers while
  lacking `LOCAL_LLM_MODEL` counts as **un**available: it would fail at parse
  time, after the user has already taken the photograph. The probe carries the
  front door's token (`LOCAL_LLM_TOKEN`), since the door answers 401 to
  everything else — `/api/tags` included.
- **FR-4.9 (MUST)** When scanning is unavailable the client **shows the control
  disabled with the reason**, rather than hiding it (owner, 2026-09-01). A
  vanished button teaches nobody that the feature exists, and the fallback is
  stated in the same breath: the expense can still be added by hand. The client
  treats an unreachable capabilities endpoint as unavailable — offering a
  feature that posts to an API you cannot reach helps no one — and does not
  cache that failure, so a blip does not disable scanning until reload.
- **FR-4.10 (MUST)** **The reader scales out, and nobody waits in the dark**
  (issue #123, requirement 2; owner: *"proper load balancing … also need to
  support queuing and provide feedback to user"*).
  - *Load sharing.* The API talks to one front door (`scripts/ops/llm-proxy/`),
    which fans out to N Ollama backends by least connections, sidelines one
    that refuses connections, and — via a per-minute health check — marks
    `down` any backend that answers without advertising the pinned model, and
    warms the model back in after a host reset. Adding a machine is a line in
    the door's `backends` file plus `LOCAL_LLM_PARALLEL=N` on the API. With no
    healthy backend the door answers 502, which FR-4.8 reports as offline.
  - *Queuing.* The API admits at most `LOCAL_LLM_PARALLEL` parses at once (one
    per backend; flock slots, so a crashed parse frees its own). A scan that
    cannot start is **not refused and not held open** — the photo is stored,
    the receipt row exists, and the response carries `queued: {ticket,
    position, ahead, inFlight, slots, etaMs, retryAfterMs}` with `parsed:
    null`. Turns go oldest ticket first; a newcomer never overtakes someone
    already in line, even when the model is idle. A ticket nobody has
    refreshed in 45 s belongs to someone who left and is dropped; the line is
    capped at 25, beyond which the answer is `SCAN_BUSY` (429). Holding a PHP
    request open to wait is the one thing this must never do: that is what
    took the whole app down with 508s (ingest's history comment).
  - *Feedback.* The client shows the place in line and an honest "about N s"
    (rounds of the model until this receipt is *done*, from the last twenty
    real parses), keeps asking with its ticket when told to
    (`POST /receipts/{id}/rescan` with `ticket` — the FR-4.5 cost guard is
    charged only when a parse actually runs), flips to "reading" when next up,
    and gives its place back on cancel (`DELETE /receipts/queue/{ticket}`).
    After four minutes in line it stops and shows the server's own message,
    with the photo attached and Rescan a tap away. A client from before the
    queue existed sees that same message in `parseError`.

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
- **FR-5.6 (MUST)** Changing an expense's currency in the form keeps the
  number the user is looking at, re-reading it at the new currency's
  minor-unit scale (CLP and the other zero-decimal currencies write
  thousands with "." — never a decimal point). Amount fields that must
  reconcile — exact shares, per-payer amounts — rescale as a *set*: a split
  that balanced before the switch still balances after it, re-apportioned by
  largest remainder. A split still being typed is left as typed.

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
- **FR-7.5 (MUST)** *Either end can record a payment* (#120). The payer
  records "I sent it" (pending, FR-7.2) and the payee records "they paid me"
  — including a part payment, since money on a trip arrives in pieces. A
  payment recorded by its payee lands **confirmed** immediately: the person
  who would confirm receipt is the one recording it, and the record works
  against their own interest. It stays deletable by either party, which is
  the correction path a self-confirmed record needs; a settlement the two of
  them agreed on (payer records, payee confirms) remains final.
- **FR-7.6 (SHOULD)** *Reminders on request* (#120). Someone who is owed can
  send one reminder to someone who owes them. The automatic sweep (FR-7.4)
  deliberately never tells you to chase a friend; asked for by hand it is a
  different act. The debt must be real, the person reachable and not opted
  out, and it cools off for a few days before it can be sent again.

### 2.8 Activity & notifications

- **FR-8.1 (MUST)** Per-group and global activity feeds: expenses
  added/edited/deleted, members joined, settlements recorded/confirmed.
- **FR-8.2 (SHOULD)** Mobile push notifications (Expo push service) for:
  added to an expense, settlement received, settlement confirmed. Off by
  default; opt-in per category.
- **FR-8.3 (MUST)** Email notifications for the same events (issue #77),
  because push only reaches devices that registered a token — the push
  recipient query inner-joins `push_tokens`, so a member who never
  installed the app heard nothing at all. Email uses the *same*
  `notify_level` preference as push rather than a second setting, so it is
  controllable from the web Profile screen without an app release.
  - Settlements and joins are sent immediately; expenses and comments are
    queued in `notification_emails` and swept into **one digest per
    person** — six expenses entered at a dinner must not be six emails.
    The sweep rides the existing 10-minute `bug-sync` cron (and is
    available alone at `POST /api/internal/notify-digest`), so no new
    crontab entry is needed.
  - The actor is never told about their own action.
  - Every message carries a signed unsubscribe link
    (`GET /api/v1/notify/unsubscribe`) that sets `notify_level` to `none`
    **without a login** — someone invited by email has no password, and
    requiring sign-in to stop unwanted mail is how a domain gets marked as
    spam.
  - **Unconfirmed addresses get no detail.** A member added by email has a
    validated but unverified address that may be a typo for someone
    outside the group, so they receive only "there is new activity" —
    never descriptions or amounts. Confirmed addresses get the detail.

### 2.9 Data export & import

- **FR-9.1 (MUST)** Any member can export a group's full history as CSV.
- **FR-9.2 (SHOULD)** JSON export of everything a user can see (data
  portability / PIPEDA access requests).
- **FR-9.3 (SHOULD)** Splitwise import into an existing group, two
  sources: the Splitwise CSV export, or their REST API with the user's
  personal key (never stored). Each Splitwise member is mapped to a
  current group member, to a SlyTab user from one of the importer's
  other groups (added under the FR-2.6 consent model; issue #44), or —
  API source — invited by email (placeholder account holds their
  history until they register with that email; issue #2). Payments
  import as confirmed settlements; rows import balance-exactly.

### 2.10 Feedback

- **FR-10.1 (MUST)** Any signed-in user can report a bug from their
  profile page: a free-text comment plus an optional screenshot. Reports
  are stored server-side (screenshot alongside the comment, like receipt
  images) and reviewable together via the token-guarded internal API;
  the owner is notified by email when configured (`BUG_REPORT_EMAIL`).
  Rate-limited (10/day/user) like other upload endpoints.
- **FR-10.2 (MUST)** The reporter is kept in the loop by email (issue
  #25): an acknowledgment when the report lands, and a resolution note
  when the tracking issue closes (reports carry their GitHub issue
  number; the close notification includes the issue link).
- **FR-10.3 (MUST)** The feedback pipeline is durable — it runs
  server-side, independent of any dev session: a 10-minute cron on the
  host calls `POST /api/internal/bug-sync`, which files a GitHub issue
  for every new report and sends the FR-10.2 resolution email once an
  issue closes. Requires `BUG_GITHUB_TOKEN` (+ `BUG_GITHUB_REPO`) in the
  server config; logs to `data/bug-sync.log`.

### 2.11 My expenses (cross-group)

- **FR-11.1 (MUST)** A member can see every expense their money is in, across
  all their groups, from one screen (issue #101). Every other list in SlyTab
  is scoped to a single group, so answering "what have I been spending?"
  previously meant opening each group and adding it up by hand.
  - Two scopes, both about **money rather than authorship**: *I paid* (they
    are a payer — their money went out) and *I'm in* (they hold a share).
    Deliberately not "created by me": you can enter an expense someone else
    paid for, and that is not your spending.
  - Sortable by newest, oldest, largest and smallest.
  - Shows a running total of **their own share**, not the expense totals,
    covering the whole filtered set rather than the visible page. Foreign
    amounts convert at the rate for the day the money was spent; mixed source
    currencies mark the total approximate.
  - Leaving a group removes its expenses from this view, while the historical
    share rows stay so nobody else's balance moves.
  - `GET /api/v1/me/expenses?scope=&sort=&cursor=&q=&category=`. Amount sorts
    use a composite `<amount>:<id>` cursor — an id-only cursor silently
    repeats and skips rows once the order is not the ULID order.

### 2.12 Profile photo (#112)

- A person may set a photo, which replaces their coloured initial everywhere a
  badge is drawn. Most people will not, so the initial stays the normal case
  and the photo is the addition.
- Stored square at 256px, re-encoded as JPEG — which is also what strips EXIF,
  so no location rides along with a face. The original is not kept.
- Served by `GET /api/v1/users/<id>/avatar`, authorised by who is asking: the
  person themselves, or anyone who shares a group with them. A ULID appears in
  ordinary API responses, so knowing an id must never amount to permission.
- `POST /api/v1/me/avatar` (multipart) sets it, `DELETE` removes it.

### 2.13 Connecting to a self-hosted server (#113)

- The phone app can hold a list of servers and move between them. The list
  always contains the one the build shipped pointing at, which cannot be
  removed; anything else is added by the person using it.
- **Each server's session is stored under its own key and is never in scope
  while another is active.** A session token is a bearer credential, so one
  server receiving another's would be one server receiving the account. The
  base URL and token are a single value in the client, replaced as a whole, so
  a request in flight during a switch completes against the server it started
  on and no request can ever pair a new base with an old token.
- An address is normalised before use (`example.org` → `https://example.org/api/v1`)
  and probed at `/health`, which must answer as `slytab-api`. Plain http is
  refused except on the local network, where the wire belongs to the owner.
- A server can offer itself with `slytab://connect?base=<url>`. The custom
  scheme, not a universal link: `applinks:` domains are fixed in the app
  entitlements and verified by Apple against that domain, so a self-hosted
  server could never have one without a new build.
- **The app names the host and requires an explicit tap before it moves.** A
  link that could repoint the app silently is a way to phish a password; the
  confirmation is the security boundary, not a courtesy.
- The web app shows the connect link and its own address, but only when it is
  not the server the app already ships pointing at.

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
