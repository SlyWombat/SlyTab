#!/bin/bash
# Runs SQL from stdin against the SlyTab prod DB. Credentials are sourced
# from the repo env file at runtime and passed via MYSQL_PWD; nothing
# secret is ever echoed.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
if [ -z "$PROD_DB_PASS" ]; then echo "PROD_DB_PASS not set" >&2; exit 1; fi
exec docker run --rm -i \
  -v "$REPO/scripts/prod/mysql-ca.pem":/ca.pem:ro \
  -e MYSQL_PWD="$PROD_DB_PASS" \
  mysql:8.4 mysql \
  --host=147.5.121.145 --port=3307 --user=slytab_prod \
  --ssl-ca=/ca.pem --ssl-mode=VERIFY_CA \
  --batch --table slytab_prod
