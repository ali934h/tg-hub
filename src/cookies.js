const fs = require("fs");
const path = require("path");
const config = require("./config");

function getCookiesPath(userId) {
  const p = path.join(config.cookiesDir, `${userId}.txt`);
  return fs.existsSync(p) ? p : null;
}

function saveCookies(userId, text) {
  const p = path.join(config.cookiesDir, `${userId}.txt`);
  fs.writeFileSync(p, text, { mode: 0o600 });
}

function deleteCookies(userId) {
  const p = path.join(config.cookiesDir, `${userId}.txt`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function isValidCookiesText(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);
  return lines.some((line) => {
    if (line.startsWith("#") || !line.trim()) return false;
    const parts = line.split("\t");
    return parts.length >= 6;
  });
}

module.exports = { getCookiesPath, saveCookies, deleteCookies, isValidCookiesText };
