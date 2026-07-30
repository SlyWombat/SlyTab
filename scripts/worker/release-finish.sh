#!/bin/bash
# Complete an in-flight mobile release started by release-mobile.sh. Safe to
# run every worker cycle: it advances each platform through its stages and is a
# no-op when there is nothing to do. Secrets are sourced into the script env
# but never printed.
#
#   android:  building -> done   (APK downloaded + uploaded to the web link)
#   ios:      building -> uploaded (eas submit) -> review (beta review posted)
#
# When both platforms have shipped, the linked reports are closed (truthful
# "update your app" email) and the owner is notified. On a build error the
# release is abandoned and the owner is told.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/scripts/worker/.release-state.json"
LOG="$REPO/scripts/worker/release.log"
OPS="$REPO/scripts/ops"
API="https://electricrv.ca/slytab/api/v1"
INTERNAL="https://electricrv.ca/slytab/api/internal"
APP_ID="6794502588"
[ -f "$STATE" ] || exit 0
ENVFILE="$REPO/.env"; set -a; source "$ENVFILE"; set +a
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] $*" | tee -a "$LOG"; }
get() { python3 -c "import json;print(json.load(open('$STATE'))$1)"; }
setstage() { # setstage <ios|android> <stage>
  python3 - "$STATE" "$1" "$2" <<'PY'
import json,sys
p,plat,stage=sys.argv[1:4]; d=json.load(open(p)); d[plat]['stage']=stage
json.dump(d,open(p,'w'),indent=2)
PY
}

VER=$(get "['version']")
say "release v$VER: ios=$(get "['ios']['stage']") android=$(get "['android']['stage']")"

# --- EAS build status (returns FINISHED / ERRORED / IN_PROGRESS / ...) --------
build_status() { EAS_BUILD_PLATFORM="$2" "$OPS/eas.sh" build:view "$1" --json 2>>"$LOG" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('status',''), d.get('applicationArchiveUrl') or (d.get('artifacts') or {}).get('applicationArchiveUrl') or '')"; }

owner_mail() { # owner_mail <subject> <body>
  curl -sS -m 30 -X POST -H "X-Admin-Token: $PROD_MIGRATE_TOKEN" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"to":"dave@drscapital.com","subject":sys.argv[1],"body":sys.argv[2]}))' "$1" "$2")" \
    "$INTERNAL/send-mail" >/dev/null 2>&1 || true
}
fail_release() { # abandon on unrecoverable build error
  say "ABORT: $1"
  # If Android already shipped, the APK is LIVE at downloads/slytab-latest.apk
  # and users are updating right now. Deleting the state here would strand that
  # release: no report closed, no reporter emailed, and the tracking issues left
  # open with the fix already in people's hands. Keep the record so the iOS half
  # can be retried against the same version (issue #90).
  if [ "$(get "['android']['stage']")" = "done" ]; then
    setstage ios error
    say "PARTIAL: Android v$VER is live; iOS failed and is retryable against this version"
    owner_mail "SlyTab auto-release v$VER: Android shipped, iOS failed" \
      "$1

The Android APK for v$VER is ALREADY LIVE at downloads/slytab-latest.apk and
users can install it. The iOS half failed, so:

  - no reports were closed and no reporter was emailed (their fix is only
    half-delivered, and the mobile-release rule says do not claim otherwise)
  - the release state has been KEPT, with iOS marked 'error'

Fix the iOS cause, then re-run the worker to retry iOS against this same
version — do NOT bump the version, or Android gets rebuilt for nothing.

Check scripts/worker/release.log."
    exit 0
  fi
  owner_mail "SlyTab auto-release v$VER failed" "$1 — release abandoned, no reports closed. Check scripts/worker/release.log."
  rm -f "$STATE"; exit 0
}

# --- iOS RETRY: a kept partial release, iOS half only -------------------------
# fail_release leaves iOS at 'error' when Android has already shipped, so the
# version is fixed and only the iOS build needs redoing. Retry it here rather
# than making a human remember to (issue #90). Deliberately capped: if the
# cause is a provisioning problem, retrying forever just burns EAS minutes.
if [ "$(get "['ios']['stage']")" = "error" ]; then
  TRIES=$(get "['ios'].get('retries', 0)")
  if [ "$TRIES" -ge 3 ]; then
    say "iOS retried ${TRIES}x for v$VER and still failing — leaving it for a human"
    exit 0
  fi
  say "retrying iOS build for v$VER (attempt $((TRIES + 1)))…"
  IOSID=$(EAS_BUILD_PLATFORM=ios "$REPO/scripts/ops/eas.sh" build -p ios \
          --profile ios-testflight --non-interactive --no-wait --json 2>>"$LOG" \
          | python3 -c "import json,sys;print((json.load(sys.stdin) or [{}])[0].get('id',''))" || true)
  if [ -z "$IOSID" ]; then
    python3 -c "
import json,sys
p=sys.argv[1]; d=json.load(open(p))
d['ios']['retries']=d['ios'].get('retries',0)+1
json.dump(d,open(p,'w'),indent=2)" "$STATE"
    say "iOS retry could not be started; will try again next cycle"
    exit 0
  fi
  python3 -c "
import json,sys
p,bid=sys.argv[1:3]; d=json.load(open(p))
d['ios'].update({'build':bid,'stage':'building','retries':d['ios'].get('retries',0)+1})
json.dump(d,open(p,'w'),indent=2)" "$STATE" "$IOSID"
  say "iOS rebuild started: $IOSID"
  exit 0
fi

