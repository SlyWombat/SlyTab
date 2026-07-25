#!/bin/bash
# One feedback-worker cycle (kdocker2). Intended for cron every 15 min:
#   */15 * * * * /home/<user>/slytab-worker/Splitwise/scripts/worker/run-worker.sh
# flock prevents overlapping cycles; everything logs to worker.log.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="/tmp/slytab-worker.lock"
LOG="$REPO/../worker.log"

exec 9>"$LOCK"
flock -n 9 || exit 0   # previous cycle still running

{
  echo "===== cycle $(date -u +%FT%TZ) ====="
  cd "$REPO"
  git pull --ff-only origin main || true
  # Long timeout: a real fix (code+tests+deploy) can take a while.
  claude -p "$(cat "$REPO/scripts/worker/worker-prompt.md")" \
    --dangerously-skip-permissions \
    --max-turns 200 \
    2>&1
  echo "===== cycle done $(date -u +%FT%TZ) ====="
} >> "$LOG" 2>&1
