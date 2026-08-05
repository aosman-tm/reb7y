#!/usr/bin/env bash
# Deployment entrypoint.
#
# Installed to /srv/reb7y/run-deploy.sh - deliberately OUTSIDE the git checkout,
# because this script resets that checkout and bash reads a script incrementally
# while running it. A copy inside the repo could be rewritten mid-execution.
#
#   run-deploy.sh               deploy origin/main now
#   run-deploy.sh --if-changed  deploy only if origin/main moved (used by timer)
set -euo pipefail

APP_DIR=/srv/reb7y/app
LOCK=/srv/reb7y/.deploy.lock

# Serialise deploys: the 60s timer and a CI-triggered run must never overlap.
exec 9>"$LOCK"
if ! flock -w 900 9; then
  echo "ERROR: another deploy held the lock for 15 minutes; giving up" >&2
  exit 1
fi

cd "$APP_DIR"
git fetch --quiet --prune origin

local_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)

if [ "${1:-}" = "--if-changed" ] && [ "$local_sha" = "$remote_sha" ]; then
  exit 0
fi

echo "=== Deploying ${remote_sha:0:7} (was ${local_sha:0:7}) at $(date -u '+%F %T') UTC ==="
git reset --hard origin/main
git clean -fd
exec bash deploy/deploy.sh
