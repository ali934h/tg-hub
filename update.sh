#!/usr/bin/env bash
# Update tg-hub: pull latest code and restart.

set -euo pipefail

INSTALL_DIR="/root/tg-hub"
PROJECT="tg-hub"

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root." >&2
  exit 1
fi

cd "${INSTALL_DIR}"
git pull --ff-only
npm install --omit=dev --no-audit --no-fund
pm2 restart "${PROJECT}"
pm2 save
echo "Updated."
