#!/bin/bash
# Run the receipt corpus against the live model host, on a schedule, and tell
# the owner when the model has quietly stopped reading money correctly (#123,
# "test regularly as new models come out").
#
#   0 13 * * 0 /bin/bash /home/dave/slytab-worker/Splitwise/scripts/worker/model-corpus-check.sh >> /home/dave/model-corpus.log 2>&1
#
# Why a schedule: a model change that still returns valid JSON produces wrong
# NUMBERS, and wrong numbers become wrong money. That has happened three ways
# already — an Ollama upgrade (0.32.5 broke qwen2.5vl:7b outright), a 33 GB
# neighbour starving the image encoder, and a 37 GB neighbour evicting the
# model into a 90 s timeout — and each time the app kept answering.
# docs/llm-requirements.md has the history; this is the smoke alarm.
#
# What it does, on kdocker2 (which has docker, the slytab-php:dev image, the
# test harness in ~/slytab-test and the fixtures that are deliberately not
# committed):
#   1. syncs api/ from this checkout into the harness (never .env);
#   2. runs ReceiptCorpusTest against the pinned model (`LOCAL_LLM_MODEL`, from
#      the front door's `model` file) on EVERY backend in the door's `backends`
#      file, each one directly, not through the door — since #124 there are two
#      boxes and a receipt lands on whichever nginx picks, so a smoke alarm
#      that only watched this host would miss half the receipts going wrong;
#   3. optionally screens CANDIDATE models listed one per line in
#      ~/.slytab-corpus-candidates — reported, never gating, on one backend;
#   4. mails the owner when the pinned model fails on ANY backend, with the
#      test's own diagnosis (what was resident, how long it took) and which
#      box it was. A pass is a log line.
#
# Notify-only. It changes no pin and restarts nothing.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
HARNESS="${SLYTAB_TEST_HARNESS:-$HOME/slytab-test}"
FRONT="/data/stacks/slytab/llm-proxy"
MODEL="${LOCAL_LLM_MODEL:-$(cat "$FRONT/model" 2>/dev/null || echo qwen2.5vl:7b)}"
CANDIDATES_FILE="$HOME/.slytab-corpus-candidates"
API_INTERNAL="https://electricrv.ca/slytab/api/internal"
OWNER="dave@drscapital.com"
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] model-corpus: $*"; }

mail_to() { # mail_to <subject> <body>
  curl -sS -m 30 -X POST -H "X-Admin-Token: ${PROD_MIGRATE_TOKEN:-}" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"to":sys.argv[1],"subject":sys.argv[2],"body":sys.argv[3]}))' "$OWNER" "$1" "$2")" \
    "$API_INTERNAL/send-mail" >/dev/null 2>&1 || true
}

[ -d "$HARNESS/api" ] || { say "no harness at $HARNESS — see memory/dev-box notes; nothing run"; exit 0; }
[ -f "$HARNESS/api/tests/fixtures/receipts/expected.json" ] || { say "harness has no corpus fixtures; nothing run"; exit 0; }

# 1. sync code, never secrets; keep the harness's fixtures and vendor.
rsync -a --delete \
  --exclude 'tests/fixtures/receipts/*.jpg' --exclude 'vendor' \
  "$REPO/api/src" "$REPO/api/tests" "$REPO/api/bin" "$REPO/api/composer.json" "$REPO/api/composer.lock" "$REPO/api/phpunit.xml" \
  "$HARNESS/api/" 2>/dev/null || { say "rsync into harness failed"; exit 0; }

docker start slytab-test-mysql >/dev/null 2>&1 || true
GW="$(docker network inspect slytab-test-net -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.0.1)"

# Every backend the door fans out to (#124). A line may carry nginx flags after
# the address (`weight=3`, `backup`) — the address is the first field. This
# host's own Ollama is `127.0.0.1:11434` in that file and unreachable under
# that name from inside the test container, so it becomes the bridge gateway.
BACKENDS=()
while read -r line; do
  read -r a _ <<<"${line%%#*}"
  [ -n "$a" ] || continue
  case "$a" in 127.0.0.1:*|localhost:*) a="$GW:${a##*:}";; esac
  BACKENDS+=("$a")
done < <(cat "$FRONT/backends" 2>/dev/null || echo 127.0.0.1:11434)
[ "${#BACKENDS[@]}" -gt 0 ] || BACKENDS=("$GW:11434")

