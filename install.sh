#!/usr/bin/env bash
# tg-hub installer
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/ali934h/tg-hub/main/install.sh)

set -euo pipefail

REPO_URL="https://github.com/ali934h/tg-hub.git"
PROJECT="tg-hub"
INSTALL_DIR="/root/${PROJECT}"
DOWNLOAD_DIR="/root/${PROJECT}-downloads"
DEFAULT_SERVE_DIR="/var/lib/${PROJECT}/files"
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
  echo -e "${BOLD} Telegram video downloader${NC}"
  echo -e "${BOLD} + Google Drive upload + Direct Link via custom domain${NC}"
  echo -e "${BOLD} Repo:${NC}        ${REPO_URL}"
  echo
}

cleanup_existing() {
  step "Cleaning up any previous installation"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 delete "${PROJECT}" >/dev/null 2>&1 || true
    pm2 save --force >/dev/null 2>&1 || true
    ok "PM2 process removed"
  fi
  if [[ -f /etc/nginx/conf.d/${PROJECT}.conf ]]; then
    local bak="/etc/nginx/conf.d/${PROJECT}.conf.bak.$(date +%Y%m%d_%H%M%S)"
    mv "/etc/nginx/conf.d/${PROJECT}.conf" "${bak}"
    warn "Backed up old nginx conf to ${bak}"
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
    ok "deno already installed"
    return
  fi
  info "Installing deno (required by yt-dlp for YouTube JS extraction)"
  echo 'n' | DENO_INSTALL=/usr/local DENO_NO_UPDATE_CHECK=1 \
    sh -c "$(curl -fsSL https://deno.land/install.sh)" 2>&1 | grep -v '^$' || true
  ok "deno installed"
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
    npm install -g pm2
  fi
  ok "PM2 $(pm2 -v)"
}

clone_repo() {
  step "Cloning repository"
  git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"
  ok "Cloned to ${INSTALL_DIR}"
}

# ── prompt helpers ─────────────────────────────────────────────────────────────

prompt_nonempty() {
  local prompt="$1" default="${2:-}" value=""
  while true; do
    if [[ -n "${default}" ]]; then
      read -r -p "$(echo -e "${prompt} [${default}]: ")" value
      value="${value:-${default}}"
    else
      read -r -p "$(echo -e "${prompt}: ")" value
    fi
    [[ -z "${value// }" ]] && { err "Value cannot be empty."; continue; }
    echo "${value}"; return
  done
}

prompt_optional() {
  local prompt="$1" value=""
  read -r -p "$(echo -e "${prompt} (leave empty to skip): ")" value
  echo "${value}"
}

prompt_numeric() {
  local prompt="$1" default="${2:-}" value=""
  while true; do
    if [[ -n "${default}" ]]; then
      read -r -p "$(echo -e "${prompt} [${default}]: ")" value
      value="${value:-${default}}"
    else
      read -r -p "$(echo -e "${prompt}: ")" value
    fi
    [[ ! "${value}" =~ ^[0-9]+$ ]] && { err "Must be a non-negative integer."; continue; }
    echo "${value}"; return
  done
}

prompt_file() {
  local prompt="$1" value=""
  while true; do
    read -r -p "$(echo -e "${prompt}: ")" value
    [[ -z "${value// }" ]] && { err "Path cannot be empty."; continue; }
    [[ ! -f "${value}" ]] && { err "File not found: ${value}"; continue; }
    echo "${value}"; return
  done
}

prompt_user_ids() {
  local prompt="$1" value=""
  while true; do
    read -r -p "$(echo -e "${prompt}: ")" value
    value="${value// /}"
    [[ -z "${value}" ]] && { err "ALLOWED_USERS cannot be empty."; continue; }
    [[ ! "${value}" =~ ^[0-9]+(,[0-9]+)*$ ]] && { err "Comma-separated IDs only, e.g. 123456,789012"; continue; }
    echo "${value}"; return
  done
}

prompt_port() {
  local default="$1" value=""
  while true; do
    read -r -p "$(echo -e "Internal Node.js port [${default}]: ")" value
    value="${value:-${default}}"
    if [[ ! "${value}" =~ ^[0-9]+$ ]] || (( value < 1024 || value > 65535 )); then
      err "Port must be between 1024 and 65535."; continue
    fi
    if ss -tlnp 2>/dev/null | grep -q ":${value} "; then
      err "Port ${value} is already in use."; continue
    fi
    echo "${value}"; return
  done
}

# ── input collection variables ─────────────────────────────────────────────────

BOT_TOKEN="" API_ID="" API_HASH="" ALLOWED_USERS=""
GOOGLE_CLIENT_ID="" GOOGLE_CLIENT_SECRET="" DRIVE_FOLDER_ID=""
FILEHOST_DOMAIN="" FILEHOST_SERVE_DIR="" FILEHOST_PORT="3000"
FILEHOST_RETENTION_DAYS="0" SSL_CERT="" SSL_KEY="" SSL_DIR=""

