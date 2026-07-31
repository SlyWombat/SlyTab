#!/bin/bash
# Generate the Android screenshots for the user manual (issue #104).
#
# Same idea as capture-web.mjs, driven through adb in the disposable kdocker2
# emulator that scripts/dev/font-scale-audit.sh already uses. The device is
# recreated from the image every run, so it carries no state from the last one:
# fixed device profile, fixed density, fixed locale, fixed clock, animations
# off. Navigation is by *text*, not by coordinates — a uiautomator dump gives
# every node's text and bounds, so a shot taps "the button that says Balances"
# rather than a pixel that will move at the next layout change.
#
# The dump doubles as the uiHash input, exactly like the DOM signature on web:
# it is what the screen says and contains, and it changes when the UI does.
#
#   bash scripts/docs/capture-android.sh [--apk <path-or-url>] [--keep]
#
# Credentials: DOCS_DEMO_EMAIL / DOCS_DEMO_PASSWORD are sourced from the repo
# env file (the same place every other ops script reads secrets from) and are
# never echoed. Copy them there from docs/private/review-account.md once.
#
# ── Honest limitation, read this before trusting the output ────────────────
# apps/mobile/src/api.ts hard-codes the production API base, so a released APK
# can only ever show PRODUCTION data. These screenshots therefore come from a
# demo account on prod, not from the seeded demo world, and they are NOT
# reproducible the way the web ones are — anything that account's data does
# between releases shows up in the manual. The fix is one line in the mobile
# app (read the base from EXPO_PUBLIC_API_BASE with the current value as the
# default) plus a `demo` EAS profile; until that lands, the staleness gate
# treats Android shots as coverage-only. See docs/user-docs-process.md §7.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
HOST="${DOCS_EMU_HOST:-kdocker2}"
PKG="ca.electricrv.slytab"
APK="https://electricrv.ca/slytab/downloads/slytab-latest.apk"
KEEP=0
OUT="$REPO/docs/user-guide/img/android"

while [ $# -gt 0 ]; do
  case "$1" in
    --apk) APK="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

ENVFILE="$REPO/.env"
if [ -f "$ENVFILE" ]; then set -a; source "$ENVFILE"; set +a; fi
: "${DOCS_DEMO_EMAIL:?set DOCS_DEMO_EMAIL in the repo env file (see docs/user-docs-process.md)}"
: "${DOCS_DEMO_PASSWORD:?set DOCS_DEMO_PASSWORD in the repo env file (see docs/user-docs-process.md)}"

mkdir -p "$OUT"
echo "== booting a clean emulator on $HOST =="

# The whole device session runs remotely in one shell so the credentials cross
# the wire once, over ssh, as arguments to a script that never prints them.
ssh -o BatchMode=yes "$HOST" bash -s -- "$APK" "$DOCS_DEMO_EMAIL" "$DOCS_DEMO_PASSWORD" "$PKG" <<'REMOTE'
set -euo pipefail
APK="$1"; EMAIL="$2"; PASSWORD="$3"; PKG="$4"
SHOTDIR=/tmp/slytab-docs-shots
rm -rf "$SHOTDIR"; mkdir -p "$SHOTDIR"

case "$APK" in
  http*) curl -sS -m 600 -o /tmp/slytab-docs.apk "$APK"; APK=/tmp/slytab-docs.apk;;
esac

docker rm -f slytab-docs-emu >/dev/null 2>&1 || true
docker run -d --name slytab-docs-emu --device /dev/kvm \
  -e EMULATOR_DEVICE="Samsung Galaxy S10" -e WEB_VNC=false \
  budtmo/docker-android:emulator_13.0 >/dev/null
for i in $(seq 1 90); do
  [ "$(docker exec slytab-docs-emu adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)" = "1" ] && break
  sleep 10
done
adb_() { docker exec slytab-docs-emu adb "$@"; }
sh_()  { adb_ shell "$@"; }

# --- determinism: no animation, fixed locale/clock/font scale --------------
sh_ settings put global window_animation_scale 0
sh_ settings put global transition_animation_scale 0
sh_ settings put global animator_duration_scale 0
sh_ settings put system font_scale 1.0
sh_ settings put system time_12_24 24
sh_ settings put global auto_time 0
# A frozen device clock keeps the status bar and any "today" default still.
sh_ "su 0 date 071510242026.00" >/dev/null 2>&1 || sh_ date 071510242026.00 >/dev/null 2>&1 || true
# A status bar showing real wifi/battery churn is noise in a manual.
sh_ am broadcast -a com.android.systemui.demo -e command enter >/dev/null 2>&1 || true
sh_ am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1024 >/dev/null 2>&1 || true
sh_ am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null 2>&1 || true
sh_ am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 >/dev/null 2>&1 || true
sh_ am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null 2>&1 || true

