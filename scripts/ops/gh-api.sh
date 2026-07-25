#!/bin/bash
# GitHub API wrapper using the stored git credential (never printed).
# Usage: gh-api.sh METHOD PATH [json-body-file]
set -e
TOKEN=$(python3 - <<'PY'
import os
path = os.path.expanduser('~/.git-credentials')
with open(path) as f:
    for line in f:
        line = line.strip()
        if 'github.com' in line and '@' in line:
            # https://user:token@github.com
            cred = line.split('//', 1)[1].split('@', 1)[0]
            print(cred.split(':', 1)[1] if ':' in cred else cred)
            break
PY
)
if [ -z "$TOKEN" ]; then echo "no github credential found" >&2; exit 1; fi
METHOD="$1"; APIPATH="$2"; BODYFILE="${3:-}"
ARGS=(-sS -m 60 -X "$METHOD" -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json")
if [ -n "$BODYFILE" ]; then ARGS+=(--data-binary "@$BODYFILE"); fi
curl "${ARGS[@]}" "https://api.github.com$APIPATH"
