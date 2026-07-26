#!/bin/bash
# Run eas-cli with Expo + Apple credentials from the repo env file and
# secrets/. Usage: eas.sh <eas args...>. Secrets never printed.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
export EXPO_ASC_API_KEY_PATH="$REPO/secrets/AuthKey_QUC9SR2G3F.p8"
export EXPO_ASC_KEY_ID="QUC9SR2G3F"
export EXPO_ASC_ISSUER_ID="$APPLE_ASC_ISSUER_ID"
export EXPO_APPLE_TEAM_ID="V97FBD9SXN"
cd "$REPO/apps/mobile"
exec npx eas-cli "$@"
