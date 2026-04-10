const readline = require('readline');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║       TheoChat — First Time Setup     ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  if (fs.existsSync(CONFIG_PATH)) {
    const overwrite = await ask('  config.json already exists. Overwrite? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('  Setup cancelled.\n');
      rl.close();
      return;
    }
  }

  console.log('  Choose how to authenticate with YouTube:\n');
  console.log('  1) OAuth (recommended) — Sign in with Google, best for personal use');
  console.log('     You need a Google Cloud project with OAuth credentials.');
  console.log('');
  console.log('  2) API Key — Simpler setup, read-only access to public live chats');
  console.log('     You need a Google Cloud project with an API key.');
  console.log('');

  const authChoice = await ask('  Auth method (1 or 2): ');

  const config = {
    wsPort: 9300,
    httpPort: 9301
  };

  if (authChoice.trim() === '2') {
    // ─── API Key Setup ─────────────────────────────────────────
    console.log('\n  API Key Setup');
    console.log('  ─────────────');
    console.log('  1. Go to https://console.cloud.google.com');
    console.log('  2. Create a project (or select existing)');
    console.log('  3. Enable "YouTube Data API v3"');
    console.log('  4. Go to Credentials → Create Credentials → API Key');
    console.log('  5. Copy the key below\n');

    const apiKey = await ask('  API Key: ');
    config.apiKey = apiKey.trim();

  } else {
    // ─── OAuth Setup ───────────────────────────────────────────
    console.log('\n  OAuth Setup');
    console.log('  ───────────');
    console.log('  1. Go to https://console.cloud.google.com');
    console.log('  2. Create a project (or select existing)');
    console.log('  3. Enable "YouTube Data API v3"');
    console.log('  4. Go to APIs & Services → OAuth consent screen');
    console.log('     - User type: External');
    console.log('     - Fill in app name (e.g. "TheoChat")');
    console.log('     - Add your email as a test user');
    console.log('  5. Go to Credentials → Create Credentials → OAuth client ID');
    console.log('     - Application type: Desktop app');
    console.log('  6. Copy the Client ID and Client Secret below\n');

    const clientId = await ask('  Client ID: ');
    const clientSecret = await ask('  Client Secret: ');
    config.clientId = clientId.trim();
    config.clientSecret = clientSecret.trim();
  }

  // ─── Channel / Video Config ────────────────────────────────
  console.log('\n  YouTube Channel Config');
  console.log('  ──────────────────────');
  console.log('  The service can auto-find live streams by channel ID,');
  console.log('  or you can provide a specific video ID.\n');

  const channelId = await ask('  YouTube Channel ID (starts with UC, or leave blank): ');
  if (channelId.trim()) {
    config.channelId = channelId.trim();
  }

  const videoId = await ask('  Specific Video ID (or leave blank for auto-detect): ');
  if (videoId.trim()) {
    config.videoId = videoId.trim();
  }

  if (!config.channelId && !config.videoId) {
    console.log('\n  Warning: No channel ID or video ID provided.');
    console.log('  You will need to add one to config.json before starting.');
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  console.log('\n  Config saved to config.json');
  console.log('  Run "npm start" to launch TheoChat.\n');

  rl.close();
}

main().catch(err => {
  console.error('Setup error:', err);
  rl.close();
  process.exit(1);
});
