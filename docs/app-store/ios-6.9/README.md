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
throwaway API on the runner (`SLYTAB_API_BASE` is a job-level variable that
`expo prebuild` bakes in), and the workflow refuses to go on if the built app
does not reference it.

Nothing here comes from EAS any more: the simulator app is built on the runner
itself, ad-hoc signed, which is both free and — because an unsigned build has
no keychain entitlement and therefore cannot keep a session — necessary.

The current set is seven shots and includes the member sheet (04), which is
what 1.2 added: recording money someone handed you. The numbering after it
shifted, so replace the whole set rather than individual files.
