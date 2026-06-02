#!/usr/bin/env bash
# tg-hub installer
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/ali934h/tg-hub/main/install.sh)

set -euo pipefail

REPO_URL="https://github.com/ali934h/tg-hub.git"
PROJECT="tg-hub"
INSTALL_DIR="/root/${PROJECT}"
DOWNLOAD_DIR="/root/${PROJECT}-downloads"
NODE_MAJOR=20

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

step()  { echo -e "\n${BOLD}${BLUE}==>${NC} ${BOLD}$*${NC}"; }
info()  { echo -e "${CYAN}  ->${NC} $*"; }
warn()  { echo -e "${YELLOW}  !!${NC} $*"; }
ok()    { echo -e "${GREEN}  ok${NC} $*"; }
err()   { echo -e "${RED}  xx${NC} $*" >&2; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    err "This installer must be run as root."
    exit 1
  fi
}

banner() {
  echo
  echo -e "${BOLD}${CYAN}========================================${NC}"
  echo -e "${BOLD}${CYAN}            tg-hub installer            ${NC}"
  echo -e "${BOLD}${CYAN}========================================${NC}"
  echo -e "${BOLD} Telegram video downloader + Google Drive upload${NC}"
  echo -e "${BOLD} Repo:${NC}        ${REPO_URL}"
  echo -e "${BOLD} Install dir:${NC} ${INSTALL_DIR}"
  echo -e "${BOLD} Downloads:${NC}   ${DOWNLOAD_DIR}"
  echo
}

cleanup_existing() {
  step "Cleaning up any previous installation"

  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete "${PROJECT}" >/dev/null 2>&1 || true
    pm2 save --force >/dev/null 2>&1 || true
    ok "PM2 process removed"
  fi

  if [[ -d "${INSTALL_DIR}" ]]; then
    rm -rf "${INSTALL_DIR}"
    ok "Removed ${INSTALL_DIR}"
  fi

  if [[ -d "${DOWNLOAD_DIR}" ]]; then
    info "Keeping previous downloads dir at ${DOWNLOAD_DIR} (cookies preserved)"
  fi
}

install_deno() {
  if command -v deno >/dev/null 2>&1; then
    ok "deno $(deno --version | head -1) already installed"
    return
  fi
  info "Installing deno (required by yt-dlp for YouTube JS extraction)"
  echo 'n' | DENO_INSTALL=/usr/local DENO_NO_UPDATE_CHECK=1 \
    sh -c "$(curl -fsSL https://deno.land/install.sh)" 2>&1 | grep -v '^$' || true
  ok "deno $(/usr/local/bin/deno --version | head -1)"
}

install_system_deps() {
  step "Installing system dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git ca-certificates ffmpeg python3 python3-pip xz-utils unzip

  if ! command -v node >/dev/null 2>&1 || \
     [[ "$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)" -lt "${NODE_MAJOR}" ]]; then
    info "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
  ok "Node.js $(node -v)"
  ok "npm $(npm -v)"

  if ! command -v yt-dlp >/dev/null 2>&1; then
    info "Installing yt-dlp"
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp
    chmod a+rx /usr/local/bin/yt-dlp
  else
    info "Updating yt-dlp"
    yt-dlp -U >/dev/null 2>&1 || \
      curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o /usr/local/bin/yt-dlp
    chmod a+rx /usr/local/bin/yt-dlp
  fi
  ok "yt-dlp $(yt-dlp --version)"

  install_deno

  if ! command -v pm2 >/dev/null 2>&1; then
    info "Installing PM2 globally"
    npm install -g pm2
  fi
  ok "PM2 $(pm2 -v)"
}

clone_repo() {
  step "Cloning repository"
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  ok "Cloned to ${INSTALL_DIR}"
}

prompt_nonempty() {
  local prompt="$1"
  local default="${2:-}"
  local value=""
  while true; do
    if [[ -n "${default}" ]]; then
      read -r -p "$(echo -e "${prompt} [${default}]: ")" value
      value="${value:-${default}}"
    else
      read -r -p "$(echo -e "${prompt}: ")" value
    fi
    if [[ -z "${value// }" ]]; then
      err "Value cannot be empty. Please try again."
      continue
    fi
    echo "${value}"
    return
  done
}

