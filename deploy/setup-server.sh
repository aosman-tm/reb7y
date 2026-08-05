#!/usr/bin/env bash
# One-time VPS provisioning for reb7y. Run as root on a fresh Ubuntu server.
#   bash setup-server.sh
set -euo pipefail

APP_DOMAIN="162-35-184-237.sslip.io"
REPO_URL="https://github.com/aosman-tm/reb7y.git"
APP_HOME="/srv/reb7y"
APP_DIR="$APP_HOME/app"
DATA_DIR="/var/lib/reb7y"

echo "############ 1. Base packages ############"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw sudo \
  debian-keyring debian-archive-keyring apt-transport-https

echo "############ 2. Swap (protects small VPS from OOM during builds) ############"
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "############ 3. Node.js 22 LTS ############"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

echo "############ 4. Deploy user ############"
if ! id deploy >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$APP_HOME" --shell /bin/bash deploy
fi
mkdir -p "$APP_HOME/.ssh" "$DATA_DIR"
chmod 700 "$APP_HOME/.ssh"
# Reuse the key already authorised for root so CI can log in as deploy.
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys "$APP_HOME/.ssh/authorized_keys"
fi
chmod 600 "$APP_HOME/.ssh/authorized_keys"
chown -R deploy:deploy "$APP_HOME" "$DATA_DIR"

# Allow the deploy user to restart ONLY this one service.
cat > /etc/sudoers.d/reb7y <<'EOF'
deploy ALL=(root) NOPASSWD: /bin/systemctl restart reb7y, /bin/systemctl status reb7y, /bin/systemctl is-active reb7y
EOF
chmod 440 /etc/sudoers.d/reb7y
visudo -c -f /etc/sudoers.d/reb7y

echo "############ 5. Clone repository ############"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo -u deploy git clone "$REPO_URL" "$APP_DIR"
fi
sudo -u deploy git -C "$APP_DIR" fetch --prune origin
sudo -u deploy git -C "$APP_DIR" reset --hard origin/main

echo "############ 6. Environment file ############"
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
fi
chown deploy:deploy "$APP_HOME/.env"
chmod 600 "$APP_HOME/.env"

echo "############ 7. systemd service ############"
install -m 644 "$APP_DIR/deploy/reb7y.service" /etc/systemd/system/reb7y.service
systemctl daemon-reload
systemctl enable reb7y

echo "############ 8. Caddy (automatic HTTPS) ############"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
install -m 644 "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
systemctl enable caddy

echo "############ 9. Firewall ############"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "=========================================================="
echo "Base setup complete."
echo "Next: put the real SHOPIFY_API_SECRET into $APP_HOME/.env"
echo "then run the first build."
echo "=========================================================="