run_corpus() { # run_corpus <model> <host:port> -> prints phpunit tail, returns its exit code
  docker run --rm --network slytab-test-net \
    -v "$HARNESS":/repo -w /repo/api \
    -e DB_HOST=slytab-test-mysql -e DB_PORT=3306 -e DB_NAME=slytab_test -e DB_TEST_NAME=slytab_test \
    -e DB_USER=slytab -e DB_PASS=ci \
    -e SESSION_PEPPER=ci-only -e INVITE_HMAC_KEY=ci-only -e MIGRATE_TOKEN=ci-only \
    -e LOCAL_LLM_URL="http://$2" -e LOCAL_LLM_MODEL="$1" -e LOCAL_LLM_TIMEOUT="${LOCAL_LLM_TIMEOUT:-90}" \
    slytab-php:dev sh -c "vendor/bin/phpunit --filter ReceiptCorpusTest --testdox 2>&1" 2>&1
}

FAILED=()
for BE in "${BACKENDS[@]}"; do
  say "pinned model $MODEL via $BE"
  T0=$(date +%s)
  OUT="$(run_corpus "$MODEL" "$BE")"; RC=$?
  SUMMARY="$(printf '%s\n' "$OUT" | grep -E '^(OK|FAILURES|ERRORS|Tests:|No tests)' | tail -2 | tr '\n' ' ')"
  if [ "$RC" -eq 0 ]; then
    say "PASS on $BE in $(( $(date +%s) - T0 ))s — $SUMMARY"
    continue
  fi
  FAILED+=("$BE")
  say "FAIL on $BE — $SUMMARY"
  printf '%s\n' "$OUT" | tail -40
  mail_to "SlyTab receipt reader: the corpus FAILED on $MODEL at $BE" \
"The weekly receipt corpus run on kdocker2 failed against the pinned model ($MODEL) on backend $BE.

$SUMMARY

Receipts are shared across every backend behind the front door, so one bad box
means a share of live scans are wrong — not all of them, which is why nobody
may have noticed.

This is the money check: real receipts re-parsed through the live model, totals asserted exactly. A failure here means receipt scanning is returning wrong numbers or not returning at all, even though the app may still look fine.

The usual suspects, in order (docs/llm-requirements.md has each one's history):
  - another model resident on the GPU starving or evicting ours (curl localhost:11434/api/ps)
  - an Ollama upgrade (ollama -v; 0.30.10 is the version that works with $MODEL)
  - a re-pulled model tag with a different digest

The test's own diagnosis follows.

$(printf '%s\n' "$OUT" | tail -40)

Nothing was changed automatically. To take the box out of rotation, mark it
\`down\` by stopping its Ollama, or remove its line from $FRONT/backends —
healthcheck.sh re-renders nginx within the minute."
done
[ "${#FAILED[@]}" -eq 0 ] || say "backends failing: ${FAILED[*]}"

# 3. candidates: screened, reported, never gating. One backend is enough — a
# candidate is being judged on how it reads receipts, not on which box it sat
# on — and each run loads a second model onto that GPU, which is the very
# neighbour this test exists to catch.
CAND_BE="${BACKENDS[0]}"
if [ -s "$CANDIDATES_FILE" ]; then
  while read -r cand; do
    cand="${cand%%#*}"; cand="$(echo "$cand" | tr -d '[:space:]')"
    [ -n "$cand" ] || continue
    T0=$(date +%s)
    COUT="$(run_corpus "$cand" "$CAND_BE")"; CRC=$?
    say "candidate $cand on $CAND_BE: $([ $CRC -eq 0 ] && echo PASS || echo FAIL) in $(( $(date +%s) - T0 ))s — $(printf '%s\n' "$COUT" | grep -E '^(OK|FAILURES|ERRORS|Tests:)' | tail -1)"
  done < "$CANDIDATES_FILE"
fi

# Leave the GPU as we found it for the pinned model: candidates were loaded
# with SlyTab's keep_alive -1, and a spare 6-20 GB model resident is exactly
# the neighbour this test exists to catch. Unload anything that is not ours.
curl -s -m 5 "http://$CAND_BE/api/ps" 2>/dev/null | python3 -c '
import json,sys,urllib.request
keep=sys.argv[1]
for m in json.load(sys.stdin).get("models",[]):
    n=m.get("name","")
    if n and n!=keep and n!=keep+":latest":
        req=urllib.request.Request("http://%s/api/generate" % sys.argv[2],
            data=json.dumps({"model":n,"keep_alive":0}).encode(),headers={"Content-Type":"application/json"})
        try: urllib.request.urlopen(req,timeout=30); print("unloaded",n)
        except Exception as e: print("could not unload",n,e)
' "$MODEL" "$CAND_BE" 2>/dev/null | while read -r l; do say "$l"; done
exit 0
