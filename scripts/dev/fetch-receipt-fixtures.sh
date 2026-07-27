#!/bin/bash
# Populate the receipt test corpus from production.
#
#   bash scripts/dev/fetch-receipt-fixtures.sh
#
# Every receipt users have uploaded becomes a fixture for
# api/tests/ReceiptCorpusTest.php, which re-parses them against the local
# vision model and checks the totals against api/tests/fixtures/receipts/
# expected.json.
#
# The IMAGES ARE NOT COMMITTED: they are photographs of real receipts and
# carry card tails and merchant tax ids. expected.json (the human-verified
# numbers) is committed, so the corpus is reproducible without publishing
# anyone's paperwork. Run this to rebuild it.
set -e
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$REPO/api/tests/fixtures/receipts"
mkdir -p "$DEST"
set -a; source "$REPO/.env"; set +a

OWNER="01KY89MG6AVQXRQ89S6SJSX8KC"   # a session is minted for the owner and revoked after
BASE="https://electricrv.ca/slytab/api/v1"

TOKEN=$(openssl rand -hex 32)
HASH=$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hmac "$PROD_SESSION_PEPPER" -r | cut -d' ' -f1)
SID=$(python3 -c "
import random, time
A='0123456789ABCDEFGHJKMNPQRSTVWXYZ'
t=int(time.time()*1000)
print(''.join(A[(t>>(5*i))&31] for i in range(9,-1,-1))+''.join(random.choice(A) for _ in range(16)))")

sql() { docker run --rm -i -e MYSQL_PWD="$PROD_DB_PASS" -v "$REPO/scripts/prod":/ca mysql:8.4 \
  mysql --ssl-ca=/ca/mysql-ca.pem --ssl-mode=VERIFY_CA \
  -h 147.5.121.145 -P 3307 -u slytab_prod slytab_prod -N -B; }
cleanup() { printf "%s" "UPDATE sessions SET revoked_at=UTC_TIMESTAMP() WHERE id='$SID';" | sql >/dev/null 2>&1 || true; }
trap cleanup EXIT

printf "%s" "INSERT INTO sessions (id,user_id,token_hash,device_label,created_at,expires_at,last_seen_at)
 VALUES ('$SID','$OWNER','$HASH','receipt-fixtures',UTC_TIMESTAMP(),
         DATE_ADD(UTC_TIMESTAMP(), INTERVAL 20 MINUTE),UTC_TIMESTAMP());" | sql

IDS=$(printf "%s" "SELECT id FROM receipts ORDER BY created_at DESC;" | sql)
for ID in $IDS; do
  OUT="$DEST/$ID.jpg"
  if [ -s "$OUT" ]; then echo "  have  $ID"; continue; fi
  curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/receipts/$ID/image" -o "$OUT"
  if file "$OUT" | grep -qi 'image data'; then echo "  saved $ID"; else echo "  FAILED $ID"; rm -f "$OUT"; fi
done
echo "corpus: $(ls -1 "$DEST"/*.jpg 2>/dev/null | wc -l) images in $DEST"