collect_inputs() {
  step "Collecting configuration"
  echo -e "${YELLOW}All inputs are shown in plain text so you can verify what you typed.${NC}\n"

  echo -e "${BOLD}Telegram bot token${NC} (from @BotFather)"
  BOT_TOKEN=$(prompt_nonempty "BOT_TOKEN")

  echo -e "\n${BOLD}Telegram API credentials${NC} (from https://my.telegram.org/apps)"
  API_ID=$(prompt_numeric "API_ID")
  API_HASH=$(prompt_nonempty "API_HASH")

  echo -e "\n${BOLD}Authorized Telegram user IDs${NC} (comma-separated)"
  echo -e "${CYAN}Tip: send /start to @userinfobot to find your numeric user id.${NC}"
  ALLOWED_USERS=$(prompt_user_ids "ALLOWED_USERS")

  # ── Google Drive (mandatory) ──────────────────────────────────────────────
  step "Google Drive setup"
  echo -e "${CYAN}After each download the bot will offer to upload to Drive.${NC}"
  echo -e "${CYAN}You need a Google Cloud project with Drive API enabled and an OAuth 2.0 Desktop client.${NC}"
  echo -e "${CYAN}See README.md § Google Drive Setup for step-by-step instructions.${NC}\n"
  GOOGLE_CLIENT_ID=$(prompt_nonempty "GOOGLE_CLIENT_ID")
  GOOGLE_CLIENT_SECRET=$(prompt_nonempty "GOOGLE_CLIENT_SECRET")
  echo -e "\n${BOLD}Drive folder ID${NC} (optional — leave empty to upload to Drive root)"
  DRIVE_FOLDER_ID=$(prompt_optional "DRIVE_FOLDER_ID")

  # ── Filehost / Direct Link (mandatory) ───────────────────────────────────
  step "Direct Link setup"
  echo -e "${CYAN}After each download the bot will also offer a permanent direct download URL.${NC}"
  echo -e "${CYAN}Requirements:${NC}"
  echo -e "${CYAN}  - Domain on Cloudflare with orange cloud (CDN) enabled${NC}"
  echo -e "${CYAN}  - Cloudflare Origin Server certificate (.pem + .key) already saved on this server${NC}\n"

  echo -e "${BOLD}Domain${NC} (e.g. files.example.com — must point to this server in Cloudflare)"
  FILEHOST_DOMAIN=$(prompt_nonempty "FILEHOST_DOMAIN")

  echo -e "\n${BOLD}Cloudflare Origin Certificate${NC}"
  echo -e "${CYAN}In Cloudflare: SSL/TLS → Origin Server → Create Certificate → save the files.${NC}"
  SSL_CERT=$(prompt_file "Path to origin .pem (certificate) file")
  SSL_KEY=$(prompt_file  "Path to origin .key (private key) file")
  SSL_DIR=$(dirname "${SSL_CERT}")

  echo -e "\n${BOLD}Files serve directory${NC} (nginx will serve files from here)"
  FILEHOST_SERVE_DIR=$(prompt_nonempty "FILEHOST_SERVE_DIR" "${DEFAULT_SERVE_DIR}")

  echo -e "\n${BOLD}Internal Node.js port${NC} (nginx proxies /health to it)"
  FILEHOST_PORT=$(prompt_port "3000")

  echo -e "\n${BOLD}Retention${NC} — how many days to keep hosted files (0 = keep forever)"
  FILEHOST_RETENTION_DAYS=$(prompt_numeric "FILEHOST_RETENTION_DAYS" "0")
}

confirm_summary() {
  step "Configuration summary"
  echo -e "  BOT_TOKEN:         ${BOT_TOKEN}"
  echo -e "  API_ID:            ${API_ID}"
  echo -e "  API_HASH:          ${API_HASH}"
  echo -e "  ALLOWED_USERS:     ${ALLOWED_USERS}"
  echo -e "  Google Drive:      enabled"
  echo -e "  Direct Link:       enabled"
  echo -e "  Domain:            ${FILEHOST_DOMAIN}"
  echo -e "  Serve dir:         ${FILEHOST_SERVE_DIR}"
  echo -e "  Internal port:     ${FILEHOST_PORT}"
  echo -e "  Retention:         ${FILEHOST_RETENTION_DAYS} day(s)$( [[ "${FILEHOST_RETENTION_DAYS}" == "0" ]] && echo " (keep forever)" || echo "" )"
  echo
  while true; do
    read -r -p "$(echo -e "${BOLD}Proceed? [y/N]: ${NC}")" yn
    case "${yn,,}" in
      y|yes) break ;;
      *) err "Aborted."; exit 1 ;;
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

