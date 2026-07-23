# Google sign-in — setup

Status: **implemented server + web** (ID-token flow, no client secret used).
Waiting on two user steps to go live:

1. Put the OAuth client ID in the repo `.env` (and it will be copied to prod
   on the next API deploy):

   ```
   GOOGLE_CLIENT_ID=<client id ending in .apps.googleusercontent.com>
   ```

2. In Google Cloud Console → APIs & Services → Credentials → your Web
   application client: add an **Authorized JavaScript origin** of exactly
   `https://electricrv.ca`. The Google button will not render without it.
   (The redirect URI entered earlier is unused by this flow — harmless to
   keep or delete.)

Then redeploy the API (`bash scripts/deploy-api.sh`) and SPA (`npm run
deploy`). The "Continue with Google" button appears automatically once the
API reports a configured client id.

## How it works (no secret anywhere)

- Web: the official Google Identity Services button returns a signed **ID
  token** in the browser; the SPA posts it to `POST /api/v1/auth/google`.
- Server: `GoogleAuthService` validates the token via Google's tokeninfo
  endpoint (signature checked by Google) and enforces issuer, audience
  (= `GOOGLE_CLIENT_ID`), expiry, and `email_verified`.
- Account mapping: `oauth_identities` (migration 004) keys on Google's
  stable `sub`. First sign-in with an email that already has a password
  account links to it; brand-new emails create a user with a random
  unguessable password hash. Either way the email counts as verified
  (Google proved mailbox ownership), so no confirmation email is sent.
- A normal SlyTab session token is issued — everything downstream is
  unchanged.

Because the client secret is never used, there is nothing sensitive to
store: a client ID is public by design.

## Creating the OAuth client (done 2026-07-23; kept for reference)

Google Cloud Console → new project `SlyTab` → OAuth consent screen
(External, scopes `openid email profile`, authorized domain
`electricrv.ca`, add yourself as a test user while in Testing mode) →
Credentials → Create credentials → OAuth client ID → **Web application**.
Since June 2025 Google shows the client secret only once at creation — this
flow doesn't need it, so ignore it.

On a phone: the Google Cloud Android app is monitoring-only (cannot create
projects or credentials) — use Chrome with **Desktop site** checked at
console.cloud.google.com instead.

## Mobile app — follow-up (not yet implemented)

Native Google sign-in in the Android app needs an **Android-type** OAuth
client registered with package `com.slywombat.slytab` plus the SHA-1 of the
APK signing certificate. Our CI currently generates a debug keystore per
build, so the fingerprint isn't stable — pin a keystore in CI first, then
add the Android client and wire `expo-auth-session` to the same
`POST /auth/google` endpoint. Until then, mobile uses email/password.
