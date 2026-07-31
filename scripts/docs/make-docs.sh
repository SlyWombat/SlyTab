#!/bin/bash
# Rebuild the SlyTab user documentation (issue #104). One command.
#
#   bash scripts/docs/make-docs.sh              # web screenshots + gate
#   bash scripts/docs/make-docs.sh --android    # also drive the emulator
#   bash scripts/docs/make-docs.sh --no-check   # regenerate without gating
#
# What it does, in order:
#   1. brings up the local stack (PHP API container + Vite) if it is not
#      already running — never touches production;
#   2. seeds the demo world through the real API;
#   3. captures every screen in scripts/docs/shots.mjs;
#   4. runs the staleness gate, which fails loudly when a screen changed and
#      its prose did not.
#
# Screenshots are taken inside a PINNED Playwright container, not on whatever
# the developer's machine happens to have installed. This is not ceremony: the
# dev box here has no emoji font at all, so group emoji rendered as ▯ boxes in
# the first run of this pipeline. Fonts, Chromium build and rasteriser all have
# to be the same every time or the images churn for reasons that have nothing
# to do with SlyTab.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

PW_IMAGE="${DOCS_PW_IMAGE:-mcr.microsoft.com/playwright:v1.61.1-noble}"
BASE="${DOCS_BASE:-http://localhost:8000}"
THEME="${DOCS_THEME:-dark}"
DO_ANDROID=0
DO_CHECK=1
STARTED_API=0
STARTED_WEB=0

while [ $# -gt 0 ]; do
  case "$1" in
    --android) DO_ANDROID=1; shift;;
    --no-check) DO_CHECK=0; shift;;
    --theme) THEME="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

case "$BASE" in *electricrv.ca*) echo "refusing to build docs against production" >&2; exit 2;; esac

cleanup() {
  [ "$STARTED_WEB" = 1 ] && kill "$WEB_PID" 2>/dev/null || true
  [ "$STARTED_API" = 1 ] && docker rm -f slytab-docs-api >/dev/null 2>&1 || true
}
trap cleanup EXIT

up() { curl -fsS -m 5 -o /dev/null "$1" 2>/dev/null; }

# --- 1. local stack --------------------------------------------------------
echo "== 1/4 local stack =="
if up "$BASE/api/v1/health"; then
  # Reusing whatever is already serving :8100 is convenient, but a plain
  # `npm run dev:api` container does NOT set MAIL_DISABLE, and seeding
  # registers four accounts — which means four verification emails handed to
  # the real MTA. They go to example.com and die there, but slowly, and the
  # seed crawls. Say so rather than letting it look like a hang.
  if ! docker ps -q -f name=slytab-docs-api | grep -q .; then
    echo "   api already up (not ours) — if seeding is slow, stop it and let"
    echo "     this script start its own container with MAIL_DISABLE=1"
  else
    echo "   api already up"
  fi
else
  ENVFILE="$REPO/.env"
  docker rm -f slytab-docs-api >/dev/null 2>&1 || true
  docker run -d --rm --name slytab-docs-api -p 8100:8100 \
    --env-file "$ENVFILE" -e MAIL_DISABLE=1 \
    -v "$REPO/api":/app -w /app slytab-php:dev \
    php -S 0.0.0.0:8100 -t public >/dev/null
  STARTED_API=1
  echo "   api container started (mail disabled)"
fi
if up "$BASE/"; then
  echo "   web already up"
else
  npm run dev:web >/tmp/slytab-docs-vite.log 2>&1 &
  WEB_PID=$!
  STARTED_WEB=1
  for _ in $(seq 1 30); do up "$BASE/" && break; sleep 1; done
  echo "   vite started"
fi
up "$BASE/api/v1/health" || { echo "   API is not answering — is the dev DB reachable?" >&2; exit 1; }

# --- 2. demo world ---------------------------------------------------------
echo "== 2/4 demo world =="
node scripts/docs/seed-demo.mjs --base "$BASE" > scripts/docs/.seed.json

# --- 3. screenshots --------------------------------------------------------
echo "== 3/4 screenshots (pinned $PW_IMAGE) =="
docker run --rm --network host \
  -v "$REPO":/repo -w /repo \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
  -e HOME=/tmp \
  --user "$(id -u):$(id -g)" \
  "$PW_IMAGE" \
  node scripts/docs/capture-web.mjs --seed scripts/docs/.seed.json --theme "$THEME"

if [ "$DO_ANDROID" = 1 ]; then
  echo "== 3b/4 android screenshots =="
  bash scripts/docs/capture-android.sh
fi

# --- 4. staleness gate -----------------------------------------------------
if [ "$DO_CHECK" = 1 ]; then
  echo "== 4/4 staleness gate =="
  node scripts/docs/check-docs.mjs
else
  echo "== 4/4 gate skipped (--no-check) =="
fi
