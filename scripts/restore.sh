#!/usr/bin/env bash
# Restore a backup into the database in DATABASE_URL.  DESTRUCTIVE: existing tables are dropped first.
#   ./scripts/restore.sh backups/salon-20260101-020000.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?Usage: restore.sh <backup.sql.gz>}"
if [ -z "${DATABASE_URL:-}" ] && [ -f .env ]; then set -a; . ./.env; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set}"
read -r -p "This will ERASE the current database content and restore $FILE. Type RESTORE to continue: " ans
[ "$ans" = "RESTORE" ] || { echo "Cancelled."; exit 1; }
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c "$FILE" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q
echo "Restore finished. Start the app again (npm start or docker compose up -d)."
