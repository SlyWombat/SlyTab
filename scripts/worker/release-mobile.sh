#!/bin/bash
# Trigger an auto-release of a mobile fix on BOTH platforms.
# Called by the worker AFTER a mobile-affecting fix is committed to main and
# the full test suite passed. Bumps versions, starts both EAS builds
# (no-wait), and records state for release-finish.sh to complete across later
# cycles. One release in flight at a time. Secrets never printed.
#
# Usage: release-mobile.sh "<comma-separated bug_report ids this release closes>"
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$REPO/scripts/worker/.release-state.json"
LOG="$REPO/scripts/worker/release.log"
ISSUES="${1:-}"
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] $*" | tee -a "$LOG"; }

if [ -f "$STATE" ]; then say "release already in flight — skipping trigger"; exit 0; fi

VJSON="$REPO/apps/mobile/versions.json"
python3 - "$VJSON" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
bump = lambda v: (lambda a: f"{a[0]}.{a[1]}.{int(a[2])+1}")(v.split('.'))
d['ios']['version'] = bump(d['ios']['version'])
d['ios']['buildNumber'] = str(int(d['ios']['buildNumber']) + 1)
d['android']['version'] = bump(d['android']['version'])
d['android']['versionCode'] = int(d['android']['versionCode']) + 1
with open(p, 'w') as f:
    json.dump(d, f, indent=2)
    f.write('\n')
PY
IOSV=$(python3 -c "import json;d=json.load(open('$VJSON'));print(d['ios']['version'],d['ios']['buildNumber'])")
ANDV=$(python3 -c "import json;d=json.load(open('$VJSON'));print(d['android']['version'],d['android']['versionCode'])")
say "bumped versions -> ios $IOSV / android $ANDV"

cd "$REPO"
git add apps/mobile/versions.json
git -c core.fileMode=false commit -q -m "Release mobile: iOS $IOSV, Android $ANDV (auto)

Automated release triggered by the feedback worker after a mobile fix.
Closes: ${ISSUES:-none listed}

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" || true
git push -q origin HEAD:main || say "push failed (continuing)"

# Start both builds without waiting. APK feeds the web download link; the iOS
# build goes to TestFlight. --json prints the build objects; grab the ids.
ejson() { python3 -c "import json,sys;print((json.load(sys.stdin) or [{}])[0].get('id',''))"; }
say "starting android APK build…"
AND=$(EAS_BUILD_PLATFORM=android "$REPO/scripts/ops/eas.sh" build -p android \
      --profile android-apk --non-interactive --no-wait --json 2>>"$LOG" | ejson || true)
say "starting iOS TestFlight build…"
IOS=$(EAS_BUILD_PLATFORM=ios "$REPO/scripts/ops/eas.sh" build -p ios \
      --profile ios-testflight --non-interactive --no-wait --json 2>>"$LOG" | ejson || true)
say "build ids -> android=$AND ios=$IOS"

python3 - "$STATE" "$IOS" "$AND" "${IOSV% *}" "${IOSV#* }" "$ISSUES" <<'PY'
import json, sys
state, ios, android, ver, iosbn, reports = sys.argv[1:7]
json.dump({
    "version": ver,
    "reports": [i.strip() for i in reports.split(',') if i.strip()],
    "ios": {"build": ios, "buildNumber": iosbn, "stage": "building" if ios else "error"},
    "android": {"build": android, "stage": "building" if android else "error"},
}, open(state, 'w'), indent=2)
PY
say "release state recorded — release-finish.sh will complete it"
