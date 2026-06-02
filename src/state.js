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
      waitingForFilehostInput: false,
      filehostActiveJob: false,

      // ── gallery flow ─────────────────────────────────────────────────────
      // true = user sent /gallery and bot is waiting for one or more URLs
      waitingForGalleryUrls: false,
      // { urls: string[], archiveName: string } — confirmed job ready to run
      galleryPendingJob: null,
      // STATE: null | "pending" | "renaming" | "processing"
      galleryState: null,
      // AbortController for the running gallery job
      galleryAbortController: null,

      // ── shared post-download action ───────────────────────────────────────
      pendingPostAction: null, // { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId }

      // ── format menu state (video flow) ───────────────────────────────────
      menuMessageId: null,
      menuView: null,
      menuPage: 0,

      // ── cookies flow ─────────────────────────────────────────────────────
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
