#!/bin/bash
# Read-only check of the deployed API's file mtimes (no deploy). Lists the
# remote api/src/Services dir so we can compare against local commit times.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
set -a; source "$REPO/.env"; set +a
BASE="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"
AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
PUB=$(dirname "$WEB_ROOT"); HOMEDIR=$(dirname "$PUB"); APPDIR="$HOMEDIR/slytab"
DIR="${1:-$APPDIR/api/src/Services}"
curl -sS -m 60 "$BASE/execute/Fileman/list_files?dir=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$DIR")" -H "$AUTH" \
  | python3 -c "
import json, sys, datetime
o = json.load(sys.stdin)
for f in o.get('data') or []:
    mt = f.get('mtime')
    ts = datetime.datetime.fromtimestamp(int(mt), datetime.timezone.utc).isoformat() if mt else '?'
    print(ts, f.get('file'))
"
