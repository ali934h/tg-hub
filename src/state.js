const userStates = new Map();

function get(userId) {
  let s = userStates.get(userId);
  if (!s) {
    s = {
      // ── video download flow ──────────────────────────────────────────────
      // true = user sent /video and bot is waiting for a URL
      waitingForVideoUrl: false,
      pendingUrl: null,
      pendingFormats: null,
      activeJob: false,
      // Post-download action flow: Drive / Direct Link / Both / None
      pendingPostAction: null, // { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId }
      menuMessageId: null,
      menuView: null,
      menuPage: 0,
      // ── cookies flow ────────────────────────────────────────────────────
      waitingForCookies: false,
    };
    userStates.set(userId, s);
  }
  return s;
}

function reset(userId) {
  userStates.delete(userId);
}

module.exports = { get, reset };
