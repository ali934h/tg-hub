#!/usr/bin/env bash
# Uninstall tg-hub: remove PM2 process, install dir, and (optionally) downloads.

set -euo pipefail

INSTALL_DIR="/root/tg-hub"
DOWNLOAD_DIR="/root/tg-hub-downloads"
PROJECT="tg-hub"

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root." >&2
  exit 1
fi

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete "${PROJECT}" >/dev/null 2>&1 || true
  pm2 save --force >/dev/null 2>&1 || true
fi

rm -rf "${INSTALL_DIR}"

read -r -p "Also remove downloads dir ${DOWNLOAD_DIR}? [y/N]: " yn
case "${yn,,}" in
  y|yes) rm -rf "${DOWNLOAD_DIR}"; echo "Removed ${DOWNLOAD_DIR}" ;;
  *) echo "Kept ${DOWNLOAD_DIR}" ;;
esac

echo "Uninstalled."
