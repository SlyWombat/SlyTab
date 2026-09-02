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
# The released app versions, so the API can tell a running app it is behind
# (#118). Copied from the mobile app's own file rather than restated here:
# that is what the release scripts bump, so the two cannot disagree about what
# was actually built.
cp "$REPO/apps/mobile/versions.json" "$STAGE/api/releases.json"
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
BUG_REPORT_EMAIL=${BUG_REPORT_EMAIL:-dave@drscapital.com}
BUG_GITHUB_TOKEN=${BUG_GITHUB_TOKEN:-$(python3 -c "
import os
try:
    for line in open(os.path.expanduser('~/.git-credentials')):
        line = line.strip()
        if 'github.com' in line and '@' in line:
            cred = line.split('//', 1)[1].split('@', 1)[0]
            print(cred.split(':', 1)[1] if ':' in cred else cred); break
except OSError: pass")}
BUG_GITHUB_REPO=${BUG_GITHUB_REPO:-SlyWombat/SlyTab}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID:-}
APPLE_CLIENT_ID=${APPLE_CLIENT_ID:-}
APPLE_BUNDLE_ID=ca.electricrv.slytab
# Sign in with Apple revocation (#81). Without these three the
# revoke is skipped and logged; deletion still works.
APPLE_SIWA_KEY_ID=${PROD_APPLE_SIWA_KEY_ID:-}
APPLE_TEAM_ID=${PROD_APPLE_TEAM_ID:-}
APPLE_SIWA_KEY_PATH=$APPDIR/apple-siwa.p8
ANTHROPIC_API_KEY=
RECEIPT_ENGINE=auto
LOCAL_LLM_URL=http://147.5.121.145:3308
LOCAL_LLM_MODEL=qwen2.5vl:7b
LOCAL_LLM_TIMEOUT=90
# How many receipts may be at the reader at once: one per Ollama behind the
# front door (#123). Raise it when a backend is added to the door's backends
# file - scripts/ops/llm-proxy/README.md. (No backticks in this heredoc: it
# is unquoted, so they would run as a command.)
LOCAL_LLM_PARALLEL=1
# The token the house-side front door expects (#119). Ollama has no auth of
# its own and that relay port is on the public internet, so without this the
# endpoint is open to anyone who finds it — which is why it was switched off.
LOCAL_LLM_TOKEN=${PROD_LLM_TOKEN:-}
EOF
cp "$REPO/scripts/prod/mysql-ca.pem" "$CONFDIR/mysql-ca.pem"
# The Apple key travels with the config; it is referenced by path on
# the server, so it has to actually be there.
# The Apple key travels with the config, which references it by a path on the
# server — so it has to actually get there. Optional: a machine without the
# key still deploys, and revocation simply stays skipped.
CONF_FILES=(-F "file-1=@$CONFDIR/config.env" -F "file-2=@$CONFDIR/mysql-ca.pem")
if [ -n "${APPLE_SIWA_KEY_PATH:-}" ] && [ -f "${APPLE_SIWA_KEY_PATH}" ]; then
  cp "$APPLE_SIWA_KEY_PATH" "$CONFDIR/apple-siwa.p8"
  CONF_FILES+=(-F "file-3=@$CONFDIR/apple-siwa.p8")
  echo "  including the Sign in with Apple key"
else
  echo "  no Sign in with Apple key configured — revocation will stay skipped"
fi

curl -sS -m 60 "$BASE/execute/Fileman/upload_files" -H "$AUTH" -F "dir=$APPDIR" -F "overwrite=1" \
  "${CONF_FILES[@]}" | st
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
cat > "$SHIMDIR/.user.ini" <<EOF
; Receipt uploads: phone photos (Pixel Motion Photos) run 10-20 MB.
upload_max_filesize = 25M
post_max_size = 26M
memory_limit = 256M
EOF
curl -sS -m 60 "$BASE/execute/Fileman/upload_files" -H "$AUTH" -F "dir=$PUB/slytab/api" -F "overwrite=1" \
  -F "file-1=@$SHIMDIR/index.php" -F "file-2=@$SHIMDIR/.htaccess" -F "file-3=@$SHIMDIR/.user.ini" | st
rm -rf "$SHIMDIR"

echo "== 5/6 migrate + seed rates + health =="
curl -sS -m 90 -X POST "https://electricrv.ca/slytab/api/internal/migrate" -H "X-Admin-Token: $PROD_MIGRATE_TOKEN"; echo
curl -sS -m 90 -X POST "https://electricrv.ca/slytab/api/internal/fetch-rates" -H "X-Admin-Token: $PROD_MIGRATE_TOKEN"; echo
curl -sS -m 30 "https://electricrv.ca/slytab/api/v1/health"; echo

echo "== 6/6 cleanup stage =="
docker run --rm -v "$STAGE":/s busybox sh -c 'rm -rf /s/api /s/*.zip' && rmdir "$STAGE"
echo "done"
