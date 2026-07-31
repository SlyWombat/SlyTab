# SlyTab — how the end-user documentation is made and kept true

**Date:** 2026-07-31 · **Issue:** #104 · **Status:** pipeline built and
verified; the prose it feeds is not written yet.

This document is not the user manual. It is the machinery that produces the
manual and then refuses to let it rot.

## 0. The problem this is solving

Every product manual dies the same way. Someone writes it once, carefully,
with screenshots taken by hand on a Tuesday. The app then ships thirty more
times. The words drift first, the pictures drift worse, and eventually a user
follows the manual, cannot find the button it describes, and stops trusting
the whole document — including the parts that are still correct. A manual
nobody trusts is worse than no manual, because it costs support time twice:
once for the original confusion, once for the doubt it leaves behind.

The failure mode is not laziness. It is that **nothing fails when the docs go
stale**. Tests go red; prose just quietly becomes fiction.

So the design goal here is narrow and concrete:

> Screenshots are generated, never taken. Prose is fingerprinted against the
> screen it describes, and a build fails — loudly, by name — when a screen
> changed and its documentation did not.

Everything below serves that sentence.

---

## 1. What the documentation contains

Four artefacts, written for users, not developers.

| # | Artefact | Authoring source | Published at | Who writes it |
|---|---|---|---|---|
| 1 | **Why SlyTab, honestly** — how it differs from Splitwise, including where Splitwise is better | `docs/user-guide/why-slytab.md` | `/slytab/marketing/help/why/` | Owner or a session, from §8 evidence |
| 2 | **User manual** with generated screen captures | `docs/user-guide/manual.md` | `/slytab/marketing/help/manual/` | Whoever ships the behaviour |
| 3 | **FAQ** | `docs/user-guide/faq.md` | `/slytab/marketing/help/faq/` | Grown from real `bug_reports` |
| 4 | **Help entry points** — Profile → Help in both apps, plus a link from the marketing pages | app source + `apps/web/public/marketing/` | in-app | See §9 |

Everything under `docs/user-guide/` is the source of truth. Everything under
`apps/web/public/marketing/help/` is generated from it and is deployed by the
existing `npm run deploy`, which uploads `apps/web/dist/` (Vite copies
`public/` verbatim, which is how `marketing/privacy/` already ships).

### Why Markdown in `docs/` and HTML in `public/`

Three reasons, in order of importance:

1. The staleness gate (§5) hashes **prose sections**. Markdown gives it a
   clean, stable section boundary (a heading and an anchor). HTML gives it
   markup churn to hash — a reformat would read as a content change.
2. The manual is reviewed in pull requests alongside the code that changed the
   screen. Reviewing Markdown diffs is possible; reviewing generated-HTML
   diffs is not.
3. GitHub renders `docs/user-guide/manual.md` with its images inline, so the
   repo copy is readable without deploying anything.

---

## 2. Where every artefact lives

```
docs/
  user-docs-process.md          this file — the process
  user-guide/
    manual.md                   prose, with ![](img/web/home.png) embeds
    why-slytab.md               the comparison
    faq.md                      the FAQ
    img/web/*.png               GENERATED — never edit, never hand-replace
    img/android/*.png           GENERATED — never edit, never hand-replace
    shots.web.json              GENERATED — per-screen uiHash + metadata
    shots.android.json          GENERATED
    docs-state.json             the accepted-documentation ledger (§5)

scripts/docs/
  make-docs.sh                  ONE COMMAND — the whole pipeline
  demo-world.mjs                the fixed demo data the manual is shot in
  seed-demo.mjs                 builds that world through the real API
  shots.mjs                     the shot list: screen ↔ code ↔ prose section
  capture-web.mjs               Playwright capture + uiHash
  capture-android.sh            emulator capture + uiHash
  check-docs.mjs                the staleness gate
  devdb.sh                      dev-database SQL helper (refuses production)

apps/web/public/marketing/help/ GENERATED site copy (see §7)
```

Nothing in `img/` is ever edited by a human. If a screenshot is wrong, the
fix is in `shots.mjs`, `demo-world.mjs`, or the app — never in an image
editor. This is the rule that makes the whole thing work; a single
hand-touched PNG reintroduces exactly the failure mode being designed out.

---

## 3. The screenshot pipeline

### 3.1 Which screens

