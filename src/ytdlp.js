const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const logger = require("./logger");

const COOKIE_HINTS = [
  "cookies",
  "sign in",
  "log in",
  "login required",
  "private video",
  "members-only",
  "age-restricted",
  "confirm you're not a bot",
  "not a bot",
  "http error 403",
  "http error 401",
  "http error 410",
  "this video is unavailable",
  "subscribers only",
  "premium",
];

function looksLikeCookieIssue(stderr) {
  const lower = (stderr || "").toLowerCase();
  return COOKIE_HINTS.some((h) => lower.includes(h));
}

function runYtDlp(args, { onStdout, onStderr, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    logger.debug("yt-dlp args:", args.join(" "));
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const to = timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (onStdout) onStdout(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    child.on("error", (err) => {
      if (to) clearTimeout(to);
      reject(err);
    });
    child.on("close", (code) => {
      if (to) clearTimeout(to);
      if (killed) {
        return reject(new Error("yt-dlp timed out"));
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(
          `yt-dlp exited with code ${code}: ${stderr.trim().slice(-500)}`,
        );
        err.stderr = stderr;
        err.code = code;
        err.cookieIssue = looksLikeCookieIssue(stderr);
        reject(err);
      }
    });
  });
}

async function probe(url, cookiesPath) {
  const args = ["-J", "--no-playlist", "--no-warnings"];
  if (cookiesPath) args.push("--cookies", cookiesPath);
  args.push(url);

  const { stdout } = await runYtDlp(args, { timeoutMs: 60_000 });
  let data;
  try {
    data = JSON.parse(stdout);
  } catch (e) {
    throw new Error("Failed to parse yt-dlp metadata output");
  }

  const formats = Array.isArray(data.formats) ? data.formats : [];
  const duration = Number(data.duration) || 0;

  const isAudioOnly = (f) =>
    f.vcodec === "none" && f.acodec && f.acodec !== "none";
  const isVideoCandidate = (f) => !isAudioOnly(f);

  const estimateBytes = (f) => {
    if (typeof f.filesize === "number" && f.filesize > 0) return f.filesize;
    if (typeof f.filesize_approx === "number" && f.filesize_approx > 0)
      return f.filesize_approx;
    const rate =
      (typeof f.tbr === "number" && f.tbr) ||
      (typeof f.vbr === "number" && f.vbr) ||
      (typeof f.abr === "number" && f.abr) ||
      0;
    if (rate > 0 && duration > 0) {
      return Math.round((rate * 1000 * duration) / 8);
    }
    return 0;
  };

  const videoFormats = formats
    .filter(isVideoCandidate)
    .map((f) => ({
      formatId: f.format_id,
      ext: f.ext || "",
      vcodec: f.vcodec && f.vcodec !== "none" ? f.vcodec : "",
      acodec: f.acodec && f.acodec !== "none" ? f.acodec : "",
      height: typeof f.height === "number" ? f.height : 0,
      width: typeof f.width === "number" ? f.width : 0,
      fps: typeof f.fps === "number" ? f.fps : 0,
      sizeBytes: estimateBytes(f),
    }))
    .filter((v) => v.formatId)
    .sort(
      (a, b) =>
        a.height - b.height ||
        a.sizeBytes - b.sizeBytes ||
        a.formatId.localeCompare(b.formatId),
    );

  const byHeight = new Map();
  for (const f of videoFormats) {
    const h = f.height;
    if (typeof h !== "number" || h <= 0) continue;
    const prev = byHeight.get(h);
    if (!prev || f.sizeBytes > prev.sizeBytes) {
      byHeight.set(h, { height: h, sizeBytes: f.sizeBytes });
    }
  }
  const videoHeights = [...byHeight.values()].sort(
    (a, b) => a.height - b.height,
  );
  const availableHeights = videoHeights.map((v) => v.height);
  const maxHeight = availableHeights.length
    ? availableHeights[availableHeights.length - 1]
    : 0;

  const audioFormats = formats
    .filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none")
    .map((f) => ({
      formatId: f.format_id,
      ext: f.ext || "audio",
      codec: f.acodec || "",
      abr: typeof f.abr === "number" ? f.abr : 0,
      sizeBytes: estimateBytes(f),
    }))
    .filter((a) => a.formatId)
    .sort((a, b) => a.abr - b.abr || a.sizeBytes - b.sizeBytes);

  let bestAudio = null;
  for (const a of audioFormats) {
    if (
      !bestAudio ||
      a.abr > bestAudio.abr ||
      (a.abr === bestAudio.abr && a.sizeBytes > bestAudio.sizeBytes)
    ) {
      bestAudio = a;
    }
  }

  if (bestAudio && bestAudio.sizeBytes > 0) {
    for (const v of videoHeights) {
      if (v.sizeBytes > 0) {
        v.sizeBytes += bestAudio.sizeBytes;
      }
    }
  }

  const hasVideo = formats.some(isVideoCandidate) || formats.length > 0;

  return {
    title: data.title || "video",
    duration,
    extractor: data.extractor || data.extractor_key || "",
    maxHeight,
    availableHeights,
    videoHeights,
    videoFormats,
    audioFormats,
    bestAudio,
    hasVideo,
    hasAudio: true,
    isLive: !!data.is_live,
  };
}

