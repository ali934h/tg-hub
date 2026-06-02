const fs = require("fs");
const path = require("path");
const { Api } = require("telegram");
const { NewMessage } = require("telegram/events");
const { CallbackQuery } = require("telegram/events/CallbackQuery");
const { Button } = require("telegram/tl/custom/button");

const config = require("./config");
const logger = require("./logger");
const auth = require("./auth");
const state = require("./state");
const ytdlp = require("./ytdlp");
const cookies = require("./cookies");
const drive = require("./drive");
const filehost = require("./filehost");
const galleryArchiveName = require("./gallery/archiveName");
const galleryStrategyEngine = require("./gallery/strategyEngine");
const galleryScraper = require("./gallery/scraper");
const galleryImageDownloader = require("./gallery/imageDownloader");
const galleryZipCreator = require("./gallery/zipCreator");
const {
  buildMainMenu,
  buildAllVideoMenu,
  buildAllAudioMenu,
} = require("./format-menu");

const URL_REGEX = /(https?:\/\/[^\s]+)/i;
const UPDATE_INTERVAL_MS = 5000;

function buildButtons(rows) {
  return rows.map((row) =>
    row.map((b) => Button.inline(b.label, Buffer.from(b.data))),
  );
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm",
    ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/opus",
    ".flac": "audio/flac", ".wav": "audio/wav", ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const parent = path.dirname(dir);
    if (parent.startsWith(config.downloadDir) && parent !== config.downloadDir) {
      const remaining = fs.readdirSync(parent);
      if (remaining.length === 0) fs.rmdirSync(parent);
    }
  } catch (e) {
    logger.warn(`Cleanup failed for ${dir}: ${e.message}`);
  }
}

function hasTelegramFile(msg) {
  return !!(msg.document || msg.video || msg.audio || msg.voice ||
    msg.videoNote || msg.sticker || msg.photo ||
    (msg.media && (msg.media.document || msg.media.photo)));
}

function buildPostDownloadButtons() {
  const d = config.drive.enabled;
  const f = config.filehost.enabled;
  if (d && f) {
    return [
      [Button.inline("☁️ Google Drive", Buffer.from("post:drive")), Button.inline("🔗 Direct Link", Buffer.from("post:link"))],
      [Button.inline("☁️🔗 Both", Buffer.from("post:both")), Button.inline("❌ None", Buffer.from("post:none"))],
    ];
  }
  if (d) return [[Button.inline("☁️ Upload to Drive", Buffer.from("post:drive")), Button.inline("❌ No thanks", Buffer.from("post:none"))]];
  if (f) return [[Button.inline("🔗 Get Direct Link", Buffer.from("post:link")), Button.inline("❌ No thanks", Buffer.from("post:none"))]];
  return null;
}

function postDownloadPromptText(labelLine, sentToTelegram = true) {
  const d = config.drive.enabled;
  const f = config.filehost.enabled;
  const base = sentToTelegram ? `${labelLine}\n✅ Sent to Telegram.\n\n` : `${labelLine}\n✅ Downloaded.\n\n`;
  if (d && f) return `${base}What else would you like?`;
  if (d) return `${base}☁️ Upload to Google Drive (public link)?`;
  if (f) return `${base}🔗 Get a direct download link?`;
  return null;
}

// ── Gallery confirm keyboard ──────────────────────────────────────────────────

function galleryConfirmKeyboard() {
  return [
    [Button.inline("✅ Start Download", Buffer.from("gallery:start")), Button.inline("✏️ Rename", Buffer.from("gallery:rename"))],
    [Button.inline("❌ Cancel", Buffer.from("gallery:cancel"))],
  ];
}

function galleryCancelKeyboard() {
  return [[Button.inline("❌ Cancel Download", Buffer.from("gallery:abort"))]];
}

function buildGallerySummary(urls, archiveName) {
  return (
    `🖼 <b>${urls.length} gallery URL${urls.length === 1 ? "" : "s"} detected</b>\n\n` +
    `📁 Archive name: <code>${escapeHtml(archiveName)}</code>\n\n` +
    `Tap <b>Start Download</b> to begin, <b>Rename</b> to choose a custom name, or <b>Cancel</b> to reset.\n\n` +
    `Allowed name characters: letters, numbers, <code>- _ .</code> (must start with letter or digit)`
  );
}

class Bot {
  constructor(client) {
    this.client = client;
  }

  start() {
    this.client.addEventHandler(
      (e) => this.safeHandle(() => this.onMessage(e)),
      new NewMessage({ incoming: true }),
    );
    this.client.addEventHandler(
      (e) => this.safeHandle(() => this.onCallback(e)),
      new CallbackQuery({}),
    );
    logger.info("Event handlers registered");
    // Load gallery strategies at startup
    galleryStrategyEngine.load().catch((err) => {
      logger.warn(`Failed to load gallery strategies: ${err.message}`);
    });
    this.registerBotCommands().catch((err) => {
      logger.warn(`Failed to register bot commands: ${err.message}`);
    });
  }

