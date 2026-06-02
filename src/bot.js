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
const {
  buildMainMenu,
  buildAllVideoMenu,
  buildAllAudioMenu,
} = require("./format-menu");

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function buildButtons(rows) {
  return rows.map((row) =>
    row.map((b) => Button.inline(b.label, Buffer.from(b.data))),
  );
}

function humanSize(bytes) {
  if (!bytes && bytes !== 0) return "?";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Guess MIME type from file extension
function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
  };
  return map[ext] || "application/octet-stream";
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
      { command: "start", description: "Start the bot" },
      { command: "help", description: "Show usage instructions" },
      { command: "cancel", description: "Cancel the current operation" },
      { command: "clearcookies", description: "Clear saved cookies" },
    ].map(
      (c) =>
        new Api.BotCommand({ command: c.command, description: c.description }),
    );
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
    try {
      await fn();
    } catch (err) {
      logger.error("Handler error:", err && err.stack ? err.stack : err);
    }
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

    if (msg.document) {
      await this.handleDocument(msg, senderId);
      return;
    }

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await this.sendHelp(msg);
      return;
    }

    if (text.startsWith("/cancel")) {
      state.reset(senderId);
      await msg.reply({ message: "✅ State reset. Send a new link." });
      return;
    }

    if (text.startsWith("/clearcookies")) {
      cookies.deleteCookies(senderId);
      userState.waitingForCookies = false;
      await msg.reply({ message: "🗑 Cookies cleared." });
      return;
    }

    const urlMatch = text.match(URL_REGEX);

    if (urlMatch) {
      userState.waitingForCookies = false;
      const url = urlMatch[1];
      if (userState.activeJob) {
        await msg.reply({
          message: "⏳ Another download is in progress. Please wait.",
        });
        return;
      }
      await this.handleUrl(msg, senderId, url);
      return;
    }

    if (userState.waitingForCookies) {
      if (cookies.isValidCookiesText(text)) {
        cookies.saveCookies(senderId, text);
        userState.waitingForCookies = false;
        await msg.reply({
          message:
            "✅ Cookies saved. Now send the link again to retry the download.",
        });
      } else {
        await msg.reply({
          message:
            "❌ This does not look like a valid cookies.txt file.\n" +
            "Use the <b>Get cookies.txt LOCALLY</b> extension, click <b>Export</b>, " +
            "open the downloaded file in a text editor, copy ALL its contents, " +
            "and paste here as a single message.\n\n" +
            "Or send /cancel to abort.",
          parseMode: "html",
        });
      }
      return;
    }

    await msg.reply({
      message:
        "Send me a video URL (YouTube, etc.) and I will offer download options.\n" +
        "Type /help for more info.",
    });
  }

  async handleDocument(msg, senderId) {
    try {
      const buf = await this.client.downloadMedia(msg, {});
      const text = buf ? buf.toString("utf8") : "";
      if (cookies.isValidCookiesText(text)) {
        cookies.saveCookies(senderId, text);
        const userState = state.get(senderId);
        userState.waitingForCookies = false;
        await msg.reply({
          message:
            "✅ Cookies saved from file. Now send the link again to retry.",
        });
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
      await msg.reply({
        message: "❌ Could not read the uploaded file.",
      });
    }
  }

  async sendHelp(msg) {
    const driveNote = config.drive.enabled
      ? "\n\n<b>Google Drive:</b> After each download, the bot will ask if you want to upload the file to Google Drive."
      : "";
    const help =
      "🎬 <b>tg-hub bot</b>\n\n" +
      "Send a video URL (YouTube, etc.) and pick a quality.\n\n" +
      "<b>Commands:</b>\n" +
      "/start, /help — this message\n" +
      "/cancel — reset state\n" +
      "/clearcookies — delete saved cookies\n\n" +
      "<b>Cookies:</b> If a site requires login, install the <b>Get cookies.txt LOCALLY</b> " +
      "browser extension, export your cookies, and either paste the file contents " +
      "as a text message OR send the cookies.txt file directly to me." +
      driveNote;
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
            "🔒 This URL seems to require cookies (login/age/region).\n\n" +
            "Please:\n" +
            "1. Install the <b>Get cookies.txt LOCALLY</b> extension in your browser.\n" +
            "2. Open the site and log in.\n" +
            "3. Export cookies for that domain.\n" +
            "4. Either paste the cookies.txt content as text OR send the cookies.txt file here.\n\n" +
            "Then send the link again to retry.",
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
      await this.client.editMessage(msg.chatId, {
        message: status.id,
        text: "❌ Live streams are not supported.",
      });
      return;
    }

    userState.pendingUrl = url;
    userState.pendingFormats = info;
    userState.menuMessageId = Number(status.id);

    const rows = buildMainMenu(info);
    const buttons = buildButtons(rows);

    const durationStr = info.duration
      ? `⏱ ${formatDuration(info.duration)}\n`
      : "";

    await this.client.editMessage(msg.chatId, {
      message: status.id,
      text:
        `🎬 <b>${escapeHtml(info.title)}</b>\n` +
        durationStr +
        `\nChoose quality:`,
      parseMode: "html",
      buttons,
    });
  }

  async onCallback(event) {
    const rawId =
      event.senderId ||
      (event.query && event.query.userId) ||
      event.userId;
    const senderId = rawId ? Number(rawId.toString()) : null;
    if (!senderId || !auth.isAllowed(senderId)) {
      logger.warn(
        `Callback from unauthorized or unknown user (resolved=${senderId})`,
      );
      await event.answer({ message: "⛔ Not authorized.", alert: true });
      return;
    }

    const data = event.data ? event.data.toString() : "";
    const userState = state.get(senderId);

    // ── Google Drive upload decision ────────────────────────────────────────
    if (data === "drive:yes" || data === "drive:no") {
      if (!userState.pendingDriveUpload) {
        await event.answer({ message: "Session expired.", alert: true });
        return;
      }
      const pending = userState.pendingDriveUpload;
      userState.pendingDriveUpload = null;

      if (data === "drive:no") {
        try {
          await this.client.editMessage(pending.chatId, {
            message: pending.messageId,
            text: `${pending.labelLine}\n✅ Done.`,
          });
        } catch (e) { /* ignore */ }
        cleanupDir(path.dirname(pending.filePath));
        await event.answer({ message: "OK" });
        return;
      }

      // drive:yes
      await event.answer({ message: "Uploading to Drive..." });
      try {
        await this.client.editMessage(pending.chatId, {
          message: pending.messageId,
          text: `${pending.labelLine}\n☁️ Uploading to Google Drive... 0%`,
        });

        let lastDriveEdit = 0;
        const fileData = await drive.uploadFile({
          filePath: pending.filePath,
          fileName: pending.fileName,
          mimeType: pending.mimeType,
          parentId: config.drive.folderId,
          onProgress: async (pct) => {
            const now = Date.now();
            if (now - lastDriveEdit < 3000) return;
            lastDriveEdit = now;
            try {
              await this.client.editMessage(pending.chatId, {
                message: pending.messageId,
                text: `${pending.labelLine}\n☁️ Uploading to Google Drive... ${pct.toFixed(1)}%`,
              });
            } catch (e) { /* ignore */ }
          },
        });

        const links = drive.buildLinks(fileData.id, fileData.mimeType);
        await this.client.editMessage(pending.chatId, {
          message: pending.messageId,
          text:
            `${pending.labelLine}\n✅ Done.\n\n` +
            `☁️ <b>Google Drive:</b>\n` +
            `<a href="${links.view}">View</a> | <a href="${links.download}">Download</a>`,
          parseMode: "html",
        });
        logger.info(`Drive upload done: ${fileData.id} (${pending.fileName})`);
      } catch (err) {
        logger.error("Drive upload failed:", err.message);
        const hint = drive.isInvalidGrant(err)
          ? "\n\nRun <code>node setup-drive.js</code> to refresh the token."
          : "";
        try {
          await this.client.editMessage(pending.chatId, {
            message: pending.messageId,
            text:
              `${pending.labelLine}\n✅ Sent to Telegram.\n\n` +
              `❌ Drive upload failed: <pre>${escapeHtml(truncate(err.message, 300))}</pre>${hint}`,
            parseMode: "html",
          });
        } catch (e) { /* ignore */ }
      } finally {
        cleanupDir(path.dirname(pending.filePath));
      }
      return;
    }

    if (data === "cancel") {
      userState.pendingUrl = null;
      userState.pendingFormats = null;
      try {
        await this.client.editMessage(event.chatId, {
          message: Number(event.messageId),
          text: "❌ Cancelled.",
        });
      } catch (e) {
        logger.debug(`editMessage on cancel failed: ${e.message}`);
      }
      await event.answer({ message: "Cancelled" });
      return;
    }

    if (!userState.pendingUrl || !userState.pendingFormats) {
      await event.answer({
        message: "Session expired. Send the link again.",
        alert: true,
      });
      return;
    }

    if (userState.activeJob) {
      await event.answer({
        message: "Another download is already running.",
        alert: true,
      });
      return;
    }

    if (
      data === "all_v" ||
      data === "all_a" ||
      data === "back" ||
      data.startsWith("pg:")
    ) {
      const info = userState.pendingFormats;
      let rows;
      if (data === "all_v") {
        userState.menuView = "v";
        userState.menuPage = 0;
        rows = buildAllVideoMenu(info, 0);
      } else if (data === "all_a") {
        userState.menuView = "a";
        userState.menuPage = 0;
        rows = buildAllAudioMenu(info, 0);
      } else if (data === "back") {
        userState.menuView = null;
        userState.menuPage = 0;
        rows = buildMainMenu(info);
      } else {
        const [, view, pageStr] = data.split(":");
        const page = Number(pageStr) || 0;
        userState.menuView = view;
        userState.menuPage = page;
        rows =
          view === "v"
            ? buildAllVideoMenu(info, page)
            : buildAllAudioMenu(info, page);
      }
      const buttons = buildButtons(rows);
      try {
        await this.client.editMessage(event.chatId, {
          message: Number(event.messageId),
          text:
            `🎬 <b>${escapeHtml(info.title)}</b>\n` +
            (info.duration ? `⏱ ${formatDuration(info.duration)}\n` : "") +
            `\nChoose quality:`,
          parseMode: "html",
          buttons,
        });
      } catch (e) {
        logger.debug(`Menu switch edit failed: ${e.message}`);
      }
      await event.answer({});
      return;
    }

    const parts = data.split(":");
    const kind = parts[0];
    if (kind !== "a" && kind !== "v") {
      await event.answer({ message: "Unknown action.", alert: true });
      return;
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
    const jobDir = path.join(
      config.downloadDir,
      String(senderId),
      Date.now().toString(),
    );

    let audioMode = null;
    let audioBitrate = 0;
    let audioFormatId = "";
    let videoHeight = 0;
    let videoFormatId = "";
    let labelLine;

    if (kind === "a") {
      const sub = parts[0] || "mp3";
      if (sub === "idx") {
        audioMode = "original";
        const idx = Number(parts[1]);
        const af =
          probeInfo &&
          Array.isArray(probeInfo.audioFormats) &&
          probeInfo.audioFormats[idx];
        if (af && af.formatId) {
          audioFormatId = af.formatId;
          const meta = [af.codec, af.abr ? `${Math.round(af.abr)}k` : ""]
            .filter(Boolean)
            .join(" ");
          labelLine = `🎧 ${af.ext || "audio"}${meta ? ` (${meta})` : ""}`;
        } else {
          audioMode = "mp3";
          labelLine = "🎵 MP3 (Best)";
        }
      } else if (sub === "orig") {
        audioMode = "original";
        if (probeInfo && probeInfo.bestAudio && probeInfo.bestAudio.formatId) {
          audioFormatId = probeInfo.bestAudio.formatId;
          labelLine = `🎧 Original (${probeInfo.bestAudio.ext || "audio"})`;
        } else {
          labelLine = "🎧 Original audio";
        }
      } else {
        audioMode = "mp3";
        audioBitrate = parts[1] ? Number(parts[1]) : 0;
        labelLine = audioBitrate
          ? `🎵 MP3 ${audioBitrate}k`
          : "🎵 MP3 (Best)";
      }
    } else {
      if (parts[0] === "idx") {
        const idx = Number(parts[1]);
        const vf =
          probeInfo &&
          Array.isArray(probeInfo.videoFormats) &&
          probeInfo.videoFormats[idx];
        if (vf && vf.formatId) {
          videoFormatId = vf.formatId;
          const dim =
            vf.width && vf.height
              ? `${vf.width}x${vf.height}`
              : vf.height
                ? `${vf.height}p`
                : "video";
          labelLine = `🎬 ${vf.ext || ""} ${dim}`.trim();
        } else {
          videoHeight = 0;
          labelLine = "🎬 Best video";
        }
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
      try {
        await this.client.editMessage(chatId, { message: messageId, text });
      } catch (e) { /* ignore */ }
    };

    await editStatus(`${labelLine}\n⬇️ Downloading... 0%`);

    let outputFile;
    try {
      if (kind === "a") {
        outputFile = await ytdlp.downloadAudio({
          url,
          jobDir,
          cookiesPath,
          mode: audioMode,
          bitrateKbps: audioBitrate,
          formatId: audioFormatId,
          onProgress: (p) =>
            editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`),
        });
      } else {
        outputFile = await ytdlp.downloadVideo({
          url,
          jobDir,
          maxHeight: videoHeight,
          formatId: videoFormatId,
          cookiesPath,
          onProgress: (p) =>
            editStatus(`${labelLine}\n⬇️ Downloading... ${p.toFixed(1)}%`),
        });
      }

      const stat = fs.statSync(outputFile);
      if (stat.size > config.maxUploadBytes) {
        throw new Error(
          `File too large (${humanSize(stat.size)} > ${humanSize(config.maxUploadBytes)}). ` +
            `Try a lower quality.`,
        );
      }

      await this.client.editMessage(chatId, {
        message: messageId,
        text: `${labelLine}\n📤 Uploading ${humanSize(stat.size)}...`,
      });

      const isAudio = kind === "a";
      const fileName = path.basename(outputFile);
      const attributes = isAudio
        ? [
            new Api.DocumentAttributeAudio({
              duration: 0,
              title: stripExt(fileName),
            }),
          ]
        : undefined;

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
          this.client
            .editMessage(chatId, {
              message: messageId,
              text: `${labelLine}\n📤 Uploading... ${pct}%`,
            })
            .catch(() => {});
        },
      });

      // ── Ask about Google Drive ─────────────────────────────────────────
      if (config.drive.enabled) {
        const userState = state.get(senderId);
        userState.pendingDriveUpload = {
          filePath: outputFile,
          fileName,
          mimeType: guessMime(outputFile),
          labelLine,
          chatId,
          messageId,
        };

        const driveButtons = [
          [
            Button.inline("☁️ Yes, upload to Drive", Buffer.from("drive:yes")),
            Button.inline("❌ No thanks", Buffer.from("drive:no")),
          ],
        ];

        await this.client.editMessage(chatId, {
          message: messageId,
          text: `${labelLine}\n✅ Sent to Telegram.\n\n☁️ Upload to Google Drive?`,
          buttons: driveButtons,
        });
        // Do NOT clean up yet — drive.js will clean up after the decision.
        return;
      }

      // Drive not configured — just mark done and cleanup.
      await this.client.editMessage(chatId, {
        message: messageId,
        text: `${labelLine}\n✅ Done.`,
      });
    } finally {
      // Only clean up if Drive upload is not pending.
      const userState = state.get(senderId);
      if (!userState.pendingDriveUpload) {
        cleanupDir(jobDir);
      }
    }
  }

  async notifyJobError(event, senderId, err) {
    const userState = state.get(senderId);
    if (err.cookieIssue || ytdlp.looksLikeCookieIssue(err.stderr || err.message)) {
      userState.waitingForCookies = true;
      try {
        await this.client.editMessage(event.chatId, {
          message: Number(event.messageId),
          text:
            "🔒 Cookies are required for this content.\n\n" +
            "Use the <b>Get cookies.txt LOCALLY</b> extension, export the cookies " +
            "for that site, and either paste the file contents as text OR send " +
            "the cookies.txt file. Then send the link again.",
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

function cleanupDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const parent = path.dirname(dir);
    if (
      parent.startsWith(config.downloadDir) &&
      parent !== config.downloadDir
    ) {
      const remaining = fs.readdirSync(parent);
      if (remaining.length === 0) fs.rmdirSync(parent);
    }
  } catch (e) {
    logger.warn(`Cleanup failed for ${dir}: ${e.message}`);
  }
}

function stripExt(name) {
  return name.replace(/\.[^.]+$/, "");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "..." : s;
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  return `${m}m ${s}s`;
}

module.exports = { Bot };