prompt_optional() {
  local prompt="$1"
  local value=""
  read -r -p "$(echo -e "${prompt} (leave empty to skip): ")" value
  echo "${value}"
}

prompt_numeric() {
  local prompt="$1"
  local value=""
  while true; do
    read -r -p "$(echo -e "${prompt}: ")" value
    if [[ ! "${value}" =~ ^[0-9]+$ ]]; then
      err "Must be a positive integer. Please try again."
      continue
    fi
    echo "${value}"
    return
  done
}

prompt_user_ids() {
  local prompt="$1"
  local value=""
  while true; do
    read -r -p "$(echo -e "${prompt}: ")" value
    value="${value// /}"
    if [[ -z "${value}" ]]; then
      err "ALLOWED_USERS cannot be empty. Add at least your own Telegram user id."
      continue
    fi
    if [[ ! "${value}" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
      err "Format must be comma-separated user ids, e.g. 123456789,987654321"
      continue
    fi
    echo "${value}"
    return
  done
}

prompt_yn() {
  local prompt="$1"
  while true; do
    read -r -p "$(echo -e "${prompt} [y/N]: ")" yn
    case "${yn,,}" in
      y|yes) return 0 ;;
      n|no|"") return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

# ── Variables set by collect_inputs ──────────────────────────────────────────
BOT_TOKEN=""
API_ID=""
API_HASH=""
ALLOWED_USERS=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
DRIVE_FOLDER_ID=""
SETUP_DRIVE=false

collect_inputs() {
  step "Collecting configuration"
  echo -e "${YELLOW}All inputs are shown in plain text so you can verify what you typed.${NC}\n"

  echo -e "${BOLD}Telegram bot token${NC} (from @BotFather)"
  BOT_TOKEN=$(prompt_nonempty "BOT_TOKEN")

  echo -e "\n${BOLD}Telegram API credentials${NC} (from https://my.telegram.org/apps)"
  API_ID=$(prompt_numeric "API_ID")
  API_HASH=$(prompt_nonempty "API_HASH")

  echo -e "\n${BOLD}Authorized Telegram user IDs${NC} (comma-separated, no spaces)"
  echo -e "${CYAN}Tip: send /start to @userinfobot to find your numeric user id.${NC}"
  ALLOWED_USERS=$(prompt_user_ids "ALLOWED_USERS")

  # ── Google Drive (optional) ───────────────────────────────────────────────
  echo
  echo -e "${BOLD}Google Drive upload (optional)${NC}"
  echo -e "${CYAN}If configured, the bot will ask after each download whether to upload to Drive.${NC}"
  if prompt_yn "Set up Google Drive integration now?"; then
    SETUP_DRIVE=true
    echo
    echo -e "${CYAN}You need a Google Cloud project with the Drive API enabled and an OAuth 2.0${NC}"
    echo -e "${CYAN}Desktop client. See README.md § Google Drive Setup for step-by-step instructions.${NC}"
    echo
    GOOGLE_CLIENT_ID=$(prompt_nonempty "GOOGLE_CLIENT_ID")
    GOOGLE_CLIENT_SECRET=$(prompt_nonempty "GOOGLE_CLIENT_SECRET")
    echo -e "\n${BOLD}Drive folder ID${NC} (optional — leave empty to upload to Drive root)"
    DRIVE_FOLDER_ID=$(prompt_optional "DRIVE_FOLDER_ID")
  else
    info "Skipping Drive setup. You can add credentials to .env and run 'node setup-drive.js' later."
  fi
}

confirm_summary() {
  step "Configuration summary"
  cat <<EOF
  Install dir:     ${INSTALL_DIR}
  Downloads dir:   ${DOWNLOAD_DIR}
  BOT_TOKEN:       ${BOT_TOKEN}
  API_ID:          ${API_ID}
  API_HASH:        ${API_HASH}
  ALLOWED_USERS:   ${ALLOWED_USERS}
  Google Drive:    $( [[ "${SETUP_DRIVE}" == true ]] && echo "enabled (token will be fetched next)" || echo "disabled" )

EOF
  while true; do
    read -r -p "$(echo -e "${BOLD}Proceed with installation? [y/N]: ${NC}")" yn
    case "${yn,,}" in
      y|yes) break ;;
      n|no|"") err "Aborted by user."; exit 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