  async registerBotCommands() {
    const commands = [
      { command: "start",             description: "Start the bot" },
      { command: "help",              description: "Show usage instructions" },
      { command: "video",             description: "Download a video or audio" },
      { command: "setvideocookies",   description: "Set cookies for restricted video content" },
      { command: "clearvideocookies", description: "Clear saved video cookies" },
      { command: "filehost",          description: "Download a file from URL or Telegram post" },
      { command: "gallery",           description: "Scrape and download images from a gallery page" },
      { command: "cancel",            description: "Cancel the current operation" },
    ].map((c) => new Api.BotCommand({ command: c.command, description: c.description }));
    await this.client.invoke(
      new Api.bots.SetBotCommands({ scope: new Api.BotCommandScopeDefault(), langCode: "", commands }),
    );
    logger.info("Bot commands registered");
  }

  async safeHandle(fn) {
    try { await fn(); }
    catch (err) { logger.error("Handler error:", err && err.stack ? err.stack : err); }
  }

  async onMessage(event) {
    const msg = event.message;
    if (!msg || !msg.isPrivate) return;
    const senderId = msg.senderId ? Number(msg.senderId.toString()) : null;
    if (!senderId) return;

    if (!auth.isAllowed(senderId)) {
      await msg.reply({ message: `⛔ You are not authorized.\nYour user ID: <code>${senderId}</code>`, parseMode: "html" });
      return;
    }

    const text = (msg.message || "").trim();
    const userState = state.get(senderId);

    // ── /start, /help ─────────────────────────────────────────────────────────
    if (text.startsWith("/start") || text.startsWith("/help")) {
      state.reset(senderId);
      await this.sendHelp(msg); return;
    }

    // ── /cancel ───────────────────────────────────────────────────────────────
    if (text.startsWith("/cancel")) {
      if (userState.galleryAbortController) userState.galleryAbortController.abort();
      state.reset(senderId);
      await msg.reply({ message: "✅ Cancelled." }); return;
    }

    // ── /video ────────────────────────────────────────────────────────────────
    if (text.startsWith("/video")) {
      state.reset(senderId);
      state.get(senderId).waitingForVideoUrl = true;
      await msg.reply({ message: "🎬 <b>Video Download</b>\n\nSend me the video URL.\n\nSend /cancel to abort.", parseMode: "html" }); return;
    }

    // ── /setvideocookies ──────────────────────────────────────────────────────
    if (text.startsWith("/setvideocookies")) {
      state.reset(senderId);
      state.get(senderId).waitingForCookies = true;
      await msg.reply({
        message:
          "🍪 <b>Set Video Cookies</b>\n\n" +
          "<b>Method 1 — Paste as text:</b>\n" +
          "Install <b>Get cookies.txt LOCALLY</b>, export for the site, paste ALL contents here.\n\n" +
          "<b>Method 2 — Send as file:</b>\n" +
          "Same but send the <code>cookies.txt</code> file directly.\n\nSend /cancel to abort.",
        parseMode: "html",
      }); return;
    }

    // ── /clearvideocookies ────────────────────────────────────────────────────
    if (text.startsWith("/clearvideocookies")) {
      cookies.deleteCookies(senderId);
      userState.waitingForCookies = false;
      await msg.reply({ message: "🗑 Video cookies cleared." }); return;
    }

    // ── /filehost ─────────────────────────────────────────────────────────────
    if (text.startsWith("/filehost")) {
      state.reset(senderId);
      state.get(senderId).waitingForFilehostInput = true;
      await msg.reply({
        message:
          "📦 <b>File Host</b>\n\nSend a <b>direct download URL</b> or a <b>Telegram message with a file</b>.\n\n" +
          `Max size: ${humanSize(filehost.MAX_BYTES)}\n\nSend /cancel to abort.`,
        parseMode: "html",
      }); return;
    }

    // ── /gallery ──────────────────────────────────────────────────────────────
    if (text.startsWith("/gallery")) {
      state.reset(senderId);
      state.get(senderId).waitingForGalleryUrls = true;
      const domains = galleryStrategyEngine.supportedDomains();
      await msg.reply({
        message:
          "🖼 <b>Gallery Download</b>\n\n" +
          "Send one or more gallery URLs (one per line).\n\n" +
          `Configured strategies: ${domains.length} site(s)\n` +
          "⚡ Auto-detection is also enabled for similar gallery sites.\n\n" +
          "Send /cancel to abort.",
        parseMode: "html",
      }); return;
    }

    // ── waiting for cookies ───────────────────────────────────────────────────
    if (userState.waitingForCookies) {
      if (hasTelegramFile(msg)) {
        try {
          const buf = await this.client.downloadMedia(msg, {});
          const cookieText = buf ? buf.toString("utf8") : "";
          if (cookies.isValidCookiesText(cookieText)) {
            cookies.saveCookies(senderId, cookieText);
            userState.waitingForCookies = false;
            await msg.reply({ message: "✅ Cookies saved. Now send /video and paste the link to retry." });
          } else {
            await msg.reply({ message: "❌ Invalid cookies.txt file. Use <b>Get cookies.txt LOCALLY</b> to export.", parseMode: "html" });
          }
        } catch (err) {
          await msg.reply({ message: "❌ Could not read the uploaded file." });
        }
        return;
      }
      if (cookies.isValidCookiesText(text)) {
        cookies.saveCookies(senderId, text);
        userState.waitingForCookies = false;
        await msg.reply({ message: "✅ Cookies saved. Now send /video and paste the link to retry." });
      } else {
        await msg.reply({ message: "❌ Invalid cookies.txt. Paste ALL contents or /cancel to abort.", parseMode: "html" });
      }
      return;
    }

    // ── waiting for video URL ─────────────────────────────────────────────────
    if (userState.waitingForVideoUrl) {
      const urlMatch = text.match(URL_REGEX);
      if (urlMatch) {
        if (userState.activeJob) { await msg.reply({ message: "⏳ Another download is in progress." }); return; }
        userState.waitingForVideoUrl = false;
        await this.handleVideoUrl(msg, senderId, urlMatch[1]); return;
      }
      await msg.reply({ message: "⚠️ That doesn't look like a valid URL.\nSend the video link or /cancel to abort." }); return;
    }

    // ── waiting for filehost input ────────────────────────────────────────────
    if (userState.waitingForFilehostInput) {
      if (userState.filehostActiveJob) { await msg.reply({ message: "⏳ A download is already in progress." }); return; }
      if (hasTelegramFile(msg)) {
        userState.waitingForFilehostInput = false;
        await this.handleFilehostTelegram(msg, senderId); return;
      }
      const urlMatch = text.match(URL_REGEX);
      if (urlMatch) {
        userState.waitingForFilehostInput = false;
        await this.handleFilehostUrl(msg, senderId, urlMatch[1]); return;
      }
      await msg.reply({ message: "⚠️ Please send a direct download URL or a Telegram file.\nOr /cancel to abort." }); return;
    }

    // ── waiting for gallery URLs ──────────────────────────────────────────────
    if (userState.waitingForGalleryUrls) {
      // If in renaming state, treat this text as the new archive name
      if (userState.galleryState === "renaming") {
        if (!userState.galleryPendingJob) {
          state.reset(senderId); await msg.reply({ message: "Session expired. Send /gallery again." }); return;
        }
        if (!galleryArchiveName.isValidArchiveName(text)) {
          await msg.reply({
            message: "❌ Invalid name. Must start with a letter or digit and contain only letters, numbers, <code>- _ .</code>\n\nPlease type a valid name:",
            parseMode: "html",
          }); return;
        }
        userState.galleryPendingJob.archiveName = text;
        userState.galleryState = "pending";
        const summary = buildGallerySummary(userState.galleryPendingJob.urls, text);
        await msg.reply({ message: `✅ Archive name updated.\n\n${summary}`, parseMode: "html", buttons: galleryConfirmKeyboard() }); return;
      }

      // If already processing, ignore
      if (userState.galleryState === "processing") {
        await msg.reply({ message: "⏳ Gallery download in progress. Use the Cancel button to stop it." }); return;
      }

      // Parse URLs from the message
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("http"));
      if (lines.length === 0) {
        await msg.reply({ message: "⚠️ No valid URLs found. Send gallery URLs (one per line) or /cancel to abort." }); return;
      }

      const slug = galleryScraper.extractGalleryName(lines[0]);
      const defaultName = galleryArchiveName.buildDefaultName(slug);
      userState.galleryPendingJob = { urls: lines, archiveName: defaultName };
      userState.galleryState = "pending";

      const summary = buildGallerySummary(lines, defaultName);
      await msg.reply({ message: summary, parseMode: "html", buttons: galleryConfirmKeyboard() }); return;
    }

