#!/usr/bin/env bash
# Backup the PostgreSQL database to ./backups/salon-YYYYmmdd-HHMMSS.sql.gz   (needs pg_dump; uses DATABASE_URL)
#   ./scripts/backup.sh                 (reads DATABASE_URL from env or .env)
#   docker compose exec -T db pg_dump -U salon salon | gzip > backups/salon-$(date +%F).sql.gz   (docker setup)
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
mkdir -p backups
OUT="backups/salon-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --no-privileges --format=plain "$DATABASE_URL" | gzip -9 > "$OUT"
chmod 600 "$OUT"
echo "Backup written: $OUT ($(du -h "$OUT" | cut -f1))"
# keep the newest ${KEEP:-14} backups
KEEP="${KEEP:-14}"; ls -1t backups/salon-*.sql.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