`scripts/docs/shots.mjs` is the shot list, and each entry names four things:

```js
{
  id: 'group-balances',
  screen: '2.4 Group detail — Balances',            // ui_requirements.md §2
  sources: ['apps/web/src/screens/Group.tsx', ...], // the code that draws it
  doc: { file: 'docs/user-guide/manual.md', anchor: 'group-balances' },
  expect: ['Alice', 'Jon'],                         // what must be on screen
  steps: async ({ openGroup, page, settle }) => { … },
}
```

`docs/design/ui_requirements.md` §4 carries the v1.0 screen checklist, and the
gate cross-references it: a screen listed there with no shot fails the build.
That is what stops the manual from silently missing a feature — coverage is
asserted against the design document rather than against someone's memory.

Two §4 screens deliberately have no shot, declared with their reason in the
`UNSHOT` map in `shots.mjs` (first-run setup, which needs a never-onboarded
account; receipt capture, which needs the self-hosted vision model running and
is therefore not reproducible offline). The gate reports those as notes rather
than failures — a known gap stays visible without permanently redding the
build, and adding one silently is impossible.

One caveat on the signed-out `welcome` shot: it renders Google's and Apple's
sign-in buttons, which are third-party scripts fetched at runtime. It is the
one screen whose appearance depends on someone else's CDN, so it will differ
on a machine with no outbound network. Worth knowing before wiring capture
into an air-gapped CI runner.

`sources` is the weak point of the whole design and deserves care. If it is
too narrow, a change slips past the gate; too broad, and unrelated edits nag
for a re-read. Keep it to the screen's own component plus the shared shell and
whatever `@slytab/core` module actually decides what the screen shows.

### 3.2 What data state

`scripts/docs/demo-world.mjs` defines one small, fixed world:

- **Dave** (the account the manual is written from), **Alice**, **Jon**,
  **Priya** — all on `example.com` (RFC 2606), all flagged `is_test` so they
  never inflate the owner metrics dashboard.
- **Cottage Trip** (CAD, three people) — four expenses including a US$96.00
  ferry ticket in a CAD group, which is the manual's multi-currency exhibit,
  and one non-equal `exact` split.
- **Household** (CAD, two people) — two utility bills, one of them an odd
  amount (C$89.99) so the manual can show what happens to the stray cent, and
  **both paid by Alice** so that the reader *owes* in this group.
- A 1:1 **friend split with Priya**, so the manual can show that friends are
  not a different feature from groups.

That last detail was not obvious and the pipeline found it: the first version
of the world had Dave owed money everywhere, and the Settle shot failed
because the `Settle` button only renders on a settlement row where *you* are
the payer. A fixture where the reader is only ever the creditor cannot
photograph half the product. It also means Home now shows both sides of its
"you're owed … · you owe …" line instead of a one-sided balance.

The demo accounts are namespaced by `SEED_REV` in `demo-world.mjs`. Changing
the shape of the world means bumping it, which builds a clean world rather
than colliding with the previous one — that is how the payer change above was
applied. Bumping it changes the email visible on the Profile screenshot, so
bump deliberately.

`scripts/docs/seed-demo.mjs` builds that world **through the real API** — the
same `POST /groups`, `POST /groups/{id}/invites`, `POST /join/{token}`,
`POST /groups/{id}/expenses` a human would hit. A fixture written straight
into SQL would be a second, private definition of the data model, and it would
rot the first time a column moved. Building it through the API means a
contract change breaks the docs build immediately and visibly.

Two states have no public endpoint, and only those two are set with SQL, via
`scripts/docs/devdb.sh`: `email_verified_at` (there is no way to click a link
in an email from a script, and without it an amber "Confirm your email" banner
sits across the top of every Home screenshot) and `is_test`.

The seed is idempotent: groups and expenses that already exist are reused. It
also caches its session tokens and retires stale sessions, because every login
opens a session and the Profile screen lists them — a seed that logged in on
every run would grow that list by one row per rebuild and make the Profile
screenshot different every time.

**The seed refuses to run against production.** It rejects any base URL
containing `electricrv.ca`, and rejects any non-localhost URL unless
`DOCS_ALLOW_REMOTE=1` is set. `devdb.sh` refuses a production-looking
`DB_HOST`. The manual is photographed on a dev database, never on live user
data — screenshots are published to the internet, and other people's grocery
bills are not ours to publish.

