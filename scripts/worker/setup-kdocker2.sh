#!/bin/bash
# One-time setup of the feedback worker on kdocker2. Run from the dev PC
# (which holds .env, secrets/, and the git credential). Idempotent.
# Secrets are transferred file→file over SSH, never printed to a terminal.
set -e
HOST="${1:-kdocker2}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="slytab-worker/Splitwise"   # relative to the remote home dir

echo "== 1/5 clone or update the repo on $HOST =="
ssh "$HOST" "mkdir -p slytab-worker && if [ -d $DEST/.git ]; then
    cd $DEST && git pull --ff-only origin main;
  else
    git clone https://github.com/SlyWombat/SlyTab.git $DEST;
  fi"

echo "== 2/5 copy gitignored config + secrets (file→file, not printed) =="
scp "$SRC/.env" "$HOST:$DEST/.env"
ssh "$HOST" "mkdir -p $DEST/secrets"
scp "$SRC/secrets/"*.p8 "$HOST:$DEST/secrets/" 2>/dev/null || echo "  (no .p8 keys — ok if not doing iOS ops here)"
scp "$SRC/scripts/prod/mysql-ca.pem" "$HOST:$DEST/scripts/prod/mysql-ca.pem"
# git credential for pushes + gh-api.sh
scp "$HOME/.git-credentials" "$HOST:.git-credentials" 2>/dev/null || echo "  (no ~/.git-credentials to copy)"
ssh "$HOST" "git config --global credential.helper store && chmod 600 .git-credentials $DEST/.env $DEST/secrets/* 2>/dev/null || true"

echo "== 3/5 install deps + build php test image =="
ssh "$HOST" "cd $DEST && npm ci && npm run php:image 2>/dev/null || echo '  (php image build skipped/failed — tests will warn)'"

echo "== 4/5 Claude Code CLI =="
ssh "$HOST" "command -v claude >/dev/null && echo '  claude already installed' || npm install -g @anthropic-ai/claude-code"
echo "  NOTE: authenticate once, interactively, on the host:  ssh $HOST -t 'claude login'"
echo "        (or set ANTHROPIC_API_KEY in $DEST/.env — the worker sources it)"

echo "== 5/5 install the 15-minute cron =="
CRON="*/15 * * * * \$HOME/$DEST/scripts/worker/run-worker.sh"
ssh "$HOST" "( crontab -l 2>/dev/null | grep -v 'run-worker.sh' ; echo \"$CRON\" ) | crontab - && echo '  cron installed:' && crontab -l | grep run-worker"

echo "== done. First manual cycle: ssh $HOST 'cd $DEST && bash scripts/worker/run-worker.sh; tail -30 ../worker.log' =="
