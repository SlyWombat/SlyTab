#!/bin/bash
# One feedback-worker cycle (kdocker2). Intended for cron every 15 min:
#   */15 * * * * <worker-dir>/Splitwise/scripts/worker/run-worker.sh
# flock prevents overlapping cycles; everything logs to worker.log
# (in SLYTAB_LOG_DIR if set, else beside the checkout). Unlike the scheduled
# watchers, this one needs a checkout it can write: it pulls, commits, pushes.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK="/tmp/slytab-worker.lock"
LOG="${SLYTAB_LOG_DIR:-$REPO/..}/worker.log"
# cron has a minimal PATH — make user-local node/claude and docker visible.
# ~/.local/bin (PC install) and ~/.npm-global/bin (kdocker2 install) both covered.
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# ANTHROPIC_API_KEY (if used instead of interactive login) lives in .env.
[ -f "$REPO/.env" ] && set -a && . "$REPO/.env" && set +a

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
