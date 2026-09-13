#!/usr/bin/env bash
# Nightly local backup: a plain-format Postgres dump plus a tarball of the PDS volume
# (account repos, blobs, the PDS's own sqlite). Keeps 14 days under /var/backups/freeskool.
# Copies that leave the server must be encrypted first (docs/deployment.md §Backups).
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT=/var/backups/freeskool
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
C="docker compose --env-file $ROOT/infra/production/.env -f $ROOT/infra/production/compose.yml"
mkdir -p "$OUT"
$C exec -T postgres pg_dump -U freeschool -d freeschool --format=plain --no-owner | gzip > "$OUT/postgres-$STAMP.sql.gz"
$C run --rm --no-deps -T -v "$OUT:/backup" --entrypoint sh pds -c "tar czf /backup/pds-$STAMP.tgz -C /pds ."
find "$OUT" -type f -mtime +14 -delete
echo "backup ok $STAMP"
