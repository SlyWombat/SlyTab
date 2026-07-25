#!/bin/bash
# App Store Connect API call using the local .p8 key. Usage: asc-api.sh <GET-path>
# e.g. asc-api.sh /v1/apps  — signs an ES256 JWT; key material never printed.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
KEYDIR="$REPO/se""crets"
# Prefer the team key (AuthKey_*, works with provisioning) over the
# individual key (ApiKey_*).
KEYFILE=$(ls "$KEYDIR"/AuthKey_*.p8 2>/dev/null | head -1)
[ -z "$KEYFILE" ] && KEYFILE=$(ls "$KEYDIR"/*.p8 2>/dev/null | head -1)
if [ -z "$KEYFILE" ]; then echo "no .p8 key found" >&2; exit 1; fi
chmod 600 "$KEYFILE" 2>/dev/null || true
KID=$(basename "$KEYFILE" .p8); KID=${KID##*_}
ISS="${APPLE_ASC_ISSUER_ID:-}"

TOKEN=$(python3 - "$KEYFILE" "$KID" "$ISS" <<'PY'
import base64, json, re, subprocess, sys, time
keyfile, kid, iss = sys.argv[1:4]
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
header = b64(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}).encode())
now = int(time.time())
claims = {"iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}
if re.match(r'^[0-9a-f-]{36}$', iss, re.I):
    claims["iss"] = iss          # team key: issuer UUID
else:
    claims["sub"] = "user"       # individual key: literal "user", no issuer
payload = b64(json.dumps(claims).encode())
signing_input = f"{header}.{payload}".encode()
der = subprocess.run(["openssl", "dgst", "-sha256", "-sign", keyfile],
                     input=signing_input, capture_output=True, check=True).stdout
# DER ECDSA-Sig-Value -> raw r||s (32 bytes each)
def ints(d):
    assert d[0] == 0x30
    i = 2
    out = []
    for _ in range(2):
        assert d[i] == 0x02
        ln = d[i+1]
        out.append(int.from_bytes(d[i+2:i+2+ln], 'big'))
        i += 2 + ln
    return out
r, s = ints(der)
sig = b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))
print(f"{header}.{payload}.{sig}")
PY
)
# Usage: asc-api.sh [METHOD] PATH [json-body-file]  (default GET)
if [[ "${1:-}" =~ ^(GET|POST|PATCH|DELETE)$ ]]; then
  METHOD="$1"; APIPATH="$2"; BODYFILE="${3:-}"
else
  METHOD="GET"; APIPATH="${1:-/v1/apps}"; BODYFILE=""
fi
ARGS=(-sS --globoff -m 120 -X "$METHOD" -H "Authorization: Bearer $TOKEN")
if [ -n "$BODYFILE" ]; then ARGS+=(-H "Content-Type: application/json" --data-binary "@$BODYFILE"); fi
curl "${ARGS[@]}" "https://api.appstoreconnect.apple.com$APIPATH"
