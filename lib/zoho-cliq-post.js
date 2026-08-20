/**
 * Post plain text to Zoho Cliq via bot /message or channel API.
 * Rewrites /incoming webhook URLs to /message when needed.
 */

/**
 * /incoming runs the bot's Deluge handler only — it does not post by itself.
 * /message (bot) or /channelsbyname/.../message (channel) posts directly.
 *
 * @param {string} webhookUrl
 * @param {string} [channelName]
 */
export function resolveZohoPostUrl(webhookUrl, channelName = "") {
  if (!webhookUrl) {
    return "";
  }

  const source = new URL(webhookUrl);
  const zapikey = source.searchParams.get("zapikey");
  const host = `${source.protocol}//${source.host}`;

  if (channelName) {
    const channelUrl = new URL(
      `${host}/api/v2/channelsbyname/${encodeURIComponent(channelName)}/message`,
    );
    if (zapikey) {
      channelUrl.searchParams.set("zapikey", zapikey);
    }
    return channelUrl.toString();
  }

  return webhookUrl.replace(/\/incoming(?=\?|$)/, "/message");
}

/**
 * @param {object} options
 * @param {string} options.webhookUrl
 * @param {string} [options.channelName]
 * @param {string} options.text
 * @param {number} [options.retryAttempts]
 * @param {number} [options.retryDelayMs]
 */
export async function postToZohoCliq({
  webhookUrl,
  channelName = "",
  text,
  retryAttempts = 3,
  retryDelayMs = 1500,
}) {
  const postUrl = resolveZohoPostUrl(webhookUrl, channelName);
  if (!postUrl) {
    throw new Error("ZOHO webhook URL is not configured");
  }

  let destination;
  try {
    const path = new URL(postUrl).pathname;
    const botMatch = path.match(/\/bots\/([^/]+)\/message$/);
    const channelMatch = path.match(/\/channelsbyname\/([^/]+)\/message$/);
    if (channelName || channelMatch) {
      destination = `channel #${channelName || channelMatch?.[1]}`;
    } else if (botMatch) {
      destination = `bot ${botMatch[1]}`;
    } else {
      destination = path;
    }
  } catch {
    destination = channelName ? `channel #${channelName}` : "Zoho Cliq";
  }

  let lastError;
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      const response = await fetch(postUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText}`);
      }
      console.log(`📨 Zoho Cliq (${destination}) response: ${responseText || "(empty)"}`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < retryAttempts) {
        console.warn(
          `⚠️  Zoho Cliq webhook failed (attempt ${attempt}/${retryAttempts}): ${error.message}. Retrying…`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  throw lastError;
}
