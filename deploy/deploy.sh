#!/usr/bin/env bash
# Runs ON THE VPS, from /srv/reb7y/app, after the new code has been pulled.
# Invoked by .github/workflows/deploy.yml on every push to main.
set -euo pipefail

echo "==> Installing dependencies"
# --include=dev is explicit: the build needs vite/typescript, and they would be
# skipped if NODE_ENV=production leaked into this step.
npm ci --include=dev --no-audit --fund=false

# Load the production environment (DATABASE_URL etc.) only AFTER npm ci, so the
# NODE_ENV=production it contains cannot strip the dev dependencies above.
ENV_FILE=/srv/reb7y/.env
if [ -f "$ENV_FILE" ]; then
  echo "==> Loading $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "ERROR: $ENV_FILE is missing" >&2
  exit 1
fi

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Building app"
npm run build

echo "==> Syncing deploy entrypoint"
# Atomic rename: a currently-running copy keeps its old inode, so refreshing
# the entrypoint cannot corrupt the script that is executing right now.
install -m 755 deploy/run-deploy.sh /srv/reb7y/.run-deploy.sh.new
mv -f /srv/reb7y/.run-deploy.sh.new /srv/reb7y/run-deploy.sh

echo "==> Restarting service"
sudo systemctl restart reb7y

echo "==> Waiting for app to come up"
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" 2>/dev/null \
     || curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT:-3000}/" 2>/dev/null | grep -qE '^[0-9]'; then
    echo "App is responding."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "ERROR: app did not respond within 30s" >&2
    # Reading service state needs no privileges - only `restart` does.
    systemctl status reb7y --no-pager -l || true
    journalctl -u reb7y --no-pager -n 40 || true
    exit 1
  fi
  sleep 1
done

systemctl is-active --quiet reb7y && echo "==> Deploy OK"
