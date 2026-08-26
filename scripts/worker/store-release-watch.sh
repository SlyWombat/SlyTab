#!/bin/bash
# Watch both stores for the release that is currently in their queues, and tell
# the owner the moment either one actually reaches users.
#
# Why this exists: `Closes #N` fires at commit time and the prod version pin is
# hand-held, but neither of those moments is when a fix reaches a phone
# (CLAUDE.md). That moment is Apple flipping a version to READY_FOR_SALE and
# Google serving the new version on the listing — and nothing was watching for
# either. Run it from cron — once a day is the owner's call (2026-08-26) and
# the right one: store review takes hours to days, so polling it every twenty
# minutes bought nothing but log noise. The owner is Eastern and kdocker2 runs
# on UTC, so 12:00 UTC lands at 08:00 EDT and 07:00 EST — a morning either
# side of the clocks changing, rather than arriving overnight.
#
#   0 12 * * * $HOME/slytab-worker/Splitwise/scripts/worker/store-release-watch.sh >> $HOME/store-watch.log 2>&1
#
# It notifies and stops there. It deliberately does NOT close issues or email
# users: dropping the version pin needs a deploy and closing a report-tracked
# issue emails a real person, and both are the owner's call. testflight-watch.sh
# auto-closes because TestFlight approval is unambiguous; App Store approval is
# one half of a two-store release, so this one hands over instead.
#
# Idempotent — a marker line per (store, version, event) means one mail each.
# Exit code is always 0, for cron. The log says what happened.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
ASC="$REPO/scripts/ops/asc-api.sh"
API_INTERNAL="https://electricrv.ca/slytab/api/internal"
APP_ID="6794502588"
PKG="ca.electricrv.slytab"
MARKERS="$REPO/scripts/worker/.store-release-notified"
OWNER="dave@drscapital.com"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36"

say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] store-release-watch: $*"; }

mail_to() { # mail_to <address> <subject> <body>
  curl -sS -m 30 -X POST -H "X-Admin-Token: ${PROD_MIGRATE_TOKEN:-}" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"to":sys.argv[1],"subject":sys.argv[2],"body":sys.argv[3]}))' "$1" "$2" "$3")" \
    "$API_INTERNAL/send-mail" >/dev/null 2>&1 || true
}

touch "$MARKERS" 2>/dev/null || true
once() { # once <marker> — true the first time only
  grep -qxF "$1" "$MARKERS" 2>/dev/null && return 1
  echo "$1" >> "$MARKERS"; return 0
}

# What we are waiting for is whatever was last built, not a number typed here:
# versions.json is what the release scripts bump, so the two cannot disagree.
read -r IOS_VER IOS_BUILD AND_VER < <(python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print(d['ios']['version'], d['ios']['buildNumber'], d['android']['version'])
" "$REPO/apps/mobile/versions.json" 2>/dev/null || echo "- - -")
say "watching for iOS $IOS_VER ($IOS_BUILD) and Android $AND_VER"

# ---------------------------------------------------------------- Apple -----
read -r V_ID V_STR V_STATE < <(
  bash "$ASC" "/v1/apps/$APP_ID/appStoreVersions?limit=1" 2>/dev/null | python3 -c "
import sys, json
try:
    v = json.load(sys.stdin)['data'][0]
    a = v['attributes']
    print(v['id'], a.get('versionString','?'), a.get('appStoreState','UNKNOWN'))
except Exception:
    print('- - UNREACHABLE')
" 2>/dev/null || echo "- - UNREACHABLE"
)
say "App Store $V_STR: $V_STATE"

# Only speak about the version we are actually waiting for. The state and the
# version string come from App Store Connect but the build number comes from
# versions.json, and a mail that welds one release's version to another's build
# number is worse than no mail — which is exactly what this said when the
# newest record was still the previous release.
if [ "$V_STR" != "$IOS_VER" ]; then
  say "newest App Store record is $V_STR, waiting for $IOS_VER — no 1.2-style record yet?"
  V_STATE="NOT_OURS"
fi

case "$V_STATE" in
  READY_FOR_SALE|PENDING_DEVELOPER_RELEASE)
    if once "ios:$V_ID:$V_STATE"; then
      if [ "$V_STATE" = "PENDING_DEVELOPER_RELEASE" ]; then
        WHAT="approved and is waiting for you to press Release — it is NOT on the store yet"
      else
        WHAT="approved and is LIVE on the App Store"
      fi
      mail_to "$OWNER" "SlyTab iOS $V_STR $WHAT" \
