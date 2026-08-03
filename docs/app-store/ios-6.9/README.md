# App Store screenshots — 6.9-inch iPhone

Apple will not accept a submission without these, and neither the owner nor
this project has an iPhone or a Mac. They are captured from the real iOS app
running in a simulator on a GitHub macOS runner:

    Actions → "iOS App Store screenshots" → Run workflow

The run produces an `ios-screenshots` artifact. Download it, drop the numbered
PNGs in this directory, and attach them with:

    python3 scripts/ops/upload-screenshots.py docs/app-store/ios-6.9

They live in the repository rather than only in an artifact because a GitHub
artifact expires and a listing asset should not depend on one. The
documentation pipeline commits its screenshots for the same reason.

Every image is 1320×2868 — the 6.9-inch size Apple requires — and shows a
seeded demo world, never anyone's real spending. The build points at a
throwaway API on the runner, and the workflow refuses to run if it does not
(see `build.ios-simulator.env` in `apps/mobile/eas.json`).
