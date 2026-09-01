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
#      the front door's `model` file) through the HOST's Ollama;
#   3. optionally screens CANDIDATE models listed one per line in
#      ~/.slytab-corpus-candidates — reported, never gating;
#   4. mails the owner on a pinned-model failure, with the test's own
#      diagnosis (what was resident, how long it took). A pass is a log line.
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

run_corpus() { # run_corpus <model> -> prints phpunit tail, returns its exit code
  docker run --rm --network slytab-test-net \
    -v "$HARNESS":/repo -w /repo/api \
    -e DB_HOST=slytab-test-mysql -e DB_PORT=3306 -e DB_NAME=slytab_test -e DB_TEST_NAME=slytab_test \
    -e DB_USER=slytab -e DB_PASS=ci \
    -e SESSION_PEPPER=ci-only -e INVITE_HMAC_KEY=ci-only -e MIGRATE_TOKEN=ci-only \
    -e LOCAL_LLM_URL="http://$GW:11434" -e LOCAL_LLM_MODEL="$1" -e LOCAL_LLM_TIMEOUT="${LOCAL_LLM_TIMEOUT:-90}" \
    slytab-php:dev sh -c "vendor/bin/phpunit --filter ReceiptCorpusTest --testdox 2>&1" 2>&1
}

say "pinned model $MODEL via $GW:11434"
OUT="$(run_corpus "$MODEL")"; RC=$?
SUMMARY="$(printf '%s\n' "$OUT" | grep -E '^(OK|FAILURES|ERRORS|Tests:|No tests)' | tail -2 | tr '\n' ' ')"
if [ "$RC" -eq 0 ]; then
  say "PASS — $SUMMARY"
else
  say "FAIL — $SUMMARY"
  printf '%s\n' "$OUT" | tail -40
  mail_to "SlyTab receipt reader: the corpus FAILED on $MODEL" \
"The weekly receipt corpus run on kdocker2 failed against the pinned model ($MODEL).

$SUMMARY

This is the money check: real receipts re-parsed through the live model, totals asserted exactly. A failure here means receipt scanning is returning wrong numbers or not returning at all, even though the app may still look fine.

The usual suspects, in order (docs/llm-requirements.md has each one's history):
  - another model resident on the GPU starving or evicting ours (curl localhost:11434/api/ps)
  - an Ollama upgrade (ollama -v; 0.30.10 is the version that works with $MODEL)
  - a re-pulled model tag with a different digest

The test's own diagnosis follows.

$(printf '%s\n' "$OUT" | tail -40)

Nothing was changed automatically."
fi

# 3. candidates: screened, reported, never gating.
if [ -s "$CANDIDATES_FILE" ]; then
  while read -r cand; do
    cand="${cand%%#*}"; cand="$(echo "$cand" | tr -d '[:space:]')"
    [ -n "$cand" ] || continue
    T0=$(date +%s)
    COUT="$(run_corpus "$cand")"; CRC=$?
    say "candidate $cand: $([ $CRC -eq 0 ] && echo PASS || echo FAIL) in $(( $(date +%s) - T0 ))s — $(printf '%s\n' "$COUT" | grep -E '^(OK|FAILURES|ERRORS|Tests:)' | tail -1)"
  done < "$CANDIDATES_FILE"
fi

# Leave the GPU as we found it for the pinned model: candidates were loaded
# with SlyTab's keep_alive -1, and a spare 6-20 GB model resident is exactly
# the neighbour this test exists to catch. Unload anything that is not ours.
curl -s -m 5 "http://127.0.0.1:11434/api/ps" 2>/dev/null | python3 -c '
import json,sys,urllib.request
keep=sys.argv[1]
for m in json.load(sys.stdin).get("models",[]):
    n=m.get("name","")
    if n and n!=keep and n!=keep+":latest":
        req=urllib.request.Request("http://127.0.0.1:11434/api/generate",
            data=json.dumps({"model":n,"keep_alive":0}).encode(),headers={"Content-Type":"application/json"})
        try: urllib.request.urlopen(req,timeout=30); print("unloaded",n)
        except Exception as e: print("could not unload",n,e)
' "$MODEL" 2>/dev/null | while read -r l; do say "$l"; done
exit 0
