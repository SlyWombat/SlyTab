#!/bin/bash
# Nightly dump of slytab_prod on kdocker2, 30-day retention. Installed as
# /data/stacks/slytab/backup.sh; run daily at 03:20 UTC.
#
# It makes exactly ONE database call, the dump, and nothing else touches a
# container (#129). That call is $SLYTAB_DBDUMP_CMD (word-split) if set: a
# command that takes no arguments and writes the plain SQL dump to stdout —
# house IT's root helper, so the account running this needs neither docker nor
# the database password. Unset, it is today's dump, done here with
# DB_ROOT_PASS from the cron env file.
#
#   SLYTAB_DBDUMP_CMD     the dump command          (unset: docker exec, below)
#   SLYTAB_BACKUP_DIR     where dumps go            (/data/stacks/slytab/backups)
#   SLYTAB_ENV_FILE       cron env, unset mode only (/data/stacks/slytab/cron.env)
#   SLYTAB_BACKUP_DAYS    retention in days         (30)
#
# Output goes to stdout (the journal, or cron's mail). A failed or empty dump
# exits non-zero and leaves no file behind, so a bad night is loud and never
# masquerades as a backup.
set -uo pipefail
BACKUPS="${SLYTAB_BACKUP_DIR:-/data/stacks/slytab/backups}"
ENVFILE="${SLYTAB_ENV_FILE:-/data/stacks/slytab/cron.env}"
DAYS="${SLYTAB_BACKUP_DAYS:-30}"
say() { echo "[$(TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T')] slytab-backup: $*"; }

dump() {
  if [ -n "${SLYTAB_DBDUMP_CMD:-}" ]; then
    local -a cmd; read -r -a cmd <<<"$SLYTAB_DBDUMP_CMD"
    "${cmd[@]}"
  else
    # shellcheck disable=SC1090
    set -a; . "$ENVFILE"; set +a
    # The password reaches mysqldump through the environment, never argv.
    MYSQL_PWD="${DB_ROOT_PASS:?DB_ROOT_PASS not set in $ENVFILE}" \
      docker exec -e MYSQL_PWD slytab-mysql mysqldump -uroot --single-transaction slytab_prod
  fi
}

mkdir -p "$BACKUPS" || { say "cannot create $BACKUPS"; exit 1; }
OUT="$BACKUPS/slytab_prod-$(date -u +%Y%m%d-%H%M%S).sql.gz"
TMP="$OUT.partial"
trap 'rm -f "$TMP"' EXIT

if ! dump | gzip -c > "$TMP"; then
  say "dump FAILED — no backup written tonight"
  exit 1
fi
# A dump that ran but said nothing is still a failure: mysqldump always ends
# with a "Dump completed" line.
if ! gzip -t "$TMP" 2>/dev/null || ! zcat "$TMP" | tail -n 1 | grep -q 'Dump completed'; then
  say "dump is empty or truncated — no backup written tonight"
  exit 1
fi
mv "$TMP" "$OUT"
trap - EXIT
say "wrote $OUT ($(du -h "$OUT" | cut -f1))"

find "$BACKUPS" -maxdepth 1 -type f -name '*.sql.gz' -mtime +"$DAYS" -print -delete \
  | while read -r f; do say "pruned $f"; done
exit 0
