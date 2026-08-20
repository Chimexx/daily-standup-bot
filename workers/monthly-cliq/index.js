#!/usr/bin/env node
/**
 * Monthly Cliq Worker
 * Sends a direct message to a Zoho Cliq user once per calendar month
 * on a configured day. Default delivery is as YOU (OAuth), not a bot.
 *
 * Setup:
 *   1. cp config/examples/monthly-cliq.config.example.json monthly-cliq.config.json
 *   2. Fill in recipient + message; add Zoho OAuth to .env (see docs/MONTHLY-CLIQ.md)
 *   3. npm run monthly-cliq
 *
 * Disable: set "enabled": false in the config file (or MONTHLY_CLIQU_ENABLED=0).
 *
 * Test without sending:
 *   DRY_RUN=1 MONTHLY_CLIQU_FORCE=1 npm run monthly-cliq
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadEnvFile } from "../../lib/env.js";
import { createRunErrorLogger } from "../../lib/error-log.js";
import {
  getZohoAccessToken,
  loadZohoOAuthFromEnv,
  sendCliqUserMessage,
} from "../../lib/zoho-cliq-user.js";
import {
  PROJECT_ROOT,
  resolveEnvPath,
  resolveProjectPath,
} from "../../lib/paths.js";

loadEnvFile(join(PROJECT_ROOT, ".env"));

const DEFAULT_CONFIG_FILE = resolveEnvPath(process.env.MONTHLY_CLIQU_CONFIG_FILE, "monthly-cliq.config.json");
const LAST_RUN_FILE = join(PROJECT_ROOT, ".last-monthly-cliq");
const ERROR_LOG_FILE = join(PROJECT_ROOT, "monthly-cliq-errors.txt");

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const FORCE_RUN = /^(1|true|yes)$/i.test(process.env.MONTHLY_CLIQU_FORCE || "");
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1500;

const runErrorLog = createRunErrorLogger(ERROR_LOG_FILE);

function initErrorLog() {
  runErrorLog.init();
}

function recordRunError(message, error) {
  runErrorLog.record(message, error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetries(operation, label) {
  let lastError;
  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < API_RETRY_ATTEMPTS) {
        console.warn(
          `⚠️  ${label} failed (attempt ${attempt}/${API_RETRY_ATTEMPTS}): ${error.message}. Retrying…`,
        );
        await sleep(API_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parsePositiveInt(value, fallback, { min = 1, max = 31 } = {}) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

function resolveConfigPath() {
  const configured = process.env.MONTHLY_CLIQU_CONFIG_FILE?.trim();
  if (configured) {
    return resolveProjectPath(configured);
  }
  if (existsSync(DEFAULT_CONFIG_FILE)) {
    return DEFAULT_CONFIG_FILE;
  }
  return DEFAULT_CONFIG_FILE;
}

/**
 * @returns {{
 *   enabled: boolean,
 *   dayOfMonth: number,
 *   hour: number,
 *   minute: number,
 *   recipient: string,
 *   message: string,
 *   delivery: "user" | "bot",
 *   zohoBotMessageUrl: string,
 * }}
 */
function normalizeDelivery(value) {
  const v = String(value ?? "user").trim().toLowerCase();
  if (v === "bot") {
    return "bot";
  }
  return "user";
}

function loadConfig() {
  const configPath = resolveConfigPath();
  /** @type {Record<string, unknown>} */
  let fileConfig = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (error) {
      throw new Error(`Invalid JSON in ${configPath}: ${error.message}`);
    }
  }

  const schedule =
    fileConfig.schedule && typeof fileConfig.schedule === "object"
      ? /** @type {Record<string, unknown>} */ (fileConfig.schedule)
      : {};

  const enabled = parseBool(
    process.env.MONTHLY_CLIQU_ENABLED ?? fileConfig.enabled,
    false,
  );

  const dayOfMonth = parsePositiveInt(
    process.env.MONTHLY_CLIQU_DAY ?? schedule.dayOfMonth ?? fileConfig.dayOfMonth,
    1,
    { min: 1, max: 31 },
  );

  const hour = parsePositiveInt(
    process.env.MONTHLY_CLIQU_HOUR ?? schedule.hour,
    9,
    { min: 0, max: 23 },
  );

  const minute = parsePositiveInt(
    process.env.MONTHLY_CLIQU_MINUTE ?? schedule.minute,
    0,
    { min: 0, max: 59 },
  );

  const recipient = String(
    process.env.MONTHLY_CLIQU_RECIPIENT ?? fileConfig.recipient ?? "",
  ).trim();

  const messageFile = String(
    process.env.MONTHLY_CLIQU_MESSAGE_FILE ?? fileConfig.messageFile ?? "",
  ).trim();

  let message = String(process.env.MONTHLY_CLIQU_MESSAGE ?? fileConfig.message ?? "").trim();

  if (messageFile) {
    const messagePath = resolveProjectPath(messageFile);
    if (!existsSync(messagePath)) {
      throw new Error(`Message file not found: ${messagePath}`);
    }
    message = readFileSync(messagePath, "utf-8").trim();
  }

  const delivery = normalizeDelivery(
    process.env.MONTHLY_CLIQU_DELIVERY ?? fileConfig.delivery,
  );

  const zohoBotMessageUrl = String(
    process.env.MONTHLY_CLIQU_BOT_MESSAGE_URL ??
      process.env.ZOHO_BOT_MESSAGE_URL ??
      fileConfig.zohoBotMessageUrl ??
      "",
  ).trim();

  return {
    enabled,
    dayOfMonth,
    hour,
    minute,
    recipient,
    message,
    delivery,
    zohoBotMessageUrl,
    configPath,
  };
}

