# tg-hub

Telegram bot that downloads videos and audio from YouTube and other yt-dlp-supported sites, with an optional **Google Drive upload** after each download.

Built on top of [tg-video](https://github.com/ali934h/tg-video), extended with the Drive upload flow from [tg-upto](https://github.com/ali934h/tg-upto).

---

## Features

- Download video (any quality) or audio (MP3 / original) from YouTube and hundreds of other sites via yt-dlp
- Cookie support for age-restricted, private, or login-required content
- After each successful download, the bot asks: **☁️ Upload to Google Drive?**
  - **Yes** → uploads the file to Drive and sends back a View + Download link
  - **No** → keeps only the Telegram copy and cleans up
- Google Drive is **fully optional** — if the credentials are not set in `.env`, the bot works exactly like `tg-video` without asking about Drive

---

## Prerequisites

- Ubuntu 22.04 / 24.04 server with **root** access
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Telegram **API_ID** and **API_HASH** from <https://my.telegram.org/apps>
- Your Telegram numeric user id (ask [@userinfobot](https://t.me/userinfobot))
- *(Optional, for Drive)* A Google Cloud project with the Drive API enabled and an OAuth 2.0 Desktop client

---

## Install

One-line install (run as root):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/ali934h/tg-hub/main/install.sh)
```

The installer will:

- Install Node.js 20, ffmpeg, yt-dlp, deno, and PM2
- Clone this repo to `/root/tg-hub`
- Prompt for `BOT_TOKEN`, `API_ID`, `API_HASH`, and `ALLOWED_USERS`
- Ask if you want to set up Google Drive — if yes, walks you through it interactively
- Start the bot with PM2 and enable auto-start on boot

The bot uses **MTProto polling** — no inbound port, no domain, no SSL needed.

---

## (Optional) Set up Google Drive after install

If you skipped Drive during install, you can add it any time:

#### 1 — Create a Google Cloud project and OAuth client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a new project.
2. Enable the **Google Drive API**: *APIs & Services → Library → Google Drive API → Enable*.
3. Go to *APIs & Services → OAuth consent screen*:
   - User type: **External** → fill in app name and email → save.
   - Under *Publishing status*, click **Publish app** (no Google review needed for `drive.file` scope).
4. Go to *APIs & Services → Credentials → Create Credentials → OAuth client ID*:
   - Application type: **Desktop app**
   - Copy the **Client ID** and **Client Secret**.

#### 2 — Add credentials to `.env`

```bash
nano /root/tg-hub/.env
```

Fill in:

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
DRIVE_FOLDER_ID=   # optional: folder ID to upload into (leave blank for Drive root)
```

#### 3 — Run the OAuth setup script

```bash
node /root/tg-hub/setup-drive.js
```

Open the printed URL in a browser, approve, then either let the redirect be caught automatically (SSH tunnel) or paste the redirect URL into the terminal. The script saves the refresh token directly into `.env`.

#### 4 — Restart

```bash
pm2 restart tg-hub
pm2 logs tg-hub   # should print "Google Drive upload: enabled"
```

---

## Daily commands

```bash
pm2 logs tg-hub                      # follow live logs
pm2 restart tg-hub                   # restart
pm2 stop tg-hub                      # stop
bash /root/tg-hub/update.sh          # pull latest code and restart
bash /root/tg-hub/uninstall.sh       # remove everything
```

---

## Usage

1. Open a private chat with your bot in Telegram.
2. Send any video URL (YouTube, etc.).
3. Pick a quality from the inline keyboard:
   - **🎵 Audio (MP3)** — best-quality MP3 in one tap.
   - **🎬 144p / 360p / … / 1080p** — common heights available for that source.
   - **📂 All Video** — every individual format with container, resolution, codec, and estimated size.
   - **📂 All Audio** — every native audio stream, plus MP3 transcoding options at 128 / 192 / 320 / Best.
4. The bot downloads and uploads the file to Telegram.
5. If Google Drive is configured, the bot asks: **☁️ Upload to Google Drive?**
   - Tap **Yes** → the file is uploaded and you receive a Drive link.
   - Tap **No** → done, the Telegram copy is kept.

### Cookies (for restricted content)

If a source requires login, age verification, or is region-locked, the bot will prompt you. Two methods:

- **Paste as text** — install the **Get cookies.txt LOCALLY** browser extension, export cookies for the site, and paste the full file contents into the chat.
- **Send as a file** — same export, but send the `cookies.txt` file directly to the bot as an attachment.

Then resend the original URL.

### Bot commands

| Command | Action |
|---|---|
| `/start`, `/help` | Show usage instructions |
| `/cancel` | Cancel the current operation and reset state |
| `/clearcookies` | Delete your saved cookies |

---

## Troubleshooting

**Bot does not respond.**
Check `pm2 logs tg-hub`. Make sure your numeric user ID is in `ALLOWED_USERS` in `/root/tg-hub/.env`.

**`File too large`.**
MTProto upload limit is ~2 GB. Choose a lower quality, or reduce `MAX_UPLOAD_MB` in `.env` and restart.

**Age-restricted / login-required / `Sign in to confirm you're not a bot`.**
Provide cookies via the *Get cookies.txt LOCALLY* extension and retry.

**`invalid_grant` error on Drive upload.**
Your refresh token expired — common when the OAuth app is in *Testing* status. Publish the app at [console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience), then re-run `node /root/tg-hub/setup-drive.js` and restart.

**Drive upload prompt not appearing.**
Make sure all three `GOOGLE_*` variables are set in `.env` and the bot was restarted. Check `pm2 logs tg-hub` for `"Google Drive upload: enabled"`.

**yt-dlp errors after a site update.**
Run `yt-dlp -U`, then `pm2 restart tg-hub`.

**Need to reconfigure.**
Edit `/root/tg-hub/.env` (chmod 600) and run `pm2 restart tg-hub`.

**Start over.**
`bash /root/tg-hub/uninstall.sh`, then run the one-line installer again.