function buildVideoFormat(maxHeight) {
  if (!maxHeight || maxHeight <= 0) {
    return [
      "bv*[ext=mp4]+ba[ext=m4a]",
      "bv*[ext=mp4]+ba",
      "bv*+ba[ext=m4a]",
      "bv*+ba",
      "b[ext=mp4]",
      "best",
    ].join("/");
  }
  return [
    `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]`,
    `bv*[height<=${maxHeight}][ext=mp4]+ba`,
    `bv*[height<=${maxHeight}]+ba[ext=m4a]`,
    `bv*[height<=${maxHeight}]+ba`,
    `b[height<=${maxHeight}][ext=mp4]`,
    `b[height<=${maxHeight}]`,
    "best",
  ].join("/");
}

async function downloadVideo({ url, jobDir, maxHeight, cookiesPath, onProgress, formatId = "" }) {
  fs.mkdirSync(jobDir, { recursive: true });
  const formatSelector = buildVideoFormat(maxHeight);
  const args = [
    "-f", formatSelector,
    "--merge-output-format", "mp4",
    "--restrict-filenames",
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "-o", path.join(jobDir, "%(title).100B.%(ext)s"),
  ];
  if (cookiesPath) args.unshift("--cookies", cookiesPath);
  args.push(url);

  await runYtDlp(args, {
    timeoutMs: 60 * 60 * 1000,
    onStdout: (s) => parseProgress(s, onProgress),
  });
  return findOutputFile(jobDir);
}

async function downloadAudio({ url, jobDir, cookiesPath, onProgress, mode = "mp3", bitrateKbps = 0, formatId = "" }) {
  fs.mkdirSync(jobDir, { recursive: true });
  const formatSelector = "bestaudio/best";
  const args = [
    "-f", formatSelector,
    "--restrict-filenames",
    "--no-playlist",
    "--newline",
    "--no-warnings",
    "-o", path.join(jobDir, "%(title).100B.%(ext)s"),
  ];

  if (mode === "mp3") {
    args.push("-x", "--audio-format", "mp3");
    if (bitrateKbps && bitrateKbps > 0) {
      args.push("--audio-quality", `${bitrateKbps}K`);
    } else {
      args.push("--audio-quality", "0");
    }
  }

  if (cookiesPath) args.unshift("--cookies", cookiesPath);
  args.push(url);

  await runYtDlp(args, {
    timeoutMs: 60 * 60 * 1000,
    onStdout: (s) => parseProgress(s, onProgress),
  });
  return findOutputFile(jobDir);
}

function parseProgress(chunk, onProgress) {
  if (!onProgress) return;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
    if (m) {
      onProgress(parseFloat(m[1]));
    }
  }
}

function findOutputFile(jobDir) {
  const entries = fs
    .readdirSync(jobDir)
    .filter((n) => !n.endsWith(".part") && !n.endsWith(".ytdl"));
  if (entries.length === 0) {
    throw new Error("No output file produced by yt-dlp");
  }
  const stats = entries.map((n) => {
    const p = path.join(jobDir, n);
    return { p, size: fs.statSync(p).size };
  });
  stats.sort((a, b) => b.size - a.size);
  return stats[0].p;
}

module.exports = {
  probe,
  downloadVideo,
  downloadAudio,
  looksLikeCookieIssue,
};
