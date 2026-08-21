#!/usr/bin/env bash
# Play Store phone screenshots, captured from the real Android app.
#
# Runs inside `reactivecircus/android-emulator-runner` with a booted emulator,
# against an APK built in the same job and pointed at that job's own throwaway
# API (10.0.2.2 is the host loopback as the emulator sees it). Two consequences
# worth stating plainly, because the manual's Android shots have neither:
#
#   - the data is the seeded demo world, not production. Nobody's real
#     balances can reach a store listing.
#   - it is reproducible. Same commit, same pictures.
#
# The logic lives in this file rather than in the workflow's `script:` input
# because the emulator-runner action splits multi-line input and produces a
# syntax error that names none of this (MegaPDF blueprint §8).
#
#   bash scripts/docs/capture-store-android.sh <apk> <email> <password> [outdir]
#
# Navigation is by TEXT, never coordinates: the app labels its controls (#79),
# so a shot taps "the row that says Alice" and survives the next layout change.
# The helpers are lifted from capture-android.sh, which drives the manual's
# Android shots the same way through a remote emulator.
set -euo pipefail

APK="${1:?usage: capture-store-android.sh <apk> <email> <password> [outdir]}"
EMAIL="${2:?missing demo email}"
PASSWORD="${3:?missing demo password}"
OUT="${4:-/tmp/store-shots}"
PKG="ca.electricrv.slytab"

mkdir -p "$OUT"

# Diagnostics belong here, where the emulator still exists: the workflow's own
# post-failure step runs after the emulator-runner has gone, and an `adb` with
# no device waits for one for ever rather than failing.
on_error() {
  echo "--- what was on screen ---"
  adb exec-out screencap -p > "$OUT/zz-failure-state.png" 2>/dev/null || true
  adb exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r' | head -60 || true
  echo "--- cleartext / network complaints ---"
  adb logcat -d 2>/dev/null | grep -iE "cleartext|ECONNREFUSED|Failed to connect|Network request failed" | tail -20 || true
  echo "--- logcat tail ---"
  adb logcat -d 2>/dev/null | tail -60 || true
}
trap on_error ERR

# --- a device Play will accept -----------------------------------------------
# Play's maximum screenshot ratio is 2:1 and most emulator profiles are taller
# than that (a Pixel 6 is 2.11:1), so the shots would be rejected at upload.
# 1080x1920 at density 420 is the shape the existing listing uses.
adb shell wm size 1080x1920
adb shell wm density 420
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
adb shell settings put system font_scale 1.0

# A status bar showing the runner's real clock and battery is noise on a store
# listing — demo mode freezes it at the marketing convention.
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter >/dev/null 2>&1 || true
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null 2>&1 || true
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null 2>&1 || true
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 >/dev/null 2>&1 || true
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null 2>&1 || true

# Two things that both surface as "can't reach SlyTab", told apart before the
# app gets a chance to blur them: is the API still running (it was started in
# an earlier step, in the background), and can the device see the host at all?
echo "--- API health from the runner ---"
curl -fsS -m 10 http://127.0.0.1:8100/api/v1/health || {
  echo "!! the API is not answering on the runner — it died between steps" >&2
  exit 1
}
echo "--- host reachability from the device ---"
adb shell ping -c 2 10.0.2.2 2>&1 | tail -3 || true

adb install -r "$APK"
# Grant notifications rather than letting Android ask. The prompt is a system
# dialog drawn over the app, and uiautomator only dumps the TOP window — so
# with it up the flow cannot see the tab bar it is waiting for, and reports
# "never saw Groups" about a screen that is right there behind it.
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb logcat -c

