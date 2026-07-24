#!/bin/bash
# Accessibility audit: run the published APK at several Android font
# scales in the disposable kdocker2 emulator and collect screenshots.
#
#   bash scripts/dev/font-scale-audit.sh [apk-path-on-kdocker2]
#
# Screenshots land in /tmp/fontscale-<scale>.png on kdocker2; pull them
# with scp. 1.0 = default, 1.3 = "Large", 2.0 = Android's maximum.
set -e
APK="${1:-/tmp/slytab-test.apk}"
HOST="${AUDIT_HOST:-kdocker2}"

ssh -o BatchMode=yes "$HOST" bash -s "$APK" <<'REMOTE'
set -e
APK="$1"
[ -f "$APK" ] || { curl -sS -m 300 -o "$APK" https://electricrv.ca/slytab/downloads/slytab.apk; }
docker rm -f slytab-emu >/dev/null 2>&1 || true
docker run -d --name slytab-emu --device /dev/kvm \
  -e EMULATOR_DEVICE="Samsung Galaxy S10" -e WEB_VNC=false \
  budtmo/docker-android:emulator_13.0 >/dev/null
for i in $(seq 1 60); do
  BOOT=$(docker exec slytab-emu adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)
  [ "$BOOT" = "1" ] && break
  sleep 10
done
docker cp "$APK" slytab-emu:/tmp/app.apk
docker exec slytab-emu adb install -r /tmp/app.apk >/dev/null

for SCALE in 1.0 1.3 2.0; do
  docker exec slytab-emu adb shell settings put system font_scale "$SCALE"
  docker exec slytab-emu adb shell am force-stop com.slywombat.slytab
  sleep 2
  docker exec slytab-emu adb shell monkey -p com.slywombat.slytab -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
  sleep 12
  docker exec slytab-emu adb exec-out screencap -p > "/tmp/fontscale-$SCALE.png"
  echo "scale $SCALE: fatals=$(docker exec slytab-emu adb logcat -d | grep -c 'FATAL EXCEPTION' || true)"
  docker exec slytab-emu adb logcat -c
done
docker rm -f slytab-emu >/dev/null
echo "screenshots: /tmp/fontscale-{1.0,1.3,2.0}.png on $(hostname)"
REMOTE
