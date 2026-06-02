/**
 * Filehost helpers for tg-hub.
 *
 * Responsibilities:
 *   - Download a file from an HTTP(S) URL to a temp dir.
 *   - Download a Telegram document to a temp dir (via GramJS iterDownload).
 *   - Register a downloaded file into FILEHOST_SERVE_DIR so nginx can serve it.
 *   - Write a sidecar .json (same pattern as tg-filehost) for retention.
 *   - Build the public direct-download URL.
 *   - Provide a retention sweep that deletes files older than FILEHOST_RETENTION_DAYS.
 *
 * Nginx serves FILEHOST_SERVE_DIR/<name> straight from disk.
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
const MAX_BYTES = 2000 * 1024 * 1024; // 2000 MB hard limit
let retentionTimer = null;

// ── helpers ───────────────────────────────────────────────────────────────────

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function sanitizeExt(name) {
  const ext = path.extname(name || "").toLowerCase().replace(/[^a-z0-9.]/g, "");
  return ext.length > 1 && ext.length <= 16 ? ext : "";
}

function sanitizeFileName(name) {
  return (name || "file")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/[\/\\<>:"|?*]/g, "_")
    .trim()
    .slice(0, 200) || "file";
}

function serveDir() {
  return config.filehost.serveDir;
}

function metaPath(fileName) {
  return path.join(serveDir(), `${fileName}${META_SUFFIX}`);
}

function hostedFilePath(fileName) {
  return path.join(serveDir(), fileName);
}

function buildUrl(fileName) {
  const domain = config.filehost.domain.replace(/\/$/, "");
  return `https://${domain}/files/${fileName}`;
}

function humanSize(bytes) {
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

// ── download from HTTP(S) URL ─────────────────────────────────────────────────

/**
 * Download a file from a direct URL to a temp directory.
 * Returns { tmpPath, fileName, size }.
 * Throws if size exceeds MAX_BYTES or download fails.
 */
async function downloadFromUrl(url, tmpDir, onProgress) {
  await fsp.mkdir(tmpDir, { recursive: true });

  // HEAD first to get filename + size hint
  let guessedName = "file";
  let contentLength = 0;
  try {
    const head = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (head.ok) {
      contentLength = Number(head.headers.get("content-length") || 0);
      if (contentLength > MAX_BYTES) {
        throw new Error(`File is too large (${humanSize(contentLength)} > ${humanSize(MAX_BYTES)})`);
      }
      const cd = head.headers.get("content-disposition") || "";
      const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
      if (m) guessedName = decodeURIComponent(m[1].trim());
      else guessedName = path.basename(new URL(url).pathname) || "file";
    }
  } catch (e) {
    if (e.message.includes("too large")) throw e;
    // HEAD failed — continue without size info
    guessedName = path.basename(new URL(url).pathname) || "file";
  }

  guessedName = sanitizeFileName(guessedName);
  const tmpPath = path.join(tmpDir, guessedName);

  const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const writeStream = fs.createWriteStream(tmpPath);
  let received = 0;
  let lastReport = 0;
  const reader = res.body.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        throw new Error(`File is too large (exceeds ${humanSize(MAX_BYTES)})`);
      }
      if (!writeStream.write(value)) {
        await new Promise((resolve) => writeStream.once("drain", resolve));
      }
      if (onProgress && contentLength > 0) {
        const pct = Math.min(100, (received / contentLength) * 100);
        const stepped = Math.floor(pct);
        if (stepped !== lastReport) { lastReport = stepped; onProgress(pct, received, contentLength); }
      }
    }
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
  } catch (err) {
    try { writeStream.destroy(); } catch (_) { /* ignore */ }
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return { tmpPath, fileName: guessedName, size: received };
}

// ── download from Telegram document ──────────────────────────────────────────

/**
 * Download a Telegram document/file message to a temp directory via GramJS iterDownload.
 * Returns { tmpPath, fileName, size }.
 * Throws if size exceeds MAX_BYTES.
 */
async function downloadFromTelegram(client, msg, tmpDir, onProgress) {
  await fsp.mkdir(tmpDir, { recursive: true });

  // Extract file name and size from the message media attributes
  let fileName = "file";
  let fileSize = 0;

  const doc = msg.media && (msg.media.document || msg.media.photo);
  if (doc) {
    fileSize = doc.size ? Number(doc.size) : 0;
    if (fileSize > MAX_BYTES) {
      throw new Error(`File is too large (${humanSize(fileSize)} > ${humanSize(MAX_BYTES)})`);
    }
    // Try to get filename from document attributes
    if (doc.attributes) {
      for (const attr of doc.attributes) {
        if (attr.fileName) { fileName = sanitizeFileName(attr.fileName); break; }
      }
    }
    if (fileName === "file" && doc.mimeType) {
      const ext = doc.mimeType.split("/")[1] || "";
      if (ext) fileName = `file.${ext}`;
    }
  }

  const tmpPath = path.join(tmpDir, fileName);
  const writeStream = fs.createWriteStream(tmpPath);
  let received = 0;
  let lastReport = 0;

  try {
    for await (const chunk of client.iterDownload({
      file: msg.media,
      requestSize: 1024 * 1024,
    })) {
      received += chunk.length;
      if (received > MAX_BYTES) {
        throw new Error(`File is too large (exceeds ${humanSize(MAX_BYTES)})`);
      }
      if (!writeStream.write(chunk)) {
        await new Promise((resolve) => writeStream.once("drain", resolve));
      }
      if (onProgress && fileSize > 0) {
        const pct = Math.min(100, (received / fileSize) * 100);
        const stepped = Math.floor(pct);
        if (stepped !== lastReport) { lastReport = stepped; onProgress(pct, received, fileSize); }
      }
    }
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
  } catch (err) {
    try { writeStream.destroy(); } catch (_) { /* ignore */ }
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  return { tmpPath, fileName, size: received };
}

// ── register file into serve dir ─────────────────────────────────────────────

/**
 * Move (or copy+delete) a downloaded file into the serve dir and register it.
 * Returns { fileName, url }.
 */
async function registerFile(srcPath, originalName) {
  await fsp.mkdir(serveDir(), { recursive: true });

  const ext = sanitizeExt(originalName || srcPath);
  const id = randomId();
  const fileName = `${id}${ext}`;
  const dest = hostedFilePath(fileName);

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

// ── delete / list ─────────────────────────────────────────────────────────────

async function deleteFile(fileName) {
  for (const p of [hostedFilePath(fileName), metaPath(fileName)]) {
    try { await fsp.unlink(p); } catch (e) { if (e.code !== "ENOENT") logger.warn(`filehost: unlink ${p}: ${e.message}`); }
  }
}

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
      try {
        const stat = await fsp.stat(hostedFilePath(e.name));
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
    if (Number.isFinite(ts) && ts < cutoff) {
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
  }, 60 * 60 * 1000);
  retentionTimer.unref?.();
  runRetentionOnce().catch((e) => logger.warn(`filehost: initial retention error: ${e.message}`));
}

function stopRetention() {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}

module.exports = {
  registerFile,
  deleteFile,
  listFiles,
  buildUrl,
  downloadFromUrl,
  downloadFromTelegram,
  startRetention,
  stopRetention,
  runRetentionOnce,
  MAX_BYTES,
  humanSize,
};
