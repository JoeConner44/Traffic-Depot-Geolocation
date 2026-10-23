#!/usr/bin/env bash
# One-time (and re-runnable) server setup for a Debian 12 VM, e.g. a Google Cloud e2-micro.
# Run from the cloned repo at /opt/traffic-depot:   sudo bash deploy/setup.sh <hostname>
# See docs/DEPLOY-GCP.md for the full walkthrough.
set -euo pipefail

HOST_NAME="${1:-}"
APP_DIR=/opt/traffic-depot
DATA_DIR=/var/lib/traffic-depot
APP_USER=tdmap                      # service account that runs the app (cannot log in)
APP_OWNER="${SUDO_USER:-root}"       # you: owns the repo, so 'git pull' works without sudo

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo."; exit 1; }
[ -n "$HOST_NAME" ] || { echo "Usage: sudo bash deploy/setup.sh <hostname>   (e.g. map.example.com or 34-23-45-67.sslip.io)"; exit 1; }
[ "$(pwd -P)" = "$APP_DIR" ] || { echo "Run this from $APP_DIR (clone the repo there first)."; exit 1; }

echo "==> Swap (the free VM has 1 GB of RAM)"
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Packages: Node 22, build tools, Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> User and directories"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$DATA_DIR"
chown -R "$APP_USER":"$APP_USER" "$DATA_DIR"
chmod 700 "$DATA_DIR"
touch /var/log/td-sync.log && chown "$APP_USER":"$APP_USER" /var/log/td-sync.log

if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: $APP_DIR/.env does not exist. Create it first (see docs/DEPLOY-GCP.md, step 5), then re-run this script."
  exit 1
fi
chown "$APP_OWNER":"$APP_USER" "$APP_DIR/.env" && chmod 640 "$APP_DIR/.env"   # you edit it, the service can read it

echo "==> Install app dependencies"
sudo -u "$APP_OWNER" bash -c "cd $APP_DIR && npm ci --omit=dev"

echo "==> systemd service"
install -m 644 deploy/td-map.service /etc/systemd/system/td-map.service
systemctl daemon-reload
systemctl enable --now td-map
systemctl restart td-map

echo "==> Caddy (HTTPS for $HOST_NAME)"
sed "s/__HOSTNAME__/$HOST_NAME/g" deploy/Caddyfile.template > /etc/caddy/Caddyfile
systemctl enable caddy
systemctl restart caddy

echo "==> Nightly sync (cron) and log rotation"
install -m 644 deploy/td-sync.cron /etc/cron.d/td-sync
install -m 644 deploy/td-sync.logrotate /etc/logrotate.d/td-sync

echo
echo "Done. Check:   systemctl status td-map --no-pager     and open   https://$HOST_NAME"