"App Store review has finished: version $V_STR (build $IOS_BUILD) $WHAT.

Two things were deliberately left waiting on this moment:

  1. The prod version pin. /api/v1/app/release still advertises an iOS build
     that is reachable nowhere. Now that the App Store serves build
     $IOS_BUILD — which is what apps/mobile/versions.json already says —
     the pin can simply be dropped: deploy-api.sh generates the file from
     versions.json, so stop re-pinning after the next deploy.

  2. Issues held open because the fix was only in code (CLAUDE.md), #120
     among them. Closing one emails the reporter 'it is fixed, update your
     app', which is true for iPhone from now on. Check Android has actually
     shipped too before closing anything that fixed both.

Nothing has been closed or deployed automatically. This mail is the handover."
      say "emailed the owner — iOS $V_STATE"
    else
      say "already notified for iOS $V_STR ($V_STATE)"
    fi
    ;;
  REJECTED|METADATA_REJECTED|DEVELOPER_REJECTED|INVALID_BINARY)
    if once "ios:$V_ID:$V_STATE"; then
      mail_to "$OWNER" "SlyTab iOS $V_STR was $V_STATE" \
"App Store review returned $V_STATE for version $V_STR (build $IOS_BUILD).

The reason is in App Store Connect under Resolution Center — the API does not
carry the text. Nothing was retried automatically."
      say "emailed the owner — iOS $V_STATE"
    else
      say "already notified for iOS $V_STR ($V_STATE)"
    fi
    ;;
  UNREACHABLE) say "could not reach App Store Connect — will try again next run" ;;
  NOT_OURS)    ;;
  *)           say "iOS still in the queue — nothing to do" ;;
esac

# --------------------------------------------------------------- Google -----
# Play has no review-status field in the Developer API at all: a committed
# production release reads status=completed long before Google has reviewed it.
# The public listing is the only honest signal for "a user can get this".
#
# Reading it needs care. The page is a megabyte and carries carousels of other
# apps, so a bare grep for the version we want can be satisfied by somebody
# else's version number. What the listing does contain, exactly once, is its
# own version — so collect every quoted x.y.z on the page and only believe the
# answer when there is precisely one. More than one means the page changed
# shape and the answer is "ask a human", not a confident mail.
#
# One state this cannot see: if managed publishing is ever turned on for the
# account, Google reviews the release and then HOLDS it until someone presses
# Publish in the Console. The listing never flips, so this watcher stays quiet
# for ever and the silence reads exactly like "still in review".
PLAY_HTML=$(curl -sS -m 40 -A "$UA" -H 'Accept-Language: en-CA,en' \
  "https://play.google.com/store/apps/details?id=$PKG&hl=en_CA&gl=CA" 2>/dev/null || true)
SEEN=$(printf '%s' "$PLAY_HTML" | grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' | tr -d '"' | sort -u)
SEEN_N=$(printf '%s' "$SEEN" | grep -c . || true)
SEEN_1L=$(printf '%s' "$SEEN" | tr '\n' ' ')

if [ -z "$PLAY_HTML" ]; then
  say "could not reach the Play listing — will try again next run"
elif [ "$SEEN_N" = "0" ]; then
  say "Play listing shows no version at all (\"varies with device\"?) — check by hand with play-api.py tracks"
elif [ "$SEEN_N" != "1" ]; then
  say "Play listing is ambiguous, $SEEN_N versions on the page ($SEEN_1L) — not guessing"
elif [ "$SEEN" != "$AND_VER" ]; then
  say "Play listing still advertises $SEEN, waiting for $AND_VER — still in review"
elif once "android:$AND_VER"; then
  mail_to "$OWNER" "SlyTab Android $AND_VER is live on Google Play" \
"The Play listing is now advertising $AND_VER, so Google's review is done and
the production release is being served to users.

That is read off the public store page, which is the only place Google says
so — the Developer API has no review-status field. The page advertised
exactly one version, $SEEN, which is why this is being stated rather than
guessed.

The sideload APK on the download link should match: if downloads/slytab-latest.apk
is still an older build, upload the new one (scripts/ops/upload-apk.sh), because
a sideloaded APK never updates itself."
  say "emailed the owner — Android $AND_VER is live"
else
  say "already notified for Android $AND_VER"
fi

say "done"
exit 0