### 3.3 How determinism is achieved

Verified: **two consecutive full runs produce byte-identical PNGs** for all
eleven screens, and identical `uiHash` values. That is the bar, and it is met
by nailing down every source of variation:

| Source of drift | How it is pinned |
|---|---|
| Data | The seeded demo world above — fixed names, amounts, dates |
| Today's date | `demo-world.mjs` `TODAY = 2026-07-15T10:24-04:00`, and Playwright's `page.clock.install()` freezes the browser clock to it, so "this month", relative dates and date defaults never move |
| Exchange rates | The foreign expense passes `fxRateOverride: 1.37`, stored as source `manual` — no call to the ECB feed, no rate that differs between two runs |
| Viewport | Fixed per device in `shots.mjs`: 1280×900 desktop, 390×844 narrow, `deviceScaleFactor: 2` |
| Theme | Forced via `localStorage['slytab.theme']` **and** the context `colorScheme`, so the app's "System" default never consults the machine |
| Locale / timezone | `en-CA` / `America/Toronto`, so currency and date formatting are identical on any machine and in CI |
| Motion | `reducedMotion: 'reduce'`, `animations: 'disabled'`, plus injected CSS that kills every transition, animation and the text caret |
| Fonts and rasteriser | Capture runs inside a **pinned container**, `mcr.microsoft.com/playwright:v1.61.1-noble` |
| Async races | A custom `settle()` (see below) |
| Genuinely per-device content | Masked, and excluded from the hash — see below |

**The container is not ceremony.** The dev machine here has *no emoji font
installed at all* (`fc-list | grep -c emoji` → 0), so the first run of this
pipeline rendered every group emoji as a ▯ box. The pinned image ships
`NotoColorEmoji.ttf`. Font availability, Chromium build and text rasteriser
all have to be identical every run, or the images churn for reasons that have
nothing to do with SlyTab. The image tag is pinned in `make-docs.sh` and
bumping it is a deliberate act that will re-stamp every screen.

**`settle()` does not use `networkidle`.** Playwright's `networkidle` is
scoped to a navigation, so after an in-app click — which is every click in a
SPA — it returns instantly. That is not a theoretical concern: the first run
of this pipeline shipped a completely blank Balances tab because of it, while
reporting success. `capture-web.mjs` instead counts in-flight requests itself
and waits for the count to sit at zero for 500 ms, then waits for skeletons to
detach, then for `document.fonts.ready`. On top of that, every shot declares
`expect` — text that must be visible — so a screen that silently loses its
content fails the build instead of quietly shipping an empty picture.

**Masking is the small, controlled escape hatch.** Exactly one region on one
screen is genuinely per-run: Profile's signed-in-devices list, which renders
real server timestamps as "last active …" against a frozen browser clock. A
shot may declare `mask: [{ selector, hasText }]`; those nodes get a
`data-docs-mask` attribute, are painted over in the image, and collapse to a
single `<masked/>` token in the signature. Anything added to `mask` needs a
comment saying why, because every masked region is a region the gate can no
longer see.

### 3.4 Android

`scripts/docs/capture-android.sh` drives the disposable emulator on `kdocker2`
(`budtmo/docker-android:emulator_13.0`), the same one
`scripts/dev/font-scale-audit.sh` already uses. The device is recreated from
the image every run, so it carries nothing over: fixed device profile, font
scale 1.0, animations off, SystemUI demo mode for a still status bar, frozen
device clock.

Navigation is by **text, not coordinates**: a `uiautomator dump` gives every
node's text and bounds, so a step taps "the button that says Balances" rather
than a pixel that moves at the next layout change. That same dump is the
`uiHash` input, so one gate covers both surfaces.

Credentials come from `DOCS_DEMO_EMAIL` / `DOCS_DEMO_PASSWORD` in the repo env
file — the same place every other ops script reads secrets from — and are
passed to the remote shell as arguments, never echoed. Copy them there once
from `docs/private/review-account.md`.

