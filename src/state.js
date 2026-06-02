const userStates = new Map();

function get(userId) {
  let s = userStates.get(userId);
  if (!s) {
    s = {
      pendingUrl: null,
      pendingFormats: null,
      waitingForCookies: false,
      activeJob: false,
      // Google Drive upload flow
      pendingDriveUpload: null, // { filePath, fileName, mimeType, labelLine, chatId, messageId }
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
