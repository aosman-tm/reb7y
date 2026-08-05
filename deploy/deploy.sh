#!/usr/bin/env bash
# Runs ON THE VPS, from /srv/reb7y/app, after the new code has been pulled.
# Invoked by .github/workflows/deploy.yml on every push to main.
set -euo pipefail

echo "==> Installing dependencies"
npm ci --no-audit --fund=false

echo "==> Generating Prisma client"
npx prisma generate

echo "==> Applying database migrations"
npx prisma migrate deploy

echo "==> Building app"
npm run build

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
    sudo systemctl status reb7y --no-pager -l || true
    exit 1
  fi
  sleep 1
done

sudo systemctl is-active --quiet reb7y && echo "==> Deploy OK"
