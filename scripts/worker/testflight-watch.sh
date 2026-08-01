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

# The changelog lives in release-notes.md, keyed to the build it describes.
# It used to be hard-coded in this script, which meant the NEXT release would
# have mailed testers the previous build's changelog — and a confidently wrong
# email is worse than no email. If the notes do not describe the build Apple
# just approved, tell the owner and mail nobody.
NOTES="$REPO/scripts/worker/release-notes.md"
read -r NOTES_BUILD NOTES_VER < <(python3 -c "
import re, sys
try: t = open(sys.argv[1]).read()
except OSError: print(' '); raise SystemExit
g = lambda k: (re.search(rf'^{k}:\s*(\S+)\s*$', t, re.M) or [None, ''])[1]
print(g('build') or '-', g('version') or '-')
" "$NOTES" 2>/dev/null || echo "- -")

if [ "$NOTES_BUILD" != "$BUILD_NO" ]; then
  say "notes describe build '${NOTES_BUILD}' but Apple approved $BUILD_NO — mailing nobody"
  if ! grep -qx "$BUILD_ID" "$MARKERS.alert" 2>/dev/null; then
    mail_to "dave@drscapital.com" "SlyTab iOS build $BUILD_NO approved — but nobody was emailed" \
"Apple approved iOS build $BUILD_NO, but scripts/worker/release-notes.md
describes build '${NOTES_BUILD}'.

Nobody was emailed. Sending testers the wrong changelog is worse than sending
nothing, so this stops rather than guesses.

Update release-notes.md to match build $BUILD_NO, then run
scripts/worker/testflight-watch.sh (or wait for the next cron run) and the
tester mail goes out."
    echo "$BUILD_ID" >> "$MARKERS.alert"
  fi
  exit 0
fi

TESTER_BODY=$(python3 -c "
import sys
body = open(sys.argv[1]).read().split('---', 2)[2].lstrip('\n')
print(body.replace('{{TESTFLIGHT_URL}}', sys.argv[2]))
" "$NOTES" "$TESTFLIGHT_URL")

COUNT=0
for addr in $RECIPIENTS; do
  mail_to "$addr" "SlyTab for iPhone — update $NOTES_VER is ready" "$TESTER_BODY"
  COUNT=$((COUNT + 1))
done
say "emailed $COUNT Apple-signin tester(s)"

mail_to "dave@drscapital.com" "SlyTab iOS build $BUILD_NO approved — ready to test" \
"TestFlight beta review has APPROVED iOS build $BUILD_NO (v$NOTES_VER).

It is installable now, and $COUNT tester(s) who sign in with Apple have been
emailed the link — Jon among them, since his account is Apple-linked. He can
install it whenever you nudge him.

The matching Android build is on the download link.

This is also the first build in which notifications have ever worked, so it is
worth asking him to turn them on and confirm one actually arrives — that path
has never once been exercised on a real device.

What the testers were told, verbatim:

$TESTER_BODY"

say "emailed the owner"

# Issues deliberately left open because their fix was only in code, not on
# anyone's phone (CLAUDE.md). Closing one sends "it's fixed, update your app",
# which becomes true at approval and not a moment earlier — so it happens here
# rather than at commit time, where `Closes #N` would have fired days ago.
CLOSE=$(python3 -c "
import re, sys
t = open(sys.argv[1]).read()
m = re.search(r'^issues:\s*(.+?)\s*\$', t, re.M)
print(m.group(1).replace(',', ' ') if m else '')
" "$NOTES" 2>/dev/null || echo "")
for N in $CLOSE; do
  python3 -c "
import json, sys
print(json.dumps({'body':
  f'Shipped. iOS build {sys.argv[1]} (v{sys.argv[2]}) has passed TestFlight beta '
  f'review and is installable, and the matching Android build is on the download '
  f'link. Testers have been emailed.\n\nClosed now rather than at commit time: '
  f'until Apple approved it, the fix existed only in the repository.'}))
" "$BUILD_NO" "$NOTES_VER" > /tmp/_gh_comment.json
  bash "$REPO/scripts/ops/gh-api.sh" POST "/repos/SlyWombat/SlyTab/issues/$N/comments" \
    /tmp/_gh_comment.json >/dev/null 2>&1 || true
  echo '{"state":"closed","state_reason":"completed"}' > /tmp/_gh_state.json
  bash "$REPO/scripts/ops/gh-api.sh" PATCH "/repos/SlyWombat/SlyTab/issues/$N" \
    /tmp/_gh_state.json >/dev/null 2>&1 || true
  say "closed #$N"
done
rm -f /tmp/_gh_comment.json /tmp/_gh_state.json

echo "$BUILD_ID" >> "$MARKERS"
say "done"
