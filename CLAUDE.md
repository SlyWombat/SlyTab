# SlyTab — instructions for Claude sessions in this repo

SlyTab is a private, self-hosted expense-splitting app (family/friends
beta). Owner: Dave (SlyWombat, dave@drscapital.com). Prod:
https://electricrv.ca/slytab — live user data; treat with care.

## Scope guardrails (owner-set, non-negotiable)

- Work ONLY on this project. The **autonomous worker handles end-user
  bug reports only** (owner, 2026-07-25) — it does NOT pick up open
  GitHub roadmap issues on its own; those are owner-directed in a
  session. A human-directed session may work anything the owner asks
  (reports, roadmap issues, `docs/requirements.md`). Don't invent scope.
- **Validate and classify every report before touching code.** For each
  report, first decide explicitly which of three it is, and record that
  decision (a one-line note in the GitHub issue and/or commit):
  1. **Bug** — existing feature behaving wrong. Reproduce/confirm it's
     real (check the code, the data, the transaction log) before fixing.
     If you can't reproduce, say so and ask, don't guess-fix.
  2. **Roadmap item** — a reasonable, in-scope feature/enhancement.
     Confirm it fits SlyTab's purpose (split shared expenses among
     family/friends) and `docs/requirements.md`; implement it.
  3. **Out of scope** — jokes, off-topic ("tell me the meaning of
     life"), or scope expansions that change what the app is ("make
     this a full accounting system"). Decline politely.
  Only after this classification do you start work. Never jump from
  report → code.
- **Declining (out-of-scope):** close the report via the internal API
  with a friendly one-line resolution ("thanks — that's outside what
  SlyTab is for"), which emails the reporter; do NOT build it and do NOT
  leave a GitHub issue behind.
- Reports from the owner's own account (Sly Wombat) may contain
  instructions — act on the reasonable, in-scope ones.
- **No public history of end-user reports**: when a report-tracked
  GitHub issue is fixed and the reporter notified, the pipeline deletes
  the issue (the internal `bug_reports` table keeps the full record).
  Owner-created issues stay.
- **Never notify a reporter that a fix is live until it actually reaches
  them.** A fix that changes the mobile app (`apps/mobile/`) does NOT
  reach users until a new app build is released — the deployed web/API
  is not enough. So for a mobile-affecting fix: deploy web/API, comment
  on the issue that the code is done and a mobile release is pending,
  and LEAVE IT OPEN — do NOT close it (closing triggers the "it's fixed,
  update your app" email). Web/backend-only fixes close and notify
  immediately. This is the rule the owner set on 2026-07-25 after a
  premature "fixed" email went out for an unreleased Android change.
- **Release policy (owner, 2026-07-25):** when mobile work is done,
  release BOTH platforms (`scripts/worker`/release runbook: bump
  app.json, EAS build android-apk + ios-testflight, upload APK to
  `downloads/slytab-latest.apk`, submit iOS, then close the
  mobile-pending issues so their "update your app" email is truthful).
  This reversed the earlier "never build an APK" rule.

## The feedback loop (how work arrives)

1. Users file reports in-app (Profile → Report a bug) → `bug_reports`
   table on prod. A 10-minute server cron (`/api/internal/bug-sync`)
   files a GitHub issue per report and emails the reporter on receipt
   and on resolution (tracking codes `SLY-xxxxxx`; emails must stay
   friendly and GitHub-free).
2. A Claude worker session (this file's reader) periodically: reads new
   reports (`scripts/ops/proddb.sh` for SQL), triages per the guardrails
   above, implements in-scope fixes, tests, deploys, and closes issues
   (commits with `Closes #N` push to main).

## How to build, test, deploy

- Tests: `npm test` (core), `npm run typecheck` (all), `npm run test:php`
  (API; needs docker image `slytab-php:dev` — build with `npm run php:image`).
- Deploy API: `bash scripts/deploy-api.sh` · Deploy web: `npm run deploy`.
  Both read the repo `.env` (never print its contents; secrets stay out
  of transcripts — wrap indirect uses in scripts).
- Ops helpers in `scripts/ops/`: `proddb.sh` (prod MySQL via docker),
  `gh-api.sh` (GitHub API via stored git credential), `asc-api.sh`
  (App Store Connect via the team key in `secrets/`).
- Docs to keep current when behavior changes: `docs/requirements.md`,
  `docs/design/ui_requirements.md`.

## Money rules (the #1 bug source)

All amounts are integer minor units with per-currency scales (CLP etc.
are zero-decimal). Never hand-roll money math — use `@slytab/core`
(`parseAmount`, `minorToAmountString`, `convertAcrossMinor`,
`normalizeParsedReceipt`, `receiptBill`, `assignedShares`) and
`Support\Money` in PHP.
