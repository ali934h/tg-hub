/**
 * Atomic ZIP creator for gallery feature.
 * Writes to a .tmp file and renames on success so nginx never serves a partial archive.
 */

"use strict";

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const archiver = require("archiver");
const logger = require("../logger");

async function createZip(sourceDir, archiveName, outputDir) {
  await fsp.mkdir(outputDir, { recursive: true });
  const finalPath = path.join(outputDir, `${archiveName}.zip`);
  const tmpPath = `${finalPath}.tmp`;

  // Refuse to overwrite an existing archive
  try {
    await fsp.access(finalPath);
    throw new Error(`Archive already exists: ${path.basename(finalPath)}`);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(tmpPath);
      const archive = archiver("zip", { zlib: { level: 6 } });
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    throw err;
  }

  await fsp.rename(tmpPath, finalPath);
  const stats = await fsp.stat(finalPath);
  logger.info(`gallery: ZIP created: ${path.basename(finalPath)} (${stats.size} bytes)`);
  return finalPath;
}

module.exports = { createZip };
