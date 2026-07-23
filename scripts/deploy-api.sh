#!/bin/bash
# SlyTab API production deploy (see docs/deployment.md). Requires the repo
# env file to hold CPANEL_HOST/PORT/USER/TOKEN, WEB_ROOT, and the PROD_*
# secrets. The SPA deploys separately via `npm run deploy`. Status only.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
BASE="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"
AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
PUB=$(dirname "$WEB_ROOT"); HOMEDIR=$(dirname "$PUB"); APPDIR="$HOMEDIR/slytab"

st() { python3 -c "import json,sys
raw = sys.stdin.read()
try:
    o = json.loads(raw)
    print('  status:', o.get('status'), (o.get('errors') or ''))
except Exception:
    print('  non-json response:', raw[:120].replace(chr(10), ' '))"; }
api2() { curl -sS -m 120 "$BASE/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=Fileman&cpanel_jsonapi_func=fileop&$1" -H "$AUTH" >/dev/null; }
enc() { python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1"; }

echo "== 1/6 stage + zip production API =="
STAGE=$(mktemp -d)
mkdir -p "$STAGE/api"
cp -r "$REPO/api/src" "$REPO/api/bin" "$REPO/api/composer.json" "$REPO/api/composer.lock" "$STAGE/api/"
docker run --rm -v "$STAGE/api":/app -w /app composer:2 install --no-dev --no-interaction --no-progress -o >/dev/null 2>&1
python3 - "$STAGE" <<'PY'
import os, sys, zipfile
stage = sys.argv[1]
with zipfile.ZipFile(os.path.join(stage, 'slytab-api.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(os.path.join(stage, 'api')):
        for f in files:
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, stage))
PY
echo "  staged"

echo "== 2/6 replace remote api code =="
api2 "op=trash&sourcefiles=$(enc "$APPDIR/api")" || true
curl -sS -m 300 "$BASE/execute/Fileman/upload_files" -H "$AUTH" \
  -F "dir=$APPDIR" -F "overwrite=1" -F "file-1=@$STAGE/slytab-api.zip" | st
api2 "op=extract&sourcefiles=$(enc "$APPDIR/slytab-api.zip")&destfiles=$(enc "$APPDIR")"
api2 "op=unlink&sourcefiles=$(enc "$APPDIR/slytab-api.zip")"
echo "  extracted"

echo "== 3/6 config + CA + backup script =="
CONFDIR=$(mktemp -d)
cat > "$CONFDIR/config.env" <<EOF
DB_HOST=147.5.121.145
DB_PORT=3307
DB_NAME=slytab_prod
DB_USER=slytab_prod
DB_PASS=$PROD_DB_PASS
DB_SSL_CA=$APPDIR/mysql-ca.pem
SESSION_PEPPER=$PROD_SESSION_PEPPER
INVITE_HMAC_KEY=$PROD_INVITE_HMAC_KEY
MIGRATE_TOKEN=$PROD_MIGRATE_TOKEN
DATA_DIR=$APPDIR/data
APP_URL=https://electricrv.ca/slytab
MAIL_FROM=SlyTab <noreply@electricrv.ca>
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
ANTHROPIC_API_KEY=
RECEIPT_ENGINE=auto
LOCAL_LLM_URL=http://147.5.121.145:3308
LOCAL_LLM_MODEL=qwen2.5vl:7b
LOCAL_LLM_TIMEOUT=90
EOF
cp "$REPO/scripts/prod/mysql-ca.pem" "$CONFDIR/mysql-ca.pem"

curl -sS -m 60 "$BASE/execute/Fileman/upload_files" -H "$AUTH" -F "dir=$APPDIR" -F "overwrite=1" \
  -F "file-1=@$CONFDIR/config.env" -F "file-2=@$CONFDIR/mysql-ca.pem" | st
rm -rf "$CONFDIR"

echo "== 4/6 front-controller shim =="
SHIMDIR=$(mktemp -d)
cat > "$SHIMDIR/index.php" <<EOF
<?php
declare(strict_types=1);
putenv('APP_CONFIG_PATH=$APPDIR/config.env');
putenv('API_BASE_PATH=/slytab');
require '$APPDIR/api/vendor/autoload.php';
\\SlyTab\\App::create()->run();
EOF
cp "$REPO/api/public/.htaccess" "$SHIMDIR/.htaccess"
curl -sS -m 60 "$BASE/execute/Fileman/upload_files" -H "$AUTH" -F "dir=$PUB/slytab/api" -F "overwrite=1" \
  -F "file-1=@$SHIMDIR/index.php" -F "file-2=@$SHIMDIR/.htaccess" | st
rm -rf "$SHIMDIR"

echo "== 5/6 migrate + seed rates + health =="
curl -sS -m 90 -X POST "https://electricrv.ca/slytab/api/internal/migrate" -H "X-Admin-Token: $PROD_MIGRATE_TOKEN"; echo
curl -sS -m 90 -X POST "https://electricrv.ca/slytab/api/internal/fetch-rates" -H "X-Admin-Token: $PROD_MIGRATE_TOKEN"; echo
curl -sS -m 30 "https://electricrv.ca/slytab/api/v1/health"; echo

echo "== 6/6 cleanup stage =="
docker run --rm -v "$STAGE":/s busybox sh -c 'rm -rf /s/api /s/*.zip' && rmdir "$STAGE"
echo "done"
