#!/bin/bash
# Read-only download of one file from the prod app dir (cPanel Fileman
# get_file_content), for ops debugging — e.g. pulling a stored receipt
# image to reproduce a parse locally. Usage:
#   fetch-prod-file.sh <path-relative-to-app-dir> <local-out-file>
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$REPO/.env"; set +a
BASE="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"
AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
PUB=$(dirname "$WEB_ROOT"); HOMEDIR=$(dirname "$PUB"); APPDIR="$HOMEDIR/slytab"
REL="$1"; OUT="$2"
DIR="$APPDIR/$(dirname "$REL")"; FILE="$(basename "$REL")"
enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }
curl -sS -m 120 "$BASE/execute/Fileman/get_file_content?dir=$(enc "$DIR")&file=$(enc "$FILE")" -H "$AUTH" \
  | python3 -c "
import json, sys, base64
o = json.load(sys.stdin)
if not o.get('status'):
    sys.stderr.write('fileman error: %s\n' % o.get('errors'))
    sys.exit(1)
d = o['data']
content = d.get('content') or ''
enc = (d.get('from_charset') or '').lower()
with open(sys.argv[1], 'wb') as f:
    if enc in ('base64',) or d.get('is_binary'):
        f.write(base64.b64decode(content))
    else:
        f.write(content.encode('utf-8', 'surrogateescape'))
" "$OUT"
ls -la "$OUT"
