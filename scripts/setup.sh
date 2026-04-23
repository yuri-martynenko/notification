#!/bin/bash
# Setup script run on the VibeCode server after first deploy.
# Installs Node.js 20, PM2, deps, and starts the app under PM2.

set -e

echo "=== Notification app server setup ==="

# Install Node 20 if missing
if ! command -v node &> /dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs build-essential python3
fi

# Install PM2 globally
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi

cd /opt/notification

# Install dependencies
npm install --production

# Generate .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" .env
  PUBLIC_URL=${APP_PUBLIC_URL:-https://app-cdc72b7c.vibecode.bitrix24.tech}
  sed -i "s|^APP_PUBLIC_URL=.*|APP_PUBLIC_URL=$PUBLIC_URL|" .env
  echo ".env generated with random ENCRYPTION_KEY"
fi

# Start (or restart) under PM2
pm2 start src/index.js --name notification --update-env || pm2 restart notification --update-env
pm2 save
pm2 startup systemd -u $USER --hp $HOME | tail -1 | sudo bash || true

echo "=== Setup complete ==="
pm2 status
