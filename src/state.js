const userStates = new Map();

function get(userId) {
  let s = userStates.get(userId);
  if (!s) {
    s = {
      pendingUrl: null,
      pendingFormats: null,
      waitingForCookies: false,
      activeJob: false,
      // Post-download action flow: Drive / Direct Link / Both / None
      pendingPostAction: null, // { filePath, jobDir, fileName, mimeType, labelLine, chatId, messageId }
      menuMessageId: null,
      menuView: null,
      menuPage: 0,
    };
    userStates.set(userId, s);
  }
  return s;
}

function reset(userId) {
  userStates.delete(userId);
}

module.exports = { get, reset };
