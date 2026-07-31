#!/bin/bash
# Runs SQL from stdin against the SlyTab DEV database (docs/dev-environment.md).
# Same shape as scripts/ops/proddb.sh: credentials are sourced from the repo
# env file at runtime and passed via MYSQL_PWD, so nothing secret is echoed.
#
# Used by the documentation pipeline for the two things the public API has no
# endpoint for — marking demo accounts email-verified (there is no way to
# "click the link in the email" from a script) and flagging them is_test.
# Everything else in the demo world goes through the real API on purpose.
#
# Refuses to run against the production host.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
if [ -z "$DB_PASS" ]; then echo "DB_PASS not set" >&2; exit 1; fi
case "${DB_HOST:-}" in
  *147.5.121.145*|*electricrv*) echo "refusing: DB_HOST looks like production" >&2; exit 2;;
esac
exec docker run --rm -i \
  -e MYSQL_PWD="$DB_PASS" \
  mysql:8.4 mysql \
  --host="$DB_HOST" --port="${DB_PORT:-3306}" --user="$DB_USER" \
  --batch --table "${DB_NAME:-slytab_dev}"