write_env() {
  step "Writing .env"
  cat > "${INSTALL_DIR}/.env" <<EOF
BOT_TOKEN=${BOT_TOKEN}
API_ID=${API_ID}
API_HASH=${API_HASH}
ALLOWED_USERS=${ALLOWED_USERS}
DOWNLOAD_DIR=${DOWNLOAD_DIR}
MAX_UPLOAD_MB=2000
LOG_LEVEL=info

# Google Drive (optional)
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GOOGLE_REFRESH_TOKEN=
DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID}
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  ok ".env written with chmod 600"
}

prepare_dirs() {
  step "Preparing directories"
  mkdir -p "${DOWNLOAD_DIR}"
  mkdir -p "${DOWNLOAD_DIR}/cookies"
  chmod 755 /root
  chmod -R 755 "${DOWNLOAD_DIR}"
  chmod 700 "${DOWNLOAD_DIR}/cookies"
  ok "Created ${DOWNLOAD_DIR}"
}

install_npm_deps() {
  step "Installing Node.js dependencies"
  cd "${INSTALL_DIR}"
  npm install --omit=dev --no-audit --no-fund
  ok "npm install complete"
}

run_drive_setup() {
  if [[ "${SETUP_DRIVE}" != true ]]; then
    return
  fi

  step "Setting up Google Drive OAuth token"
  echo -e "${CYAN}Running setup-drive.js — follow the prompts to authorize Drive access.${NC}"
  echo -e "${CYAN}If this server has no browser, use an SSH tunnel or paste the redirect URL manually.${NC}\n"
  cd "${INSTALL_DIR}"
  node setup-drive.js || {
    warn "Drive OAuth setup failed or was skipped."
    warn "You can re-run it later with: node ${INSTALL_DIR}/setup-drive.js"
  }
}

setup_pm2() {
  step "Setting up PM2"
  cd "${INSTALL_DIR}"

  pm2 install pm2-logrotate >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:max_size 10M >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:retain 7 >/dev/null 2>&1 || true
  pm2 set pm2-logrotate:compress true >/dev/null 2>&1 || true

  pm2 start ecosystem.config.js
  pm2 save

  info "Configuring systemd auto-start"
  env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

  ok "PM2 process registered"
}

success_message() {
  local drive_note=""
  if [[ "${SETUP_DRIVE}" == true ]]; then
    drive_note="\n  - After each download the bot will ask if you want to upload to Google Drive."
  else
    drive_note="\n  - To add Google Drive later: fill in GOOGLE_* in .env then run 'node ${INSTALL_DIR}/setup-drive.js' and restart."
  fi

  echo -e "\n${BOLD}${GREEN}Installation complete!${NC}\n"
  cat <<EOF
${BOLD}Next steps:${NC}
  - Send /start to your bot in Telegram (only ALLOWED_USERS can use it).
  - Send a video URL to receive quality options.${drive_note}

${BOLD}Useful commands:${NC}
  pm2 logs ${PROJECT}               # follow logs
  pm2 restart ${PROJECT}            # restart
  pm2 stop ${PROJECT}               # stop
  bash ${INSTALL_DIR}/update.sh     # pull latest code and restart
  bash ${INSTALL_DIR}/uninstall.sh  # remove everything

EOF
}

main() {
  require_root
  banner
  cleanup_existing
  install_system_deps
  clone_repo
  collect_inputs
  confirm_summary
  write_env
  prepare_dirs
  install_npm_deps
  run_drive_setup
  setup_pm2
  success_message
}

main "$@"
