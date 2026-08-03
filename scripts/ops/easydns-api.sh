#!/bin/bash
# easyDNS REST API wrapper. Same shape as gh-api.sh and asc-api.sh: credentials
# are read from the repo env file at runtime and never echoed.
#
#   easydns-api.sh METHOD PATH [json-body-file]
#
#   easydns-api.sh GET  /zones/records/all/slytab.com
#   easydns-api.sh PUT  /zones/records/add/slytab.com/A  body.json
#   easydns-api.sh DELETE /zones/records/slytab.com/12345
#
# .env keys: EASYDNS_TOKEN, EASYDNS_API_KEY.
#
# SANDBOX BY DEFAULT. easyDNS copies the live zones into the sandbox, so the
# calls look identical and the blast radius is not — electricrv.ca is serving
# real users and its DNS is not something to be one typo away from. Production
# needs EASYDNS_LIVE=1 stated on the command line, per invocation, so it is
# always a decision rather than a leftover setting:
#
#   EASYDNS_LIVE=1 easydns-api.sh GET /domains/list/USER
#
# Two things easyDNS enforces that most APIs do not:
#   - A User-Agent is mandatory. Requests without one are blocked outright,
#     which presents as a refusal that looks nothing like a missing header.
#   - Rate limits are 1 request/second and 500/day, and breaching them returns
#     420 rather than the usual 429. The sleep below is not politeness; without
#     it a loop over a zone's records trips the limit within a second.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# EASYDNS_ENV_FILE lets the sandbox pair live outside the repo entirely. The
# two sets are different credentials against different hosts, and keeping the
# throwaway one out of .env means there is never a moment where the file holds
# both and the wrong one is in scope.
ENVFILE="${EASYDNS_ENV_FILE:-$REPO/.env}"
if [ ! -f "$ENVFILE" ]; then echo "no credentials file at $ENVFILE" >&2; exit 1; fi
set -a; source "$ENVFILE"; set +a

if [ -z "${EASYDNS_TOKEN:-}" ] || [ -z "${EASYDNS_API_KEY:-}" ]; then
  echo "EASYDNS_TOKEN and EASYDNS_API_KEY must be set in .env" >&2
  exit 1
fi

if [ "${EASYDNS_LIVE:-0}" = "1" ]; then
  HOST="rest.easydns.net"
  PORT=""
else
  HOST="sandbox.rest.easydns.net"
  PORT=""
fi

METHOD="$1"; APIPATH="$2"; BODYFILE="${3:-}"

# One request per second, counted across every call rather than per process:
# separate invocations are still the same quota, and the limit does not care
# that a shell exited in between.
STAMP="${TMPDIR:-/tmp}/.easydns-last-call"
if [ -f "$STAMP" ]; then
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  [ $((NOW - LAST)) -lt 1 ] && sleep 1
fi
date +%s > "$STAMP"

ARGS=(-sS -m 60 -X "$METHOD"
  # Identifies the caller, and is not optional to easyDNS.
  -A "SlyTab-ops/1.0 (+https://electricrv.ca/slytab)"
  -H "Accept: application/json")
if [ -n "$BODYFILE" ]; then
  ARGS+=(-H "Content-Type: application/json" --data-binary "@$BODYFILE")
fi

# Credentials arrive on stdin rather than in the argument list, so they never
# appear in `ps` output on a shared host.
curl "${ARGS[@]}" --config - "https://${HOST}${PORT}${APIPATH}" <<CONFIG
user = "${EASYDNS_TOKEN}:${EASYDNS_API_KEY}"
CONFIG
