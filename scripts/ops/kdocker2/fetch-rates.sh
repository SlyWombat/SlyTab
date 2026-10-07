#!/bin/bash
# Daily ECB rate refresh: asks the prod API to fetch today's reference rates.
# Installed as /data/stacks/slytab/fetch-rates.sh on kdocker2; run daily at
# 06:10 UTC. HTTPS only — no container, no database.
#
#   SLYTAB_ENV_FILE  holds the admin token          (/data/stacks/slytab/cron.env)
#   SLYTAB_LOG_DIR   where fetch-rates.log goes     (/data/stacks/slytab)
#
# The token is PROD_MIGRATE_TOKEN (MIGRATE_TOKEN is accepted too). It goes to
# curl on stdin, never in argv. Exits non-zero when the API does not answer
# 200, so a scheduler sees the failure.
set -uo pipefail
ENVFILE="${SLYTAB_ENV_FILE:-/data/stacks/slytab/cron.env}"
LOG="${SLYTAB_LOG_DIR:-/data/stacks/slytab}/fetch-rates.log"
URL="https://electricrv.ca/slytab/api/internal/fetch-rates"
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
TOKEN="${PROD_MIGRATE_TOKEN:-${MIGRATE_TOKEN:-}}"
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] fetch-rates: $*" >> "$LOG"; }

if [ -z "$TOKEN" ]; then
  say "no PROD_MIGRATE_TOKEN in $ENVFILE — nothing fetched"
  exit 1
fi
BODY="$(mktemp)"; trap 'rm -f "$BODY"' EXIT
CODE="$(printf 'header = "X-Admin-Token: %s"\n' "$TOKEN" \
  | curl -sS -m 90 -K - -X POST -o "$BODY" -w '%{http_code}' "$URL" 2>>"$LOG")"
say "HTTP $CODE $(head -c 300 "$BODY" | tr '\n' ' ')"
[ "$CODE" = 200 ]
