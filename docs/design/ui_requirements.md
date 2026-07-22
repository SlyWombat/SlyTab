# SlyTab — UI Requirements

**Date:** 2026-07-22 · **Status:** v1.0 screen inventory. Companion to
[DESIGN.md](DESIGN.md) (tokens/components) and
[requirements.md](../requirements.md) (FR references).

Mobile (Expo) is the primary surface; web mirrors it with a centred 640px
column (lists) and modal sheets. Differences are called out per screen.

## 1. Navigation shell

Mobile: bottom tab bar with four tabs — **Home**, **Groups**, **Activity**,
**Profile** — plus a floating **+** FAB (add expense) on Home and Group
screens. Web: left sidebar with the same four destinations; FAB becomes a
persistent "New expense" button in the header.

Deep links: `slytab://join/<token>` (and
`electricrv.ca/slytab/join/<token>`) → Join Group screen;
`slytab://expense/<id>` → Expense Detail (used by push notifications).

## 2. Screen inventory

### 2.1 Onboarding & auth

**Welcome** — wordmark, one-line pitch, `Create account` (primary),
`Sign in` (secondary). If launched from an invite link, show "Dave invited
you to *Cottage Trip*" above the buttons and carry the invite through
auth (FR-2.3).

**Create account / Sign in** — email, password (min 10 chars, strength
hint), display name (create only). Inline validation on blur; server errors
inline, not toasts. `Forgot password?` → email-entry screen → "check your
inbox" confirmation (identical response whether or not the account exists).

**First-run setup** (create only) — pick avatar colour/emoji, default
currency (pre-set CAD), optional payment handles with a "you can add these
later" skip. One screen, not a carousel.

### 2.2 Home

The answer to "where do I stand?".

- Hero: total net position across all groups (`--ss-type-hero`, count-up
  animation): "You're owed C$142.10" (green) / "You owe C$36.00" (amber) /
  "All settled up ✓". If multiple currencies can't be merged, show home-
  currency total with a "+ 2 other currencies" disclosure.
- Below: BalancePill list of *people* (direct groups first, then per-group
  nets), sorted by absolute amount, settled people collapsed under "Settled
  up (4)".
- Row tap → that person/group's detail. Hero tap → "Who owes whom" breakdown.
- Pull-to-refresh (mobile) / auto-refetch on focus (web).
- Empty state: "No expenses yet. Start a group or add your first expense."

### 2.3 Groups list

Cards: emoji, name, member badges (max 5 + overflow), your net in that group
(Amount, colour-coded). Archived groups in a collapsed section. `New group`
button top-right.

**Create group sheet** — name, emoji picker, home currency (defaults to your
currency). On create → straight to Invite sheet.

**Invite sheet** — QR code (large, centre), share-link button (system share
sheet on mobile, copy on web), expiry note ("Link works for 7 days"),
`Revoke link`. (FR-2.3)

**Join group** (via link/QR) — group name, emoji, member count, `Join`
button. If not signed in, auth flows first and returns here.

### 2.4 Group detail

Header: emoji + name, member badges, **your net balance in this group**
(Amount-lg). Tab strip: **Expenses · Balances · Totals**.

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
(no chart library; SplitBar-style bars). `Export CSV` lives here (FR-9.1).

Group settings (gear): rename, emoji, home currency (only while the group
has no foreign-currency expenses), members list (with leave/remove per
FR-2.4), invite, archive.

### 2.5 Add / edit expense (the money screen)

Bottom sheet, optimized for a 10-second entry. Order:

1. **Amount + currency** — Keypad, giant mono amount, currency chip
   (defaults to group home currency; recently-used currencies first).
2. **Description** — single line; category auto-suggested from keywords,
   overrideable chip row (FR-3.1).
3. **Paid by** — defaults to you; tap → member picker; supports multiple
   payers with per-payer amounts that must sum to total (FR-3.3, live
   remainder shown).
4. **Split** — segmented control: `Equal · Unequal`. Equal shows member
   checklist (everyone on by default). Unequal opens the split editor:
   sub-tabs **Amounts / Shares / % / +Adjust**, one row per member with
   inline Keypad, live "remaining: C$0.00" reconciliation line that must
   reach zero before save (FR-3.2). The split editor renders a SplitBar
   preview at the top.
5. **Date** (defaults today) · **Notes** · **Receipt** (`Scan receipt`
   primary, `Attach photo` secondary).
6. `Save` — disabled until amount > 0 and splits reconcile. Save is
   optimistic: sheet closes, row appears immediately, error rolls back with
   a toast + retry.

Editing an existing expense reuses the sheet, pre-filled; a footer notes
"Edits are visible to the whole group" (FR-3.4).

### 2.6 Receipt scan flow (FR-4.x)

1. **Capture** — camera with receipt-framing guides, torch toggle, gallery
   pick. After capture: crop/rotate, `Use photo`.
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
   C$23.10 · Alice C$18.75") (FR-4.3).
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
toggles, off by default per FR-8.2), sessions/devices (revoke), export my
data (FR-9.2), sign out, delete account (typed confirmation, explains
anonymization per FR-1.5). Footer: version + git SHA, privacy policy link,
"Made by Electric RV".

## 3. Cross-cutting UI rules

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
