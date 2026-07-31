#!/bin/bash
# Publish the app-association files that make invite links open the app.
#
# WHY THIS IS NOT PART OF `npm run deploy`: Apple and Google both fetch these
# from the DOMAIN ROOT —
#   https://electricrv.ca/.well-known/apple-app-site-association
#   https://electricrv.ca/.well-known/assetlinks.json
# — and the web deploy writes to public_html/slytab. The copy that ships in
# apps/web/public/.well-known/ therefore lands at /slytab/.well-known/, which
# nothing reads. This script puts them where they are actually looked for.
#
# Run it after any change to the association files, and after any rebuild of
# the hosting account.
#
# Three things that silently break universal links, all checked at the end:
#   - a redirect (Apple follows none)
#   - the wrong content type (the AASA has no extension, so the server cannot
#     guess; an .htaccess ForceType fixes it)
#   - a stale Android fingerprint after the signing key changes
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
ENVFILE="$REPO/.env"
set -a; source "$ENVFILE"; set +a
API="https://$CPANEL_HOST:${CPANEL_PORT:-2083}"
AUTH="Authorization: cpanel $CPANEL_USER:$CPANEL_TOKEN"
PUB=$(dirname "$WEB_ROOT")
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "== Android signing fingerprint =="
# Read from the PUBLISHED APK rather than the keystore: it is the artefact
# users install, so it cannot disagree with reality, and no password is
# involved. The APK is v2-only signed, so this parses the APK Signing Block
# rather than looking for a v1 META-INF certificate.
curl -sSL -m 600 -o "$STAGE/app.apk" "https://electricrv.ca/slytab/downloads/slytab-latest.apk"
SHA256=$(python3 - "$STAGE/app.apk" <<'PY'
import hashlib, struct, sys
raw = open(sys.argv[1], 'rb').read()
magic = raw.rfind(b'APK Sig Block 42')
if magic < 0:
    print(''); raise SystemExit
size_after = struct.unpack('<Q', raw[magic - 8:magic])[0]
off = magic + 16 - size_after - 8 + 8
end = magic - 8
out = b''
while off < end:
    pair_len = struct.unpack('<Q', raw[off:off + 8])[0]
    pid = struct.unpack('<I', raw[off + 8:off + 12])[0]
    if pid == 0x7109871a:                      # APK Signature Scheme v2
        val = raw[off + 12:off + 8 + pair_len]
        u32 = lambda b, o: struct.unpack('<I', b[o:o + 4])[0]
        p = 8                                   # signers seq + first signer len
        signed_len = u32(val, p); p += 4
        sd = val[p:p + signed_len]
        q = 0
        q += 4 + u32(sd, q)                     # digests
        q += 4                                  # certificates length
        cert_len = u32(sd, q); q += 4
        out = sd[q:q + cert_len]
        break
    off += 8 + pair_len
print(hashlib.sha256(out).hexdigest().upper() if out else '')
PY
)
[ -n "$SHA256" ] && echo "   read from the APK (starts ${SHA256:0:12}…)" \
                 || echo "   COULD NOT READ — Android links will not verify"

echo "== stage the files =="
cp "$REPO/apps/web/public/.well-known/apple-app-site-association" "$STAGE/"
python3 - "$STAGE/assetlinks.json" "${SHA256:-}" <<'PY'
import json, sys
out, sha = sys.argv[1], sys.argv[2]
fp = ':'.join(sha[i:i + 2] for i in range(0, len(sha), 2)) if sha else ''
json.dump([{
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {"namespace": "android_app",
               "package_name": "ca.electricrv.slytab",
               "sha256_cert_fingerprints": [fp] if fp else []},
}], open(out, 'w'), indent=2)
PY
cat > "$STAGE/.htaccess" <<'HT'
# The AASA has no file extension, so the server serves it with no type at all
# and iOS refuses it without a word. Force it.
<Files "apple-app-site-association">
  ForceType application/json
</Files>
HT

echo "== upload to the domain root =="
curl -sS -m 60 "$API/execute/Fileman/mkdir" -H "$AUTH" \
  --data-urlencode "path=$PUB" --data-urlencode "name=.well-known" >/dev/null 2>&1 || true
curl -sS -m 180 "$API/execute/Fileman/upload_files" -H "$AUTH" \
  -F "dir=$PUB/.well-known" -F "overwrite=1" \
  -F "file-1=@$STAGE/apple-app-site-association" \
  -F "file-2=@$STAGE/assetlinks.json" \
  -F "file-3=@$STAGE/.htaccess" >/dev/null

echo "== verify what the server returns =="
sleep 2
FAIL=0
for f in apple-app-site-association assetlinks.json; do
  URL="https://electricrv.ca/.well-known/$f"
  CODE=$(curl -sS -m 25 -o "$STAGE/got-$f" -w '%{http_code}' -L "$URL")
  REDIR=$(curl -sS -m 25 -o /dev/null -w '%{num_redirects}' "$URL")
  CT=$(curl -sS -m 25 -o /dev/null -w '%{content_type}' -L "$URL")
  SAME=$(cmp -s "$STAGE/$f" "$STAGE/got-$f" && echo byte-exact || echo DIFFERS)
  printf '   %-30s http=%s redirects=%s type=%s %s\n' "$f" "$CODE" "$REDIR" "$CT" "$SAME"
  [ "$CODE" = "200" ] && [ "$REDIR" = "0" ] && [ "$SAME" = "byte-exact" ] \
    && [ "${CT%%;*}" = "application/json" ] || FAIL=1
done
[ "$FAIL" = "0" ] && echo "   all good" || { echo "   SOMETHING IS WRONG — links will not work" >&2; exit 1; }