function formatMonthKey(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

function getLastRunMonth() {
  if (!existsSync(LAST_RUN_FILE)) {
    return null;
  }
  try {
    return readFileSync(LAST_RUN_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function saveLastRunMonth(monthKey) {
  writeFileSync(LAST_RUN_FILE, `${monthKey}\n`, "utf-8");
}

function applyMessageTemplate(message, now) {
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return message
    .replaceAll("{{date}}", dateLabel)
    .replaceAll("{{month}}", now.toLocaleString("en-US", { month: "long" }))
    .replaceAll("{{year}}", String(now.getFullYear()));
}

function isScheduledNow(config, now) {
  if (FORCE_RUN) {
    return true;
  }

  if (now.getDate() !== config.dayOfMonth) {
    return false;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const scheduledMinutes = config.hour * 60 + config.minute;
  return currentMinutes >= scheduledMinutes;
}

async function sendCliqBotMessage(config, text) {
  if (!config.zohoBotMessageUrl) {
    throw new Error(
      "zohoBotMessageUrl is required when delivery is \"bot\". Set it in monthly-cliq.config.json.",
    );
  }

  const payload = {
    text,
    userids: config.recipient,
  };

  await withRetries(async () => {
    const response = await fetch(config.zohoBotMessageUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return response;
  }, "Zoho Cliq bot message");
}

async function sendCliqUserDirectMessage(config, text) {
  const oauth = loadZohoOAuthFromEnv();

  await withRetries(async () => {
    const accessToken = await getZohoAccessToken(oauth);
    await sendCliqUserMessage({
      recipient: config.recipient,
      text,
      accessToken,
      dc: oauth.dc,
    });
  }, "Zoho Cliq user message");
}

async function deliverMessage(config, text) {
  if (!config.recipient) {
    throw new Error(
      "recipient is not configured. Set recipient in monthly-cliq.config.json or MONTHLY_CLIQU_RECIPIENT.",
    );
  }
  if (!text) {
    throw new Error("Message is empty. Set message or messageFile in the config.");
  }

  if (config.delivery === "bot") {
    await sendCliqBotMessage(config, text);
    return;
  }

  await sendCliqUserDirectMessage(config, text);
}

async function main() {
  initErrorLog();

  console.log("=".repeat(60));
  console.log("📬 Monthly Cliq Worker");
  console.log("=".repeat(60));
  console.log(`🕐 Running at: ${new Date().toLocaleString()}\n`);

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    recordRunError("Failed to load config", error);
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }

  console.log(`📄 Config: ${config.configPath}`);

  if (!config.enabled) {
    console.log("⏸️  Monthly Cliq worker is disabled (enabled: false). Exiting.");
    process.exit(0);
  }

  const now = new Date();
  const monthKey = formatMonthKey(now);
  const lastRunMonth = getLastRunMonth();

  if (!isScheduledNow(config, now)) {
    console.log(
      `📅 Not scheduled now (day ${config.dayOfMonth} at ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")}). Exiting.`,
    );
    process.exit(0);
  }

  if (!FORCE_RUN && lastRunMonth === monthKey) {
    console.log(`✅ Already sent for ${monthKey} (.last-monthly-cliq). Exiting.`);
    process.exit(0);
  }

  const message = applyMessageTemplate(config.message, now);

  console.log(`👤 Recipient: ${config.recipient}`);
  console.log(`📨 Sends as you (9:00 AM local on day ${config.dayOfMonth} each month)`);
  console.log(`📆 Month: ${monthKey}`);
  console.log("\n" + "=".repeat(60));
  console.log("📝 MESSAGE:");
  console.log("=".repeat(60));
  console.log(message);
  console.log("=".repeat(60));

  if (DRY_RUN) {
    console.log("\n🧪 DRY_RUN: Skipping Cliq send (.last-monthly-cliq unchanged).");
    process.exit(0);
  }

  try {
    const label = config.delivery === "bot" ? "Zoho Cliq bot" : "your Cliq account";
    console.log(`\n📤 Sending via ${label}…`);
    await deliverMessage(config, message);
    saveLastRunMonth(monthKey);
    console.log(`\n✅ Message sent. Recorded ${monthKey} in .last-monthly-cliq`);
  } catch (error) {
    recordRunError("Failed to send monthly Cliq message", error);
    console.error("\n❌ Failed to send message.");
    console.error("   See monthly-cliq-errors.txt for details.");
    process.exit(1);
  }
}

main().catch((error) => {
  if (!runErrorLog.initialized) {
    initErrorLog();
  }
  recordRunError("Fatal error", error);
  console.error("\n💥 Fatal error:", error.message);
  process.exit(1);
});
