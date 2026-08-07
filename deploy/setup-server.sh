#!/usr/bin/env bash
# One-time VPS provisioning for reb7y.
# Target: AlmaLinux 9 (InterServer VPS, shipped with an unused DirectAdmin stack).
# Run as root:  bash setup-server.sh
set -euo pipefail

APP_DOMAIN="162-35-184-237.sslip.io"
REPO_URL="https://github.com/aosman-tm/reb7y.git"
APP_HOME="/srv/reb7y"
APP_DIR="$APP_HOME/app"
DATA_DIR="/var/lib/reb7y"

echo "############ 1. Free ports 80/443 and RAM from the unused DirectAdmin stack ############"
# Reversible: `systemctl enable --now <name>` brings any of these back.
DA_SERVICES="directadmin httpd exim dovecot named mysqld mariadb pure-ftpd pure-certd spamassassin php-fpm74 php-fpm83"
for svc in $DA_SERVICES; do
  if systemctl list-unit-files --no-legend "${svc}.service" 2>/dev/null | grep -q .; then
    systemctl disable --now "$svc" 2>/dev/null && echo "  disabled $svc" || echo "  skipped $svc"
  fi
done
# Stop DirectAdmin's cron from resurrecting the services it monitors.
for f in /etc/cron.d/directadmin_cron /etc/cron.d/directadmin; do
  [ -f "$f" ] && mv "$f" "$f.disabled" && echo "  disabled cron $f"
done
echo "  NOTE: csf/lfd firewall left running on purpose."

echo "############ 2. Extra swap (protects the build on a 1 CPU / 1.7 GB box) ############"
if ! swapon --show=NAME --noheadings | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  added 2G swapfile"
fi
free -h

echo "############ 3. Base packages ############"
dnf install -y -q git curl sudo tar 'dnf-command(copr)'

echo "############ 4. Node.js 22 LTS ############"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
fi
echo "  node $(node -v) / npm $(npm -v)"

echo "############ 5. Deploy user ############"
if ! id deploy >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash deploy
fi
mkdir -p "$APP_HOME/.ssh" "$DATA_DIR"
chmod 700 "$APP_HOME/.ssh"
# Reuse the key already authorised for root so GitHub Actions can log in as deploy.
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "$APP_HOME/.ssh/authorized_keys"
  chmod 600 "$APP_HOME/.ssh/authorized_keys"
fi
chown -R deploy:deploy "$APP_HOME" "$DATA_DIR"

# The deploy user may restart ONLY this one service - nothing else.
# Reading service state (status/is-active/journalctl) needs no privileges,
# so restart is the single command that has to be granted.
cat > /etc/sudoers.d/reb7y <<'EOF'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart reb7y
EOF
chmod 440 /etc/sudoers.d/reb7y
visudo -cf /etc/sudoers.d/reb7y

echo "############ 6. Clone repository ############"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u deploy git clone --quiet "$REPO_URL" "$APP_DIR"
fi
sudo -u deploy git -C "$APP_DIR" fetch --quiet --prune origin
sudo -u deploy git -C "$APP_DIR" reset --quiet --hard origin/main

echo "############ 7. Environment file ############"
if [ ! -f "$APP_HOME/.env" ]; then
  cat > "$APP_HOME/.env" <<EOF
NODE_ENV=production
PORT=3000
SHOPIFY_APP_URL=https://$APP_DOMAIN
SHOPIFY_API_KEY=db9c247c216de6d8e9128fef88c9766f
SHOPIFY_API_SECRET=REPLACE_ME
SCOPES=read_orders,read_all_orders,read_products,read_locations,read_shipping
DATABASE_URL=file:$DATA_DIR/prod.sqlite
EOF
  echo "  created $APP_HOME/.env (SHOPIFY_API_SECRET still needs the real value)"
fi
chown deploy:deploy "$APP_HOME/.env"
chmod 600 "$APP_HOME/.env"

echo "############ 8. systemd units ############"
install -m 644 "$APP_DIR/deploy/reb7y.service" /etc/systemd/system/reb7y.service
# Auto-deploy: polls GitHub every minute. The repo is public, so this needs no
# credentials on the server and no secret in GitHub.
install -m 755 -o deploy -g deploy "$APP_DIR/deploy/run-deploy.sh" "$APP_HOME/run-deploy.sh"
install -m 644 "$APP_DIR/deploy/reb7y-autodeploy.service" /etc/systemd/system/reb7y-autodeploy.service
install -m 644 "$APP_DIR/deploy/reb7y-autodeploy.timer" /etc/systemd/system/reb7y-autodeploy.timer
install -m 755 "$APP_DIR/deploy/backup.sh" /usr/local/bin/reb7y-backup
install -m 644 "$APP_DIR/deploy/reb7y-backup.service" /etc/systemd/system/reb7y-backup.service
install -m 644 "$APP_DIR/deploy/reb7y-backup.timer" /etc/systemd/system/reb7y-backup.timer
systemctl daemon-reload
systemctl enable --quiet reb7y
systemctl enable --quiet --now reb7y-autodeploy.timer
systemctl enable --quiet --now reb7y-backup.timer

echo "############ 9. Caddy (automatic HTTPS) ############"
if ! command -v caddy >/dev/null 2>&1; then
  dnf copr enable -y @caddy/caddy
  dnf install -y caddy
fi
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable --quiet caddy

echo
echo "=========================================================="
echo "Server provisioning complete."
echo "Ports 80/443 are now free for Caddy."
echo "Next: set the real SHOPIFY_API_SECRET in $APP_HOME/.env,"
echo "      then run the first build."
echo "=========================================================="
