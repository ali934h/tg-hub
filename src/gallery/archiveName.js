/**
 * Archive-name validation and sanitisation for the gallery feature.
 */

const crypto = require("crypto");

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]{1,79}$/;

function isValidArchiveName(name) {
  if (typeof name !== "string") return false;
  if (!NAME_REGEX.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

function sanitiseSlug(raw, fallback = "gallery") {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9\-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30);
  if (!cleaned || !/^[a-zA-Z0-9]/.test(cleaned)) return fallback;
  return cleaned;
}

function buildDefaultName(slug) {
  const safe = sanitiseSlug(slug);
  return `${safe}_${Date.now()}`;
}

function withRandomSuffix(name) {
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${name}-${suffix}`;
}

module.exports = { NAME_REGEX, isValidArchiveName, sanitiseSlug, buildDefaultName, withRandomSuffix };
