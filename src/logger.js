const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "..", "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const configLevel = (process.env.LOG_LEVEL || "info").toLowerCase();
const currentLevel = LEVELS[configLevel] ?? LEVELS.info;

const logFile = fs.createWriteStream(path.join(LOG_DIR, "bot.log"), { flags: "a" });

function write(level, ...args) {
  if ((LEVELS[level] ?? 99) > currentLevel) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${args.map(String).join(" ")}`;
  console.log(line);
  logFile.write(line + "\n");
}

const logger = {
  error: (...a) => write("error", ...a),
  warn: (...a) => write("warn", ...a),
  info: (...a) => write("info", ...a),
  debug: (...a) => write("debug", ...a),
};

module.exports = logger;
