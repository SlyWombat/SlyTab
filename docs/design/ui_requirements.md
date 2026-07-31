# SlyTab — UI Requirements

**Date:** 2026-07-22 · **Status:** v1.0 screen inventory. Companion to
[DESIGN.md](DESIGN.md) (tokens/components) and
[requirements.md](../requirements.md) (FR references).

Mobile (Expo) is the primary surface; web mirrors it with a centred 640px
column (lists) and modal sheets. Differences are called out per screen.

## 1. Navigation shell

Mobile: bottom tab bar with four tabs — **Home**, **Groups**, **Activity**,
**Profile** — plus a floating add-expense FAB on Home and Group screens
(labelled `＋ Add expense` on Home, see §2.2; bare `+` inside a group).
Web: left sidebar with the same four destinations; the same FAB pattern
applies (plus the `n` shortcut, §3).

Mobile shell status: the four-tab bar shipped in v0.1.3 (issue #40
follow-up) — Home, Groups, Activity (client-side merge of the per-group
feeds until a global endpoint exists; no unread dot yet), and Profile
(tab icon is the user's avatar badge; the former profile sheet is now a
screen). Groups open as a pushed screen over the shell. All screens and
sheets respect the device safe areas; nothing may render under the
Android gesture bar or the status bar (issue #40, SDK 54 edge-to-edge).

Web shell status: the four destinations shipped 2026-07-31 (issue #103) —
a left rail on wide viewports that becomes a bottom bar under 760px, since a
fixed rail on a phone-width browser costs more than it gives. Selection is
carried by colour and weight, not opacity. Group detail is a pushed screen
over the shell and returns to Groups. Before this, web had no sidebar, no
Groups or Activity screen, and Profile was a sheet — so the global activity
feed (FR-8.1) was unreachable outside the phone, and "My expenses" had to
live under Profile on web while sitting under Activity on mobile.

Deep links: `slytab://join/<token>` (and
`electricrv.ca/slytab/join/<token>`) → Join Group screen;
`slytab://expense/<id>` → Expense Detail (used by push notifications).

## 2. Screen inventory

### 2.1 Onboarding & auth

**Welcome** — wordmark, one-line pitch, `Create account` (primary),
`Sign in` (secondary). If launched from an invite link, show "Dave invited
you to *Cottage Trip*" above the buttons and carry the invite through
auth (FR-2.3).

**First-run onboarding** (issue #36) — the first time a user reaches the
app after creating/claiming their account (server `onboarded_at` is null),
a one-screen welcome captures the essentials before anything else: their
display name and **home/base currency** (pre-filled from the browser
locale on web, overridable), plus an optional "how people pay you"
(Interac / PayPal / Venmo) disclosure. `Get started` stamps `onboarded_at`
via `PATCH /me {onboarded:true}` and drops them into the app (invite-joins
continue into their group). Everything is editable later in Profile; the
flow is shown once. Existing users are backfilled so they never see it.

**Create account / Sign in** — email, password (min 10 chars, strength
hint), display name (create only). Inline validation on blur; server errors
inline, not toasts. `Forgot password?` → email-entry screen → "check your
inbox" confirmation (identical response whether or not the account exists).

**Third-party sign-in (FR-1.7)** — below the form, an "or" divider with
the official Google button and an Apple button (web; each hidden unless
the server reports it configured). On mobile, `Continue with Google`
(issue #39) opens the system browser to the web `/app-signin/<state>`
page; the button shows "Waiting for your browser…" with a `Cancel` link
until the app claims the session, and the browser page ends on "You're
signed in ✓ — switch back to the SlyTab app", auto-opening
`slytab://signed-in` with an `Open SlyTab` link as fallback (issue #40).
The mobile button renders immediately from the cached last-known server
answer rather than waiting on the config fetch.

**First-run setup** (create only) — pick avatar colour/emoji, default
currency (pre-set CAD), optional payment handles with a "you can add these
later" skip. One screen, not a carousel.

### 2.2 Home

The answer to "where do I stand?" — and the fastest way to add an expense.

- Hero: total net position across all groups in the *user's* home
  currency, mono tabular (Ledger principle 1), with a plain-language
  split line underneath when anything is outstanding: "you're owed
  **C$182.00** · you owe **C$36.00**" — owed green, owe amber, both
  served by `/me/balances` (`total.owedMinor` / `total.oweMinor`).
  "All settled up ✓" only when both sides are zero (a zero *net* with
  offsetting balances still shows the split). Tertiary line: "Across N
  groups · converted to CAD at today's rate".
- Sections carry counts ("Friends · 2", "Groups · 3"). Friends (direct
  groups) list first as people rows; groups render as **cards**: the
  emoji in a 44px rounded tile (`--ss-surface-2`, emoji font fallback),
  group name, and up to two per-person ledger lines — "Jon owes you
  **US$481.30**" / "you owe Vijay **US$12.00**" (first names, amounts
  mono + direction-coloured), then "plus N more balances". The card
  answers *who owes whom* without opening the group
  (`items[].myPairs` on `/me/balances`, biggest first). A group with no
  outstanding pairs reads "all square with Jon, Vijay ✓"; a one-member
  group prompts "just you so far — invite your people".
- Archived groups are hidden behind a "Show N archived groups" toggle
  (declutter; they're read-only anyway).
- Row tap → that person/group's detail.
- Pull-to-refresh (mobile) / auto-refetch on focus (web).
- Empty state: "No expenses yet. Start a group and invite your people."

**Quick add expense (issue #20).** Adding an expense is the everyday action;
creating a group is rare. Home therefore leads with a labelled
`＋ Add expense` pill FAB (not a bare `+`, and not group creation):

- One active (non-archived) group → straight into that group's Add Expense
  sheet (§2.5). No intermediate taps.
- Several groups → a "Where did this expense happen?" picker sheet listing
  friends and groups, with the most recently used group pinned first and
  tagged "recent" (remembered per device: `slytab.lastGroup` in
  localStorage / secure store, updated on group open and quick add).
- The sheet opens pre-set to the chosen group's last-used currency (same
  mid-trip behaviour as adding from inside the group).
- No groups yet → the picker explains and offers `New group` /
  `Split with a friend` as the primary actions.
- Group creation stays available but secondary: a small `New group` button
  in the footer beside `Split with a friend`.
- Web keyboard: `n` opens quick add (§3 web parity).

### 2.3 Groups list

Cards: emoji, name, member badges (max 5 + overflow), your net in that group
(Amount, colour-coded). Archived groups in a collapsed section. `New group`
button top-right.

**Create group sheet** — name, emoji picker, home currency (defaults to your
currency). On create → straight to Invite sheet.

**Invite sheet** — leads with **People you know** (issue #24 / FR-2.6):
everyone from your other groups, deduped, alphabetical, one `＋ Add` tap
each — no email, no round-trip. Below it, "Or someone new": email invite,
QR code (large, centre), share-link button (system share sheet on mobile,
copy on web), expiry note ("Link works for 7 days"), `Revoke link`.
(FR-2.3)

**Join group** (via link/QR) — group name, emoji, member count, `Join`
button. If not signed in, auth flows first and returns here.

### 2.4 Group detail

Header: emoji + name, member badges, **your net balance in this group**
(Amount-lg). Tab strip: **Expenses · Balances · Totals**.

The category picker offers the five headings first (one tap still files an
expense — speed entry is unchanged) with the chosen heading's subcategories
on a second row; on web it is a grouped `<select>`. Hidden categories are
omitted unless the expense being edited already uses one.

**Expenses tab** — reverse-chron list grouped by month. Row: category chip
colour-strip, description, payer ("Dave paid"), date, and right-aligned
*your share effect* ("you lent C$18.00" green / "you borrowed C$7.50"
amber / "not involved" tertiary). Receipt-attached expenses show a 📄 glyph.
Infinite scroll (cursor pagination). Row tap → Expense detail.

**Balances tab** — each member's net (BalancePill), then the **simplified
settlement plan** (FR-6.2): "Alice → Dave C$25.00" rows, each with a
`Settle` button. A toggle reveals raw pairwise balances ("show all debts").

**Totals tab** — group total spent, per-member paid vs share, this
month/all-time toggle, per-category totals as a simple horizontal bar list
(no chart library; SplitBar-style bars). Category totals roll **subcategories
up under their heading**, with the leaves indented beneath so the breakdown
stays explorable. `Export CSV` lives here (FR-9.1).

**Categories page** — reached from the group's footer actions, a full screen
rather than a sheet. Lists every heading with its subcategories; each row is
an editable label with a `Reset` affordance once renamed, and a show/hide
toggle. Headings can be moved up and down. `Save` appears in the header only
when something differs from what is stored. The last visible category cannot
be hidden. Everything scrolls in one container so large system font scales
push content down rather than collapsing a list.

Group settings (gear): rename, emoji, home currency (only while the group
has no foreign-currency expenses), members list (with leave/remove per
FR-2.4), invite, archive.

### 2.5 Add / edit expense (the money screen)

Bottom sheet, optimized for a 10-second entry (issue #37). The happy path
is **amount → description → Save**: date defaults to today, category and
payer to sensible defaults, and those rarely-touched fields (paid-by,
date, category, notes) live behind a **"More options"** disclosure whose
summary line shows their current values (and flags any non-default so
nothing is silently hidden). The split section states its default plainly
— "Split equally — everyone's in (N)" — with one-tap **Everyone / Just
me** shortcuts. Full field order when expanded:

1. **Amount + currency** — Keypad, giant mono amount, currency chip
   (defaults to group home currency; recently-used currencies first).
2. **Description** — single line; category auto-suggested from keywords,
   overrideable chip row (FR-3.1).
3. **Paid by** — defaults to you; tap → member picker; supports multiple
   payers with per-payer amounts that must sum to total (FR-3.3, live
   remainder shown).
4. **Split** — segmented control over all five methods (FR-3.2, issue
   #13): `Equal · Exact · Shares · % · +/−`. Equal shows the member
   checklist (everyone on by default). Exact gives one amount row per
   member with a live "remaining: C$0.00" reconciliation line that must
   reach zero before save. Shares / % / +/− give one input per member
   (share count, percentage, signed offset) with the computed per-member
   amount previewed beside it and the split-math error ("percentages sum
   to 92, expected 100") shown as the hint until the inputs reconcile.
   Editing re-opens on the stored method with its inputs restored
   (persisted as `splitInput`).
5. **Date** (defaults today) · **Notes** · **Receipt** (`Scan receipt`
   primary, `Attach photo` secondary).
6. `Save` — disabled until amount > 0 and splits reconcile. Save is
   optimistic: sheet closes, row appears immediately, error rolls back with
   a toast + retry.

Editing an existing expense reuses the sheet, pre-filled; a footer notes
"Edits are visible to the whole group" (FR-3.4).

When the expense already has one or more scanned receipts (FR-4.4), the
receipt row swaps to three actions:

- **View receipt(s)** — full-screen viewer over the sheet; pager when a
  bill + card slip are both attached; `New photo` and `Close` beneath.
- **Rescan** — re-runs the parser on the *stored* photo server-side
  (`POST /receipts/{id}/rescan`, same daily cost guard as scanning) and
  drops into the normal review/assign flow (§2.6 steps 3–5). No
  re-photographing — useful when the parser has improved or the first
  read was wrong.
- **New photo** — replaces the scan via the usual capture flow (§2.6).

The sheet seeds its receipt links from the expense being edited, so
saving an edit never silently detaches a receipt.

### 2.6 Receipt scan flow (FR-4.x)

1. **Capture** — camera with receipt-framing guides, torch toggle, gallery
   pick. After capture: crop/rotate, `Use photo`. The photo's EXIF GPS
   picks the likely local currency (issue #21 / FR-4.7): a receipt
   photographed in Chile hints CLP no matter what the form currently
   shows. Read client-side from the original bytes (shrinking strips
   EXIF; screenshots have none) via `gpsFromJpeg` + `currencyForLocation`
   in @slytab/core; the printed currency, when the parser can read one,
   still wins.
2. **Parsing** — indeterminate progress on a dimmed receipt thumbnail
   ("Reading your receipt…", typically 3–10s). Cancel returns to manual
   entry with photo attached. Parse failure → friendly error + `Enter
   manually` (photo stays attached) (FR-4.2).
3. **Review items** — editable list of parsed items (name, qty, price);
   subtotal/tax/tip/total fields below. If the numbers don't reconcile
   (low confidence), a caution banner highlights the delta and the
   mismatching fields get amber outlines. Users can add/delete/edit rows.
4. **Assign items** — member badges across the top; tap an item then tap
   badges to assign (multi-assign splits that item equally among its
   assignees). Unassigned items sit under a "Nobody yet" header; a
   `Split rest equally` shortcut clears the remainder. Tax + tip prorate
   automatically and are shown per-person in the live footer ("Dave
   C$23.10 · Alice C$18.75") (FR-4.3). Every row has an ✕ to **ignore**
   a line that isn't part of the bill — loyalty credits, promo blurbs
   the parser mistook for items (issue #23); ignored lines count toward
   nothing, don't block `Continue`, and can be restored with ↩. The
   math lives in @slytab/core (`receiptBill` / `assignedShares`), shared
   by web and mobile and covered by the totals-invariant test suite.
5. `Continue` → returns to the Add Expense sheet with amount, description
   (merchant), date, currency, and an exact-amounts split pre-filled;
   normal save applies.

### 2.7 Settle up (FR-7.x)

Entry: `Settle` on a simplified-plan row, or `Settle up` on a person.

**Settle sheet** — "You pay Dave" + editable amount (pre-filled with the
owed amount, partial payments allowed), then payment methods as large
buttons, built from Dave's saved handles: `Interac e-Transfer` (opens mail
compose with amount/memo), `PayPal.Me`, `Venmo`, and always `Record cash /
other`. After launching a payment app: "Did you send it?" → `I sent it`
records a **pending** settlement (FR-7.2).

Payee experience: pending settlements appear at the top of Home and in
Activity with `Confirm received` / `Didn't get it`. Confirm plays the
settled animation; decline notifies the payer with a note field.

Profile → payment handles screen explains each format inline and validates
shape (email for Interac, username patterns for PayPal/Venmo).

### 2.8 Expense detail

Full record: amount (hero), description, category, payer(s), date, split
breakdown (SplitBar + per-member rows), converted amount + rate + source
when foreign (with `Edit rate` per FR-5.4), receipt thumbnail → full-screen
viewer (pinch zoom), notes, edit history (collapsed), `Edit` / `Delete`.
Delete asks once, then soft-deletes with an undo toast (FR-3.5).

### 2.9 Activity (FR-8.1)

Global feed, reverse-chron, grouped by day: "Dave added *Groceries* C$82.10
in **Household**", "Alice confirmed your payment", member joins, edits
(tappable → diff view), deletions (with `Restore` for 30 days). Per-group
feeds appear inside Group detail via the header. Unread dot on the tab
badge.

### 2.10 Profile & settings

Sections: account (name, avatar, email, change password), payment handles,
default currency, theme (System / Dark / Light), notifications (per-category
toggles, off by default per FR-8.2), sessions/devices (revoke; labels name
the browser and OS — issue #26 — and idle sessions are swept on login),
**get the phone apps** (issue #27: web-only link to the install page —
home-screen install today, Android beta APK, iOS TestFlight when live),
**report a bug** (FR-10.1: inline form — "what went wrong?" textarea +
optional screenshot attach; confirmation reads "Thanks — your report is
in"; the reporter is emailed on receipt and on resolution per FR-10.2),
export my data (FR-9.2), sign out, delete account (typed confirmation,
explains anonymization per FR-1.5). Footer: version + git SHA, privacy
policy link, "Made by Electric RV".

### 2.11 My expenses (FR-11.1)

Reached from **Profile → My expenses** on web, and on mobile from a segmented
control at the top of the **Activity** tab (*Activity | My expenses*).

Deliberately **not a fifth tab**: the shell is four (§1) and the tab bar is
the tightest thing in the UI at large text — 10.5pt labels capped at 1.2x.
A fifth would hurt exactly the users who most need the room. Activity answers
"what has happened" and this answers "what have I spent"; both are
cross-group, time-ordered lists of the same underlying events.

Layout, top to bottom: scope chips (*I'm in* / *I paid*), sort chips or a
select, then a count-and-total line, then the rows. Each row carries its
group name — without it a cross-group list reads as a pile of unrelated
amounts. Empty states name the scope ("You haven't paid for anything yet")
rather than saying "nothing here".

## 3. Cross-cutting UI rules

**Icons are drawn, never typed.** Interface icons come from the shared set
(`apps/web/src/Icon.tsx`, `apps/mobile/src/Icon.tsx`) — the same Material
Symbols geometry on both clients, so the two look like one product. Emoji and
punctuation are not icons (issue #102): they render in their own colours, so
a selected control can only be dimmed rather than recoloured; they scale with
the text size and overflow fixed containers, which is how the split checkbox
came to clip and hide who was being charged (#96); and a screen reader
announces the character. Icons take a **fixed pixel size** independent of
Dynamic Type and are hidden from the accessibility tree, so the surrounding
control keeps owning the label. Group emoji is exempt — that is content the
user chose, not chrome.


- **Money rendering** — only via the Amount component; original currency
  primary, converted secondary; direction always colour + sign, never colour
  alone (see DESIGN.md §4).
- **Optimistic writes** with rollback toasts; destructive actions get one
  confirm max plus undo where possible.
- **Offline (mobile)** — banner "Offline — showing last synced data"; all
  write affordances disabled with inline explanation (NFR-5).
- **Loading** — skeleton rows for lists (never spinners on full screens);
  receipt parsing is the one allowed indeterminate progress moment.
- **Errors** — inline near the field wherever possible; toasts only for
  background/optimistic failures; every error names a next step.
- **Accessibility** — 44pt minimum touch targets; screen-reader labels on
  all Amount components include direction words ("you are owed"); WCAG AA
  contrast in both themes; `prefers-reduced-motion` honoured; dynamic type
  supported up to XL on mobile without truncating amounts.
- **Empty states** — every list has one, with a single primary action.
- **Web parity** — keyboard: `n` = new expense, `Esc` closes sheets, forms
  submit on Enter; all sheets become centred modals ≤480px.

## 4. v1.0 screen checklist

| # | Screen | FRs |
|---|---|---|
| 1 | Welcome / auth / reset | 1.1–1.3 |
| 2 | First-run setup | 1.4 |
| 3 | Home | 6.1 |
| 4 | Groups list + create + invite + join | 2.1–2.3 |
| 5 | Group detail (Expenses/Balances/Totals) | 3.x, 6.x, 9.1 |
| 6 | Add/edit expense sheet + split editor | 3.1–3.4 |
| 7 | Receipt capture → review → assign | 4.1–4.4 |
| 8 | Settle sheet + confirm flow | 7.1–7.4 |
| 9 | Expense detail + receipt viewer | 3.5, 5.3–5.4 |
| 10 | Activity | 8.1 |
| 11 | Profile & settings | 1.4–1.5, 8.2, 9.2 |