**Android screenshots are not yet deterministic, and this is honest, not a
bug to hide.** `apps/mobile/src/api.ts` hard-codes
`https://electricrv.ca/slytab/api/v1`, so a released APK can only ever show
*production* data. The Android shots therefore come from a demo account on
prod, not from the seeded demo world, and anything that account's data does
between releases shows up in the manual. The gate marks them
`deterministic: false` and treats them as coverage-only. The fix is one line
in the mobile app — read the base from `EXPO_PUBLIC_API_BASE`, defaulting to
today's value — plus a `demo` EAS profile; it was out of scope for this change
because #104 forbids touching app source. Until then, prefer the web
screenshots for anything the manual explains in detail, and use Android shots
to show the phone shell.

---

## 4. How it is invoked

One command:

```bash
bash scripts/docs/make-docs.sh              # web screenshots + staleness gate
bash scripts/docs/make-docs.sh --android    # also drive the emulator
bash scripts/docs/make-docs.sh --no-check   # regenerate without gating
bash scripts/docs/make-docs.sh --theme light
```

It brings up the local stack if it is not already running (PHP API container
with `MAIL_DISABLE=1`, Vite on :8000 proxying `/api`), seeds the demo world,
captures every shot inside the pinned container, and runs the gate. It refuses
a production base URL and cleans up anything it started.

Prerequisites are the ones the repo already has (`docs/dev-environment.md`):
Docker, the `slytab-php:dev` image, and the dev MySQL on `kdocker2`. If the
dev database is behind, run `npm run db:migrate` first — the pipeline will
otherwise fail at the seed with a column error, which is the correct place to
fail.

### Where it plugs into the release flow

The docs must never claim something a user cannot yet see, which is the same
rule the release policy already applies to bug-report emails.

1. **On any change to a screen** — the author runs `make-docs.sh`, reads the
   sections the gate flags, edits the prose, and re-accepts. This is the main
   loop; it belongs in the same commit as the UI change.
2. **`scripts/worker/release-mobile.sh`** — no change. It bumps versions and
   starts builds; the docs are already current by then, or the change was
   never merged.
3. **`scripts/worker/release-finish.sh`** — when both platforms have shipped
   and the release is being closed out, that is the moment the published site
   copy should be refreshed, because that is the moment the screenshots become
   true for everyone. Add, immediately before the reports are closed:

   ```bash
   bash "$REPO/scripts/docs/make-docs.sh" >>"$LOG" 2>&1 \
     && node "$REPO/scripts/docs/build-site.mjs" >>"$LOG" 2>&1 \
     && npm --prefix "$REPO" run deploy >>"$LOG" 2>&1 \
     || say "docs rebuild failed — release continues, docs are stale"
   ```

   Deliberately non-fatal there. A release that has already put an APK in
   people's hands must not be abandoned because a screenshot job could not
   reach the emulator host; the owner gets told instead. The *blocking* copy
   of this check is the one in CI, below.
4. **CI** — `.github/workflows` should run `node scripts/docs/check-docs.mjs`
   against the committed `shots.web.json`. That is the gate that actually
   stops stale prose from merging, and it needs no browser, no database and no
   network: it reads the committed capture metadata, re-hashes the source
   files and re-hashes the prose.

That split matters. Generating screenshots needs a whole stack and is
therefore run by a human or by the release job; *checking* costs milliseconds
and is therefore run on every push.

---

## 5. The staleness check

`node scripts/docs/check-docs.mjs`.

Generated screenshots cannot go stale — they are rebuilt from the app. The
prose can, silently. So the gate compares three fingerprints per documented
screen:

- **`uiHash`** — what the screen *says and contains*: its visible text plus
  its element skeleton (tag, role, `aria-label`), normalised and captured at
  screenshot time. Deliberately **not** a pixel hash: pixels change when
  Chromium changes its text rasteriser, which would cry wolf, whereas a
  renamed button, a new control or a reordered section is exactly what a
  manual needs re-reading for.
- **`srcHash`** — the contents of the files in the shot's `sources`. This
  catches what `uiHash` cannot: a pure CSS restyle, or a behaviour change
  behind an unchanged label. A source file that no longer exists is itself
  reported, because it means the screen was rewritten and the shot list was
  not.
- **`proseHash`** — the manual section under the shot's anchor.

`docs/user-guide/docs-state.json` records, per screen, the `uiHash` and
`srcHash` that a human last accepted the prose against. The gate fails when
either has moved and the prose has not been re-accepted since:

```
✗ group-balances: the screen changed and its documentation did not
    uiHash   a91f4c02… → 4c02a91f…  (what the screen says changed)
    srcHash  7b3e0011… → 91aa54cd…  (the code that draws it changed)
    read     docs/user-guide/manual.md#group-balances, update it if needed, then:
             node scripts/docs/check-docs.mjs --accept group-balances
```

It also fails when:

- a shot could not be captured at all (the shot list no longer matches the UI);
- a screen on the `ui_requirements.md` §4 checklist has no shot;
- a manual section has no anchor matching a shot's `doc.anchor`;
- a section does not actually embed its screenshot — prose that describes a
  screen without showing it is how manuals start drifting.

Prose edited on its own re-stamps quietly: writing better English about an
unchanged screen is not something to gate.

**`--accept` is per-screen and manual on purpose.** `--accept-all` exists for
a genuine bulk rewrite, and using it routinely turns the gate into a rubber
stamp, which is the same as not having one. The point of the flow is that a
human's eyes crossed the section between the change and the acceptance. There
is no way to enforce that in software; there is only a way to make skipping it
a visible, deliberate act.

### What this cannot catch

Stated plainly, because a check whose limits are unknown gets over-trusted:

- **Prose that was wrong when it was written.** The gate proves the prose was
  looked at, not that it is correct.
- **Copy changes behind a mask.** One region, on one screen (§3.3).
- **Server-side behaviour with no visible surface** — a changed FX fallback
  window, a changed retention rule. `sources` can list an API service file to
  pull those in, and for anything the manual asserts about behaviour it
  should.
- **Screens not on the list.** Coverage is checked against
  `ui_requirements.md` §4, so §4 has to stay honest — which it is already
  supposed to be.

---

## 6. Who updates the prose, and when

| Trigger | Who | What they do |
|---|---|---|
| A UI change lands | The author of the change | `make-docs.sh`, fix flagged sections, `--accept`, all in the same commit |
| A behaviour change with no visual tell | The author | Update `why-slytab.md` / `faq.md`; add the service file to `sources` so it is gated next time |
| A user asks the same question twice | The worker session that handles the second report | Add an FAQ entry; the `bug_reports` table is the backlog |
| A release ships | `release-finish.sh` | Rebuild and publish the site copy (§4) |
| Quarterly | Owner | Re-read `why-slytab.md` against the competitor's current product — a comparison ages faster than a manual, because the other side ships too |

The autonomous worker's remit is unchanged: it handles end-user bug reports
only. Regenerating and re-accepting documentation for a screen it changed
while fixing a report is part of that fix, not new scope. Writing the
comparison, restructuring the manual, or deciding what goes in the FAQ is
owner-directed work.

---

## 7. Publishing to the marketing site

`scripts/docs/build-site.mjs` renders each `docs/user-guide/*.md` into the
existing marketing page shell and writes:

```
apps/web/public/marketing/help/index.html      hub: manual · FAQ · why SlyTab
apps/web/public/marketing/help/manual/index.html
apps/web/public/marketing/help/faq/index.html
apps/web/public/marketing/help/why/index.html
apps/web/public/marketing/help/img/**          copied from docs/user-guide/img
```

Requirements on it, so it does not become a second style system:

- Reuse the CSS block already inlined in
  `apps/web/public/marketing/support/index.html` (dark/light via
  `prefers-color-scheme`, 640px column, `Space Grotesk` headings). Every
  marketing page is a self-contained file with no external requests; the help
  pages must match.
- Widen the column for the manual only — 640px is right for a privacy policy,
  too narrow for 1280px-wide screenshots. Images get `max-width: 100%` and a
  border matching `.card`.
- Rewrite `img/web/foo.png` → `img/web/foo.png` relative to the published
  page, so the same Markdown renders correctly both on GitHub and on the site.
- Emit nothing that is not generated from `docs/user-guide/`. If a page needs
  hand-written HTML, it belongs in `marketing/` as its own page, not here.

**This script is the one piece deliberately not yet written.** A renderer with
nothing to render cannot be verified, and shipping unverified code into a
"cannot go stale" pipeline would be the wrong kind of thorough. It lands with
the first draft of `manual.md`. Everything it depends on — the images, the
metadata, the gate — exists and is proven.

---

## 8. Substance for "why SlyTab", verified

