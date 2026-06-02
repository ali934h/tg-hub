const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value ? value.trim() : null;
}

function parseAllowedUsers(raw) {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const n = Number(s);
        if (!Number.isFinite(n) || !Number.isInteger(n)) {
          throw new Error(`Invalid user id in ALLOWED_USERS: ${s}`);
        }
        return n;
      }),
  );
}

const downloadDir = process.env.DOWNLOAD_DIR || "/root/tg-hub-downloads";
fs.mkdirSync(downloadDir, { recursive: true });
fs.mkdirSync(path.join(downloadDir, "cookies"), { recursive: true });

// ── Google Drive ──────────────────────────────────────────────────────────────
const googleClientId = optionalEnv("GOOGLE_CLIENT_ID");
const googleClientSecret = optionalEnv("GOOGLE_CLIENT_SECRET");
const googleRefreshToken = optionalEnv("GOOGLE_REFRESH_TOKEN");
const driveEnabled = !!(googleClientId && googleClientSecret && googleRefreshToken);

// ── Filehost (direct-link via nginx) ─────────────────────────────────────────
const filehostDomain = optionalEnv("FILEHOST_DOMAIN");
const filehostServeDir = optionalEnv("FILEHOST_SERVE_DIR") || path.join(downloadDir, "serve");
const filehostRetentionDays = Number(process.env.FILEHOST_RETENTION_DAYS || 0);
const filehostEnabled = !!filehostDomain;

if (filehostEnabled) {
  fs.mkdirSync(filehostServeDir, { recursive: true });
}

const config = {
  botToken: requireEnv("BOT_TOKEN"),
  apiId: Number(requireEnv("API_ID")),
  apiHash: requireEnv("API_HASH"),
  allowedUsers: parseAllowedUsers(requireEnv("ALLOWED_USERS")),
  downloadDir,
  cookiesDir: path.join(downloadDir, "cookies"),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB || 2000) * 1024 * 1024,
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
  sessionFile: path.join(__dirname, "..", "bot.session"),

  drive: {
    enabled: driveEnabled,
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    refreshToken: googleRefreshToken,
    folderId: optionalEnv("DRIVE_FOLDER_ID"),
  },

  filehost: {
    enabled: filehostEnabled,
    domain: filehostDomain || "",
    // Where nginx serves files from (alias in nginx conf)
    serveDir: filehostServeDir,
    // Internal Node port for /health endpoint (used by nginx upstream check)
    port: Number(process.env.FILEHOST_PORT || 3000),
    retentionDays: filehostRetentionDays,
  },
};

if (!Number.isFinite(config.apiId) || config.apiId <= 0) {
  throw new Error("API_ID must be a positive integer");
}

if (config.allowedUsers.size === 0) {
  throw new Error("ALLOWED_USERS must contain at least one user id");
}

module.exports = config;
