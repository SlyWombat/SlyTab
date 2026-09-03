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
# A line may carry nginx upstream flags after the address, space separated:
#
#   192.168.10.38:11434 weight=3     # three receipts here for every one elsewhere
#   127.0.0.1:11434 backup           # only when no primary is up
#
# That matters because the boxes are not equals: kdocker3 (R9700) parses a
# receipt in ~3.4 s warm where kdocker2's iGPU takes ~6.7 s (#124), and plain
# `least_conn` over the two would still send half of them to the slow one.
# Recognised: `weight=N`, `backup`, and overrides of the per-server defaults
# `max_fails=1` / `fail_timeout=20s`. Anything else is refused here rather than
# rendered — an unknown word would only fail later, in `nginx -t`, with the
# door left on its old config and no clue why.
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
PRIMARIES=0
while read -r line; do
  read -r addr flags <<<"${line%%#*}"
  [ -n "$addr" ] || continue

  # Per-server defaults, overridable by a flag on the line. Held in variables
  # rather than appended, so `max_fails=2` REPLACES the default instead of
  # emitting the directive twice (which nginx rejects).
  max_fails="max_fails=1"
  fail_timeout="fail_timeout=20s"
  weight=""
  backup=""
  for f in $flags; do
    case "$f" in
      backup)                              backup=" backup" ;;
      weight=[1-9]|weight=[1-9][0-9])      weight=" $f" ;;
      max_fails=[0-9]|max_fails=[0-9][0-9]) max_fails="$f" ;;
      fail_timeout=[1-9]*[sm])             fail_timeout="$f" ;;
      *) echo "backends: $addr carries an unrecognised flag '$f' — refusing to render" >&2; exit 1 ;;
    esac
  done
  [ -n "$backup" ] || PRIMARIES=$((PRIMARIES + 1))

  # `down` is the health verdict and outranks everything: healthcheck.sh
  # decides it, this script only writes it down.
  down=""
  if [ "${HEALTHY+set}" = set ]; then
    case " $HEALTHY " in *" $addr "*) ;; *) down=" down";; esac
  fi
  UPSTREAMS+="    server ${addr} ${max_fails} ${fail_timeout}${weight}${backup}${down};"$'\n'
done < "$BACKENDS_FILE"
[ -n "$UPSTREAMS" ] || { echo "backends file names no backend" >&2; exit 1; }
# nginx has no upstream without a primary: a pool of nothing but `backup`
# servers fails `nginx -t`, and would leave the door on its old config with
# only nginx's own wording to explain it.
[ "$PRIMARIES" -gt 0 ] || { echo "every backend is marked \`backup\` — at least one must be a primary" >&2; exit 1; }

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
