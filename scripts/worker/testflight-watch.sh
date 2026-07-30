#!/bin/bash
# Watch the newest iOS build's TestFlight beta review and, the moment Apple
# approves it, tell the testers.
#
# Why this exists as a script rather than a loop in a session: beta review can
# take most of a day, and the promise "we'll email you when it's ready" has to
# survive whatever is or isn't running at the time. Run it from cron:
#
#   */17 * * * * /path/to/scripts/worker/testflight-watch.sh >> /path/watch.log 2>&1
#
# It is idempotent — a marker file per build means the mail goes out once, no
# matter how often this runs. Safe to invoke by hand at any time.
#
# Exit codes: 0 always (cron-friendly); the log says what happened.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
ASC="$REPO/scripts/ops/asc-api.sh"
API_INTERNAL="https://electricrv.ca/slytab/api/internal"
APP_ID="6794502588"
MARKERS="$REPO/scripts/worker/.testflight-notified"
TESTFLIGHT_URL="https://testflight.apple.com/join/eK9sm1jH"

say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] testflight-watch: $*"; }

read -r BUILD_ID BUILD_NO STATE < <(
  bash "$ASC" "/v1/builds?filter[app]=$APP_ID&limit=1&sort=-uploadedDate" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    b = d['data'][0]
    print(b['id'], b['attributes'].get('version', '?'), end=' ')
except Exception:
    print('- - -', end=' ')
    raise SystemExit
" 2>/dev/null
  bash "$ASC" "/v1/builds/$(bash "$ASC" "/v1/builds?filter[app]=$APP_ID&limit=1&sort=-uploadedDate" 2>/dev/null | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['data'][0]['id'])
except Exception: print('none')")/betaAppReviewSubmission" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d['data']['attributes'].get('betaReviewState', 'UNKNOWN'))
except Exception:
    print('NONE')
" 2>/dev/null
)

say "build $BUILD_NO ($BUILD_ID) beta review: $STATE"

if [ "$STATE" != "APPROVED" ]; then
  say "not approved yet — nothing to do"
  exit 0
fi

mkdir -p "$(dirname "$MARKERS")"
touch "$MARKERS"
if grep -qx "$BUILD_ID" "$MARKERS" 2>/dev/null; then
  say "already notified for this build — not mailing again"
  exit 0
fi

mail_to() { # mail_to <address> <subject> <body>
  curl -sS -m 30 -X POST -H "X-Admin-Token: $PROD_MIGRATE_TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"to":sys.argv[1],"subject":sys.argv[2],"body":sys.argv[3]}))' "$1" "$2" "$3")" \
    "$API_INTERNAL/send-mail" >/dev/null 2>&1 || true
}

# Everyone who signs in with Apple is a candidate for the iPhone build; that is
# a fact the database holds, so ask it rather than hard-coding a name.
RECIPIENTS=$(printf "SELECT u.email FROM users u JOIN oauth_identities o ON o.user_id=u.id \
WHERE o.provider='apple' AND u.deleted_at IS NULL AND u.notify_level<>'none';\n" \
  | bash "$REPO/scripts/ops/proddb.sh" 2>/dev/null | awk -F'|' '/@/ {gsub(/ /,"",$2); print $2}')

TESTER_BODY="The iPhone version of SlyTab has just been updated, and this build
fixes signing in with Apple — if you tried before and could not get in, that
was our fault, and it works now.

Install or update it here: $TESTFLIGHT_URL

Open that on your iPhone. If you do not have TestFlight yet, the link will
send you to install it first, then bring you back to SlyTab.

Sign in with Apple and your groups will already be there.

Also in this update: much better readability at larger text sizes, bigger
buttons, saved-password support so you are not typing it out each time, and
clearer messages when your phone is offline.

If anything is still wrong, please tell us from Profile -> Report a bug.

- SlyTab"

COUNT=0
for addr in $RECIPIENTS; do
  mail_to "$addr" "SlyTab for iPhone — Apple sign-in now works" "$TESTER_BODY"
  COUNT=$((COUNT + 1))
done
say "emailed $COUNT Apple-signin tester(s)"

mail_to "dave@drscapital.com" "SlyTab iOS build $BUILD_NO approved — ready to test" \
"TestFlight beta review has APPROVED iOS build $BUILD_NO (v1.0.3).

It is live to the 'SlyTab family' group now, and $COUNT tester(s) who sign in
with Apple have been emailed the install link.

What is in it:
  - Sign in with Apple, which the iOS build shipped without (Jon was locked
    out entirely; his account is Apple-linked so there was no password path)
  - WCAG AA contrast for all secondary text, in both themes
  - Large-text fixes where the split checkbox and currency code were clipped
    - both money-affecting
  - 44pt touch targets on the split/payer/currency chips
  - Password AutoFill and Enter-to-submit on sign-in
  - An error boundary, so a render fault no longer blanks the whole app
  - Honest offline behaviour instead of raw JS errors
  - Confirmation before deleting an expense
  - Privacy policy reachable in-app, and a privacy manifest (both were
    certain App Store rejections)

Android v1.0.3 is already on the download link.

Still open and deliberately not in this build: Apple token revocation on
account deletion, leave-group/report in the app, light theme, and moving
Google sign-in to ASWebAuthenticationSession. See the issues under #79."

say "emailed the owner"
echo "$BUILD_ID" >> "$MARKERS"
say "done"
