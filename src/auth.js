const config = require("./config");

function isAllowed(userId) {
  return config.allowedUsers.has(userId);
}

module.exports = { isAllowed };
