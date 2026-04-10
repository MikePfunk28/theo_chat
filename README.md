# TheoChat

Combines YouTube live chat into your Twitch chat. YouTube messages appear directly in your Twitch chat panel with a red **YT** badge. When your YouTube mods delete messages or ban users, those actions are reflected in real time.

## How It Works

Two pieces:

1. **Service** — A Node.js app that connects to YouTube's gRPC streaming API and receives chat messages, deletions, and bans in real time.
2. **Extension** — A browser extension (Chrome/Zen/Chromium) that connects to the service and injects YouTube messages into Twitch's chat panel.

## Setup (One Time)

### 1. Google Cloud Project

You need a Google Cloud project with the YouTube Data API enabled. Takes about 5 minutes:

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (name it anything, e.g. "TheoChat")
3. In the sidebar, go to **APIs & Services → Library**
4. Search for "YouTube Data API v3" and click **Enable**

Then choose an auth method:

**Option A: OAuth (recommended)** — Best UX, Theo just clicks "Sign in with Google"

5. Go to **APIs & Services → OAuth consent screen**
6. User type: External. Fill in app name (e.g. "TheoChat"), add your email as a test user
7. Go to **Credentials → Create Credentials → OAuth client ID**
8. Application type: **Desktop app**
9. Copy the **Client ID** and **Client Secret**

**Option B: API Key** — Simpler, no sign-in needed, read-only public chat access

5. Go to **Credentials → Create Credentials → API Key**
6. Copy the key (optionally restrict it to YouTube Data API v3)

### 2. Install the Service

```bash
cd service
npm install
npm run setup
```

The setup wizard will ask which auth method you want and walk you through entering your credentials. It also asks for a YouTube Channel ID (starts with UC) so it can auto-find live streams.

### 3. Start the Service

```bash
npm start
```

If using OAuth, your browser will open a Google sign-in page on first run. Sign in and click Allow. This only happens once — the token is saved locally.

### 4. Install the Extension

1. Open Zen/Chrome and go to `zen://extensions` (or `chrome://extensions`)
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension` folder from this project
5. Open Twitch — YouTube chat messages will appear with a red [YT] badge

## Usage

Every time you stream:

1. Start the service: `cd service && npm start`
2. Open Twitch in Zen/Chrome with the extension installed
3. YouTube chat appears in your Twitch chat panel automatically

The service finds your active live stream automatically. When the stream ends, it waits and reconnects when you go live again.

## What You'll See

- YouTube messages in Twitch chat with a red **YT** badge
- YouTube mod/owner/member badges on messages
- Super Chat amounts displayed
- When a YouTube mod deletes a message → it gets struck through and removed
- When a YouTube mod bans a user → all their messages are removed

## Config Reference

`config.json` supports these fields:

```json
{
  "clientId": "...",        // OAuth client ID (Option A)
  "clientSecret": "...",    // OAuth client secret (Option A)
  "apiKey": "...",          // API key (Option B) — takes priority if both are set
  "channelId": "UC...",     // YouTube channel ID for auto-detecting live streams
  "videoId": "...",         // Specific video ID (optional, overrides channelId)
  "wsPort": 9300,           // WebSocket port for extension connection
  "httpPort": 9301          // HTTP status server port
}
```

Auth priority: if `apiKey` is set, it's used. Otherwise falls back to OAuth with `clientId`/`clientSecret`.

## Project Structure

```
theo_chat/
├── service/                  # Node.js backend
│   ├── index.js              # Entry point + WebSocket server
│   ├── youtube.js            # YouTube gRPC stream + event normalization
│   ├── auth.js               # OAuth + API key auth (dual mode)
│   ├── setup.js              # First-time configuration wizard
│   ├── grpc/                 # YouTube protobuf stubs
│   │   ├── stream_list_pb.js
│   │   └── stream_list_grpc_pb.js
│   └── package.json
├── extension/                # Browser extension (Manifest V3)
│   ├── manifest.json
│   ├── content.js            # Twitch DOM injection + WebSocket client
│   ├── theochat.css          # Styling for injected messages
│   ├── icon48.png
│   └── icon128.png
└── README.md
```
