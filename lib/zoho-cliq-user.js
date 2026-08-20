/**
 * Zoho Cliq OAuth — send a DM as the authenticated user (not a bot).
 * Requires a Zoho API client + refresh token with ZohoCliq.Messages.CREATE scope.
 */

const DEFAULT_DC = "com";

/**
 * @param {string} [dc] e.g. com, eu, in, com.au
 */
function accountsBaseUrl(dc = DEFAULT_DC) {
  return `https://accounts.zoho.${dc}`;
}

/**
 * @param {string} [dc]
 */
function cliqBaseUrl(dc = DEFAULT_DC) {
  return `https://cliq.zoho.${dc}`;
}

/**
 * @returns {Promise<string>}
 */
export async function getZohoAccessToken({ clientId, clientSecret, refreshToken, dc = DEFAULT_DC }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Zoho OAuth not configured. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, and ZOHO_REFRESH_TOKEN in .env",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(`${accountsBaseUrl(dc)}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Zoho OAuth token refresh failed: ${data.error || response.status}`);
  }

  return data.access_token;
}

/**
 * Post a direct message to a user as YOU (OAuth token owner), not as a bot.
 * @param {{ recipient: string, text: string, accessToken: string, dc?: string }} params
 */
export async function sendCliqUserMessage({ recipient, text, accessToken, dc = DEFAULT_DC }) {
  const url = `${cliqBaseUrl(dc)}/api/v2/buddies/${encodeURIComponent(recipient)}/message`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  return response;
}

/**
 * Load OAuth credentials from environment.
 */
export function loadZohoOAuthFromEnv() {
  return {
    clientId: process.env.ZOHO_CLIENT_ID || "",
    clientSecret: process.env.ZOHO_CLIENT_SECRET || "",
    refreshToken: process.env.ZOHO_REFRESH_TOKEN || "",
    dc: (process.env.ZOHO_DC || DEFAULT_DC).trim(),
  };
}
