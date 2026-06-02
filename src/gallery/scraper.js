/**
 * JSDOM-based scraper for gallery pages.
 * Fetches HTML, parses with jsdom, applies CSS selector + attribute to extract image URLs.
 * Optional SOCKS5 proxy support for strategies with useProxy=true.
 */

"use strict";

const axios = require("axios");
const { JSDOM } = require("jsdom");
const { SocksProxyAgent } = require("socks-proxy-agent");
const config = require("../config");
const logger = require("../logger");

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

function resolveUrl(imgUrl, pageUrl) {
  if (!imgUrl) return null;
  if (imgUrl.startsWith("//")) return "https:" + imgUrl;
  if (imgUrl.startsWith("http://") || imgUrl.startsWith("https://")) return imgUrl;
  try { return new URL(imgUrl, pageUrl).href; } catch (_) { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function getProxyAgent(useProxy) {
  if (!useProxy || !config.gallery.proxyUrl) return null;
  const url = config.gallery.proxyUrl;
  if (!(url.startsWith("socks://") || url.startsWith("socks5://"))) {
    logger.warn(`gallery: unsupported PROXY_URL scheme: ${url}`); return null;
  }
  try { return new SocksProxyAgent(url); }
  catch (err) { logger.warn("gallery: failed to build SocksProxyAgent", err.message); return null; }
}

async function fetchHTML(url, customHeaders = {}, useProxy = false) {
  const headers = { ...DEFAULT_HEADERS, ...customHeaders };
  const agent = getProxyAgent(useProxy);
  const axiosConfig = {
    headers,
    timeout: config.gallery.scrapeTimeoutMs,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 300,
  };
  if (agent) { axiosConfig.httpAgent = agent; axiosConfig.httpsAgent = agent; }

  const retries = config.gallery.scrapeRetries;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      logger.debug(`gallery: fetching HTML: ${url} (attempt ${attempt}/${retries})`);
      const res = await axios.get(url, axiosConfig);
      return res.data;
    } catch (err) {
      const code = err.code || "";
      const isRetryable = code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND" ||
        (err.message && err.message.includes("socket hang up")) ||
        (err.response && err.response.status >= 500);
      if (isRetryable && attempt < retries) { await sleep(2000 * attempt); continue; }
      throw new Error(`HTTP request failed: ${err.message}`);
    }
  }
  throw new Error("HTTP request failed after retries");
}

async function extractImages(url, strategy) {
  const headers = strategy.headers || {};
  const useProxy = !!strategy.useProxy;
  const html = await fetchHTML(url, headers, useProxy);
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const { selector, attr, filterPatterns } = strategy.images;
  const els = document.querySelectorAll(selector);
  const urls = [];
  els.forEach((el) => {
    const raw = el.getAttribute(attr);
    const resolved = resolveUrl(raw, url);
    if (resolved) urls.push(resolved);
  });
  const filtered = (filterPatterns && filterPatterns.length)
    ? urls.filter((u) => !filterPatterns.some((p) => u.includes(p)))
    : urls;
  const unique = [...new Set(filtered)];
  logger.debug(`gallery: extracted ${unique.length} images from ${url}`);
  return unique;
}

function extractGalleryName(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "gallery";
    const cleaned = last.replace(/\.[^/.]+$/, "").replace(/[^a-zA-Z0-9-_]/g, "_");
    return cleaned || "gallery";
  } catch (_) { return "gallery"; }
}

module.exports = { extractImages, extractGalleryName };
