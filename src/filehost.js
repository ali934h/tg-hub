/**
 * Filehost helpers for tg-hub.
 *
 * Responsibilities:
 *   - Register a downloaded file into FILEHOST_SERVE_DIR so nginx can serve it.
 *   - Write a sidecar .json (same pattern as tg-filehost) for retention.
 *   - Build the public direct-download URL.
 *   - Provide a retention sweep that deletes files older than FILEHOST_RETENTION_DAYS.
 *
 * Nginx serves FILEHOST_SERVE_DIR/files/<name> straight from disk.
 * Node never proxies file bytes — only metadata operations happen here.
 */

"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const config = require("./config");
const logger = require("./logger");

const META_SUFFIX = ".json";
let retentionTimer = null;

// ── helpers ──────────────────────────────────────────────────────────────────

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function sanitizeExt(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext.length > 1 && ext.length <= 16 ? ext : "";
}

function serveDir() {
  return config.filehost.serveDir;
}

function metaPath(fileName) {
  return path.join(serveDir(), `${fileName}${META_SUFFIX}`);
}

function filePath(fileName) {
  return path.join(serveDir(), fileName);
}

function buildUrl(fileName) {
  const domain = config.filehost.domain.replace(/\/$/, "");
  return `https://${domain}/files/${fileName}`;
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Move (or copy+delete) a downloaded file into the serve dir and register it.
 * Returns { fileName, url }.
 */
async function registerFile(srcPath, originalName) {
  await fsp.mkdir(serveDir(), { recursive: true });

  const ext = sanitizeExt(originalName || srcPath);
  const id = randomId();
  const fileName = `${id}${ext}`;
  const dest = filePath(fileName);

  // Try rename first (same filesystem); fall back to copy+unlink.
  try {
    await fsp.rename(srcPath, dest);
  } catch (e) {
    if (e.code === "EXDEV") {
      await fsp.copyFile(srcPath, dest);
      await fsp.unlink(srcPath).catch(() => {});
    } else {
      throw e;
    }
  }

  const stat = await fsp.stat(dest);
  const entry = {
    id,
    originalName: path.basename(originalName || srcPath),
    fileName,
    size: stat.size,
    uploadedAt: new Date().toISOString(),
    url: buildUrl(fileName),
  };
  await fsp.writeFile(metaPath(fileName), JSON.stringify(entry, null, 2), "utf8");
  logger.info(`filehost: registered ${fileName} (${stat.size} bytes)`);
  return { fileName, url: entry.url };
}

/**
 * Delete a hosted file and its sidecar.
 */
async function deleteFile(fileName) {
  for (const p of [filePath(fileName), metaPath(fileName)]) {
    try { await fsp.unlink(p); } catch (e) { if (e.code !== "ENOENT") logger.warn(`filehost: unlink ${p}: ${e.message}`); }
  }
}

/**
 * List all hosted files (reads sidecars).
 */
async function listFiles() {
  let entries;
  try { entries = await fsp.readdir(serveDir(), { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }

  const items = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.endsWith(META_SUFFIX) || e.name.startsWith(".")) continue;
    try {
      const raw = await fsp.readFile(metaPath(e.name), "utf8");
      items.push(JSON.parse(raw));
    } catch (_) {
      // no sidecar — surface with mtime
      try {
        const stat = await fsp.stat(filePath(e.name));
        items.push({ id: e.name, fileName: e.name, originalName: e.name, size: stat.size, uploadedAt: stat.mtime.toISOString(), url: buildUrl(e.name) });
      } catch (_2) { /* ignore */ }
    }
  }
  return items.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

// ── retention ─────────────────────────────────────────────────────────────────

async function runRetentionOnce() {
  const days = config.filehost.retentionDays;
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400_000;
  const all = await listFiles();
  let removed = 0;
  for (const entry of all) {
    const ts = new Date(entry.uploadedAt).getTime();
    const age = Number.isFinite(ts) ? ts : 0;
    if (age < cutoff) {
      await deleteFile(entry.fileName);
      removed++;
      logger.info(`filehost: retention removed ${entry.fileName}`);
    }
  }
  if (removed > 0) logger.info(`filehost: retention sweep removed ${removed} file(s)`);
  return removed;
}

function startRetention() {
  if (retentionTimer) return;
  const days = config.filehost.retentionDays;
  if (!days || days <= 0) {
    logger.info("filehost: retention disabled (files kept forever)");
    return;
  }
  logger.info(`filehost: retention enabled — files older than ${days} day(s) will be removed`);
  retentionTimer = setInterval(async () => {
    try { await runRetentionOnce(); } catch (e) { logger.warn(`filehost: retention error: ${e.message}`); }
  }, 60 * 60 * 1000); // check every hour
  retentionTimer.unref?.();
  // Run once at startup too
  runRetentionOnce().catch((e) => logger.warn(`filehost: initial retention error: ${e.message}`));
}

function stopRetention() {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}

module.exports = { registerFile, deleteFile, listFiles, buildUrl, startRetention, stopRetention, runRetentionOnce };
