# SlyTab — Security Review

**Date:** 2026-08-02 · **Reviewer:** Claude (adversarial code review + non-destructive
production probing) · **Target:** `main` @ `0acf1ee` · **Prod:** https://electricrv.ca/slytab

**Method.** Every finding below is labelled with how it was established:

- **[code]** — verified by reading the source. File:line cited.
- **[probe]** — verified against production with a non-destructive request
  (headers, TLS handshake, unauthenticated calls). No data was created,
  modified, or deleted; no brute-force or load testing was performed.
- **[infer]** — reasoned from code + configuration but **not** confirmed end
  to end. Each one states what would confirm it.

---

## Executive summary

**Overall posture: moderate risk, with a strong core and a soft perimeter.**

The parts of this codebase that usually go wrong are, unusually, right. Password
hashing is argon2id; session tokens are 256-bit random values stored only as
peppered HMACs; password reset revokes every session; the Google and Apple
token verifications enforce issuer, audience (constant-time), expiry, and
`email_verified`; and **every SQL statement in the application is parameterised**
— including the recently added `IN (...)` batching in `BalanceService` and
`ExpenseService`, which builds placeholder lists, never interpolated values.

Authorization is the area the brief flagged as highest-value, and it holds up.
I walked all 54 routes in `api/src/Routes/Api.php` one at a time (matrix in
[Appendix A](#appendix-a--route-by-route-authorization-matrix)). **Every route
that takes a group, expense, receipt, settlement, or session id enforces
ownership or membership**, either in the route body or in the first lines of the
service method it delegates to. I found no classic IDOR.

The risk is concentrated elsewhere — in transport, and in **consent**. Three of
the five High findings are variations on one theme: *the app performs an
irreversible, privacy-relevant action on a user's behalf without ever asking
them.* Joining a group, being added to a group, and completing a sign-in all
happen silently, and each one hands a stranger the victim's real name and
payment handles.

1. **Transport.** The whole app — SPA *and* API — is served over plaintext
   HTTP with no redirect and no HSTS (**H1**, verified live). Session bearer
   tokens are one downgrade away from the wire. This is the single most
   valuable thing to fix, and it is a five-line `.htaccess` change.
2. **Consent.** `POST /api/v1/friends` attaches any registered user to a group
   by email address alone and returns their name and payment handles (**H2**);
   an invite deep link auto-joins a group with no confirmation prompt on either
   client (**H4**); and the browser half of the mobile sign-in handoff shows no
   confirmation code, making it a textbook device-code phishing target with a
   legitimate `https://electricrv.ca` URL (**H5**).
3. **Database transport.** The PDO connection crosses the public internet to a
   VM in Toronto with certificate verification switched off (**H3**), so the
   CA pin the design relies on is not actually enforced.

Nothing here suggests a compromise has occurred. For a private beta with real
family data, H1–H5 are worth fixing before the next release; the Mediums are
worth fixing before any wider launch. Note that **H4 and H5 change the mobile
app**, so per the project's release rule they do not reach users until a new
build ships.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 5 |
| Medium | 10 |
| Low | 11 |
| Informational | 4 |

---

## Findings

### H1 — The app and API are served over plaintext HTTP, with no redirect and no HSTS

**Evidence:** [probe] + [code]

```
$ curl -D - http://electricrv.ca/slytab/api/v1/health
HTTP/1.1 200 OK
Server: Apache
...
{"status":"ok","service":"slytab-api","schemaVersion":1}
```

The apex *does* redirect (`http://electricrv.ca/` → `301` → `https://`), but
`/slytab/` and `/slytab/api/` do not — they answer `200` over cleartext. The
cause is in version control: `apps/web/dist/.htaccess:18-19` and
`api/public/.htaccess:9` both issue `RewriteEngine On`, which resets the
rewrite context for that directory and discards the inherited apex HTTPS rule.
Neither file contains an HTTPS redirect of its own.

No `Strict-Transport-Security` header is present on any response
(`api/public/.htaccess:15-17` sets only `Cache-Control`), so even the apex
redirect gives no protection against stripping on a first visit.

**Why it matters here.** Authentication is a bearer token in an
`Authorization` header (`api/src/Middleware/RequireAuth.php:24-28`) with a
**180-day rolling lifetime** (`api/src/Services/AuthService.php:19`,
`:123-124`). There are no cookies and therefore no `Secure` flag to fall back
on. A token captured once is good for six months and slides forward on every
use. The Splitwise import also posts the user's **personal Splitwise API key**
in a request body (`api/src/Routes/Api.php:752`).

**Exploit scenario.** A user on café Wi-Fi opens a SlyTab link, or a bookmark,
or an email link that lost its scheme. An attacker on the same network runs
sslstrip against `http://electricrv.ca/slytab/`, the page loads happily over
HTTP because the server never insists otherwise, and the SPA's next XHR carries
`Authorization: Bearer <64 hex chars>` in the clear. The attacker now has a
180-day session for that account: full expense history, every group member's
email and payment handles, and the ability to create expenses and settlements.

**Fix.** In `apps/web/dist/.htaccess` (and its generator,
`scripts/deploy-cpanel.mjs`) plus `api/public/.htaccess`, immediately after
`RewriteEngine On`:

```apache
RewriteCond %{HTTPS} !=on
RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
```

and add, guarded by `mod_headers`:

```apache
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
```

Ship HSTS only once the redirect is confirmed working on every path, since it
is hard to walk back. Consider also shortening `SESSION_DAYS` from 180.

---

### H2 — `POST /api/v1/friends` discloses any registered user's identity and payment handles to anyone who knows their email, and adds them to a group without consent

**Evidence:** [code]

The route takes an arbitrary email and is **not rate-limited**
(`api/src/Routes/Api.php:534-541`):

```php
$p->post('/friends', function (Request $rq, Response $rs) use ($groups): Response {
    $me = Http::user($rq);
    $b = Http::body($rq);
    return Http::json($rs->withStatus(201), $groups->directGroup(
        $me['id'], Http::str($b, 'email'), ...
```

`GroupService::directGroup` (`api/src/Services/GroupService.php:204-244`)
creates a group and calls `addMemberByEmail` (`:242`). That method looks the
address up and, **if a real account exists, adds it to the group outright**
(`:262-290`) — no invitation, no acceptance. `directGroup` then returns
`$this->get($id)` (`:243`), and `get()` projects every member including
`paymentHandles` (`:135-140`):

```php
'members' => array_map(static fn(array $u): array => [
    'id' => $u['id'],
    'displayName' => $u['display_name'],
    'avatar' => $u['avatar'],
    'paymentHandles' => json_decode($u['payment_handles'] ?: '{}', true),
], $m->fetchAll()),
```

`paymentHandles` holds `interacEmail`, `paypalMe`, and `venmo`
(`api/src/Services/AuthService.php:233-246`).

This is a **deliberate consent model that one endpoint bypasses**. The
sibling endpoint `addKnownMember` enforces it correctly — you may only add
someone you already share a group with (`GroupService.php:308-317`, "The
shared-group requirement is the consent model"). `directGroup` reaches the
same outcome with nothing but an email address.

**Exploit scenario.** An attacker registers a free account and scripts
`POST /api/v1/friends` against a list of candidate addresses (a leaked
breach dump, a company directory, guessed `first.last@` patterns). For each
address the response tells them, in one request:

- whether that person uses SlyTab (a real name comes back for a member, the
  local-part of the email for a placeholder — `GroupService.php:268`);
- their **real display name** and avatar;
- their **Interac e-Transfer address, PayPal.Me handle, and Venmo username** —
  i.e. a verified payment identity, which is exactly the raw material for
  e-transfer fraud and payment-request phishing.

There is no rate limit, so this runs at request speed. As a side effect the
attacker also (a) inserts the victim into a group they can then file expenses
into, making it appear the victim owes them money, and (b) triggers an
outbound email from `noreply@electricrv.ca` whose subject line contains the
**attacker-controlled display name** (`GroupService.php:363`) — an unmetered
mail relay riding the owner's domain reputation.

**Fix.** Three changes, in order of importance:

1. In `directGroup`, do not auto-add an existing user. Create the direct group
   with the caller only, and mint an invite the other person must accept —
   reusing `createInvite`, which the code already has.
2. Never return `paymentHandles` for a member the caller does not yet share an
   *accepted* group with. Better: drop them from the group projection entirely
   and serve them from a dedicated "how do I pay this person" endpoint that
   checks for a non-zero balance.
3. Add `$limiter->guard('friends', $userId, 10, 3600)` to the route, and the
   same to `POST /groups/{id}/invites` (see **M9**).

---

### H3 — MySQL TLS certificate verification is disabled on a connection that crosses the public internet

**Evidence:** [code] — `api/src/Db/Db.php:42-49`

```php
// Production reaches MySQL over a public tunnel: encrypt with the
// server's own CA (self-signed, so hostname verification is off —
// the CA pin is the trust anchor).
$sslCa = Env::get('DB_SSL_CA');
if ($sslCa !== '') {
    $options[PDO::MYSQL_ATTR_SSL_CA] = $sslCa;
    $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = false;
}
```

The comment states the intent — pin the CA, skip only hostname matching —
but **that is not what this flag does under PHP's mysqlnd driver**.
`MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => false` maps to
`MYSQLI_CLIENT_SSL_DONT_VERIFY_SERVER_CERT`, which disables certificate
validation *in its entirety*. mysqlnd has never implemented hostname-only
verification as a separate step. The CA file at `DB_SSL_CA` is loaded and then
effectively ignored: the connection is encrypted, but against **any**
certificate an endpoint presents.

The path this protects is not a LAN. Per `docs/deployment.md`, the cPanel host
in Toronto dials `147.5.121.145:3307` — a public Oracle VM address — which
tunnels to MySQL at the owner's home.

**Exploit scenario.** Anyone able to intercept or redirect that route (BGP or
DNS interference, a compromised upstream, or another tenant of the shared
cPanel host in a position to hijack the egress path) terminates the TLS session
with a self-signed certificate of their own. PHP accepts it without complaint.
The attacker then reads and rewrites the full MySQL wire protocol: every user
row, every `password_hash`, every `token_hash`, every expense — and can inject
`UPDATE`s. The `REQUIRE SSL` grant on the MySQL side does not help, because
the attacker's leg to the real server is a legitimate TLS session.

Note that `docs/deployment.md` also records that "the cPanel egress IP is
shared with other tenants of that host", so the iptables allow-list on port
3307 admits every tenant of that shared host, not just SlyTab.

**Fix.** Set `PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT => true` and make the
certificate verifiable:

- reissue the MySQL server certificate with the connect address in its SAN
  (`IP:147.5.121.145`, or give the VM a DNS name and connect by it), then
  keep `MYSQL_ATTR_SSL_CA` pointed at the pinned CA; **or**
- terminate at a client certificate (`MYSQL_ATTR_SSL_CERT`/`SSL_KEY`) so the
  tunnel is mutually authenticated.

Until this is done, the connection should be treated as authenticated-by-
nothing, and the `REQUIRE SSL` grant should not be read as a guarantee.

---

### H4 — An invite deep link joins a group silently, with no confirmation, on both clients

**Evidence:** [code]

Mobile (`apps/mobile/App.tsx:379-401`):

```js
Linking.getInitialURL().then((url) => { const t = inviteTokenFrom(url); if (t) setPendingInvite(t); })
...
api.join(token).then((g) => { setTab('home'); setNav({ screen: 'group', groupId: g.id }); })
```

Web is the same shape (`apps/web/src/App.tsx:117-126`) and fires the moment a
signed-in user loads `/join/<32-hex>`. There is **no "Join *<group>*?" prompt,
no group preview, and no undo** beyond finding the group and leaving it.

The mobile app registers the custom scheme `slytab://` (`apps/mobile/app.json:5`).
A custom scheme is **not verified** — on Android any other installed app can
register the same scheme, and any web page can navigate to it. The HTTPS
universal-link surface is correctly tight by comparison (`apps/mobile/app.json:54-69`
and `apps/web/public/.well-known/apple-app-site-association:8` scope the app to
`/slytab/join/*` only), but the custom scheme bypasses that entirely.

The token extractor is also looser on mobile than on web: it matches `/join/`
**anywhere** in the URL and accepts `[A-Za-z0-9_-]+`
(`apps/mobile/App.tsx:216-220`), where web requires
`\/join\/([a-f0-9]{32})$` (`apps/web/src/App.tsx:22`).

**Exploit scenario.** An attacker creates a group, mints an invite
(`POST /groups/{id}/invites` — unmetered, see **M9**), and gets the victim to
open `slytab://join/<token>` from a web page, a QR code, a message, or another
installed app. One tap and the victim is enrolled. The attacker immediately
reads their **display name, avatar, and payment handles** from the member list
(`GroupService.php:135-140`) — the same disclosure as **H2**, reached by a
different road — and can then file expenses that make it appear the victim owes
them money, with the victim receiving genuine SlyTab emails and push
notifications about the "debt" (`NotificationService::notifyGroup`).

Because invites are multi-use and non-revocable for seven days (**M6**), a
single posted link works on everyone who taps it, for a week.

**Fix.** Require an explicit confirmation before `api.join` on both clients:
fetch and display the group name and member count, then join only on a tap.
This is a UX change as much as a security one — a person should always know
which group they just entered. Additionally, tighten
`inviteTokenFrom` to the web client's strict `^/join/[a-f0-9]{32}$` pattern.

---

### H5 — The sign-in handoff page has no confirmation code or device binding (device-code phishing)

**Evidence:** [code] — `apps/web/src/screens/Auth.tsx:93-130`

The browser half of the mobile Google sign-in flow renders
`/app-signin/<state>` for **any** state present in the path, and tells the user:

> "Sign in to the SlyTab app — Confirm your Google account below and the app
> will sign itself in."

Nothing on that page identifies **which device** is waiting. There is no short
code to match, no device label echoed back, and no binding between the browser
session and the app that started the handoff.

The server-side protocol is otherwise well built — I reviewed it closely and it
is sound (`AuthHandoffService.php:41-80`: 128-bit state, 256-bit verifier stored
as SHA-256 and compared with `hash_equals`, 10-minute TTL, single-use, and the
verifier never travels in a URL). **That is precisely why this matters:** the
cryptography cannot help, because in this attack the victim is *voluntarily*
completing the attacker's handoff. No amount of expiry or single-use
enforcement prevents it.

**Exploit scenario — full account takeover:**

1. The attacker installs SlyTab and taps *Sign in with Google*. Their app calls
   `POST /auth/handoff/start` and receives `state` + `verifier`, then begins
   polling `POST /auth/handoff/claim` (`apps/mobile/App.tsx:551-603`).
2. The attacker does **not** complete the browser step. Instead they send the
   victim `https://electricrv.ca/slytab/app-signin/<attacker-state>` — a real
   link, on the real domain, over real HTTPS, with a valid certificate. Every
   phishing heuristic a user has been taught says this link is safe.
3. The victim opens it, sees a plausible SlyTab page asking them to confirm
   their Google account, and signs in. The browser posts the victim's Google
   ID token to `/auth/handoff/<state>/google` (`apps/web/src/screens/Auth.tsx:117`),
   which resolves it to the **victim's** user id (`AuthHandoffService.php:57-60`).
4. The attacker's polling app claims the handoff and receives a full
   session token for the victim's account (`AuthHandoffService.php:78-79`).

The attacker now holds a 180-day session (**I1**) for the victim's account:
every group, every expense, every receipt photo, every member's payment
handles, and the ability to create expenses and settlements as the victim.

**Fix.** Bind the browser step to the device that started it, so a victim can
tell that the page is not theirs:

1. Have `start()` return a short human-readable code (e.g. `WQ4-7KP`) derived
   from the handoff row, and display it prominently in the app.
2. Show that code on `/app-signin/<state>` along with the stored
   `device_label`, with copy along the lines of *"Signing in on **Dave's
   Pixel**. Only continue if this code matches the one on your phone: WQ4-7KP."*
3. Better still, require the user to **type** the code into the browser page
   before the Google button appears, which defeats the attack outright rather
   than relying on the victim noticing a mismatch.

Also consider showing the resolved account in the app ("Signed in as
dave@…, continue?") before the claimed session is used, so a mismatch is
visible on the other side too.

---

### M1 — No Content-Security-Policy on any response

**Evidence:** [probe] + [code]

Production returns `X-Content-Type-Options: nosniff`, `X-Frame-Options:
SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`, and
`Permissions-Policy` — a good baseline — but **no `Content-Security-Policy`**.
`apps/web/index.html:1-15` contains no CSP `<meta>` tag, and no CSP appears
anywhere in the repo or the deploy scripts.

**Why it matters.** CSP is the control that turns "an XSS bug" into "an XSS
bug that cannot exfiltrate anything". The web client stores the session token
in the browser (see client-side findings) and renders user-authored text —
expense descriptions, notes, group names, comments, display names — on nearly
every screen. React escapes by default, which is why I found no live XSS sink
(see [Verified NOT vulnerable](#verified-not-vulnerable)), but that is one
careless `dangerouslySetInnerHTML` away from changing, and there is currently
nothing behind it.

**Fix.** Add to `apps/web/dist/.htaccess` and its generator
(`scripts/deploy-cpanel.mjs:176-205`, which already emits an
`<IfModule mod_headers.c>` block — the natural home for this). The policy must
allow the two sign-in SDKs the app injects at runtime
(`apps/web/src/screens/Auth.tsx:70-74`, `:172-176`):

```apache
Header always set Content-Security-Policy "default-src 'self'; \
  script-src 'self' https://accounts.google.com https://appleid.cdn-apple.com; \
  connect-src 'self' https://accounts.google.com https://appleid.cdn-apple.com; \
  frame-src https://accounts.google.com https://appleid.apple.com; \
  img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; \
  object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
```

`style-src` needs `'unsafe-inline'` because the app uses inline `style={{…}}`
heavily; `script-src` should not need it, since Vite emits external modules.
Deploy first as `Content-Security-Policy-Report-Only` and check the browser
console through a full sign-in with both providers before enforcing.

---

### M2 — WebP and PNG receipt uploads keep their EXIF GPS coordinates

**Evidence:** [code] — `api/src/Services/ReceiptService.php:187-215`, `:231`

Issue #83 added metadata stripping, and the docblock is explicit that this is
the one place it can be guaranteed:

> Receipt photos carry the camera's GPS fix — where the user was, to a few
> metres — and every client has a path that uploads the file untouched […] So
> the only place this can be guaranteed is here, where all of them converge.

The implementation only handles JPEG (`:190-192`):

```php
$raw = @file_get_contents($path);
if ($raw === false || strncmp($raw, "\xFF\xD8", 2) !== 0) {
    return; // not a JPEG; PNGs carry no EXIF GPS from our clients
}
```

But `image/webp` is an accepted upload type (`:23`), and **WebP carries EXIF
in a dedicated `EXIF` RIFF chunk, GPS tags included** — the comment's PNG
reasoning does not extend to it. PNG likewise supports an `eXIf` chunk since
the 1.5.0 spec.

The re-encode path that would otherwise destroy metadata is skipped for any
image at or under 1600px and 2 MB (`:231`):

```php
if ($big <= self::MAX_DIMENSION && (filesize($path) ?: 0) <= 2 * 1024 * 1024) {
    return [$relPath, $mime];
}
```

So a modest WebP — which is exactly what a client-side shrinker produces —
is stored byte-for-byte with its GPS fix intact, and is then served to every
group member by `GET /api/v1/receipts/{id}/image`
(`api/src/Routes/Api.php:715-721`).

**Exploit scenario.** A user photographs a receipt at home and shares the
expense with a housemate's ex, a colleague, or anyone else in a group. That
member downloads the receipt image and reads the coordinates of the user's home
out of the file — the precise disclosure issue #83 was filed to prevent.

**Fix.** Make the guarantee unconditional rather than format-conditional. The
simplest correct change is to re-encode *every* upload through GD to JPEG
(dropping all ancillary chunks) rather than returning early for small files; if
the size shortcut is worth keeping, add WebP and PNG chunk strippers next to
`stripJpegMetadata` and drop `EXIF`/`XMP`/`eXIf`/`iTXt` chunks. Add a test to
`api/tests/ExifStripTest.php` covering a small WebP with GPS.

---

### M3 — Upload type validation trusts the client's `Content-Type`; stored bytes are never checked

**Evidence:** [code] — `api/src/Services/ReceiptService.php:38-41`,
`api/src/Services/BugReportService.php:49-52`

```php
$mime = $file->getClientMediaType() ?? '';
if (!isset(self::MIME_EXT[$mime])) {
    throw new ApiException('VALIDATION', 'image must be JPEG, PNG, or WebP');
}
```

`getClientMediaType()` is the `Content-Type` the *client* wrote into the
multipart part. It is attacker-controlled and is never cross-checked against
the file's magic bytes. `normalizeImage` calls `getimagesize` and, on failure,
returns the file untouched (`ReceiptService.php:225-228`).

The stored extension is chosen from the same untrusted map, so it is always one
of `jpg|png|webp` — **there is no path to a `.php` upload**, and the data
directory is outside the web root (`DATA_DIR=$APPDIR/data` where `$APPDIR` is
`~/slytab`, per `scripts/deploy-api.sh:11` and `docs/deployment.md`). I probed
this and confirmed it: `https://electricrv.ca/slytab/slytab-data/` returns the
SPA's `index.html`, not a file listing. So this is **not** RCE and **not**
direct file exposure.

What it does mean is that arbitrary bytes can be stored and then served back
under an `image/*` type the attacker chose (`api/src/Routes/Api.php:715-721`):

```php
$rs->getBody()->write(file_get_contents($img['path']));
return $rs->withHeader('Content-Type', $img['mime'])
```

**Exploit scenario.** An attacker in a shared group uploads an HTML or SVG
payload declared as `image/jpeg`. Any group member who opens the receipt gets
the bytes back from a *first-party* origin. `nosniff` is set in production
today, which blocks the browser from re-typing it, so this is currently
contained — but the mitigation lives entirely in host configuration that is not
in version control (see **M8**), and `Content-Disposition` is absent, so the
response is treated as inline.

**Fix.** Validate the bytes, not the header. Replace the
`getClientMediaType()` check with `finfo_file(...)` / `getimagesize()` on the
moved file and reject anything that is not genuinely JPEG/PNG/WebP; derive the
stored extension and the served `Content-Type` from that verdict. Add
`Content-Disposition: inline; filename="receipt.jpg"` and an explicit
`X-Content-Type-Options: nosniff` on the image responses so they do not depend
on host config.

---

### M4 — Production secrets and the Apple signing key are deployed world-readable on shared hosting

**Evidence:** [code] + [doc] — `scripts/deploy-api.sh:47-96`, `docs/deployment.md`

`deploy-api.sh` uploads `config.env` (holding `DB_PASS`, `SESSION_PEPPER`,
`INVITE_HMAC_KEY`, `MIGRATE_TOKEN`) and, when present, the Sign in with Apple
private key `apple-siwa.p8` to `~/slytab/` via the cPanel Fileman UAPI
(`:93-96`). **There is no `chmod` anywhere in the script**, so both land at the
UAPI default. `docs/deployment.md` records the result explicitly:

> the host's copy lives in `~/slytab/config.env` (0644, above web root)

Above the web root is the right call and I confirmed it is not HTTP-reachable
(`/slytab/api/composer.json` → `403`; `/slytab/config.env` → SPA fallback, not
the file). But `0644` on a shared host means the file is readable by any
process that can traverse to it.

**Why it matters here.** `SESSION_PEPPER` is the HMAC key over every session
token (`AuthService.php:340-343`) *and* over password-reset and email-
verification tokens (`PasswordResetService.php:79-82`,
`EmailVerificationService.php:72-75`). Anyone who reads it, plus a copy of the
`sessions` table, can forge sessions and mint valid reset tokens for any
account. `MIGRATE_TOKEN` is the only guard on `/api/internal/*`, which includes
`POST /send-mail` and `POST /migrate`.

**Fix.** Append a chmod step to `deploy-api.sh` after the config upload — e.g.
a Fileman `chmod` call or an equivalent — setting `config.env` and
`apple-siwa.p8` to `0600`. Verify with `stat` as part of the deploy's health
step. Separately, `PROD_MIGRATE_TOKEN` is passed on the curl command line at
`deploy-api.sh:127-128`, where it is visible in the local process list; move it
to a header read from an environment variable.

---

### M5 — Login rate limiting is per-IP only; there is no per-account throttle or lockout

**Evidence:** [code] — `api/src/Routes/Api.php:283-289`,
`api/src/Services/RateLimiter.php:20-42`

```php
$g->post('/auth/login', function (...) {
    $limiter->guard('auth', $ip($rq), 10, 60);
```

The bucket key is `scope:identifier:window` where the identifier is
`REMOTE_ADDR` (`Api.php:115-116`). Nothing counts failures **against the
account being targeted**, and there is no lockout, no backoff, and no
notification on repeated failure. The same shape applies to `/auth/register`,
`/auth/google`, `/auth/apple`, and the handoff endpoints.

**Exploit scenario.** 10 attempts per minute per IP is 14,400 per day from a
single address, and an attacker with 100 cheap proxies has 1.44 million
password guesses a day against one known account, entirely within the limit as
written. The 10-character minimum (`AuthService.php:20`) helps, but a
credential-stuffing run against addresses harvested via **H2** does not need to
guess — it only needs to replay, and the per-IP limit does nothing to slow a
distributed replay.

**Fix.** Add a second guard keyed on the account, before the credential check:

```php
$limiter->guard('loginEmail', strtolower(trim($email)), 10, 900);
```

`RateLimiter::guard` already hashes the identifier (`:23`), so the email never
lands in the table in the clear. Consider also emailing the account holder
after N consecutive failures.

---

### M6 — Invite links are multi-use, non-revocable, and grant seven days of full group access

**Evidence:** [code] — `api/src/Services/GroupService.php:340-402`

`createInvite` mints a 128-bit token stored as an HMAC (`:346-350`) with a
7-day expiry (`:16`, `:347`). `join` looks it up, checks only expiry, and adds
the caller (`:378-402`). **The invite is never marked used**, there is no
`used_at` column in the flow, and no route exists to revoke one — the only
route in the API is `POST /groups/{id}/invites`, which creates.

**Why it matters.** Joining a group is not a small privilege. It grants the
entire expense history, the activity log, every receipt photo, and every
member's display name and payment handles (`GroupService::get`, `:135-140`).

**Exploit scenario.** An invite is emailed to a housemate, who forwards the
thread to a group chat, or it sits in a mailbox that is later compromised, or a
member leaves the group on bad terms with the link still in their inbox. For
seven days anyone holding that URL joins silently and reads everything. The
group has no way to cancel it and — because `join` only records activity for a
genuinely new membership (`:392-400`) — a rejoin by someone who previously left
produces an activity entry, but there is no "this invite was used" signal
anywhere.

**Fix.** Add `used_at` to `invites`, set it in `join`, and reject an invite
that already has one (email invites are addressed to one person, so single-use
matches intent). Add `DELETE /groups/{id}/invites/{id}` and surface outstanding
invites in the group UI so members can see and revoke them.

---

### M7 — The privacy policy says "no telemetry"; `/api/v1/timings` collects per-user telemetry and keeps it 45 days

**Evidence:** [code] — `apps/web/public/marketing/privacy/index.html`,
`api/src/Services/ClientTimingService.php:66-104`, `:30`

The published policy — the URL given to the App Store and Play Console —
states under *What we don't collect*:

> No analytics, no telemetry, no advertising or tracking SDKs, no contact-list
> access, and no selling or sharing of anything for advertising.

`ClientTimingService::record` writes a row per measurement containing
`user_id`, `kind`, `name`, `ms`, `status`, `platform`, and `app_version`
(`:72-100`), retained for `RETENTION_DAYS = 45` (`:30`). Up to 60 items per
batch (`:26`) and 300 batches per hour per user (`api/src/Routes/Api.php:363`).

The service is **well built** for its purpose — `template()` strips ULIDs,
UUIDs, hex tokens, and numeric ids from paths (`:43-55`), so it does not record
*which* group anyone opened, and there is no third-party involved. The code
comment says as much: "there is no third-party analytics in this app and this
does not introduce one." That is true and is not the problem. The problem is
that the policy promises no **first-party** telemetry either, and this is
first-party telemetry stored against a user id.

**Why it matters.** This is a store-compliance and truthfulness issue, not an
attacker-facing one. `docs/deployment.md` already warns that the store pages
"describe real behaviour and are checked against it by the stores". A privacy
policy that is falsifiable by reading the API is a liability at review time.

**Fix.** Pick one and do it fully:

- **Preferred:** stop storing `user_id` in `client_timing` (pass `null` — the
  column is already nullable and `record()` already accepts `?string`). Nothing
  in `summary()` uses it (`:114-145`). Percentiles per endpoint do not need to
  know whose phone produced them. Then the policy stays true as written.
- **Or:** amend the policy to describe it plainly — "we record how long screens
  and requests take on your device, with identifiers stripped from the URL, for
  45 days, to find slow parts of the app" — and update the store listings.

---

### M8 — The security headers that exist are host-side only and are not in version control

**Evidence:** [probe] + [code]

Production returns `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, and `Permissions-Policy`. **None of these appear in
`api/public/.htaccess`, `apps/web/dist/.htaccess`, `scripts/deploy-cpanel.mjs`,
or `scripts/deploy-api.sh`.** They are set somewhere in the cPanel account
configuration that the repository does not describe.

**Why it matters.** Both deploy scripts overwrite `.htaccess` on every run
(`deploy-api.sh:117-121`, and `apps/web/dist/.htaccess:1` is stamped
"Auto-generated […] do not hand-edit on the host"). A host migration, a cPanel
reset, or a change to whatever sets these headers removes them with no test to
notice — and **M3**'s containment depends on `nosniff` being one of them.

**Fix.** Move all four headers into the two tracked `.htaccess` files (and the
generator in `scripts/deploy-cpanel.mjs`) alongside the CSP from **M1** and the
HSTS from **H1**, so that the deployed configuration is the reviewed
configuration. Add a header assertion to `scripts/ops/api-deploy-check.sh`.

---

### M9 — Two authenticated endpoints send unmetered mail to arbitrary addresses with attacker-controlled content

**Evidence:** [code] — `api/src/Routes/Api.php:518-525`, `:534-541`,
`api/src/Services/GroupService.php:352-373`

Neither `POST /groups/{id}/invites` nor `POST /friends` calls
`$limiter->guard(...)`. Both reach `createInvite`, which sends mail through the
cPanel MTA with a subject line built from user-controlled values
(`GroupService.php:363`):

```php
"{$inviter} invited you to \"{$group['name']}\" on SlyTab",
```

`$inviter` is the caller's `displayName` (up to 80 chars, freely set via
`PATCH /me`); `$group['name']` is up to 80 chars of the caller's choosing.

**Exploit scenario.** One free account, a display name set to a marketing or
phishing string, and a loop over an address list produces unlimited mail from
`noreply@electricrv.ca` with attacker-chosen text in the subject. The likely
outcome is not a breach but a **domain reputation loss**: `electricrv.ca` gets
listed, and the resulting collateral damage is that SlyTab's own password-reset
and verification emails stop being delivered.

**Fix.** Rate-limit both routes per user (`$limiter->guard('invite', $userId,
20, 86400)`), and cap distinct recipient addresses per user per day. See also
**L1** on sanitising these two strings before they enter a mail header.

---

### M10 — The in-flight GET coalescing map is keyed by path alone and is never cleared when the token changes

**Evidence:** [code] — `apps/web/src/api.ts:198-209`, identical at
`apps/mobile/src/api.ts:194-205`

```js
const inFlight = new Map<string, Promise<unknown>>();

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method === 'GET') {
    const running = inFlight.get(path) as Promise<T> | undefined;
    if (running) return running;                       // <-- no user/token in the key
    const p = timedReq<T>(method, path, body).finally(() => { inFlight.delete(path); });
    inFlight.set(path, p);
    return p;
  }
```

The key is the bare request path with no user or token component.
`setToken()` (`apps/web/src/api.ts:183-186`) and both sign-out handlers
(`apps/web/src/App.tsx:188-195`, `apps/mobile/App.tsx:458-466`) clear the token,
the current user, and the persistent SWR cache — **but not `inFlight`**. An
entry survives until its own request settles.

**Exploit scenario.** User A signs out while a GET is still outstanding. User B
signs in *in the same tab or app process* and requests the same path before A's
request settles. B is handed A's promise, and therefore A's data, under B's
identity, with no error raised. This is a cross-user data leak on a shared or
family device — which is precisely the deployment this app is built for.

**Severity rationale.** Rated Medium rather than High because the window is
only the lifetime of a single request and signing in takes far longer than that,
so it is very hard to hit and not remotely triggerable. But the invariant that
makes it safe is **accidental**, not designed, and a future change that keeps
entries around longer (a retry, a slow endpoint, an offline queue) would turn
it into a reliable leak with no code review flagging it.

**Fix.** One line, in both clients:

```js
export function setToken(token: string | null): void {
  inFlight.clear();
  // …existing body
}
```

Related, same area: the persistent cache is cleared on explicit sign-out but
**not** when a stored token is merely rejected (`apps/web/src/App.tsx:112`,
`apps/mobile/App.tsx:328-331`). Because those cache keys *are* user-scoped
(`slytab.cache.<userId>.<name>`) this is not a cross-user leak, but a dead
session's balances and expenses linger in `localStorage` and in
`documentDirectory/slytab-cache/` indefinitely. Call `cacheClear()` there too.

---

## Low

| # | Finding | Evidence | Fix |
|---|---|---|---|
| **L1** | **Possible mail header injection.** `displayName` is validated only with `trim()` and a length check (`AuthService.php:185-190`); internal `\r\n` survives. Group names are the same (`GroupService.php:62-67`). Both are interpolated into the `$subject` argument of `mail()` (`Mailer.php:40`, via `GroupService.php:363`). **[infer]** — modern PHP rejects CR/LF in `mail()`'s `$to` and `$subject`, which would make this a non-issue, but I could not run PHP in this environment to confirm the behaviour on the host's PHP 8.3. **To confirm:** `php -r` a `mail()` call with an embedded `\r\nBcc:` subject on the production PHP version, or read the generated headers with `MAIL_DISABLE` set. | `AuthService.php:185-190`, `GroupService.php:62-67`, `Mailer.php:29-41` | Regardless of the outcome, strip control characters where the values are validated: `preg_replace('/[\r\n\t]+/', ' ', $name)`. One line, removes the question. |
| **L2** | **No `nonce` or `iat` check on Apple identity tokens.** `AppleAuthService::signIn` verifies `sub`, `aud`, `iss`, `exp`, and `email_verified` (`:88-93`) but ignores `nonce`. A captured identity token can be replayed to `POST /auth/apple` until it expires (~10 min) to obtain a session as that user. Google's flow is equivalent (`GoogleAuthService.php:67-72`). | `AppleAuthService.php:88-93` | Have the client generate a nonce, send its hash to Apple, and reject tokens whose `nonce` does not match a recently issued one. |
| **L3** | **Apple refresh tokens stored in plaintext.** `oauth_identities.refresh_token` is written raw (`AppleAuthService.php:108-111`). It is a long-lived credential for the user's Apple relationship with this app; combined with **H3** it is readable by anyone on the DB path. | `AppleAuthService.php:108-111` | Encrypt at rest with a key from `config.env`, or accept the risk explicitly given it only enables revocation. |
| **L4** | **`client_timing.name` is unvalidated free text for `kind='screen'`.** `substr($name, 0, 120)` with no character filter (`ClientTimingService.php:95`), surfaced verbatim through `GET /api/internal/metrics/timing` to the owner's Homepage dashboard. If that widget renders HTML unescaped, a user can store 120 chars of markup that executes in the admin's browser. **[infer]** — I did not review the Homepage widget, which is outside this repo. | `ClientTimingService.php:95` | Whitelist: `preg_match('/^[A-Za-z0-9 _\/:.-]{1,120}$/', $name)` or drop the row. |
| **L5** | **Account-existence oracle on registration.** `POST /auth/register` returns `409 EMAIL_TAKEN` for a real account and `201` otherwise (`AuthService.php:60-74`). Password reset is careful to avoid exactly this (`PasswordResetService.php:32-33`, and the route comment at `Api.php:293`), so the property is inconsistent across the auth surface. | `AuthService.php:69` | Lower value than **H2**; if H2 is fixed, consider making registration respond identically and confirm by email. |
| **L6** | **`LIKE` wildcards unescaped in search.** `'%' . $filters['q'] . '%'` in three places — a `q` of `%%%%%%%` forces a full scan. Values are bound, so this is **not** injection, only a cost. | `ExpenseService.php:169`, `:251`, `:341` | `addcslashes($q, '%_\\')`. |
| **L7** | **Push token takeover.** `registerToken` upserts on the token primary key with `ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)` (`NotificationService.php:33-36`), so anyone who learns another user's Expo token can rebind it to their own account — silencing the victim's notifications and pushing attacker-chosen content to the victim's device. Tokens are not exposed by any endpoint, so exploitation needs a separate leak. | `NotificationService.php:33-36` | Refuse to rebind a token already owned by a different live user. |
| **L8** | **No roles: any member can rename or archive a group.** `POST /groups/{id}/archive` checks membership only (`Api.php:551-555`), and archiving makes the group read-only for everyone (`GroupService::assertWritable`). `DELETE` is correctly restricted to the creator (`GroupService.php:472-478`), so the inconsistency looks unintended. | `Api.php:551-555` | Either restrict archive to the creator, or make it reversible via an unarchive route. |
| **L9** | **The web client sends the raw search term in timing telemetry.** `record({ kind: 'api', name: \`${method} ${path}\` })` keeps the query string, so a `name` can be `GET /me/expenses?q=<the user's search text>` — user content. Mobile strips it correctly (`apps/mobile/src/api.ts:217-223`), and the module's own header at `apps/web/src/timing.ts:14-17` promises "nothing here carries a group id, a description or an amount", so the code contradicts its stated contract. Contained because the server templates the query away before storage (`ClientTimingService.php:43-55`, `:95`) and it travels in a POST body rather than a logged URL. | `apps/web/src/api.ts:238-240` | Mirror mobile: `path.split('?')[0]`. |
| **L10** | **No change-password endpoint.** `PATCH /me` handles name, avatar, currency, handles, and notify level (`AuthService.php:180-224`) but not the password; the only path is the emailed reset. A user who suspects compromise cannot rotate credentials in-app, though they *can* revoke sessions (`DELETE /me/sessions/{id}`). | `AuthService.php:180-224` | Add `POST /me/password` requiring the current password, and revoke other sessions on success. |
| **L11** | **Half an email-verification token can be stored in `client_timing`.** `POST /auth/verify/<64-hex>` is recorded like any other call, and the server's templating regexes collapse a 32-hex run first (`ClientTimingService.php:50`), so a 64-hex token leaves a 32-char remainder in `name`. Low value — it is a single-use 48-hour token in the app's own database — but avoidable. | `ClientTimingService.php:50` | Add a `#/[0-9a-f]{64}\b#i` → `/:token` rule ahead of the 32-hex one, and exclude `/auth/*` from timing on the client. |

---

## Informational

- **I1 — Session lifetime.** 180 days, rolling on every request
  (`AuthService.php:19`, `:123-124`), with idle sessions swept at 30 days on
  each new login (`:316-319`). Reasonable for a family app; it is the multiplier
  that makes **H1** expensive, so the two should be considered together.
- **I2 — Receipt photos and the Claude fallback.** `RECEIPT_ENGINE=auto`
  prefers the self-hosted model and only calls Anthropic if
  `ANTHROPIC_API_KEY` is set (`ReceiptService.php:346-358`). I confirmed the
  key is **not set** in the deployed config, so photos are not leaving the
  owner's hardware today — matching the privacy policy. This becomes a
  policy-affecting change the moment that key is added; the policy already
  says so, which is the right way round.
- **I3 — Repository lives in a cloud-synced folder.** The working tree is under
  `/mnt/d/OneDrive/My Documents/…`, and `secrets/` contains the Apple `.p8`
  keys and the Android upload keystore `slytab-upload.jks`, alongside the local
  config holding `PROD_*` values. Both are correctly git-ignored
  (`.gitignore:2`, `:5`) and untracked — I verified with `git ls-files` — but
  git-ignoring does not stop OneDrive from replicating them to Microsoft's
  cloud and to any other machine on that account. Consider relocating
  `secrets/` and the config file outside the synced tree, or into an encrypted
  container.
- **I4 — Bug report text is copied to GitHub.** `syncGithub` writes the
  reporter's display name and verbatim message into a public-repo issue body
  (`BugReportService.php:236-244`) before the pipeline later deletes it
  (`:266-273`). The window is short and the deletion is deliberate policy, but
  the content is world-readable while it exists, and users are not told this
  when they file a report.

---

## Verified NOT vulnerable

Checked deliberately, found genuinely sound. **Do not re-do this work** unless
the cited code changes.

**Authorization / IDOR — the highest-value area, checked route by route.**
All 54 routes in `api/src/Routes/Api.php` were traced to the ownership check
that protects them; the full matrix is in [Appendix A](#appendix-a--route-by-route-authorization-matrix).
Summary of the non-obvious ones, where the check is in the *service* rather
than the route body and is easy to mistake for missing:

- `PATCH /groups/{id}` → `GroupService::update` asserts membership on its
  first line (`GroupService.php:56`).
- `DELETE /groups/{id}` → `GroupService::delete` asserts membership
  (`:441`) *and* restricts deletion to the creator while others remain
  (`:472-478`).
- `PATCH /expenses/{id}` → `ExpenseService::update` loads the expense, then
  asserts membership of *its* group (`ExpenseService.php:114-117`).
- `DELETE /expenses/{id}` → `softDelete` (`:431-433`);
  `POST /expenses/{id}/restore` → `restore` (`:451`);
  `GET|POST /expenses/{id}/comments` → `comments` (`:396`) and `addComment`
  (`:418`).
- `POST /settlements/{id}/confirm` → only the payee may confirm
  (`SettlementService.php:66-68`); `DELETE /settlements/{id}` → only the payer
  or payee, and never once confirmed (`:82-87`).
- `GET /receipts/{id}/image` and `POST /receipts/{id}/rescan` → the receipt's
  `groupId` is read first and membership asserted against it
  (`Api.php:709-717`) — the ordering is correct.
- `DELETE /me/sessions/{id}` → scoped in SQL by `user_id`, with a `rowCount()`
  check so another user's session id returns 404, not success
  (`AuthService.php:153-160`).
- `GET /me/expenses` → joins `memberships` as well as the payer/share link, so
  leaving a group removes its expenses from the view
  (`ExpenseService.php:239-247`).
- `assertMember` itself requires `left_at IS NULL` (`GroupService.php:154-163`),
  so departed members lose access rather than retaining it.

**SQL injection — including the new `IN (...)` batching the brief called out.**
Every batching site builds a placeholder list and binds the values; none
interpolates data:

- `BalanceService::childAmounts` — `implode(',', array_fill(0, count($ids), '?'))`
  (`BalanceService.php:301-305`). `{$table}` is a literal from two internal
  call sites (`:273-274`).
- `ExpenseService::childRows` (`:670-672`) and `checkedReceiptIds` (`:486-488`)
  — same pattern; `$select` and `$orderBy` are literals from `shapeMany`
  (`:643-654`).
- `EmailNotificationService::markSent` (`:171-173`) — same.
- `LIMIT` clauses are interpolated but always from a PHP `int`
  (`ExpenseService.php:203`, `:293`), and the route clamps it to 1–100
  (`Api.php:577`).
- Sort direction and `ORDER BY` come from a `match` over a whitelist
  (`ExpenseService.php:272-277`), never from input.
- `MetricsService` builds SQL from string literals only (`:28-62`).
- `AuthService.php:291` interpolates `{$table}` from a hardcoded three-element
  array. `PDO::ATTR_EMULATE_PREPARES => false` (`Db.php:35`) means genuine
  server-side prepares throughout.

A grep for `eval`, `exec`, `system`, `shell_exec`, `passthru`, `popen`,
`proc_open`, `unserialize`, `extract`, and `assert` across `api/src` returns
**no hits** — the only matches were `Env::require()` and `PDO::exec()` on
static SQL.

**Authentication primitives.**
- Passwords: argon2id with `PASSWORD_ARGON2ID` where available
  (`AuthService.php:345-351`), 10-character minimum (`:20`, `:45-47`).
- Session tokens: `bin2hex(random_bytes(32))` — 256 bits — stored only as
  `hash_hmac('sha256', $token, SESSION_PEPPER)` (`:321`, `:340-343`). The
  plaintext token is never persisted.
- `RequireAuth` constrains the token shape to exactly 64 hex characters before
  any database work (`RequireAuth.php:25`).
- Login compares against a dummy hash for unknown emails so timing does not
  reveal account existence (`AuthService.php:91-93`).
- Password reset: single-use, 1-hour, hashed, **and revokes every session on
  success** (`PasswordResetService.php:55-77`) — the step most
  implementations forget. Reset requests are silent on unknown addresses
  (`:32-33`).
- Email verification: single-use, 48-hour, hashed
  (`EmailVerificationService.php:56-70`).
- Account deletion anonymises rather than deletes, revokes all sessions, ends
  all memberships, purges OAuth/reset/verification rows, and notifies Apple —
  all inside one transaction (`AuthService.php:255-298`).

**OAuth.**
- Google: token handed to Google's `tokeninfo` for signature verification, then
  `aud` compared with `hash_equals`, `iss` against a whitelist, plus `exp` and
  `email_verified` (`GoogleAuthService.php:60-75`).
- Apple: RS256 enforced explicitly (`AppleAuthService.php:334`), `kid` matched
  against the live JWKS (`:340-348`), `openssl_verify` over `header.payload`
  (`:351`), then `iss`/`exp`/`email_verified` and a **constant-time**
  multi-audience check that deliberately avoids early return
  (`:122-130`). No `alg: none` or HS256-confusion path exists.
- Handoff: 128-bit `state`, 256-bit `verifier` stored as SHA-256 and compared
  with `hash_equals`, 10-minute TTL, single-use — the row is deleted the moment
  a session is issued (`AuthHandoffService.php:41-47`, `:69-80`).

**Internal admin routes.** All twelve `/api/internal/*` routes sit behind one
group middleware doing `hash_equals` against `MIGRATE_TOKEN`
(`Api.php:231-237`). `Env::require` throws when the variable is missing, so the
guard **fails closed** rather than open (`Env.php:66-74`). Confirmed live:
no token → `403`; wrong token → `403 FORBIDDEN`. The configured token is 64
hex characters.

**Path traversal.** Receipt and bug-report paths are built from a
server-generated ULID and a group id that has already passed `assertMember`
(`ReceiptService.php:44-50`, `BugReportService.php:57`); reads resolve the
stored path from the database, never from a request parameter
(`ReceiptService.php:325-336`, `BugReportService.php:305-316`). No user-supplied
segment reaches the filesystem.

**Data directory exposure.** [probe] `DATA_DIR` is `~/slytab/data`, above the
web root. `https://electricrv.ca/slytab/slytab-data/` and
`.../slytab/config.env` both return the SPA `index.html` (the `.htaccess` SPA
fallback), not files; `.../slytab/api/composer.json` returns Apache `403`.
`api/vendor/` is git-ignored and lives outside the docroot.

**CORS.** [probe] No `Access-Control-Allow-Origin` on any response, and no CORS
middleware in `App.php`. Cross-origin reads are blocked by the browser default
— correct for an API whose only web client is same-origin.

**TLS (once you are on HTTPS).** [probe] Valid Let's Encrypt certificate
(`CN=www.electricrv.ca`, verify code 0), TLS 1.2 with
`ECDHE-RSA-AES256-GCM-SHA384`; TLS 1.0 and 1.1 are both refused. The gap is
**H1** — that HTTPS is not required — not the HTTPS itself.

**Error handling.** `displayErrorDetails` is `false`
(`App.php:36`) and every unmapped throwable becomes a generic
`{"error":{"code":"INTERNAL","message":"something went wrong on our side"}}`
(`:46-54`). Confirmed live: no stack traces, no SQL, no paths.

**Unsubscribe endpoint.** Public by necessity, but HMAC-signed with
`INVITE_HMAC_KEY` and compared with `hash_equals`
(`EmailNotificationService.php:227-236`), and its HTML output runs through
`htmlspecialchars(..., ENT_QUOTES)` (`Api.php:262`).

**Splitwise API key handling.** Used for the requests in hand and never
written to the database or the log — I traced every use of `$apiKey`
(`SplitwiseApiImportService.php:70-103`, `:239-259`). The docblock's claim
(`:20`) is accurate. The endpoint is fixed, so there is no SSRF; `swGroupId`
is cast to `int` before interpolation (`Api.php:761`).

**Cross-site scripting in the web and mobile clients.** A repo-wide grep of
`apps/web/src` and `apps/mobile/src` for `dangerouslySetInnerHTML`, `innerHTML`,
`outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`,
and `srcDoc` returns **zero matches**. All user-authored text reaches the DOM
through JSX text nodes or React Native `<Text>`, both of which escape. The
React escape hatches were checked individually:

- The only dynamic `<img src>` is a `blob:` object URL created locally from a
  fetched receipt (`apps/web/src/screens/Group.tsx:1144`, built at
  `apps/web/src/api.ts:448`) — not attacker-controlled.
- The two `document.createElement('script')` sites have hardcoded literal `src`
  values (Google GIS and Apple JS, `apps/web/src/screens/Auth.tsx:70-74`,
  `:172-176`).
- `apps/web/src/pdf.ts:6-28` does **not** template user text into a PDF; it
  renders page 1 of an uploaded PDF to a canvas via pdfjs `^6.1.200` and
  exports a JPEG.
- No CSS injection: the only `url(...)` values are a static SVG data URI
  (`apps/web/src/styles/components.css:72`) and an SVG mask id
  (`apps/web/src/ui.tsx:129`).

**Payment handles interpolated into `mailto:`/PayPal/Venmo links — checked and
closed by the server.** `apps/web/src/screens/Group.tsx:1884-1898` and
`apps/mobile/App.tsx:3646-3656` interpolate another member's handle straight
into a URL without encoding, which looks like a header-injection or
path-manipulation vector. It is not, because `AuthService::validateHandles`
(`api/src/Services/AuthService.php:227-248`) is strict at the point of write:
`interacEmail` must pass `FILTER_VALIDATE_EMAIL` (which rejects `?`), and
`paypalMe`/`venmo` must match `/^[A-Za-z0-9._-]{1,50}$/` (which excludes `/`
and `?`). No stored value can therefore add a `mailto:` header or redirect the
path. Worth recording that the protection is **entirely server-side**: if that
validation is ever loosened, these six call sites become live injection points,
so add `encodeURIComponent` there as defence in depth.

**Client token storage.** Web uses `localStorage` under `slytab.token`
(`apps/web/src/api.ts:8`, `:180-186`); mobile uses `expo-secure-store` — the
device keystore — under `slytab.session` (`apps/mobile/App.tsx:222`, `:322`,
`:340`, `:462`), holding it in a module-level variable at runtime
(`apps/mobile/src/api.ts:82-85`). The token is sent **only** as an
`Authorization: Bearer` header, never placed in a URL, and never handed to a
third party. `localStorage` is XSS-readable rather than `HttpOnly`, which is the
standard SPA tradeoff — it is the reason **M1** (CSP) matters.

**No client-side logging.** A grep for `console.log|warn|error|debug` across
`apps/web/src`, `apps/mobile/src`, and `apps/mobile/App.tsx` returns **zero
hits**. Nothing leaks to a device log or a browser console.

**No hardcoded secrets in the clients.** Grepped for `AIza`, `sk-`, `ghp_`,
`-----BEGIN`, `secret`, `apikey`, and `client_id` across both apps and their
configs. The Google and Apple client IDs are **fetched at runtime** from
`/auth/google/config` and `/auth/apple/config` (`apps/web/src/api.ts:478`,
`:484`) rather than baked into the bundle — and are public values regardless.
`eas.json:36-42` references key *paths*, never values.
`apps/mobile/credentials.json` exists on disk but is untracked and ignored.

**Universal-link scope.** The HTTPS deep-link surface is correctly minimal:
`apps/mobile/app.json:54-69` and
`apps/web/public/.well-known/apple-app-site-association:8` both scope the app
to `/slytab/join/*` only, deliberately leaving `/slytab/app-signin/*` in the
browser. `scripts/ops/publish-applinks.sh:36-79` generates `assetlinks.json`
from the *published* APK's v2 signing certificate and verifies no-redirect,
`application/json`, and byte-exactness before publishing (`:98-111`). The
weakness is the unverifiable custom scheme, not this — see **H4**.

**Persistent client caches are user-scoped and cleared on sign-out.** Keys are
`slytab.cache.<userId>.<name>` on web (`apps/web/src/cache.ts:25-27`) and the
same reduced to a filename on mobile (`apps/mobile/src/cache.ts:38-40`). All
twelve `swr()` call sites go through the per-user `ck` helper
(`apps/web/src/screens/Group.tsx:137`, `apps/mobile/App.tsx:1880`) — each was
checked, none bypasses it — and `cacheClear()` runs on sign-out on both
(`apps/web/src/App.tsx:188-195`, `apps/mobile/App.tsx:458-466`). **There is no
cross-user leak through the SWR cache.** The separate in-flight map is a
different object and is the subject of **M10**.

**Timing telemetry payload.** `{ items: [{ kind, name, ms, status }], platform,
appVersion }` (`apps/web/src/timing.ts:19-24`,
`apps/mobile/src/timing.ts:22-27`), buffered and flushed on a 20-second timer,
a 25-item burst, page-hide, or app-background, and dropped silently on failure.
No amounts, no descriptions, no entity ids, no device fingerprint, no third
party. The one gap is the un-stripped query string on web (**L9**).

**Money handling.** Not a security property as such, but checked because the
project treats it as one: all amounts are integer minor units, payer and share
sums are re-validated server-side against the total, and every participant is
re-checked for active membership — the client is never trusted
(`ExpenseService.php:510-585`, especially `:542-550`).

**Dependencies.** `npm audit`: 13 findings — **0 critical, 2 high, 11
moderate** — and *every one* is build-time tooling in the Expo/React Native
chain, none of it reachable at runtime in the deployed web or API.
- HIGH `brace-expansion` (GHSA-mh99-v99m-4gvg, DoS) at 1.1.16 / 2.1.2 / 5.0.7 —
  transitive via react-native codegen, glob, rimraf, test-exclude.
  **`npm audit fix` resolves it**; worth doing since it is free.
- HIGH `postcss` **8.4.49** (GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 — source-map
  path traversal / file disclosure) via `@expo/metro-config` → `@expo/cli`.
  Needs the Expo SDK 57 major upgrade; the copies under vite/vitest are already
  8.5.22 and clean.
- The 11 moderates are all Expo SDK packages routing through the same upgrade.

PHP production dependencies are a short, current, clean list: `slim/slim`
**4.15.2**, `slim/psr7` **1.8.0** (past CVE-2023-30536, fixed in 1.6.1),
`nikic/fast-route` 1.3.1, `anthropic-ai/sdk` v0.7.0, `php-http/discovery`
1.20.0, and the PSR interface packages. No known advisories against any of
them. None of the usual suspects (guzzle, php-jwt, symfony, phpmailer) is
present. `composer install --no-dev` is used when staging
(`deploy-api.sh:27`), so the phpunit chain never ships.

---

## What I could not assess

| Area | Why | What would be needed |
|---|---|---|
| **Authenticated runtime behaviour** | The rules of engagement allow non-destructive probing only, so every finding about logged-in behaviour is from code, not observation. The **H2** exploit in particular is a code-verified conclusion I did not execute against production. | A throwaway account on a **staging** database, with permission to run the H2 request against a second throwaway account. Roughly 10 minutes and it converts H2 from `[code]` to `[probe]`. |
| **The real `mail()` behaviour on the host (L1)** | No PHP runtime in this environment; the outcome depends on the host's PHP 8.3 build. | Run a `mail()` call with a CR/LF-bearing subject on the host with `MAIL_DISABLE` set and read the logged headers. |
| **The owner's Homepage dashboard (L4)** | It lives outside this repository, so I could not tell whether it escapes the strings `/api/internal/metrics/timing` returns. | The widget's template/config. |
| **Host-level web server configuration** | The four security headers in production are set somewhere I cannot see (**M8**), and I could not determine what sets them or how easily it is lost. | cPanel account config, or the top-level `public_html/.htaccess`. |
| **Database state and hygiene** | `scripts/ops/proddb.sh` was deliberately not used: reading live user data is not required for a code review and would itself be a privacy event. So I cannot say whether any old sessions, stale invites, or orphaned placeholder accounts exist. | Owner-run queries; see the checklist. |
| **Mobile binary hardening** | Only the source was reviewed. Certificate pinning, jailbreak/root posture, and what actually ships in the release bundle are properties of the built artefact. Note there is **no certificate pinning** in the client source, so **H1** applies to the mobile app too. | The release IPA/APK. |
| **The H4 and H5 exploits, executed** | Both are code-verified but not run. H4 needs a device with the app installed to confirm that `slytab://join/<token>` is accepted from a third-party context on the installed build; H5 needs two accounts and two devices. | A test device with the QA build, plus two throwaway accounts on staging. Under an hour for both. |
| **Infrastructure outside the app** | The Oracle relay VM, the rathole tunnel, the home MySQL container, and the Ollama endpoint are described in `docs/deployment.md` but were not examined. `docs/deployment.md` already flags the Ollama endpoint as unauthenticated. | Shell access to the VM and kdocker2. |

---

## Re-runnable security checklist

Run before each release. Every item is a command or a specific file to open.

### Transport and headers

```bash
# 1. HTTP must redirect, on every path (H1). Expect 301 on all three.
for p in / /slytab/ /slytab/api/v1/health; do
  curl -sS -o /dev/null -w "$p -> %{http_code}\n" "http://electricrv.ca$p"
done

# 2. Required headers must be present (M1, M8). Expect all five.
curl -sSI https://electricrv.ca/slytab/api/v1/health | grep -iE \
  'strict-transport|content-security-policy|x-content-type|x-frame|referrer-policy'

# 3. TLS floor: 1.0 and 1.1 must be refused.
for v in tls1 tls1_1; do echo | openssl s_client -connect electricrv.ca:443 -$v 2>&1 \
  | grep -q 'Cipher is' && echo "$v ACCEPTED - FAIL" || echo "$v refused - ok"; done
```

### Authorization

```bash
# 4. No new route may take an id without an ownership check.
#    List every {id} route, then confirm each appears in Appendix A.
grep -nE "\\\$(g|p)->(get|post|patch|put|delete)\('[^']*\{" api/src/Routes/Api.php

# 5. Internal routes must stay guarded. Expect 403 for both.
curl -sS -o /dev/null -w "no token: %{http_code}\n"  https://electricrv.ca/slytab/api/internal/metrics
curl -sS -o /dev/null -w "bad token: %{http_code}\n" -H 'X-Admin-Token: nope' \
  https://electricrv.ca/slytab/api/internal/metrics
```

### Injection

```bash
# 6. Every IN(...) must be built from placeholders, never values.
grep -rn 'IN ({' api/src            # each hit's $in must come from array_fill(...,'?')

# 7. No SQL may interpolate a variable that is not a hardcoded literal.
grep -rnE '(prepare|query|exec)\(\s*"[^"]*\{\$' api/src

# 8. No dangerous sinks. Expect zero hits.
grep -rnE '\b(eval|exec|shell_exec|system|passthru|popen|proc_open|unserialize|extract)\s*\(' api/src

# 9. No raw HTML injection in the web client. Expect zero hits.
grep -rn 'dangerouslySetInnerHTML\|innerHTML\|new Function\|javascript:' apps/web/src apps/mobile/src
```

### Client-side consent and state

```bash
# 9a. Joining a group must require confirmation, not fire on link open (H4).
grep -n 'api.join\|pendingInvite\|inviteTokenFrom' apps/mobile/App.tsx apps/web/src/App.tsx
#     Each api.join call must sit behind an explicit user action.

# 9b. The in-flight map must be cleared whenever the token changes (M10).
grep -n 'inFlight' apps/web/src/api.ts apps/mobile/src/api.ts
#     setToken() must call inFlight.clear().

# 9c. The handoff page must show a device label and match code (H5).
grep -n 'app-signin\|deviceLabel\|handoff' apps/web/src/screens/Auth.tsx

# 9d. Timing names must never carry a query string (L9).
grep -n "name: \`\${method}" apps/web/src/api.ts apps/mobile/src/api.ts
#     Both must use path.split('?')[0].

# 9e. No console logging in either client. Expect zero hits.
grep -rn 'console\.\(log\|warn\|error\|debug\)' apps/web/src apps/mobile/src apps/mobile/App.tsx
```

### Uploads and privacy

```bash
# 10. Upload type must be decided by content, not by the client's header (M3).
grep -rn 'getClientMediaType' api/src
#     Each hit should be paired with a finfo_file/getimagesize verification.

# 11. Metadata stripping must cover every accepted format (M2).
npm run test:php -- --filter ExifStrip
#     The suite must include a small WebP and a PNG, not only JPEG.

# 12. The privacy policy must still match the code (M7).
#     Open apps/web/public/marketing/privacy/index.html and re-read
#     "What we don't collect" against api/src/Services/ClientTimingService.php
#     and against whether ANTHROPIC_API_KEY is set in the deployed config.
```

### Secrets and configuration

```bash
# 13. Nothing secret may be tracked. Expect no output from both.
git ls-files | grep -Ei '(^|/)\.env$|secrets/|\.p8$|\.jks$|\.pem$|credentials'
git log --oneline -S'BEGIN PRIVATE KEY' -- . | head

# 14. On the host, after every deploy (M4): config.env and apple-siwa.p8 must be 0600.
#     stat -c '%a %n' ~/slytab/config.env ~/slytab/apple-siwa.p8

# 15. Rotate SESSION_PEPPER, INVITE_HMAC_KEY, and MIGRATE_TOKEN if any host
#     compromise is suspected. Rotating SESSION_PEPPER logs everyone out and
#     invalidates outstanding reset tokens - that is the point.
```

### Dependencies

```bash
# 16. No new HIGH or CRITICAL that is reachable at runtime.
npm audit --omit=dev
cd api && composer audit          # or: composer outdated --direct
```

### Rate limiting

```bash
# 17. Every unauthenticated or mail-sending route must carry a guard.
#     Compare the two lists; anything in the first and not the second is a gap.
grep -n "auth/\|/friends\|/invites\|/bugs\|/receipts\|/timings" api/src/Routes/Api.php
grep -n 'limiter->guard' api/src/Routes/Api.php
```

---

## Appendix A — route-by-route authorization matrix

Every route in `api/src/Routes/Api.php`. "Check" is the line that enforces
access — in the route body, or in the service method the route delegates to.

### `/api/internal/*` — 12 routes

All guarded by one group middleware: `hash_equals(MIGRATE_TOKEN, X-Admin-Token)`
at `Api.php:231-237`, failing closed via `Env::require`. Routes: `GET /bugs`,
`GET /bugs/{id}/image`, `PATCH /bugs/{id}`, `POST /bugs/{id}/notify-closed`,
`POST /bug-sync`, `GET /metrics`, `POST /reminders`, `POST /notify-digest`,
`POST /send-mail`, `POST /migrate`, `POST /fetch-rates`,
`GET /receipts/prunable`, `GET /metrics/timing`, `GET /metrics/receipts`,
`POST /mail-test`. ✅

### `/api/v1/*` public — 11 routes

| Route | Protection | Verdict |
|---|---|---|
| `GET /health`, `GET /health/deep` | none by design; constant / `SELECT 1` | ✅ |
| `GET /notify/unsubscribe` | HMAC + `hash_equals` (`EmailNotificationService.php:235`) | ✅ |
| `POST /auth/register` | rate-limited `Api.php:270` | ✅ (see **L5**) |
| `POST /auth/login` | rate-limited `:284` | ✅ (see **M5**) |
| `POST /auth/reset-request` | rate-limited `:291`; silent on unknown | ✅ |
| `POST /auth/reset` | rate-limited `:296`; single-use hashed token | ✅ |
| `POST /auth/verify/{token}` | 256-bit single-use token (`EmailVerificationService.php:63`) | ✅ |
| `GET /auth/{google,apple}/config` | public client ids only | ✅ |
| `POST /auth/google`, `POST /auth/apple` | rate-limited; full claim verification | ✅ (see **L2**) |
| `POST /auth/handoff/{start,claim}`, `.../{state}/google` | rate-limited; verifier `hash_equals`, single-use | ✅ protocol sound — ⚠️ **H5** is in the browser UI, not here |

### `/api/v1/*` authenticated — 31 routes

| Route | Ownership check | Verdict |
|---|---|---|
| `POST /timings` | own user id; rate-limited `:363` | ✅ |
| `POST /bugs` | own user id; rate-limited `:377` | ✅ |
| `POST /auth/logout` | own `sessionId` `:388` | ✅ |
| `GET /me`, `PATCH /me`, `DELETE /me` | own id; delete requires email confirmation (`AuthService.php:263`) | ✅ |
| `POST /me/verify-request` | own id; rate-limited `:403` | ✅ |
| `POST /me/push-tokens` | own id | ✅ (see **L7**) |
| `GET /me/sessions` | scoped by `user_id` (`AuthService.php:141`) | ✅ |
| `DELETE /me/sessions/{id}` | `WHERE id=? AND user_id=?` + `rowCount` (`AuthService.php:155-159`) | ✅ |
| `GET /me/balances` | iterates `listForUser` only | ✅ |
| `GET /groups` | `listForUser` (`GroupService.php:147`) | ✅ |
| `POST /groups` | creator becomes member | ✅ |
| `PATCH /groups/{id}` | `GroupService.php:56` | ✅ |
| `GET /groups/{id}` | `Api.php:508` | ✅ |
| `POST /groups/{id}/members` | `Api.php:514` + shared-group check `GroupService.php:308-317` | ✅ |
| `POST /groups/{id}/invites` | `Api.php:519` | ✅ (see **M6**, **M9**) |
| `POST /join/{token}` | 128-bit invite token | ✅ server-side — ⚠️ clients auto-call it, **H4** |
| **`POST /friends`** | **none — email only** | ⚠️ **H2** |
| `POST /groups/{id}/leave` | `Api.php:544` + zero-balance `:545` | ✅ |
| `POST /groups/{id}/archive` | `Api.php:552` | ✅ (see **L8**) |
| `DELETE /groups/{id}` | `GroupService.php:441`, `:472-478` | ✅ |
| `GET /me/expenses` | membership join (`ExpenseService.php:241`) | ✅ |
| `GET|POST /groups/{id}/expenses` | `Api.php:592`, `:599` | ✅ |
| `GET /expenses/{id}` | `Api.php:609` | ✅ |
| `PATCH /expenses/{id}` | `ExpenseService.php:116` | ✅ |
| `DELETE /expenses/{id}` | `ExpenseService.php:432` | ✅ |
| `POST /expenses/{id}/restore` | `ExpenseService.php:451` | ✅ |
| `GET|POST /expenses/{id}/comments` | `ExpenseService.php:396`, `:418` | ✅ |
| `GET /groups/{id}/{balances,totals}` | `Api.php:633`, `:637` | ✅ |
| `GET|PUT /groups/{id}/categories` | `Api.php:643`, `:647` | ✅ |
| `POST /groups/{id}/settlements` | `Api.php:659` | ✅ |
| `POST /settlements/{id}/confirm` | payee only (`SettlementService.php:66`) | ✅ |
| `DELETE /settlements/{id}` | payer or payee (`SettlementService.php:85`) | ✅ |
| `GET /receipts/eta` | aggregate timings only, no user data | ✅ |
| `POST /groups/{id}/receipts` | `Api.php:698` + writable `:699`; rate-limited `:697` | ✅ |
| `POST /receipts/{id}/rescan` | `Api.php:710` (after resolving groupId) | ✅ |
| `GET /receipts/{id}/image` | `Api.php:717` | ✅ |
| `POST /groups/{id}/import/splitwise` | `Api.php:727` | ✅ |
| `POST /groups/{id}/import/splitwise-api` | `Api.php:750` | ✅ |
| `GET /groups/{id}/activity` | `Api.php:767` | ✅ |
| `GET /groups/{id}/export.csv` | `Api.php:772` | ✅ |
| `GET /rates` | public FX data; codes regex-validated `:783` | ✅ |
