#!/bin/bash
# Publish an APK to the public download names, byte-exact and verified.
#
#   bash scripts/ops/upload-apk.sh <path-to.apk> <version>
#
# Why the zip dance: cPanel's Fileman upload appends the multipart boundary
# terminator to whatever it stores ("\r\n------…--", ~52 bytes). A zip
# survives that — readers find the central directory and ignore trailing
# junk, which is why deploy-api.sh has always worked — but an APK does NOT:
# its v2/v3 signature covers the whole file, and Android rejects the result
# with INSTALL_PARSE_FAILED_NOT_APK. The 1.0.0 download was broken this way
# and nobody noticed, because the file still opened as a zip.
#
# So: upload a ZIP of the APK, extract it server-side (the extracted file is
# exact), then re-download and compare sha256 before calling it published.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
APK="${1:?usage: upload-apk.sh <apk> <version>}"
VER="${2:?usage: upload-apk.sh <apk> <version>}"
set -a; source "$REPO/.env"; set +a

BASE="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"
AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
PUBLIC="https://electricrv.ca/slytab/downloads"
DIR="$WEB_ROOT/downloads"
WANT=$(sha256sum "$APK" | cut -d' ' -f1)

enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }
fileop() { curl -sS -m 300 "$BASE/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Fileman&cpanel_jsonapi_func=fileop&$1" -H "$AUTH" >/dev/null; }

echo "publishing $(basename "$APK") — $(stat -c%s "$APK") bytes, sha256 ${WANT:0:16}…"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

fail=0
for NAME in slytab.apk slytab-latest.apk "slytab-$VER.apk"; do
  # python's zipfile — no `zip` binary on this box, and stored (not
  # deflated) keeps a 60MB APK fast to pack and unpack.
  python3 -c "
import sys, zipfile
apk, out, name = sys.argv[1:4]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    z.write(apk, name)
" "$APK" "$STAGE/upload.zip" "$NAME"

  curl -sS -m 900 "$BASE/execute/Fileman/upload_files" -H "$AUTH" \
    -F "dir=$DIR" -F "overwrite=1" -F "file-1=@$STAGE/upload.zip;filename=slytab-upload.zip" > /dev/null
  fileop "op=extract&sourcefiles=$(enc "$DIR/slytab-upload.zip")&destfiles=$(enc "$DIR")"
  fileop "op=unlink&sourcefiles=$(enc "$DIR/slytab-upload.zip")"
  rm -f "$STAGE/upload.zip"

  sleep 2
  GOT=$(curl -sSL -m 900 "$PUBLIC/$NAME" | sha256sum | cut -d' ' -f1)
  if [ "$GOT" = "$WANT" ]; then
    echo "  OK   $NAME"
  else
    echo "  FAIL $NAME — served ${GOT:0:16}… != ${WANT:0:16}…"
    fail=1
  fi
done
exit $fail
