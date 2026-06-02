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
const {
  buildMainMenu,
  buildAllVideoMenu,
  buildAllAudioMenu,
} = require("./format-menu");

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

// All commands — used to detect "user typed a command while in a flow"
const ALL_COMMANDS = [
  "/start", "/help", "/video", "/cancel",
  "/setvideocookies", "/clearvideocookies",
];

function isCommand(text) {
  return ALL_COMMANDS.some((cmd) => text.startsWith(cmd));
}

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
    ".flac": "audio/flac", ".wav": "audio/wav",
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

function buildPostDownloadButtons() {
  const d = config.drive.enabled;
  const f = config.filehost.enabled;
  if (d && f) {
    return [
      [
        Button.inline("☁️ Google Drive", Buffer.from("post:drive")),
        Button.inline("🔗 Direct Link", Buffer.from("post:link")),
      ],
      [
        Button.inline("☁️🔗 Both", Buffer.from("post:both")),
        Button.inline("❌ None", Buffer.from("post:none")),
      ],
    ];
  }
  if (d) return [[Button.inline("☁️ Upload to Drive", Buffer.from("post:drive")), Button.inline("❌ No thanks", Buffer.from("post:none"))]];
  if (f) return [[Button.inline("🔗 Get Direct Link", Buffer.from("post:link")), Button.inline("❌ No thanks", Buffer.from("post:none"))]];
  return null;
}