The comparison must be checkable or it is marketing. Each claim below was
verified against the code on 2026-07-31; several were **wrong as originally
briefed**, and the corrected wording is what should be published.

**Rates are captured at entry, and balances are computed from the stored
rate.** `ExpenseService::validate()` locks an FX rate onto every
foreign-currency expense (`api/src/Services/ExpenseService.php:547-563`);
`BalanceService` reads only that stored rate. Balances do not move when the
market does. **Correction to the brief:** "never re-fetched" is too strong.
`update()` re-runs the same validation, so re-saving an expense re-derives the
rate for its date — and a manual override is *not* carried through an edit
(`apps/web/src/screens/Group.tsx:495`), reverting to the ECB rate. The
`/me/expenses` total also converts live rather than from stored rates. Publish
the honest version: *"the rate is captured on the expense when you add it, and
every balance is computed from that stored rate; re-saving an expense
re-derives it."* Splitwise's bulk currency conversion, which rewrites settled
expenses and warns that it will move other members' balances, is still the
sharper contrast — and it is a fair one.

**Receipt scanning runs on our own hardware.** `RECEIPT_ENGINE=auto` with
`LOCAL_LLM_URL` set routes every scan to a self-hosted Ollama
(`qwen2.5vl:7b`) on the owner's box (`ReceiptService::parseLocal()`,
`docs/llm-requirements.md`). No cloud OCR or vision API is in the path at all.
**Caveat worth stating rather than hiding:** a Claude-API path is compiled in
and switched off in production (`scripts/deploy-api.sh` writes an empty
`ANTHROPIC_API_KEY`), and `docs/requirements.md` FR-4.1 is stale in still
describing it. Say "receipt photos are read by a model on our own hardware and
do not leave it", and keep it true.

**EXIF is stripped server-side.** `ReceiptService::stripJpegMetadata()` runs on
every ingest and removes the whole APP1 segment — all EXIF, including GPS, and
XMP — losslessly, with tests (`api/tests/ExifStripTest.php`). **Two caveats:**
it is JPEG-only (a WebP upload from a non-SlyTab client would pass through),
and the *client* reads GPS from the original bytes before upload
(`packages/core/src/exif-gps.ts`) to guess the currency. That last one is a
better story than the brief assumed, so tell it: *the coordinates never leave
your device; only a three-letter currency code is sent, and the stored photo
has its metadata stripped on the server.*

**Money is integer minor units with per-currency scale.** `packages/core/src/money.ts`
and `api/src/Support/Money.php` mirror each other. **Correction:** the shared
vectors in `packages/core/test-vectors/` cover *split and debt-simplification*
math — 10 + 5 cases, asserted from both Vitest and PHPUnit against the same
files — plus 35 category slugs. The `Money` layer itself is duplicated in two
languages with no cross-language vector. Claim exactly the 15 cases; do not
claim "all the money math".

**No analytics or tracking SDKs.** True, and unusually so: no Sentry, Firebase,
Amplitude, GA, Segment or `expo-updates` anywhere; the iOS privacy manifest
declares `NSPrivacyTracking: false` with empty collected-data types. **Caveats:**
push notifications go through Expo's service, the Google and Apple sign-in
buttons load third-party scripts when configured, and the server keeps its own
receipt-scan metrics. Say "no third-party analytics", not "no telemetry".

**Account deletion is in-app and anonymising.** `AuthService::deleteAccount()`
scrambles the identity, keeps the expense history other members' balances
depend on, hard-deletes OAuth identities and verification rows, and calls
Apple's `/auth/revoke` for the stored refresh token. **Caveat:** revocation is
best-effort by design and deletion succeeds regardless; push-token rows are not
removed. Phrase it as *"your identity is erased; the expense history other
people's balances depend on stays, attributed to 'Deleted user'."*

### Where Splitwise is better — publish this, unhedged

A comparison that only flatters is one nobody believes twice.

- **Recurring expenses** (FR-3.6) and **settlement reminders** (FR-7.4) are
  specified and unimplemented. Rent gets re-entered by hand every month.
- **Offline** — `docs/requirements.md` NFR-5 promises a read-only cache;
  nothing in `apps/mobile/` implements it. No connectivity, no app. Splitwise
  works on a plane.
- **Payments** — SlyTab never moves money and never will (explicit non-goal).
  It emits PayPal.Me / Venmo / Interac deep links and records a self-reported
  "I sent it". Splitwise has real payment rails.
