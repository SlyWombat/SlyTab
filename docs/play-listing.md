# Google Play listing — SlyTab (ca.electricrv.slytab)

Source of truth for what is in the Play Console. Filled via the Play API on
2026-08-09 (session pattern; graphics generated with PIL from the real app
icon). Field limits in brackets, counts as committed.

## Title [30] — 6

SlyTab

## Short description [80] — 78

Split expenses with family and friends. Receipts, currencies, fewest payments.

## Full description [4000] — ~1,590

Same text as the App Store description for 1.1 (single paragraph breaks
instead of hard-wrapped lines). If one store's copy changes, change both —
they are intentionally identical. See `docs/app-store/` for the iOS side.

## Graphics

- Icon 512×512: `apps/mobile/assets/icon.png` resized — the real app icon.
- Feature graphic 1024×500: generated — navy gradient, logo from
  `adaptive-icon.png`, Segoe UI wordmark, tagline "Shared expenses, kept
  honest."
- Phone screenshots: `store-screenshots/01…05` (1080×1920 Android captures).

## Console-only (cannot be set via API)

Data safety form, content rating questionnaire, target audience, ads
declaration ("no ads"), category. These gate the first production
send-for-review and live in the Play Console UI.

## Release model

AAB built and upload-key-signed by `.github/workflows/android-release.yml`
(artifact `slytab-release-aab`), uploaded to Play via the API, production
release created as **draft** — a never-published app requires draft status,
and a human presses "Send for review" in the Console (blueprint §8).
Android versions independently of iOS (`apps/mobile/versions.json`).
