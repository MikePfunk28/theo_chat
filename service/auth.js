const { OAuth2Client } = require('google-auth-library');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const open = require('open');

const TOKEN_PATH = path.join(__dirname, '.tokens.json');
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

/**
 * Determines the auth mode from config:
 *   - "oauth"  → OAuth with clientId/clientSecret (user signs in with Google)
 *   - "apikey" → Simple API key (no sign-in, read-only public data)
 */
function getAuthMode(config) {
  if (config.apiKey) return 'apikey';
  if (config.clientId && config.clientSecret) return 'oauth';
  throw new Error('No authentication configured. Run "npm run setup" to configure.');
}

// ─── OAuth Flow ────────────────────────────────────────────────

function createOAuth2Client(config) {
  return new OAuth2Client(
    config.clientId,
    config.clientSecret,
    'http://localhost:9400/oauth/callback'
  );
}

async function getAuthenticatedOAuthClient(config) {
  const oauth2Client = createOAuth2Client(config);

  // Check for existing tokens
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);

    // Check if token is expired and refresh if needed
    if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
      console.log('  Access token expired, refreshing...');
      try {
        const { credentials } = await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(credentials);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
        console.log('  Token refreshed successfully.');
      } catch (err) {
        console.error('  Failed to refresh token, re-authenticating...');
        fs.unlinkSync(TOKEN_PATH);
        return authenticateInteractive(oauth2Client);
      }
    }

    return oauth2Client;
  }

  return authenticateInteractive(oauth2Client);
}

function authenticateInteractive(oauth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });

    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);

      if (parsed.pathname === '/oauth/callback') {
        const code = parsed.query.code;

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Error: No authorization code received</h1>');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          oauth2Client.setCredentials(tokens);
          fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0e0e10; color: white;">
                <div style="text-align: center;">
                  <h1>TheoChat Connected!</h1>
                  <p>You can close this tab and go back to the terminal.</p>
                </div>
              </body>
            </html>
          `);

          server.close();
          console.log('  Authentication successful! Token saved.');
          resolve(oauth2Client);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h1>Error exchanging code for token</h1>');
          server.close();
          reject(err);
        }
      }
    });

    server.listen(9400, () => {
      console.log('\n  Opening browser for Google sign-in...');
      console.log('  If the browser does not open, visit this URL:\n');
      console.log(`  ${authUrl}\n`);
      open(authUrl).catch(() => {});
    });
  });
}

// ─── Unified Auth Interface ────────────────────────────────────

/**
 * Returns the authenticated YouTube API client (googleapis).
 * Works with both OAuth and API key modes.
 */
async function getYouTubeApiClient(config) {
  const { google } = require('googleapis');
  const mode = getAuthMode(config);

  if (mode === 'apikey') {
    console.log('  [Auth] Using API key');
    return google.youtube({ version: 'v3', auth: config.apiKey });
  }

  // OAuth mode
  console.log('  [Auth] Using OAuth (sign-in with Google)');
  const oauth2Client = await getAuthenticatedOAuthClient(config);
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

/**
 * Returns gRPC metadata for authenticating the streamList call.
 * OAuth → Bearer token; API key → x-goog-api-key header.
 */
async function getGrpcMetadata(config) {
  const grpc = require('@grpc/grpc-js');
  const metadata = new grpc.Metadata();
  const mode = getAuthMode(config);

  if (mode === 'apikey') {
    metadata.add('x-goog-api-key', config.apiKey);
  } else {
    // OAuth — get current access token, refreshing if needed
    const oauth2Client = await getAuthenticatedOAuthClient(config);
    const tokenInfo = oauth2Client.credentials;

    // Refresh if within 5 minutes of expiry
    if (tokenInfo.expiry_date && tokenInfo.expiry_date - Date.now() < 5 * 60 * 1000) {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2));
      metadata.add('authorization', `Bearer ${credentials.access_token}`);
    } else {
      metadata.add('authorization', `Bearer ${tokenInfo.access_token}`);
    }
  }

  return metadata;
}

module.exports = { getAuthMode, getYouTubeApiClient, getGrpcMetadata };