- **Reach** — iOS is TestFlight-only, Android is a sideloaded APK, the web app
  is not a PWA and is English-only.
- **Scale and availability** — one self-hosted stack, no redundancy, designed
  for ≤100 users. If the model host goes down, receipt scanning fails outright
  rather than falling back.
- **Currency coverage** — roughly 50 codes; outside that an expense cannot be
  saved, and mobile has no manual-rate escape hatch at all.
- **No social layer** — no friend graph, no discovery, invite by link or email
  only. For some people that is the feature; say so, but say it after
  admitting it is a limitation.

Where SlyTab genuinely wins: Splitwise CSV **and** API import, CSV and full
JSON export, no ads, no paywalled features, Apache-2.0 source, cross-language
parity tests on the split math, and receipts processed on hardware the owner
controls.

---

## 9. The in-app Help entry

Required by #104, **not done in this change** because #104 also forbids
touching app or web source. It is a small, well-defined follow-up:

- **Web** — `apps/web/src/screens/Home.tsx`, the Profile block. There is
  already a footer line linking `marketing/privacy/`
  (`Home.tsx:628`) and a `🐛 Report a bug` button (`Home.tsx:414`). Add a
  `Help & how-to` row immediately above *Report a bug*: someone about to file
  a report should pass the manual on the way. Use
  `${import.meta.env.BASE_URL}marketing/help/`, matching the privacy link, so
  it works in dev and under `/slytab/`.
- **Mobile** — `apps/mobile/App.tsx`, the same position relative to the
  existing report button (`App.tsx:1073`) and privacy link (`App.tsx:1280`).
  `Linking.openURL('https://electricrv.ca/slytab/marketing/help/')`.
- **Marketing** — add Help to the nav of `marketing/support/index.html` and to
  `marketing/apps/index.html`.
- Both additions land in the shot list (`profile` already covers the screen),
  so the gate will demand the manual's Profile section mention them.

Both apps changing means the mobile release rule applies: the web link ships
immediately, the mobile one only reaches users on the next build, and no
reporter is told "it's fixed" until it does.

---

## 10. Non-goals

Explicit, so nobody expands this by accident:

- **Not developer documentation.** `docs/architecture.md`,
  `docs/requirements.md` and `docs/design/` keep their audience. The user
  guide never mentions a table, an endpoint or a file path.
- **Not a screenshot-diff test suite.** The gate asks "was this prose
  re-read?", not "does this screen look right?". Visual regression is a
  different job with a different failure mode, and bolting it on here would
  make the docs build fail for reasons no writer can act on.
- **Not pixel-exact assertions.** Pixel equality across two runs on one
  machine is a nice property and it holds today, but it is not something the
  gate depends on and it must never become a merge blocker — a Chromium bump
  would then break every pull request.
- **Not localisation.** English only, matching `requirements.md`.
- **Not video, GIFs or an interactive tour.** Every one of those is a thing
  that goes stale and that no gate here can check.
- **Not a public docs site with its own framework.** Four static pages in the
  existing marketing shell, deployed by the existing deploy. No Docusaurus, no
  second build system, no second stylesheet.
- **Not screenshots from production.** Ever. The seed refuses it in code.
- **Not an automatic prose writer.** The gate can tell you a section needs
  re-reading. It cannot tell you what to say, and it should not pretend to.

---

## 11. Current status

| Piece | State |
|---|---|
| Demo world + API seeding | **Working**, idempotent, refuses production |
| Web capture, 11 screens | **Working**; two consecutive runs byte-identical |
| Pinned capture container | **Working** (`playwright:v1.61.1-noble`) |
| `uiHash` / `srcHash` / `proseHash` gate | **Written**; blocked on prose existing (it fails today with "no section anchored …", which is correct — the manual is not written) |
| Android capture | **Written, not yet run end-to-end**; non-deterministic until `EXPO_PUBLIC_API_BASE` exists (§3.4) |
| `build-site.mjs` | **Deliberately deferred** to the first draft (§7) |
| `manual.md` / `faq.md` / `why-slytab.md` | Not written — out of scope for #104 |
| In-app Help entry | Not done — needs app source changes (§9) |
| CI gate wiring | Not done — one step in `.github/workflows` (§4) |
