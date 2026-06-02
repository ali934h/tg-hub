const userStates = new Map();

function get(userId) {
  let s = userStates.get(userId);
  if (!s) {
    s = {
      // ── video download flow ──────────────────────────────────────────────
      waitingForVideoUrl: false,
      pendingUrl: null,
      pendingFormats: null,
      activeJob: false,

      // ── filehost flow ────────────────────────────────────────────────────
      // true = user sent /filehost and bot is waiting for a URL or file
      waitingForFilehostInput: false,
      filehostActiveJob: false,

      // Post-download action flow: Drive / Direct Link / Both / None
      // Shared between video and filehost flows.
      pendingPostAction: null, // { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId }

      // ── format menu state (video flow) ───────────────────────────────────
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
