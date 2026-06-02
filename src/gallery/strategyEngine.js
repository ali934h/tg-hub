/**
 * Strategy engine for gallery scraping.
 * Loads site-specific CSS selector rules from siteStrategies.json,
 * looks up by domain, and provides fallback search across all strategies.
 */

"use strict";

const fsp = require("fs").promises;
const path = require("path");
const logger = require("../logger");

const STRATEGIES_PATH = path.join(__dirname, "config/siteStrategies.json");

class StrategyEngine {
  constructor() {
    this.strategies = {};
    this.loaded = false;
  }

  async load() {
    const raw = await fsp.readFile(STRATEGIES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    delete parsed._comment;
    delete parsed._structure;
    this.strategies = parsed;
    this.loaded = true;
    logger.info(`gallery: loaded ${Object.keys(this.strategies).length} site strategies`);
  }

  ensureLoaded() {
    if (!this.loaded) throw new Error("Gallery strategies not loaded yet");
  }

  getDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return ""; }
  }

  get(url) {
    this.ensureLoaded();
    return this.strategies[this.getDomain(url)] || null;
  }

  supportedDomains() {
    this.ensureLoaded();
    return Object.keys(this.strategies);
  }

  /**
   * Try all strategies until one returns >= minImages.
   * Capped at fallbackLimit to avoid hammering every strategy on unknown sites.
   */
  async findWorking(url, scraper, { fallbackLimit = 5, minImages = 5 } = {}) {
    this.ensureLoaded();
    const entries = Object.entries(this.strategies).slice(0, fallbackLimit);
    for (const [, strategy] of entries) {
      try {
        const images = await scraper.extractImages(url, strategy);
        if (images && images.length >= minImages) return { strategy, images };
      } catch (err) {
        logger.debug(`gallery: fallback strategy '${strategy.name}' failed: ${err.message}`);
      }
    }
    return null;
  }
}

module.exports = new StrategyEngine();
