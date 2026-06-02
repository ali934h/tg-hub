/**
 * Parallel image downloader for gallery feature.
 * Streams each image to disk with retry + exponential backoff.
 * Optional SOCKS5 proxy support.
 */

"use strict";

const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { SocksProxyAgent } = require("socks-proxy-agent");
const config = require("../config");
const logger = require("../logger");

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

function getProxyAgent() {
  const url = config.gallery.proxyUrl;
  if (!url || !(url.startsWith("socks://") || url.startsWith("socks5://"))) return null;
  try { return new SocksProxyAgent(url); }
  catch (err) { logger.warn("gallery: invalid PROXY_URL", err.message); return null; }
}

async function downloadImage(url, destPath, useProxy = false) {
  const agent = useProxy ? getProxyAgent() : null;
  const axiosConfig = {
    responseType: "stream",
    timeout: config.gallery.downloadTimeoutMs,
    headers: HEADERS,
  };
  if (agent) { axiosConfig.httpAgent = agent; axiosConfig.httpsAgent = agent; }

  for (let attempt = 1; attempt <= config.gallery.downloadRetries; attempt++) {
    try {
      const res = await axios.get(url, axiosConfig);
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(destPath);
        res.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
        res.data.on("error", reject);
      });
      return true;
    } catch (err) {
      if (attempt < config.gallery.downloadRetries) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      logger.warn(`gallery: failed to download image: ${url}`, err.message);
      return false;
    }
  }
  return false;
}

async function downloadGallery(gallery, destDir, onProgress, signal) {
  const { name, urls, useProxy } = gallery;
  const galleryDir = path.join(destDir, name);
  fs.mkdirSync(galleryDir, { recursive: true });

  let completed = 0;
  let success = 0;
  const total = urls.length;
  const queue = [...urls.entries()];
  const concurrency = config.gallery.downloadConcurrency;

  const worker = async () => {
    while (queue.length > 0) {
      if (signal?.aborted) return;
      const [idx, url] = queue.shift();
      let ext = ".jpg";
      try {
        const e = path.extname(new URL(url).pathname);
        if (e && e.length <= 6) ext = e;
      } catch (_) { /* keep default */ }
      const filename = `${String(idx + 1).padStart(4, "0")}${ext}`;
      const destPath = path.join(galleryDir, filename);
      const ok = await downloadImage(url, destPath, useProxy);
      if (ok) success++;
      completed++;
      onProgress?.({ current: completed, total });
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, urls.length || 1) }, worker);
  await Promise.all(workers);
  return { success, total };
}

async function downloadMultipleGalleries(galleries, destDir, onProgress, signal) {
  let totalSuccess = 0;
  let completedGalleries = 0;
  const totalGalleries = galleries.length;

  for (const gallery of galleries) {
    if (signal?.aborted) break;
    logger.info(`gallery: downloading ${gallery.name} (${gallery.urls.length} images)`);
    const result = await downloadGallery(
      gallery,
      destDir,
      (progress) => onProgress?.({ completedGalleries, totalGalleries, galleryName: gallery.name, galleryProgress: progress }),
      signal,
    );
    totalSuccess += result.success;
    completedGalleries++;
    logger.info(`gallery: done ${gallery.name} — ${result.success}/${result.total} images`);
  }
  return { successImages: totalSuccess, totalGalleries };
}

module.exports = { downloadImage, downloadGallery, downloadMultipleGalleries };
