#!/usr/bin/env node
"use strict";

// One-time helper: exchange an OAuth consent code for a refresh token
// and write it to .env. Run once after install (or to re-authenticate).
//
// Three ways to complete the flow:
//   1. Run on a machine with a browser: the redirect lands on the local
//      server and the script picks the code up automatically.
//   2. Remote VPS + SSH port-forward from your laptop:
//        ssh -L 53682:127.0.0.1:53682 root@<server>
//      Open the URL on your laptop, the redirect tunnels back automatically.
//   3. Manual paste fallback: copy the full address-bar URL (or just the
//      code) from your browser after Google redirects and paste it below.

const fs = require("fs");
const http = require("http");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");
const { google } = require("googleapis");
const dotenv = require("dotenv");

const ENV_PATH = path.resolve(__dirname, ".env");
const PORT = Number(process.env.OAUTH_LOCAL_PORT || 53682);
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(`Missing ${ENV_PATH}. Copy .env.example first.`);
    process.exit(1);
  }
  return dotenv.parse(fs.readFileSync(ENV_PATH));
}

function writeEnv(env) {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v ?? ""}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

function extractCode(input) {
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      return parsed.searchParams.get("code");
    } catch {
      return null;
    }
  }
  if (input.includes("code=")) {
    try {
      const parsed = new URL(`http://x/?${input.replace(/^[?#]/, "")}`);
      const c = parsed.searchParams.get("code");
      if (c) return c;
    } catch {
      // fall through
    }
  }
  return input;
}

function startLoopbackServer(expectedState) {
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url, REDIRECT_URI);
      if (reqUrl.pathname !== "/" && reqUrl.pathname !== "") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const error = reqUrl.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end(`OAuth error: ${error}`);
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      const code = reqUrl.searchParams.get("code");
      const state = reqUrl.searchParams.get("state");
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Missing ?code parameter.");
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("State mismatch. Aborting for security.");
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><meta charset=utf-8><title>tg-hub</title>" +
          '<body style="font-family:sans-serif;padding:2em">' +
          "<h2>Authorization received.</h2>" +
          "<p>You can close this tab and return to the terminal.</p>" +
          "</body>",
      );
      resolveCode(code);
    } catch (err) {
      res.writeHead(500);
      res.end("Internal error");
      rejectCode(err);
    }
  });

  return new Promise((resolveServer, rejectServer) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.warn(
          `Port ${PORT} is already in use - skipping loopback callback. ` +
            `You will need to paste the redirect URL manually.`,
        );
        resolveServer({ codePromise: null, close: () => {} });
      } else {
        rejectServer(err);
      }
    });
    server.listen(PORT, "127.0.0.1", () => {
      resolveServer({
        codePromise,
        close: () => server.close(),
      });
    });
  });
}

async function main() {
  const env = loadEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    console.error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env first.",
    );
    process.exit(1);
  }

  const oauth = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });

  const { codePromise, close: closeServer } = await startLoopbackServer(state);

  console.log("\n=== Google Drive OAuth setup (tg-hub) ===\n");
  console.log(`Redirect URI: ${REDIRECT_URI}`);
  console.log("");
  console.log("1. Open this URL in a browser logged in as the Drive owner:\n");
  console.log(authUrl);
  console.log("");
  console.log("2. Approve the request.");
  console.log("");
  console.log(
    `3. Google will redirect to ${REDIRECT_URI}/?code=...&state=...`,
  );
  if (codePromise) {
    console.log(
      "   - If you opened the URL on this machine, the redirect will be caught automatically.",
    );
    console.log(
      `   - If you opened it on another machine, run an SSH tunnel first:`,
    );
    console.log(
      `       ssh -L ${PORT}:127.0.0.1:${PORT} <user>@<this-server>`,
    );
  } else {
    console.log(
      "   (Local server could not start — manual paste only.)",
    );
  }
  console.log("");
  console.log(
    "   Or copy the full URL from your browser's address bar and paste below:",
  );
  console.log("");

  const inputPromise = ask("Paste the redirect URL or code (leave empty to wait for callback): ");

  let code;
  if (codePromise) {
    const winner = await Promise.race([
      codePromise.then((c) => ({ source: "callback", value: c })),
      inputPromise.then((v) => ({ source: "stdin", value: v })),
    ]);
    if (winner.source === "callback") {
      code = winner.value;
      console.log("\n(received via local callback)");
    } else {
      code = extractCode(winner.value);
    }
  } else {
    const value = await inputPromise;
    code = extractCode(value);
  }

  closeServer();

  if (!code) {
    console.error("No code received. Aborting.");
    process.exit(1);
  }

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    console.error(
      "Google did not return a refresh token. This usually means the same " +
        "Google account already granted consent before. Revoke access at " +
        "https://myaccount.google.com/permissions and run this script again.",
    );
    process.exit(1);
  }

  env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
  writeEnv(env);
  console.log("\nRefresh token saved to .env (chmod 600).");

  oauth.setCredentials({ refresh_token: tokens.refresh_token });
  const driveClient = google.drive({ version: "v3", auth: oauth });
  const about = await driveClient.about.get({ fields: "user(emailAddress)" });
  console.log(`Authenticated as: ${about.data.user.emailAddress}`);
  console.log("Setup complete. You can now start the bot.");
}

function hint(err) {
  const msg = (err && err.message ? err.message : String(err)).toLowerCase();
  if (msg.includes("invalid_grant")) {
    return [
      "",
      "  This usually means one of:",
      "    - The OAuth app is in 'Testing' status (refresh tokens expire in 7 days).",
      "      Publish it at https://console.cloud.google.com/auth/audience.",
      "    - Access was revoked at https://myaccount.google.com/permissions.",
      "    - The OAuth client was deleted/recreated in the Cloud Console.",
    ].join("\n");
  }
  if (msg.includes("invalid_request") || msg.includes("redirect_uri_mismatch")) {
    return [
      "",
      "  Google rejected the request. Make sure:",
      "    - The OAuth client type is 'Desktop app'.",
      "    - The OAuth app's publishing status is 'In production'.",
    ].join("\n");
  }
  return "";
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(`Setup failed: ${msg}${hint(err)}`);
  process.exit(1);
});