function postDownloadPromptText(labelLine) {
  const d = config.drive.enabled;
  const f = config.filehost.enabled;
  if (d && f) return `${labelLine}\n✅ Sent to Telegram.\n\nWhat else would you like?`;
  if (d) return `${labelLine}\n✅ Sent to Telegram.\n\n☁️ Upload to Google Drive (public link)?`;
  if (f) return `${labelLine}\n✅ Sent to Telegram.\n\n🔗 Get a direct download link?`;
  return null;
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
    this.registerBotCommands().catch((err) => {
      logger.warn(`Failed to register bot commands: ${err.message}`);
    });
  }

  async registerBotCommands() {
    const commands = [
      { command: "start",              description: "Start the bot" },
      { command: "help",               description: "Show usage instructions" },
      { command: "video",              description: "Download a video or audio" },
      { command: "setvideocookies",    description: "Set cookies for restricted video content" },
      { command: "clearvideocookies",  description: "Clear saved video cookies" },
      { command: "cancel",             description: "Cancel the current operation" },
    ].map((c) => new Api.BotCommand({ command: c.command, description: c.description }));
    await this.client.invoke(
      new Api.bots.SetBotCommands({
        scope: new Api.BotCommandScopeDefault(),
        langCode: "",
        commands,
      }),
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
      await msg.reply({
        message: `⛔ You are not authorized to use this bot.\nYour user ID: <code>${senderId}</code>`,
        parseMode: "html",
      });
      logger.warn(`Unauthorized access from user ${senderId}`);
      return;
    }

    const text = (msg.message || "").trim();
    const userState = state.get(senderId);

    // ── document upload (cookies file) ──────────────────────────────────────
    if (msg.document) {
      await this.handleDocument(msg, senderId);
      return;
    }

    // ── /start, /help ────────────────────────────────────────────────────────
    if (text.startsWith("/start") || text.startsWith("/help")) {
      state.reset(senderId);
      await this.sendHelp(msg);
      return;
    }

    // ── /cancel — resets everything ──────────────────────────────────────────
    if (text.startsWith("/cancel")) {
      state.reset(senderId);
      await msg.reply({ message: "✅ Cancelled. Send /video to start a new download." });
      return;
    }

    // ── /video — enter video download flow ───────────────────────────────────
    if (text.startsWith("/video")) {
      // If already in a flow, reset first (last command wins)
      state.reset(senderId);
      const fresh = state.get(senderId);
      fresh.waitingForVideoUrl = true;
      await msg.reply({
        message:
          "🎬 <b>Video Download</b>\n\n" +
          "Send me the video URL (YouTube, Instagram, Twitter, etc.).\n\n" +
          "Send /cancel to abort.",
        parseMode: "html",
      });
      return;
    }

    // ── /setvideocookies ─────────────────────────────────────────────────────
    if (text.startsWith("/setvideocookies")) {
      // Resets any active flow, enters cookie waiting mode
      state.reset(senderId);
      const fresh = state.get(senderId);
      fresh.waitingForCookies = true;
      await msg.reply({
        message:
          "🍪 <b>Set Video Cookies</b>\n\n" +
          "To provide cookies, choose one of these methods:\n\n" +
          "<b>Method 1 — Paste as text:</b>\n" +
          "1. Install the <b>Get cookies.txt LOCALLY</b> extension in your browser.\n" +
          "2. Log in to the site and open the video page.\n" +
          "3. Click the extension and export cookies.\n" +
          "4. Open the downloaded file, copy ALL contents, and paste here.\n\n" +
          "<b>Method 2 — Send as file:</b>\n" +
          "Same as above, but send the <code>cookies.txt</code> file directly.\n\n" +
          "Send /cancel to abort.",
        parseMode: "html",
      });
      return;
    }

    // ── /clearvideocookies ───────────────────────────────────────────────────
    if (text.startsWith("/clearvideocookies")) {
      cookies.deleteCookies(senderId);
      // Reset cookie waiting state but preserve any active flow
      userState.waitingForCookies = false;
      await msg.reply({ message: "🗑 Video cookies cleared." });
      return;
    }

    // ── waiting for cookies (paste or file) ──────────────────────────────────
    if (userState.waitingForCookies) {
      if (cookies.isValidCookiesText(text)) {
        cookies.saveCookies(senderId, text);
        userState.waitingForCookies = false;
        await msg.reply({
          message: "✅ Cookies saved. Now send /video and paste the link to retry.",
        });
      } else {
        await msg.reply({
          message:
            "❌ This does not look like a valid cookies.txt file.\n" +
            "Use the <b>Get cookies.txt LOCALLY</b> extension, click <b>Export</b>, " +
            "copy ALL its contents, and paste here.\n\nOr send /cancel to abort.",
          parseMode: "html",
        });
      }
      return;
    }

    // ── waiting for video URL ────────────────────────────────────────────────
    if (userState.waitingForVideoUrl) {
      const urlMatch = text.match(URL_REGEX);

      if (urlMatch) {
        if (userState.activeJob) {
          await msg.reply({ message: "⏳ Another download is in progress. Please wait." });
          return;
        }
        userState.waitingForVideoUrl = false;
        await this.handleUrl(msg, senderId, urlMatch[1]);
        return;
      }

      // Not a URL and not a command → remind
      await msg.reply({
        message: "⚠️ That doesn't look like a valid URL.\nSend the video link or /cancel to abort.",
      });
      return;
    }

    // ── URL sent without /video first ────────────────────────────────────────
    if (URL_REGEX.test(text)) {
      await this.sendHelp(msg);
      return;
    }

    // ── anything else ────────────────────────────────────────────────────────
    await this.sendHelp(msg);
  }

  async handleDocument(msg, senderId) {
    const userState = state.get(senderId);
    // Only accept cookie files when explicitly waiting for them
    if (!userState.waitingForCookies) {
      await msg.reply({
        message: "Use /setvideocookies first, then send the cookies.txt file.",
      });
      return;
    }
    try {
      const buf = await this.client.downloadMedia(msg, {});
      const text = buf ? buf.toString("utf8") : "";
      if (cookies.isValidCookiesText(text)) {
        cookies.saveCookies(senderId, text);
        userState.waitingForCookies = false;
        await msg.reply({ message: "✅ Cookies saved. Now send /video and paste the link to retry." });
      } else {
        await msg.reply({
          message:
            "❌ The uploaded file does not look like a valid cookies.txt file.\n" +
            "Please use the <b>Get cookies.txt LOCALLY</b> extension to export it.",
          parseMode: "html",
        });
      }
    } catch (err) {
      logger.error("Failed to read uploaded document:", err.message);
      await msg.reply({ message: "❌ Could not read the uploaded file." });
    }
  }

  async sendHelp(msg) {
    const extras = [];
    if (config.drive.enabled) extras.push("☁️ <b>Google Drive</b> — upload with a public link");
    if (config.filehost.enabled) extras.push("🔗 <b>Direct Link</b> — permanent direct download URL");
    const extrasNote = extras.length
      ? "\n\nAfter each download you can choose:\n" + extras.join("\n")
      : "";
    const help =
      "🎬 <b>tg-hub</b>\n\n" +
      "<b>Commands:</b>\n" +
      "/video — download a video or audio\n" +
      "/setvideocookies — set cookies for age-restricted or login-required content\n" +
      "/clearvideocookies — delete saved cookies\n" +
      "/cancel — cancel the current operation\n" +
      "/help — show this message" +
      extrasNote;
    await msg.reply({ message: help, parseMode: "html" });
  }

  async handleUrl(msg, senderId, url) {
    const userState = state.get(senderId);
    const cookiesPath = cookies.getCookiesPath(senderId);
    const status = await msg.reply({ message: "🔍 Fetching video info..." });
    let info;
    try {
      info = await ytdlp.probe(url, cookiesPath);
    } catch (err) {
      logger.warn(`Probe failed for ${senderId}: ${err.message}`);
      if (err.cookieIssue || ytdlp.looksLikeCookieIssue(err.stderr || err.message)) {
        userState.waitingForCookies = true;
        userState.pendingUrl = url;
        await this.client.editMessage(msg.chatId, {
          message: status.id,
          text:
            "🔒 This URL requires cookies (login / age restriction / region lock).\n\n" +
            "Use /setvideocookies to provide your cookies, then /video again.",
          parseMode: "html",
        });
      } else {
        await this.client.editMessage(msg.chatId, {
          message: status.id,
          text: `❌ Could not fetch info:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`,
          parseMode: "html",
        });
      }
      return;
    }

    if (info.isLive) {
      await this.client.editMessage(msg.chatId, { message: status.id, text: "❌ Live streams are not supported." });
      return;
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

  async onCallback(event) {
    const rawId = event.senderId || (event.query && event.query.userId) || event.userId;
    const senderId = rawId ? Number(rawId.toString()) : null;
    if (!senderId || !auth.isAllowed(senderId)) {
      await event.answer({ message: "⛔ Not authorized.", alert: true }); return;
    }

    const data = event.data ? event.data.toString() : "";
    const userState = state.get(senderId);

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
      try {
        await this.client.editMessage(event.chatId, { message: Number(event.messageId), text: "❌ Cancelled." });
      } catch (e) { /* ignore */ }
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
      await this.runJob(event, senderId, url, kind, parts.slice(1), probeInfo);
    } catch (err) {
      logger.error(`Job failed for ${senderId}:`, err.message);
      await this.notifyJobError(event, senderId, err);
    } finally {
      userState.activeJob = false;
    }
  }

  async runJob(event, senderId, url, kind, parts, probeInfo) {
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
      const now = Date.now();
      if (now - lastEdit < 3000) return;
      lastEdit = now;
      try { await this.client.editMessage(chatId, { message: messageId, text }); } catch (e) { /* ignore */ }
    };

    await editStatus(`${labelLine}\n⬇️ Downloading... 0%`);

    let outputFile;
    try {
      if (kind === "a") {
        outputFile = await ytdlp.downloadAudio({
          url, jobDir, cookiesPath, mode: audioMode, bitrateKbps: audioBitrate,
          formatId: audioFormatId, onProgress: (p) => editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`),
        });
      } else {
        outputFile = await ytdlp.downloadVideo({
          url, jobDir, maxHeight: videoHeight, formatId: videoFormatId, cookiesPath,
          onProgress: (p) => editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`),
        });
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
        file: outputFile,
        caption: stripExt(fileName),
        supportsStreaming: !isAudio,
        attributes,
        progressCallback: (uploaded, total) => {
          const now = Date.now();
          if (now - lastUploadEdit < 4000) return;
          lastUploadEdit = now;
          if (!total) return;
          const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
          this.client.editMessage(chatId, { message: messageId, text: `${labelLine}\n📤 Uploading... ${pct}%` }).catch(() => {});
        },
      });

      const buttons = buildPostDownloadButtons();
      const promptText = postDownloadPromptText(labelLine);

      if (buttons && promptText) {
        const userState = state.get(senderId);
        userState.pendingPostAction = { filePath: outputFile, jobDir, fileName, mimeType: guessMime(outputFile), labelLine, chatId, messageId };
        await this.client.editMessage(chatId, { message: messageId, text: promptText, buttons });
        return;
      }

      await this.client.editMessage(chatId, { message: messageId, text: `${labelLine}\n✅ Done.` });
    } finally {
      const userState = state.get(senderId);
      if (!userState.pendingPostAction) {
        cleanupDir(jobDir);
      }
    }
  }

  async handlePostAction(action, pending) {
    const { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId } = pending;

    const edit = async (text, parseMode) => {
      try { await this.client.editMessage(chatId, { message: messageId, text, parseMode: parseMode || undefined }); }
      catch (e) { /* ignore */ }
    };

    if (action === "none") {
      await edit(`${labelLine}\n✅ Done.`);
      cleanupDir(jobDir);
      return;
    }

    const doDrive = async () => {
      await edit(`${labelLine}\n☁️ Uploading to Google Drive... 0%`);
      let lastEdit = 0;
      const fileData = await drive.uploadFile({
        filePath, fileName, mimeType, parentId: config.drive.folderId,
        onProgress: async (pct) => {
          const now = Date.now();
          if (now - lastEdit < 3000) return;
          lastEdit = now;
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

    try {
      if (action === "drive") {
        const links = await doDrive();
        await edit(`${labelLine}\n✅ Done.\n\n☁️ <b>Google Drive (public):</b>\n<a href="${links.view}">View</a> | <a href="${links.download}">Download</a>`, "html");
        cleanupDir(jobDir);
      } else if (action === "link") {
        await edit(`${labelLine}\n🔗 Registering direct link...`);
        const url = await doLink();
        await edit(`${labelLine}\n✅ Done.\n\n🔗 <b>Direct Link:</b>\n<code>${escapeHtml(url)}</code>`, "html");
        cleanupDir(jobDir);
      } else if (action === "both") {
        await edit(`${labelLine}\n⏳ Processing...`);
        const driveLinks = await doDrive().catch((e) => { logger.error("Drive upload failed:", e.message); return null; });
        const directUrl = await doLink();
        let resultText = `${labelLine}\n✅ Done.\n\n`;
        if (driveLinks) {
          resultText += `☁️ <b>Google Drive:</b> <a href="${driveLinks.view}">View</a> | <a href="${driveLinks.download}">Download</a>\n`;
        } else {
          resultText += `☁️ Google Drive upload failed.\n`;
        }
        resultText += `🔗 <b>Direct Link:</b>\n<code>${escapeHtml(directUrl)}</code>`;
        await edit(resultText, "html");
        cleanupDir(jobDir);
      }
    } catch (err) {
      logger.error(`Post-action "${action}" failed:`, err.message);
      const hint = drive.isInvalidGrant(err) ? "\n\nRun <code>node setup-drive.js</code> to refresh the token." : "";
      await edit(`${labelLine}\n✅ Sent to Telegram.\n\n❌ Post-action failed: <pre>${escapeHtml(truncate(err.message, 300))}</pre>${hint}`, "html");
      cleanupDir(jobDir);
    }
  }

  async notifyJobError(event, senderId, err) {
    const userState = state.get(senderId);
    if (err.cookieIssue || ytdlp.looksLikeCookieIssue(err.stderr || err.message)) {
      userState.waitingForCookies = true;
      try {
        await this.client.editMessage(event.chatId, {
          message: Number(event.messageId),
          text: "🔒 Cookies are required for this content.\n\nUse /setvideocookies to provide your cookies, then /video again.",
          parseMode: "html",
        });
      } catch (e) { /* ignore */ }
      return;
    }
    try {
      await this.client.editMessage(event.chatId, {
        message: Number(event.messageId),
        text: `❌ Failed:\n<pre>${escapeHtml(truncate(err.message, 400))}</pre>`,
        parseMode: "html",
      });
    } catch (e) { /* ignore */ }
  }
}

module.exports = { Bot };
