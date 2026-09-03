#!/bin/bash
# Active health for the receipt reader's backends (#123, requirement 2).
#
#   * * * * * /data/stacks/slytab/llm-proxy/healthcheck.sh >> $HOME/llm-health.log 2>&1
#
# For every backend in `backends`:
#   1. Does /api/tags answer, and does it list the pinned model (`model` file,
#      default qwen2.5vl:7b)? That is the definition of "available" the API uses
#      (FR-4.8) — so a backend that fails it is rendered `down` in nginx and
#      SlyTab never sends it a receipt.
#   2. Is the model RESIDENT (/api/ps)? If not, load it with keep_alive -1.
#      This is what survives a host reset: kdocker2 hard-reset ~11 times in the
#      week before this was written (house-network-ops#48), and every reset
#      unloaded the model so the next receipt paid ~20 s of cold start — or,
#      with another consumer's 37 GB model on the GPU, timed out at 90 s.
#      Warming is a POST with an empty prompt: it loads and returns.
#
# Then it renders nginx.conf with the healthy set (render.sh --apply), which
# reloads nginx only if the set changed, and writes status/status.json — served
# by the door at /slytab/status, token required — so an operator (or a future
# probe) can see which box is doing what without SSH.
#
# Logs one line per CHANGE, nothing per quiet minute. Exit code is always 0.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
MODEL="$(cat "$D/model" 2>/dev/null || echo qwen2.5vl:7b)"
STATUS_DIR="$D/status"
STATE="$STATUS_DIR/.healthy"           # last healthy set, for change detection
mkdir -p "$STATUS_DIR"
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] llm-health: $*"; }

# The two questions, as python read from stdin (Ollama JSON) with the model
# tag as argv[1]. Kept in heredocs: quoting python inside a bash single-quoted
# string is how the first version of this reported every model as absent.
PY_ADVERTISES=$(cat <<'PYEOF'
import json, sys
want = sys.argv[1]; wanted = want if ":" in want else want + ":latest"
try: names = [m.get("name", "") for m in json.load(sys.stdin).get("models", [])]
except Exception: names = []
sys.exit(0 if (want in names or wanted in names) else 1)
PYEOF
)
PY_RESIDENT=$(cat <<'PYEOF'
import json, sys
want = sys.argv[1]; wanted = want if ":" in want else want + ":latest"
try: ms = json.load(sys.stdin).get("models", [])
except Exception: ms = []
print("yes" if any(m.get("name") in (want, wanted) for m in ms) else "no")
print(", ".join("%s %.1fGB" % (m.get("name"), m.get("size", 0) / 1e9) for m in ms))
PYEOF
)

HEALTHY=()
DETAILS=()
while read -r line; do
  # A backends line may carry nginx flags after the address (`weight=3`,
  # `backup` — render.sh reads those). Health is about the address alone.
  read -r addr _ <<<"${line%%#*}"
  [ -n "$addr" ] || continue
  tags="$(curl -sS -m 4 "http://$addr/api/tags" 2>/dev/null)" || tags=""
  if [ -z "$tags" ]; then
    DETAILS+=("{\"backend\":\"$addr\",\"ok\":false,\"reason\":\"no answer\"}")
    continue
  fi
  if ! printf '%s' "$tags" | python3 -c "$PY_ADVERTISES" "$MODEL" 2>/dev/null; then
    DETAILS+=("{\"backend\":\"$addr\",\"ok\":false,\"reason\":\"does not advertise $MODEL\"}")
    continue
  fi
  # Resident? Warm it if not — in the background, so a cold load on one box
  # does not hold up the check of the others. The load itself takes ~20 s.
  ps="$(curl -sS -m 4 "http://$addr/api/ps" 2>/dev/null)" || ps=""
  resident=$(printf '%s' "$ps" | python3 -c "$PY_RESIDENT" "$MODEL" 2>/dev/null)
  is_resident="$(printf '%s\n' "$resident" | sed -n 1p)"
  others="$(printf '%s\n' "$resident" | sed -n 2p)"
  if [ "$is_resident" != "yes" ]; then
    say "warming $MODEL on $addr (resident now: ${others:-nothing})"
    (curl -sS -m 180 -X POST "http://$addr/api/generate" \
       -H 'Content-Type: application/json' \
       -d "{\"model\":\"$MODEL\",\"prompt\":\"\",\"keep_alive\":-1}" >/dev/null 2>&1 || true) &
  fi
  HEALTHY+=("$addr")
  DETAILS+=("{\"backend\":\"$addr\",\"ok\":true,\"resident\":$([ "$is_resident" = yes ] && echo true || echo false),\"loaded\":\"${others//\"/}\"}")
done < "$D/backends"

NOW="$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')"
{
  printf '{"checkedAt":"%s","model":"%s","healthy":%d,"total":%d,"backends":[' "$NOW" "$MODEL" "${#HEALTHY[@]}" "${#DETAILS[@]}"
  (IFS=,; printf '%s' "${DETAILS[*]}")
  printf ']}\n'
} > "$STATUS_DIR/status.json.tmp" && mv "$STATUS_DIR/status.json.tmp" "$STATUS_DIR/status.json"

NEWSET="${HEALTHY[*]:-}"
OLDSET="$(cat "$STATE" 2>/dev/null || echo '<first run>')"
if [ "$NEWSET" != "$OLDSET" ]; then
  say "healthy backends: [${NEWSET:-none}] (was [${OLDSET}])"
  for d in "${DETAILS[@]}"; do say "  $d"; done
  printf '%s' "$NEWSET" > "$STATE"
fi

# Render with the healthy set; render.sh prints changed/unchanged and reloads
# nginx on change. An empty HEALTHY renders every backend down — nginx then
# answers 502, which the API reads as "offline", which is the truth.
out="$(HEALTHY="$NEWSET" bash "$D/render.sh" --apply 2>&1)" || say "render failed: $out"
[ "$out" = "unchanged" ] || say "nginx: $out"
wait
exit 0
