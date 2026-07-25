#!/bin/bash
# One-time setup of the feedback worker on kdocker2. Run from the dev PC
# (which holds .env, secrets/, and the git credential). Idempotent.
# Secrets are transferred file→file over SSH, never printed.
set -e
HOST="kdocker2"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="slytab-worker/Splitwise"

echo "== 1/6 clone or