    // ── URL/file without a command ────────────────────────────────────────────
    if (URL_REGEX.test(text) || hasTelegramFile(msg)) {
      await this.sendHelp(msg); return;
    }

    await this.sendHelp(msg);
  }

  async sendHelp(msg) {
    const extras = [];
    if (config.drive.enabled) extras.push("☁️ <b>Google Drive</b> — upload with a public link");
    if (config.filehost.enabled) extras.push("🔗 <b>Direct Link</b> — permanent direct download URL");
    const extrasNote = extras.length ? "\n\nAfter each download you can choose:\n" + extras.join("\n") : "";
    const help =
      "🎬 <b>tg-hub</b>\n\n" +
      "<b>Commands:</b>\n" +
      "/video — download a video or audio\n" +
      "/gallery — scrape and download images from a gallery page\n" +
      "/filehost — download a file from a URL or Telegram post\n" +
      "/setvideocookies — set cookies for restricted video content\n" +
      "/clearvideocookies — delete saved video cookies\n" +
      "/cancel — cancel the current operation\n" +
      "/help — show this message" +
      extrasNote;
    await msg.reply({ message: help, parseMode: "html" });
  }

  // ── /video flow ──────────────────────────────────────────────────────────────

  async handleVideoUrl(msg, senderId, url) {
    const userState = state.get(senderId);
    const cookiesPath = cookies.getCookiesPath(senderId);
    const status = await msg.reply({ message: "🔍 Fetching video info..." });
    let info;
    try {
      info = await ytdlp.probe(url, cookiesPath);
    } catch (err) {
      if (err.cookieIssue || ytdlp.looksLikeCookieIssue(err.stderr || err.message)) {
        userState.waitingForCookies = true;
        await this.client.editMessage(msg.chatId, { message: status.id, text: "🔒 Cookies required.\n\nUse /setvideocookies, then /video again.", parseMode: "html" });
      } else {
        await this.client.editMessage(msg.chatId, { message: status.id, text: `❌ Could not fetch info:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`, parseMode: "html" });
      }
      return;
    }
    if (info.isLive) {
      await this.client.editMessage(msg.chatId, { message: status.id, text: "❌ Live streams are not supported." }); return;
    }
    userState.pendingUrl = url;
    userState.pendingFormats = info;
    userState.menuMessageId = Number(status.id);
    const durationStr = info.duration ? `⏱ ${formatDuration(info.duration)}\n` : "";
    await this.client.editMessage(msg.chatId, {
      message: status.id,
      text: `🎬 <b>${escapeHtml(info.title)}</b>\n${durationStr}\nChoose quality:`,
      parseMode: "html",
      buttons: buildButtons(buildMainMenu(info)),
    });
  }

  // ── /filehost flow — Telegram file ───────────────────────────────────────────

  async handleFilehostTelegram(msg, senderId) {
    const userState = state.get(senderId);
    userState.filehostActiveJob = true;
    const status = await msg.reply({ message: "⬇️ Downloading from Telegram... 0%" });
    const jobDir = path.join(config.downloadDir, String(senderId), `fh_${Date.now()}`);
    let lastEdit = 0;
    const editStatus = async (text) => {
      const now = Date.now(); if (now - lastEdit < 3000) return; lastEdit = now;
      try { await this.client.editMessage(msg.chatId, { message: status.id, text }); } catch (e) { /* ignore */ }
    };
    try {
      const { tmpPath, fileName, size } = await filehost.downloadFromTelegram(this.client, msg, jobDir, (pct) => editStatus(`⬇️ Downloading from Telegram... ${pct.toFixed(1)}%`));
      const buttons = buildPostDownloadButtons();
      const promptText = postDownloadPromptText(`📦 <b>${escapeHtml(fileName)}</b>`, false);
      if (buttons && promptText) {
        userState.pendingPostAction = { filePath: tmpPath, jobDir, fileName, mimeType: guessMime(tmpPath), labelLine: `📦 ${fileName}`, chatId: msg.chatId, messageId: status.id };
        await this.client.editMessage(msg.chatId, { message: status.id, text: promptText, parseMode: "html", buttons }); return;
      }
      await this.client.editMessage(msg.chatId, { message: status.id, text: `📦 ${fileName}\n✅ Downloaded (${humanSize(size)}).` });
    } catch (err) {
      try { await this.client.editMessage(msg.chatId, { message: status.id, text: `❌ Download failed:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`, parseMode: "html" }); } catch (e) { /* ignore */ }
      cleanupDir(jobDir);
    } finally {
      userState.filehostActiveJob = false;
      if (!state.get(senderId).pendingPostAction) cleanupDir(jobDir);
    }
  }

  // ── /filehost flow — direct URL ───────────────────────────────────────────────

  async handleFilehostUrl(msg, senderId, url) {
    const userState = state.get(senderId);
    userState.filehostActiveJob = true;
    const status = await msg.reply({ message: "⬇️ Downloading... 0%" });
    const jobDir = path.join(config.downloadDir, String(senderId), `fh_${Date.now()}`);
    let lastEdit = 0;
    const editStatus = async (text) => {
      const now = Date.now(); if (now - lastEdit < 3000) return; lastEdit = now;
      try { await this.client.editMessage(msg.chatId, { message: status.id, text }); } catch (e) { /* ignore */ }
    };
    try {
      const { tmpPath, fileName, size } = await filehost.downloadFromUrl(url, jobDir, (pct) => editStatus(`⬇️ Downloading... ${pct.toFixed(1)}%`));
      await this.client.editMessage(msg.chatId, { message: status.id, text: `📤 Uploading to Telegram ${humanSize(size)}...` });
      let lastUploadEdit = 0;
      await this.client.sendFile(msg.chatId, {
        file: tmpPath, caption: fileName,
        progressCallback: (uploaded, total) => {
          const now = Date.now(); if (now - lastUploadEdit < 4000) return; lastUploadEdit = now;
          if (!total) return;
          const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
          this.client.editMessage(msg.chatId, { message: status.id, text: `📤 Uploading to Telegram... ${pct}%` }).catch(() => {});
        },
      });
      const labelLine = `📦 ${fileName}`;
      const buttons = buildPostDownloadButtons();
      const promptText = postDownloadPromptText(labelLine, true);
      if (buttons && promptText) {
        userState.pendingPostAction = { filePath: tmpPath, jobDir, fileName, mimeType: guessMime(tmpPath), labelLine, chatId: msg.chatId, messageId: status.id };
        await this.client.editMessage(msg.chatId, { message: status.id, text: promptText, parseMode: "html", buttons }); return;
      }
      await this.client.editMessage(msg.chatId, { message: status.id, text: `${labelLine}\n✅ Done.` });
    } catch (err) {
      try { await this.client.editMessage(msg.chatId, { message: status.id, text: `❌ Failed:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`, parseMode: "html" }); } catch (e) { /* ignore */ }
      cleanupDir(jobDir);
    } finally {
      userState.filehostActiveJob = false;
      if (!state.get(senderId).pendingPostAction) cleanupDir(jobDir);
    }
  }

  // ── /gallery job ──────────────────────────────────────────────────────────────

  async runGalleryJob(senderId, chatId, statusMsgId, urls, archiveName) {
    const userState = state.get(senderId);
    userState.galleryState = "processing";
    const abortController = new AbortController();
    userState.galleryAbortController = abortController;
    const { signal } = abortController;

    const tempDir = path.join(config.gallery.tempDir, String(senderId), `job_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let lastStatusUpdate = 0;
    const updateStatus = async (text) => {
      const now = Date.now();
      if (now - lastStatusUpdate < UPDATE_INTERVAL_MS) return;
      lastStatusUpdate = now;
      try {
        await this.client.editMessage(chatId, { message: statusMsgId, text, parseMode: "html", buttons: galleryCancelKeyboard() });
      } catch (e) { /* ignore */ }
    };

    try {
      // ── 1. Extract images ───────────────────────────────────────────────────
      const galleries = [];
      const failedUrls = [];

      for (let i = 0; i < urls.length; i++) {
        if (signal.aborted) break;
        const url = urls[i];
        const galleryName = galleryScraper.extractGalleryName(url);
        try {
          let strategy = galleryStrategyEngine.get(url);
          let imageUrls = [];
          if (strategy) {
            imageUrls = await galleryScraper.extractImages(url, strategy);
          }
          if (!strategy || imageUrls.length === 0) {
            await updateStatus(`🧪 Trying fallback strategies for gallery ${i + 1}/${urls.length}...`);
            const result = await galleryStrategyEngine.findWorking(url, galleryScraper, {
              fallbackLimit: config.gallery.fallbackStrategyLimit,
              minImages: config.gallery.fallbackMinImages,
            });
            if (result) {
              imageUrls = result.images;
            } else {
              failedUrls.push(url);
              galleries.push({ name: galleryName, urls: [], useProxy: false });
              continue;
            }
          }
          galleries.push({ name: galleryName, urls: imageUrls, useProxy: !!(strategy && strategy.useProxy) });
          logger.info(`gallery: extracted ${imageUrls.length} images from ${url}`);
        } catch (err) {
          logger.warn(`gallery: failed to extract: ${url}`, err.message);
          failedUrls.push(url);
          galleries.push({ name: galleryName, urls: [], useProxy: false });
        }
        await updateStatus(`🔎 Extracting images... (${i + 1}/${urls.length} done)`);
      }

      const totalImages = galleries.reduce((s, g) => s + g.urls.length, 0);
      if (totalImages === 0) {
        throw new Error("No images found in any of the provided galleries.");
      }

      if (failedUrls.length > 0) {
        try {
          await this.client.sendMessage(chatId, {
            message: `⚠️ Could not extract images from ${failedUrls.length} URL(s). Continuing with the rest...`,
          });
        } catch (e) { /* ignore */ }
      }

      const successfulGalleries = galleries.filter((g) => g.urls.length > 0).length;
      await updateStatus(
        `✅ Found ${totalImages} images across ${successfulGalleries} gallery(ies).\n⬇️ Downloading images...`
      );

      // ── 2. Download images ──────────────────────────────────────────────────
      const downloadResult = await galleryImageDownloader.downloadMultipleGalleries(
        galleries.filter((g) => g.urls.length > 0),
        tempDir,
        (progress) => {
          updateStatus(
            `⬇️ Downloading gallery ${progress.completedGalleries + 1}/${progress.totalGalleries}\n` +
            `Current: ${progress.galleryName}\n` +
            `Progress: ${progress.galleryProgress.current}/${progress.galleryProgress.total} images`
          );
        },
        signal,
      );

      if (downloadResult.successImages === 0) {
        try {
          await this.client.editMessage(chatId, {
            message: statusMsgId,
            text: signal.aborted ? "⚠️ Cancelled. No images were downloaded." : "❌ Failed to download any images.",
          });
        } catch (e) { /* ignore */ }
        return;
      }

      // ── 3. Create ZIP ───────────────────────────────────────────────────────
      try {
        await this.client.editMessage(chatId, {
          message: statusMsgId,
          text: signal.aborted
            ? `⚠️ Cancelled. Packaging ${downloadResult.successImages} images...`
            : "📦 Creating ZIP archive...",
        });
      } catch (e) { /* ignore */ }

      const finalName = galleryArchiveName.withRandomSuffix(archiveName);
      const zipPath = await galleryZipCreator.createZip(tempDir, finalName, config.gallery.tempDir);
      const zipFileName = path.basename(zipPath);
      const zipStat = fs.statSync(zipPath);
      const statusLabel = signal.aborted ? "⚠️ Partial download" : "✅ Download complete";

      // ── 4. Upload to Telegram ───────────────────────────────────────────────
      try {
        await this.client.editMessage(chatId, {
          message: statusMsgId,
          text: `📤 Uploading <b>${escapeHtml(zipFileName)}</b> to Telegram (${humanSize(zipStat.size)})...`,
          parseMode: "html",
        });
      } catch (e) { /* ignore */ }

      let lastUploadEdit = 0;
      await this.client.sendFile(chatId, {
        file: zipPath,
        caption: `📦 ${zipFileName}\n${statusLabel}\n🖼 ${downloadResult.successImages} images | 💾 ${humanSize(zipStat.size)}`,
        forceDocument: true,
        progressCallback: (uploaded, total) => {
          const now = Date.now();
          if (now - lastUploadEdit < 4000) return;
          lastUploadEdit = now;
          if (!total) return;
          const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
          this.client.editMessage(chatId, {
            message: statusMsgId,
            text: `📤 Uploading <b>${escapeHtml(zipFileName)}</b>... ${pct}%`,
            parseMode: "html",
          }).catch(() => {});
        },
      });

      // ── 5. Post-action buttons ──────────────────────────────────────────────
      const labelLine = `🖼 ${zipFileName}`;
      const buttons = buildPostDownloadButtons();
      const promptText = postDownloadPromptText(labelLine, true);

      if (buttons && promptText) {
        userState.pendingPostAction = {
          filePath: zipPath,
          jobDir: path.dirname(zipPath),
          fileName: zipFileName,
          mimeType: "application/zip",
          labelLine,
          chatId,
          messageId: statusMsgId,
        };
        try {
          await this.client.editMessage(chatId, { message: statusMsgId, text: promptText, parseMode: "html", buttons });
        } catch (e) { /* ignore */ }
      } else {
        try { await this.client.editMessage(chatId, { message: statusMsgId, text: `${labelLine}\n✅ Done.` }); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
      }

      logger.info(`gallery: job complete for user ${senderId}: ${zipFileName}`);
    } catch (err) {
      logger.error(`gallery: job failed for user ${senderId}:`, err.message);
      try {
        await this.client.editMessage(chatId, {
          message: statusMsgId,
          text: `❌ Gallery download failed:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>\n\nPlease check your URLs and try again.`,
          parseMode: "html",
        });
      } catch (e) { /* ignore */ }
    } finally {
      // Clean up temp image staging dir (not the zip — post-action needs it)
      cleanupDir(tempDir);
      if (!state.get(senderId).pendingPostAction) {
        // Also clean zip if no post-action
        try { fs.rmSync(path.join(config.gallery.tempDir, String(senderId)), { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
      userState.galleryState = null;
      userState.galleryAbortController = null;
      userState.galleryPendingJob = null;
      userState.waitingForGalleryUrls = false;
    }
  }

  // ── callback handler ──────────────────────────────────────────────────────────

  async onCallback(event) {
    const rawId = event.senderId || (event.query && event.query.userId) || event.userId;
    const senderId = rawId ? Number(rawId.toString()) : null;
    if (!senderId || !auth.isAllowed(senderId)) {
      await event.answer({ message: "⛔ Not authorized.", alert: true }); return;
    }

    const data = event.data ? event.data.toString() : "";
    const userState = state.get(senderId);

    // ── gallery callbacks ─────────────────────────────────────────────────────
    if (data.startsWith("gallery:")) {
      const action = data.slice(8);

      if (action === "start") {
        if (!userState.galleryPendingJob) {
          await event.answer({ message: "Session expired.", alert: true }); return;
        }
        await event.answer({ message: "Starting..." });
        try {
          await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: "🚀 Starting gallery download..." });
        } catch (e) { /* ignore */ }
        const { urls, archiveName } = userState.galleryPendingJob;
        // Run async — don't await so callback returns immediately
        this.safeHandle(() => this.runGalleryJob(senderId, event.chatId, Number(event.messageId), urls, archiveName));
        return;
      }

      if (action === "rename") {
        if (!userState.galleryPendingJob) {
          await event.answer({ message: "Session expired.", alert: true }); return;
        }
        userState.galleryState = "renaming";
        await event.answer({});
        try {
          await this.client.editMessage(event.chatId, {
            message: Number(event.messageId),
            text:
              "✏️ Type your custom archive name:\n\n" +
              "Allowed: letters, numbers, <code>- _ .</code> (must start with letter/digit)\n" +
              "Example: <code>my-gallery_2026</code>\n\n" +
              "Or send /cancel to abort.",
            parseMode: "html",
          });
        } catch (e) { /* ignore */ }
        return;
      }

      if (action === "cancel") {
        state.reset(senderId);
        await event.answer({ message: "Cancelled." });
        try { await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: "✅ Cancelled." }); } catch (e) { /* ignore */ }
        return;
      }

      if (action === "abort") {
        if (userState.galleryAbortController) {
          userState.galleryAbortController.abort();
          await event.answer({ message: "Cancelling..." });
        } else {
          await event.answer({ message: "No active download." });
        }
        return;
      }

      await event.answer({}); return;
    }

    // ── post-download action ──────────────────────────────────────────────────
    if (data.startsWith("post:")) {
      if (!userState.pendingPostAction) {
        await event.answer({ message: "Session expired.", alert: true }); return;
      }
      const pending = userState.pendingPostAction;
      userState.pendingPostAction = null;
      const action = data.slice(5);
      await event.answer({ message: action === "none" ? "OK" : "Processing..." });
      await this.handlePostAction(action, pending);
      return;
    }

    if (data === "cancel") {
      userState.pendingUrl = null;
      userState.pendingFormats = null;
      try { await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: "❌ Cancelled." }); } catch (e) { /* ignore */ }
      await event.answer({ message: "Cancelled" }); return;
    }

    if (!userState.pendingUrl || !userState.pendingFormats) {
      await event.answer({ message: "Session expired. Send /video to start again.", alert: true }); return;
    }

    if (userState.activeJob) {
      await event.answer({ message: "Another download is already running.", alert: true }); return;
    }

    if (data === "all_v" || data === "all_a" || data === "back" || data.startsWith("pg:")) {
      const info = userState.pendingFormats;
      let rows;
      if (data === "all_v") { userState.menuView = "v"; userState.menuPage = 0; rows = buildAllVideoMenu(info, 0); }
      else if (data === "all_a") { userState.menuView = "a"; userState.menuPage = 0; rows = buildAllAudioMenu(info, 0); }
      else if (data === "back") { userState.menuView = null; userState.menuPage = 0; rows = buildMainMenu(info); }
      else {
        const [, view, pageStr] = data.split(":");
        const page = Number(pageStr) || 0;
        userState.menuView = view; userState.menuPage = page;
        rows = view === "v" ? buildAllVideoMenu(info, page) : buildAllAudioMenu(info, page);
      }
      try {
        await this.client.editMessage(event.chatId, {
          message: Number(event.messageId),
          text: `🎬 <b>${escapeHtml(info.title)}</b>\n${info.duration ? `⏱ ${formatDuration(info.duration)}\n` : ""}\nChoose quality:`,
          parseMode: "html",
          buttons: buildButtons(rows),
        });
      } catch (e) { /* ignore */ }
      await event.answer({}); return;
    }

    const parts = data.split(":");
    const kind = parts[0];
    if (kind !== "a" && kind !== "v") {
      await event.answer({ message: "Unknown action.", alert: true }); return;
    }

    userState.activeJob = true;
    const url = userState.pendingUrl;
    const probeInfo = userState.pendingFormats;
    userState.pendingUrl = null;
    userState.pendingFormats = null;

    try {
      await event.answer({ message: "Starting..." });
      await this.runVideoJob(event, senderId, url, kind, parts.slice(1), probeInfo);
    } catch (err) {
      logger.error(`Video job failed for ${senderId}:`, err.message);
      await this.notifyJobError(event, senderId, err);
    } finally {
      userState.activeJob = false;
    }
  }

  // ── video download job ────────────────────────────────────────────────────────

  async runVideoJob(event, senderId, url, kind, parts, probeInfo) {
    const chatId = event.chatId;
    const messageId = Number(event.messageId);
    const cookiesPath = cookies.getCookiesPath(senderId);
    const jobDir = path.join(config.downloadDir, String(senderId), Date.now().toString());

    let audioMode = null, audioBitrate = 0, audioFormatId = "";
    let videoHeight = 0, videoFormatId = "";
    let labelLine;

    if (kind === "a") {
      const sub = parts[0] || "mp3";
      if (sub === "idx") {
        audioMode = "original";
        const idx = Number(parts[1]);
        const af = probeInfo && Array.isArray(probeInfo.audioFormats) && probeInfo.audioFormats[idx];
        if (af && af.formatId) {
          audioFormatId = af.formatId;
          const meta = [af.codec, af.abr ? `${Math.round(af.abr)}k` : ""].filter(Boolean).join(" ");
          labelLine = `🎧 ${af.ext || "audio"}${meta ? ` (${meta})` : ""}`;
        } else { audioMode = "mp3"; labelLine = "🎵 MP3 (Best)"; }
      } else if (sub === "orig") {
        audioMode = "original";
        if (probeInfo && probeInfo.bestAudio && probeInfo.bestAudio.formatId) {
          audioFormatId = probeInfo.bestAudio.formatId;
          labelLine = `🎧 Original (${probeInfo.bestAudio.ext || "audio"})`;
        } else { labelLine = "🎧 Original audio"; }
      } else {
        audioMode = "mp3";
        audioBitrate = parts[1] ? Number(parts[1]) : 0;
        labelLine = audioBitrate ? `🎵 MP3 ${audioBitrate}k` : "🎵 MP3 (Best)";
      }
    } else {
      if (parts[0] === "idx") {
        const idx = Number(parts[1]);
        const vf = probeInfo && Array.isArray(probeInfo.videoFormats) && probeInfo.videoFormats[idx];
        if (vf && vf.formatId) {
          videoFormatId = vf.formatId;
          const dim = vf.width && vf.height ? `${vf.width}x${vf.height}` : vf.height ? `${vf.height}p` : "video";
          labelLine = `🎬 ${vf.ext || ""} ${dim}`.trim();
        } else { videoHeight = 0; labelLine = "🎬 Best video"; }
      } else {
        videoHeight = Number(parts[0]) || 0;
        labelLine = videoHeight > 0 ? `🎬 ${videoHeight}p` : "🎬 Best video";
      }
    }

    let lastEdit = 0;
    const editStatus = async (text) => {
      const now = Date.now(); if (now - lastEdit < 3000) return; lastEdit = now;
      try { await this.client.editMessage(chatId, { message: messageId, text }); } catch (e) { /* ignore */ }
    };

    await editStatus(`${labelLine}\n⬇️ Downloading... 0%`);

    let outputFile;
    try {
      if (kind === "a") {
        outputFile = await ytdlp.downloadAudio({ url, jobDir, cookiesPath, mode: audioMode, bitrateKbps: audioBitrate, formatId: audioFormatId, onProgress: (p) => editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`) });
      } else {
        outputFile = await ytdlp.downloadVideo({ url, jobDir, maxHeight: videoHeight, formatId: videoFormatId, cookiesPath, onProgress: (p) => editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`) });
      }

      const stat = fs.statSync(outputFile);
      if (stat.size > config.maxUploadBytes) {
        throw new Error(`File too large (${humanSize(stat.size)} > ${humanSize(config.maxUploadBytes)}). Try a lower quality.`);
      }

      await this.client.editMessage(chatId, { message: messageId, text: `${labelLine}\n📤 Uploading ${humanSize(stat.size)}...` });

      const isAudio = kind === "a";
      const fileName = path.basename(outputFile);
      const attributes = isAudio ? [new Api.DocumentAttributeAudio({ duration: 0, title: stripExt(fileName) })] : undefined;

      let lastUploadEdit = 0;
      await this.client.sendFile(chatId, {
        file: outputFile, caption: stripExt(fileName), supportsStreaming: !isAudio, attributes,
        progressCallback: (uploaded, total) => {
          const now = Date.now(); if (now - lastUploadEdit < 4000) return; lastUploadEdit = now;
          if (!total) return;
          const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
          this.client.editMessage(chatId, { message: messageId, text: `${labelLine}\n📤 Uploading... ${pct}%` }).catch(() => {});
        },
      });

      const buttons = buildPostDownloadButtons();
      const promptText = postDownloadPromptText(labelLine, true);
      if (buttons && promptText) {
        const userState = state.get(senderId);
        userState.pendingPostAction = { filePath: outputFile, jobDir, fileName, mimeType: guessMime(outputFile), labelLine, chatId, messageId };
        await this.client.editMessage(chatId, { message: messageId, text: promptText, parseMode: "html", buttons }); return;
      }
      await this.client.editMessage(chatId, { message: messageId, text: `${labelLine}\n✅ Done.` });
    } finally {
      if (!state.get(senderId).pendingPostAction) cleanupDir(jobDir);
    }
  }

  // ── shared post-download action ───────────────────────────────────────────────

  async handlePostAction(action, pending) {
    const { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId } = pending;
    const edit = async (text, parseMode) => {
      try { await this.client.editMessage(chatId, { message: messageId, text, parseMode: parseMode || undefined }); } catch (e) { /* ignore */ }
    };

    if (action === "none") {
      await edit(`${labelLine}\n✅ Done.`);
      cleanupDir(jobDir);
      // Also delete single file if it's outside jobDir (e.g. gallery zip in tempDir)
      if (!filePath.startsWith(jobDir)) { try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ } }
      return;
    }

    const doDrive = async () => {
      await edit(`${labelLine}\n☁️ Uploading to Google Drive... 0%`);
      let lastEdit = 0;
      const fileData = await drive.uploadFile({
        filePath, fileName, mimeType, parentId: config.drive.folderId,
        onProgress: async (pct) => {
          const now = Date.now(); if (now - lastEdit < 3000) return; lastEdit = now;
          await edit(`${labelLine}\n☁️ Uploading to Google Drive... ${pct.toFixed(1)}%`);
        },
      });
      await drive.makePublic(fileData.id);
      logger.info(`Drive upload done + public: ${fileData.id} (${fileName})`);
      return drive.buildLinks(fileData.id, fileData.mimeType);
    };

    const doLink = async () => {
      const result = await filehost.registerFile(filePath, fileName);
      logger.info(`Filehost registered: ${result.url}`);
      return result.url;
    };

    const cleanup = () => {
      cleanupDir(jobDir);
      if (!filePath.startsWith(jobDir)) { try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ } }
    };

    try {
      if (action === "drive") {
        const links = await doDrive();
        await edit(`${labelLine}\n✅ Done.\n\n☁️ <b>Google Drive (public):</b>\n<a href="${links.view}">View</a> | <a href="${links.download}">Download</a>`, "html");
        cleanup();
      } else if (action === "link") {
        await edit(`${labelLine}\n🔗 Registering direct link...`);
        const url = await doLink();
        await edit(`${labelLine}\n✅ Done.\n\n🔗 <b>Direct Link:</b>\n<code>${escapeHtml(url)}</code>`, "html");
        cleanup();
      } else if (action === "both") {
        await edit(`${labelLine}\n⏳ Processing...`);
        const driveLinks = await doDrive().catch((e) => { logger.error("Drive upload failed:", e.message); return null; });
        const directUrl = await doLink();
        let resultText = `${labelLine}\n✅ Done.\n\n`;
        if (driveLinks) resultText += `☁️ <b>Google Drive:</b> <a href="${driveLinks.view}">View</a> | <a href="${driveLinks.download}">Download</a>\n`;
        else resultText += `☁️ Google Drive upload failed.\n`;
        resultText += `🔗 <b>Direct Link:</b>\n<code>${escapeHtml(directUrl)}</code>`;
        await edit(resultText, "html");
        cleanup();
      }
    } catch (err) {
      logger.error(`Post-action "${action}" failed:`, err.message);
      const hint = drive.isInvalidGrant(err) ? "\n\nRun <code>node setup-drive.js</code> to refresh the token." : "";
      await edit(`${labelLine}\n✅ Sent to Telegram.\n\n❌ Post-action failed: <pre>${escapeHtml(truncate(err.message, 300))}</pre>${hint}`, "html");
      cleanup();
    }
  }

  async notifyJobError(event, senderId, err) {
    const userState = state.get(senderId);
    if (err.cookieIssue || ytdlp.looksLikeCookieIssue(err.stderr || err.message)) {
      userState.waitingForCookies = true;
      try { await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: "🔒 Cookies required.\n\nUse /setvideocookies, then /video again.", parseMode: "html" }); } catch (e) { /* ignore */ }
      return;
    }
    try { await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: `❌ Failed:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`, parseMode: "html" }); } catch (e) { /* ignore */ }
  }
}

module.exports = { Bot };
