#!/bin/bash
# Render the front door's nginx.conf from the template, the token and the
# backend list — and apply it only if nginx agrees it is valid.
#
#   render.sh [--apply]            # write nginx.conf(.new); --apply reloads nginx
#   HEALTHY="host:port host:port" render.sh --apply
#
# Backends come from `backends` beside this script: one `host:port` per line,
# `#` comments allowed. A backend not named in $HEALTHY (when HEALTHY is set at
# all) is rendered `down`, which keeps the upstream block valid — nginx refuses
# an empty upstream — while sending it nothing. healthcheck.sh is the normal
# caller; by hand, run it with no HEALTHY to render every backend up.
#
# Prints "changed" or "unchanged" so a cron caller can stay quiet.
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
TOKEN_FILE="$D/token"
BACKENDS_FILE="$D/backends"
OUT="$D/nginx.conf"

[ -s "$TOKEN_FILE" ] || { echo "no token at $TOKEN_FILE — see README" >&2; exit 1; }
[ -s "$BACKENDS_FILE" ] || { echo "no backends at $BACKENDS_FILE — one host:port per line" >&2; exit 1; }

UPSTREAMS=""
while read -r line; do
  addr="${line%%#*}"; addr="$(echo "$addr" | tr -d '[:space:]')"
  [ -n "$addr" ] || continue
  flag=""
  if [ "${HEALTHY+set}" = set ]; then
    case " $HEALTHY " in *" $addr "*) ;; *) flag=" down";; esac
  fi
  UPSTREAMS+="    server ${addr} max_fails=1 fail_timeout=20s${flag};"$'\n'
done < "$BACKENDS_FILE"
[ -n "$UPSTREAMS" ] || { echo "backends file names no backend" >&2; exit 1; }

NEW="$(mktemp)"
trap 'rm -f "$NEW"' EXIT
# The token goes in via awk's variable, never via sed's pattern space, so a
# token containing a delimiter cannot corrupt the file.
awk -v tok="$(cat "$TOKEN_FILE")" -v ups="$UPSTREAMS" '
  { gsub(/__TOKEN__/, tok) }
  /__UPSTREAMS__/ { printf "%s", ups; next }
  { print }
' "$D/nginx.conf.tmpl" > "$NEW"
chmod 600 "$NEW"

if [ -f "$OUT" ] && cmp -s "$NEW" "$OUT"; then
  echo unchanged
  exit 0
fi

# Validate in a throwaway container against the same image the door runs.
mkdir -p "$D/status"
docker run --rm -v "$NEW":/etc/nginx/nginx.conf:ro -v "$D/status":/srv/status:ro \
  nginx:1.27-alpine nginx -t >/dev/null 2>&1 \
  || { echo "rendered config is INVALID — leaving the running one alone" >&2; docker run --rm -v "$NEW":/etc/nginx/nginx.conf:ro nginx:1.27-alpine nginx -t >&2 || true; exit 1; }

cat "$NEW" > "$OUT"
chmod 600 "$OUT"
if [ "${1:-}" = "--apply" ]; then
  docker exec slytab-llm-proxy nginx -s reload >/dev/null 2>&1 || echo "nginx reload failed — is slytab-llm-proxy running?" >&2
fi
echo changed
