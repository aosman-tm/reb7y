#!/usr/bin/env bash
# Nightly backup of the reb7y database.
#
# Installed to /usr/local/bin/reb7y-backup and run by reb7y-backup.timer.
#
# The data here exists nowhere else: Shopify knows your orders, but your
# material costs, recipes, delivery costs, expenses and the whole price history
# live only in this file. Losing it cannot be undone.
set -euo pipefail

DB=/var/lib/reb7y/prod.sqlite
DIR=/var/backups/reb7y
KEEP_DAILY=14
KEEP_WEEKLY=56

mkdir -p "$DIR/daily" "$DIR/weekly"

stamp=$(date +%F)
work="$DIR/daily/prod-$stamp.sqlite"

# `.backup` takes a consistent snapshot of a live database. Copying the file
# with cp would risk capturing a half-written transaction.
sqlite3 "$DB" ".backup '$work'"

# A backup that cannot be read is worse than none, because it looks like safety.
if ! sqlite3 "$work" "PRAGMA integrity_check;" | grep -qx "ok"; then
  echo "ERROR: integrity check failed for $work" >&2
  rm -f "$work"
  exit 1
fi

# Prove the tables that matter are actually in there.
rows=$(sqlite3 "$work" "SELECT COUNT(*) FROM Material;" 2>/dev/null || echo "ERR")
if [ "$rows" = "ERR" ]; then
  echo "ERROR: backup is missing expected tables" >&2
  rm -f "$work"
  exit 1
fi

gzip -f "$work"
archive="$work.gz"

# Keep a weekly copy on Sundays so a slow-burning problem is still recoverable
# after two weeks of dailies have rotated away.
if [ "$(date +%u)" = "7" ]; then
  cp "$archive" "$DIR/weekly/prod-$stamp.sqlite.gz"
fi

find "$DIR/daily" -name 'prod-*.sqlite.gz' -mtime "+$KEEP_DAILY" -delete
find "$DIR/weekly" -name 'prod-*.sqlite.gz' -mtime "+$KEEP_WEEKLY" -delete

echo "Backup OK: $archive ($(du -h "$archive" | cut -f1)), Material rows: $rows"