# Google Drive
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GOOGLE_REFRESH_TOKEN=
DRIVE_FOLDER_ID=${DRIVE_FOLDER_ID}

# Direct Link / Filehost
FILEHOST_DOMAIN=${FILEHOST_DOMAIN}
FILEHOST_SERVE_DIR=${FILEHOST_SERVE_DIR}
FILEHOST_PORT=${FILEHOST_PORT}
FILEHOST_RETENTION_DAYS=${FILEHOST_RETENTION_DAYS}
EOF
  chmod 600 "${INSTALL_DIR}/.env"
  ok ".env written (chmod 600)"
}

prepare_dirs() {
  step "Preparing directories"
  mkdir -p "${DOWNLOAD_DIR}" "${DOWNLOAD_DIR}/cookies"
  chmod 700 "${DOWNLOAD_DIR}/cookies"
  ok "Download dir: ${DOWNLOAD_DIR}"

  mkdir -p "${FILEHOST_SERVE_DIR}"
  chmod 755 "${FILEHOST_SERVE_DIR}"
  case "${FILEHOST_SERVE_DIR}" in
    /root*)
      warn "FILEHOST_SERVE_DIR is under /root. Adding traversal permission (chmod o+x /root)."
      chmod o+x /root ;;
  esac
  ok "Serve dir: ${FILEHOST_SERVE_DIR}"
}

install_npm_deps() {
  step "Installing Node.js dependencies"
  cd "${INSTALL_DIR}"
  npm install --omit=dev --no-audit --no-fund
  ok "npm install complete"
}

run_drive_setup() {
  step "Setting up Google Drive OAuth token"
  echo -e "${CYAN}Follow the prompts. Use SSH tunnel or paste the redirect URL if no browser on server.${NC}\n"
  cd "${INSTALL_DIR}"
  node setup-drive.js || {
    warn "Drive OAuth setup failed or was skipped."
    warn "Re-run later: node ${INSTALL_DIR}/setup-drive.js"
  }
}

build_ssl_fullchain() {
  step "Building SSL fullchain from Cloudflare Origin CA"
  curl -fsSL https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem \
    -o "${SSL_DIR}/cloudflare_origin_ca.pem"
  cat "${SSL_CERT}" "${SSL_DIR}/cloudflare_origin_ca.pem" > "${SSL_DIR}/fullchain.pem"
  chmod 600 "${SSL_KEY}"
  ok "fullchain.pem written to ${SSL_DIR}/fullchain.pem"
}

write_nginx_conf() {
  step "Configuring nginx"
  local target="/etc/nginx/conf.d/${PROJECT}.conf"
  sed \
    -e "s|__HOST__|${FILEHOST_DOMAIN}|g" \
    -e "s|__SSL_FULLCHAIN__|${SSL_DIR}/fullchain.pem|g" \
    -e "s|__SSL_KEY__|${SSL_KEY}|g" \
    -e "s|__SERVE_DIR__|${FILEHOST_SERVE_DIR}|g" \
    -e "s|__PORT__|${FILEHOST_PORT}|g" \
    "${INSTALL_DIR}/nginx/${PROJECT}.conf" > "${target}"

  if ! nginx -t 2>/dev/null; then
    err "nginx -t failed — check the config at ${target}"
    rm -f "${target}"
    exit 1
  fi
  systemctl reload nginx
  ok "Nginx configured: https://${FILEHOST_DOMAIN}/files/"
}

setup_nginx() {
  if ! command -v nginx >/dev/null 2>&1; then
    info "Installing nginx"
    apt-get install -y nginx
  fi
  build_ssl_fullchain
  write_nginx_conf
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
  env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
  ok "PM2 started"
}

success_message() {
  echo -e "\n${BOLD}${GREEN}========================================${NC}"
  echo -e "${BOLD}${GREEN}     tg-hub is ready!                   ${NC}"
  echo -e "${BOLD}${GREEN}========================================${NC}\n"
  echo -e "${BOLD}Send /start to your bot in Telegram to begin.${NC}\n"
  echo -e "  ☁️  Google Drive upload: ${GREEN}enabled${NC}"
  echo -e "  🔗 Direct Link: ${GREEN}enabled${NC} — https://${FILEHOST_DOMAIN}/files/"
  if [[ "${FILEHOST_RETENTION_DAYS}" != "0" ]]; then
    echo -e "     Files are kept for ${FILEHOST_RETENTION_DAYS} day(s) then auto-deleted."
  else
    echo -e "     Files are kept forever (FILEHOST_RETENTION_DAYS=0)."
  fi
  cat <<EOF

${BOLD}Useful commands:${NC}
  pm2 logs ${PROJECT}               # follow logs
  pm2 restart ${PROJECT}            # restart
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
  setup_nginx
  setup_pm2
  success_message
}

main "$@"