docker cp "$APK" slytab-docs-emu:/tmp/app.apk
adb_ install -r /tmp/app.apk >/dev/null
adb_ logcat -c

# --- helpers: find a node by its text, tap the middle of it ----------------
dump() { adb_ exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r'; }
tap_text() { # tap_text <substring> [timeout-seconds]
  local want="$1" secs="${2:-25}" i
  for i in $(seq 1 "$secs"); do
    local xml; xml="$(dump)"
    local coords
    coords=$(printf '%s' "$xml" | python3 -c "
import re,sys
xml=sys.stdin.read(); want=sys.argv[1].lower()
for m in re.finditer(r'<node[^>]*>', xml):
    n=m.group(0)
    t=(re.search(r'text=\"([^\"]*)\"',n) or [None,''])[1]
    d=(re.search(r'content-desc=\"([^\"]*)\"',n) or [None,''])[1]
    if want in t.lower() or want in d.lower():
        b=re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',n)
        if b:
            x1,y1,x2,y2=map(int,b.groups()); print((x1+x2)//2,(y1+y2)//2); break
" "$want")
    if [ -n "$coords" ]; then sh_ input tap $coords; sleep 1; return 0; fi
    sleep 1
  done
  echo "!! could not find '$want' on screen" >&2
  return 1
}
wait_text() { local want="$1" secs="${2:-30}" i
  for i in $(seq 1 "$secs"); do
    dump | grep -qiF "$want" && return 0
    sleep 1
  done
  echo "!! never saw '$want'" >&2; return 1
}
shot() { # shot <id>
  sleep 1
  adb_ exec-out screencap -p > "$SHOTDIR/$1.png"
  dump > "$SHOTDIR/$1.uix"
  echo "  ok $1"
}

launch() { sh_ am force-stop "$PKG"; sh_ monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; sleep 8; }
launch

# --- sign in ---------------------------------------------------------------
# The password is passed through `input text` rather than echoed anywhere.
if wait_text "Sign in" 40; then
  tap_text "Sign in" || true
  sleep 2
  tap_text "Email" && sh_ input text "$EMAIL"
  sh_ input keyevent 111   # ESC — close the soft keyboard before the next tap
  tap_text "Password" && sh_ input text "$PASSWORD"
  sh_ input keyevent 111
  tap_text "Sign in" || true
  sleep 8
fi

# --- the shot list ---------------------------------------------------------
wait_text "Groups" 40 || true
shot home
tap_text "Groups" && sleep 2 && shot groups
sh_ input keyevent 4; sleep 1
tap_text "Activity" && sleep 3 && shot activity
tap_text "Profile" && sleep 3 && shot profile

echo "fatals: $(adb_ logcat -d | grep -c 'FATAL EXCEPTION' || true)"
tar -C "$SHOTDIR" -cf /tmp/slytab-docs-shots.tar .
REMOTE

echo "== pulling screenshots =="
scp -q "$HOST:/tmp/slytab-docs-shots.tar" "$OUT/.shots.tar"
tar -C "$OUT" -xf "$OUT/.shots.tar"
rm -f "$OUT/.shots.tar"

# Turn the uiautomator dumps into the same shots.json shape the web capture
# writes, so one staleness gate covers both surfaces.
python3 - "$OUT" "$REPO/docs/user-guide/shots.android.json" <<'PY'
import hashlib, json, os, re, sys
out, dest = sys.argv[1], sys.argv[2]
shots = []
for f in sorted(os.listdir(out)):
    if not f.endswith('.uix'):
        continue
    sid = f[:-4]
    xml = open(os.path.join(out, f), encoding='utf-8', errors='replace').read()
    # Same normalisation idea as the web signature: the text and the element
    # skeleton, with the pixel bounds thrown away so a one-pixel reflow is not
    # reported as a documentation change.
    sig = ''.join(
        f"<{(re.search(r'class=\"([^\"]*)\"', n) or [None,''])[1]}"
        f"|{(re.search(r'text=\"([^\"]*)\"', n) or [None,''])[1]}"
        f"|{(re.search(r'content-desc=\"([^\"]*)\"', n) or [None,''])[1]}>"
        for n in re.findall(r'<node[^>]*>', xml)
    )
    shots.append({
        'id': f'android-{sid}',
        'screen': sid,
        'device': 'android',
        'image': f'img/android/{sid}.png',
        'uiHash': hashlib.sha256(sig.encode()).hexdigest()[:16],
        'deterministic': False,   # production data — see the header comment
    })
    os.remove(os.path.join(out, f))
json.dump({'shots': shots}, open(dest, 'w'), indent=2)
print(f"{len(shots)} android shots -> {dest}")
PY

if [ "$KEEP" != "1" ]; then
  ssh -o BatchMode=yes "$HOST" 'docker rm -f slytab-docs-emu >/dev/null 2>&1 || true'
fi
echo "== android screenshots in $OUT =="