# --- ANDROID: build -> APK on the web download link ---------------------------
if [ "$(get "['android']['stage']")" = "building" ]; then
  read -r AST AURL < <(build_status "$(get "['android']['build']")" android)
  say "android build: $AST"
  if [ "$AST" = "ERRORED" ] || [ "$AST" = "CANCELED" ]; then fail_release "Android build $AST"; fi
  if [ "$AST" = "FINISHED" ] && [ -n "$AURL" ]; then
    TMP="$REPO/scripts/worker/.slytab.apk"
    curl -sSL -m 300 -o "$TMP" "$AURL"
    BASE="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"; AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
    enc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1"; }
    curl -sS -m 60 "$BASE/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Fileman&cpanel_jsonapi_func=mkdir&path=$(enc "$WEB_ROOT")&name=downloads" -H "$AUTH" >/dev/null || true
    # Uploading the APK directly does NOT work: cPanel appends the multipart
    # boundary to the stored file and Android then refuses it with
    # INSTALL_PARSE_FAILED_NOT_APK (the 1.0.0 download shipped broken that
    # way). upload-apk.sh zips it, extracts server-side and verifies the
    # served sha256 — never publish an APK any other way.
    if bash "$REPO/scripts/ops/upload-apk.sh" "$TMP" "$VER" >>"$LOG" 2>&1; then
      rm -f "$TMP"
      setstage android done
      say "APK uploaded + verified -> downloads/slytab.apk + slytab-latest.apk + slytab-$VER.apk"
    else
      rm -f "$TMP"
      say "APK upload failed verification (retry next cycle)"
    fi
  fi
fi

# --- iOS: build -> eas submit -> beta review submission -----------------------
if [ "$(get "['ios']['stage']")" = "building" ]; then
  read -r IST _ < <(build_status "$(get "['ios']['build']")" ios)
  say "ios build: $IST"
  if [ "$IST" = "ERRORED" ] || [ "$IST" = "CANCELED" ]; then fail_release "iOS build $IST"; fi
  if [ "$IST" = "FINISHED" ]; then
    EASJSON="$REPO/apps/mobile/eas.json"; cp "$EASJSON" "$EASJSON.bak"
    python3 - "$EASJSON" <<'PY'
import json,os,sys
p=sys.argv[1]; d=json.load(open(p))
d['submit']['production']['ios']['ascApiKeyIssuerId']=os.environ['APPLE_ASC_ISSUER_ID']
json.dump(d,open(p,'w'),indent=2)
PY
    if EAS_BUILD_PLATFORM=ios "$OPS/eas.sh" submit -p ios --latest --non-interactive >>"$LOG" 2>&1; then
      mv "$EASJSON.bak" "$EASJSON"; setstage ios uploaded; say "iOS submitted to App Store Connect (TestFlight processing)"
    else
      mv "$EASJSON.bak" "$EASJSON"; say "eas submit failed (retry next cycle)"
    fi
  fi
fi

if [ "$(get "['ios']['stage']")" = "uploaded" ]; then
  # Find the freshly uploaded ASC build; submit it for beta review once VALID.
  # ASC's build "version" attribute is the CFBundleVersion (build NUMBER, e.g.
  # "4"), not the marketing version — filter by the recorded buildNumber.
  IOSBN=$(get "['ios']['buildNumber']")
  read -r BID BSTATE < <("$OPS/asc-api.sh" GET "/v1/builds?filter%5Bapp%5D=$APP_ID&filter%5Bversion%5D=$IOSBN&sort=-uploadedDate&limit=1" \
      | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);b=d[0] if d else {};print(b.get('id',''), b.get('attributes',{}).get('processingState',''))")
  say "asc build: id=${BID:-none} state=${BSTATE:-?}"
  if [ -n "$BID" ] && [ "$BSTATE" = "VALID" ]; then
    python3 - "$BID" > /tmp/betareview.json <<'PY'
import json,sys
print(json.dumps({"data":{"type":"betaAppReviewSubmissions","relationships":{"build":{"data":{"type":"builds","id":sys.argv[1]}}}}}))
PY
    RES=$("$OPS/asc-api.sh" POST /v1/betaAppReviewSubmissions /tmp/betareview.json)
    rm -f /tmp/betareview.json
    if echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get('data') else 1)" 2>/dev/null; then
      setstage ios review; say "iOS submitted for TestFlight beta review"
    else
      DUP=$(echo "$RES" | python3 -c "import json,sys;print(str(json.load(sys.stdin).get('errors',[{}])[0].get('detail',''))[:80])" 2>/dev/null)
      case "$DUP" in *already*|*exist*) setstage ios review; say "beta review already exists — ok";; *) say "beta review post: $DUP";; esac
    fi
  fi
fi

# --- Both shipped? close reports + notify owner -------------------------------
if [ "$(get "['android']['stage']")" = "done" ] && [ "$(get "['ios']['stage']")" = "review" ]; then
  MSG="This is fixed in SlyTab v$VER, which has now been released."
  for R in $(python3 -c "import json;print(' '.join(json.load(open('$STATE'))['reports']))"); do
    curl -sS -m 30 -X POST -H "X-Admin-Token: $PROD_MIGRATE_TOKEN" -H 'Content-Type: application/json' \
      -d "$(python3 -c 'import json,sys;print(json.dumps({"resolution":sys.argv[1],"needsAppUpdate":True}))' "$MSG")" \
      "$INTERNAL/bugs/$R/notify-closed" >/dev/null && say "closed report $R" || say "close $R failed"
  done
  owner_mail "SlyTab v$VER released (auto)" "Android APK is live on the download link; iOS build v$VER is in TestFlight beta review. Linked reports were closed and reporters emailed."
  rm -f "$STATE"; say "release v$VER complete"
fi
