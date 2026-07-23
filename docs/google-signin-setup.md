# Google sign-in — setup steps

Status: **waiting on step A** (create the OAuth client). Once the two values
from step A.7 are in `.env`, ask Claude to "wire up Google sign-in" and the
server + UI work happens without further input.

## A. One-time setup in Google Cloud Console (you)

1. Go to <https://console.cloud.google.com/> and sign in with the Google
   account that should own the integration.
2. Create a project (top bar → project picker → **New project**). Name it
   `SlyTab`. No billing account is needed for OAuth.
3. In the left menu: **APIs & Services → OAuth consent screen** (now called
   "Google Auth Platform" on some accounts):
   - User type: **External**, then **Create**.
   - App name: `SlyTab` · support email: your address.
   - Authorized domain: `electricrv.ca`.
   - Scopes: add only `openid`, `email`, `profile`.
   - Test users: add your own Gmail address (while the app is in "Testing"
     mode only listed users can sign in; you can push to "In production"
     later — no verification review is required for these basic scopes).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
5. Application type: **Web application** (this one client also serves the
   mobile app because the flow goes through our server). Name: `SlyTab web`.
6. Authorized redirect URI — exactly:

   ```
   https://electricrv.ca/slytab/api/v1/auth/google/callback
   ```

   No authorized JavaScript origins are needed.
7. **Create** → copy the **Client ID** (`…apps.googleusercontent.com`) and
   **Client secret**.

## A-alt. Doing it from an Android phone

The **Google Cloud app** (Play Store: "Google Cloud", by Google LLC) is a
monitoring app — it can switch between existing projects and view billing and
logs, but it cannot create projects, edit the OAuth consent screen, or create
OAuth credentials. So on a phone the working path is the mobile browser:

1. Open Chrome on the phone and go to <https://console.cloud.google.com/>,
   signed in with the right Google account.
2. Chrome menu (⋮) → check **Desktop site** — the console's credential pages
   need the desktop layout to show every field.
3. Follow steps A.2–A.7 above exactly as written. Landscape orientation makes
   the consent-screen forms much easier to fill.
4. To copy the Client ID/secret into `.env` on the dev machine, use anything
   already synced (e.g. a note in OneDrive) rather than messaging them in
   plain text — treat the secret like a password.

After creation you can install the Google Cloud app to keep an eye on the
project, but it is not needed for anything in this setup.

## B. Hand the values to the app

Add to the repo `.env` (never commit values; the file is gitignored):

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
```

The deploy script copies prod values from `PROD_`-prefixed variables, so also
add `PROD_GOOGLE_CLIENT_ID` / `PROD_GOOGLE_CLIENT_SECRET` (same values are
fine — one OAuth client covers dev and prod since only the redirect URI is
registered).

## C. What gets implemented next (Claude, no input needed)

- `oauth_identities` table (migration) linking `users` to Google `sub` IDs.
- `GET /auth/google` → redirect to Google with `state` + PKCE;
  `GET /auth/google/callback` → code exchange, ID-token verification
  (issuer, audience, expiry), find-or-create user by verified email, issue a
  normal SlyTab session token.
- "Continue with Google" buttons on the web Auth screen and mobile app
  (mobile opens the same server flow in a browser and catches the redirect).
- Google-verified emails count as verified (no confirmation email needed).
