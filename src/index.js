const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const config = require("./config");
const logger = require("./logger");
const { Bot } = require("./bot");

async function main() {
  let savedSession = "";
  if (fs.existsSync(config.sessionFile)) {
    savedSession = fs.readFileSync(config.sessionFile, "utf8").trim();
  }

  const session = new StringSession(savedSession);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 10,
    autoReconnect: true,
  });

  client.setLogLevel(config.logLevel === "debug" ? "info" : "error");

  logger.info("Connecting to Telegram...");
  await client.start({
    botAuthToken: config.botToken,
  });

  const sessionString = client.session.save();
  if (sessionString && sessionString !== savedSession) {
    fs.writeFileSync(config.sessionFile, sessionString, { mode: 0o600 });
    logger.info("Session saved");
  }

  const me = await client.getMe();
  logger.info(`Logged in as @${me.username || me.firstName} (id=${me.id})`);
  logger.info(`Allowed users: ${[...config.allowedUsers].join(", ")}`);

  if (config.drive.enabled) {
    logger.info("Google Drive upload: enabled");
  } else {
    logger.info("Google Drive upload: disabled (set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN to enable)");
  }

  const bot = new Bot(client);
  bot.start();

  const shutdown = async (sig) => {
    logger.info(`Received ${sig}, shutting down...`);
    try {
      await client.disconnect();
    } catch (e) {
      // ignore
    }
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception:", err && err.stack ? err.stack : err);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason);
  });
}

main().catch((err) => {
  logger.error("Fatal:", err && err.stack ? err.stack : err);
  process.exit(1);
});