# --- helpers: find a node by its text, tap the middle of it -------------------
dump() { adb exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r'; }

find_text() { # find_text <substring> [id-only] -> "x y" or empty
  # resource-id first: React Native puts testID there, and the visible "Email"
  # and "Password" on this screen are LABELS sitting above their inputs. A tap
  # on the label focuses nothing, which is how a run ended up typing the
  # password onto the end of the email address.
  dump | python3 -c "
import re,sys
xml=sys.stdin.read(); want=sys.argv[1].lower()
nodes=[m.group(0) for m in re.finditer(r'<node[^>]*>', xml)]
def attr(n, name):
    m=re.search(name+r'=\"([^\"]*)\"', n)
    return (m.group(1) if m else '')
def hit(n):
    b=re.search(r'bounds=\"\[(\d+),(\d+)\]\[(\d+),(\d+)\]\"',n)
    if not b: return None
    x1,y1,x2,y2=map(int,b.groups())
    return f'{(x1+x2)//2} {(y1+y2)//2}'
for n in nodes:                                   # exact resource-id wins
    if attr(n,'resource-id').lower().endswith(want):
        out=hit(n)
        if out: print(out); raise SystemExit
for n in nodes:                                   # then text / description
    if want in attr(n,'text').lower() or want in attr(n,'content-desc').lower():
        out=hit(n)
        if out: print(out); raise SystemExit
" "$1"
}

tap_text() { # tap_text <substring> [timeout-seconds]
  local want="$1" secs="${2:-25}" i coords
  for ((i = 0; i < secs; i++)); do
    coords="$(find_text "$want")"
    if [ -n "$coords" ]; then
      # shellcheck disable=SC2086 — two words, deliberately
      adb shell input tap $coords
      sleep 1
      return 0
    fi
    sleep 1
  done
  echo "!! could not find '$want' on screen" >&2
  return 1
}

wait_text() { # wait_text <substring> [timeout-seconds]
  local want="$1" secs="${2:-30}" i
  for ((i = 0; i < secs; i++)); do
    dump | grep -qiF "$want" && return 0
    sleep 1
  done
  echo "!! never saw '$want'" >&2
  return 1
}

shot() { # shot <name>
  sleep 2
  adb exec-out screencap -p > "$OUT/$1.png"
  echo "  ok $1"
}

launch() {
  adb shell am force-stop "$PKG"
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 8
  # Belt and braces: if a permission dialog appears anyway, get rid of it
  # rather than photographing it.
  if [ -n "$(find_text "don't allow")" ]; then
    tap_text "don't allow" 5 || true
    sleep 2
  fi
}

# --- sign in ------------------------------------------------------------------
# The password reaches the device through `input text` and is never echoed.
launch
wait_text "Sign in" 60
tap_text "Sign in" || true
sleep 2
tap_text "Email" && adb shell input text "$EMAIL"
# Return, not a second tap: the app's Email field hands focus to the password
# field on submit, which is both what its return key has always claimed to do
# and the only way a driver reliably gets into a secure field.
adb shell input keyevent 66     # ENTER
sleep 1
adb shell input text "$PASSWORD"
adb shell input keyevent 111    # ESC — put the keyboard away before tapping
tap_text "Sign in" || true
sleep 10

# --- the shot list ------------------------------------------------------------
# Ordered as the listing shows them, which is filename order at upload.
wait_text "Groups" 60
shot 01-home

# Cottage Trip is the group where the reader is OWED, so its Balances tab shows
# the settle-up plan from the creditor's seat — the thing 1.2 added.
tap_text "Cottage Trip" 30
wait_text "Balances" 30
shot 02-group-expenses

tap_text "Balances" 20
sleep 2
shot 03-balances

# The member sheet: tapping someone's balance is the new entry point, so the
# listing should show it rather than describe it.
if tap_text "Alice" 20; then
  sleep 2
  shot 04-settle
  adb shell input keyevent 4   # back — dismiss the sheet
  sleep 2
fi

tap_text "Totals" 20
sleep 2
shot 05-totals

if tap_text "Add expense" 20; then
  sleep 3
  shot 06-add-expense
  adb shell input keyevent 4
fi

echo "fatals: $(adb logcat -d | grep -c 'FATAL EXCEPTION' || true)"
ls -la "$OUT"
