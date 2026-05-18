#!/usr/bin/env node
/**
 * Daily Standup Bot
 * Automatically generates daily standup updates from git commits across multiple repos
 * and posts them to Zoho Cliq via incoming webhook.
 *
 * Setup:
 * 1. Create a .env file in this directory with GEMINI_API_KEY and ZOHO_WEBHOOK_URL
 * 2. Configure your REPO_PATHS array
 * 3. Run: node index.js
 */

import { GoogleGenAI } from "@google/genai";
import { execSync } from "child_process";
import { basename, dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";

// Get the directory where this script is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load KEY=value pairs from .env in the project directory.
 * Does not override variables already set in the environment.
 */
function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  const content = readFileSync(filePath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(join(__dirname, ".env"));

// ============================================================================
// CONFIGURATION - Edit these values
// ============================================================================

/** Your Google Gemini API Key (get free at https://ai.google.dev/) */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE";

/** Your Zoho Cliq Incoming Webhook URL (get from Zoho Cliq channel settings) */
const ZOHO_WEBHOOK_URL = process.env.ZOHO_WEBHOOK_URL || "YOUR_ZOHO_WEBHOOK_URL_HERE";

/** Array of absolute paths to your local git repositories */
const REPO_PATHS = [
  "/Users/macbook/Repos/Timart/mx-quick-manager-backend",
  "/Users/macbook/Repos/Timart/timart-custom-website",
  "/Users/macbook/Repos/Timart/timart-unify",
  "/Users/macbook/Repos/Timart/timart-landing-page",
  "/Users/macbook/Repos/Timart/partner-landing-page",
];

/** Your git author name/email pattern to match commits */
const GIT_AUTHOR_PATTERN = process.env.GIT_AUTHOR || ""; // e.g., "john.doe@company.com" or "John Doe"

/** Model to use for summarization */
const GEMINI_MODEL = "gemini-2.5-flash";

/** Max words per standup bullet (AI prompt + manual fallback) */
const MAX_STANDUP_BULLET_WORDS = 30;

/** Oldest calendar day to scan when catching up (avoids huge git logs if .last-run is very old) */
const MAX_CATCHUP_CALENDAR_DAYS = 14;

/** Retries for outbound API calls (Wi‑Fi reconnecting after wake, transient errors) */
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1500;

/** File to track last successful run date */
const LAST_RUN_FILE = join(__dirname, ".last-run");

// ============================================================================
// LAST RUN TRACKING
// ============================================================================

/**
 * Get the last run date from file
 * @returns {Date|null} The last run date or null if never run
 */
function getLastRunDate() {
  try {
    if (existsSync(LAST_RUN_FILE)) {
      const dateStr = readFileSync(LAST_RUN_FILE, "utf-8").trim();
      return new Date(dateStr);
    }
  } catch (error) {
    console.warn("⚠️  Could not read last run date:", error.message);
  }
  return null;
}

/**
 * Save the current date as the last run date
 */
function saveLastRunDate() {
  try {
    writeFileSync(LAST_RUN_FILE, new Date().toISOString());
  } catch (error) {
    console.warn("⚠️  Could not save last run date:", error.message);
  }
}

/**
 * Check if a date is a weekend (Saturday or Sunday)
 * @param {Date} date
 * @returns {boolean}
 */
function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function startOfLocalDay(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addCalendarDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @template T
 * @param {() => Promise<T>} operation
 * @param {string} label
 * @returns {Promise<T>}
 */
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

/**
 * Format date for display
 * @param {Date} date
 * @returns {string}
 */
function formatDateDisplay(date) {
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * Local timestamp string for git --since / --until (matches prior calendar-range behavior).
 */
function formatLocalGitTimestamp(d) {
  const pad = (n) => n.toString().padStart(2, "0");
  const x = new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())} ${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

/**
 * Lower bound for git log: last successful post instant, or local midnight today on first run.
 * Caps how far back we scan when .last-run is very old.
 */
function computeSinceBoundary(lastRunDate, now = new Date()) {
  const todayStart = startOfLocalDay(now);
  const oldestAllowed = addCalendarDays(todayStart, -MAX_CATCHUP_CALENDAR_DAYS);

  if (!lastRunDate) {
    return todayStart;
  }

  const last = new Date(lastRunDate);
  if (last < oldestAllowed) {
    console.warn(
      `⚠️  Last post was over ${MAX_CATCHUP_CALENDAR_DAYS} days ago; scanning commits only back to ${formatDateDisplay(oldestAllowed)}.`,
    );
    return oldestAllowed;
  }

  return last;
}

/**
 * Distinct commit calendar dates (YYYY-MM-DD), sorted, as short UI labels.
 */
function deriveDateLabels(commits) {
  const keys = [...new Set(commits.map((c) => c.date))].sort();
  return keys.map((ymd) =>
    new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }),
  );
}

// ============================================================================
// SYSTEM PROMPT FOR GEMINI
// ============================================================================

const SYSTEM_PROMPT = `You are a helpful assistant that transforms raw git commit messages into a professional daily standup update.

INPUT FORMAT:
You will receive a list of git commits in this format:
[repository-name] [YYYY-MM-DD] commit message here
[another-repo] [YYYY-MM-DD] another commit message

YOUR TASK:
1. Group commits by repository name (use commit dates only to order and merge internally — do not echo weekdays on each bullet)
2. Summarize related commits into coherent bullet points
3. Write in first person ("I") as if the developer is speaking
4. Keep it concise and professional
5. Focus on completed work, not technical implementation details
6. Use clear, business-friendly language
7. When several commits are small, vague, or intangible (typos, tweaks, cleanup, minor fixes), merge them into themed bullets instead of one bullet per commit

OUTPUT FORMAT:
Return ONLY the standup message content, formatted as:
📅 Daily Update
Date: [Date range if multiple days, or single date]

[Repository Name]:
• Completed [summary of work done]
• [Additional bullet if needed]

[Another Repository]:
• [Summary of work]

DATE LINES VS BULLETS:
The required standup header includes Date: [single date or range]. Do not prefix bullets with weekdays (Mon, Tue, …) or repeat calendar dates on every bullet — the header already provides timing context.
If commits span several calendar days and separating days avoids confusion, under that repository only insert plain (non-bullet) subsection headings before grouped bullets, such as "June 9, 2026" or "2026-06-09" — never weekday abbreviations on bullets themselves.

DEPLOYMENT / VERSION BUMPS:
Treat commits as a production or build deployment when they clearly bump app/package version, especially when package.json (or similar manifest) is mentioned. Examples: "update version to 26.5.18 in package.json", "bump version to 1.2.3", "chore: release 2.0.0".
For those commits, add an explicit bullet such as: "Shipped / deployed build [version] for [repository name]." or "Released version [version] from [repository]." Merge duplicate version-only housekeeping into one deployment line when appropriate.

GROUPING INTANGIBLE OR MINOR WORK:
Use short umbrella bullets when messages are thin (e.g. "wip", "fixes", "small tweaks", "copy", "styles") or too numerous to list individually. Prefer labels like:
• Bug fixes — group defect fixes, regressions, edge cases, error handling, and stability tweaks under one line (e.g. "Addressed several minor bugs and edge cases across [area].").
• UI / UX updates — group layout, styling, spacing, components, responsiveness, and visual polish under one line (e.g. "Refined UI/UX on [screen or flow].").
• Copy / content — group text, labels, translations, and messaging tweaks.
• Maintenance — group refactors, deps, config, lint/formatting, and housekeeping only when there is no clearer product outcome.

You may use only the umbrellas that fit the commits; omit empty categories. Prefer one strong umbrella bullet over many vague single-commit bullets.

LENGTH (STRICT):
- Each bullet point is one list line starting with • (or equivalent). Maximum ${MAX_STANDUP_BULLET_WORDS} words in the text of that bullet only — count words in that single line after the marker; title/header lines and repository names are not bullets and are unrestricted.
- Split overflow into a second bullet if needed rather than exceeding the word limit per bullet.

GUIDELINES:
- Convert technical commit messages into plain English accomplishments
- Merge multiple related commits into single bullet points
- If commits span multiple days, keep chronological order; optional dated subsection headings (plain lines, full calendar dates only when necessary)—never prefix individual bullets with weekdays or repeated dates
- Remove commit hashes, file names, and technical jargon (except version numbers for deployment bullets)
- If commits are substantive bug fixes, you may still phrase as "Fixed issue with..." or "Resolved..."; merge tiny fixes into a Bug fixes umbrella line
- If commits are substantive features, phrase as "Implemented..." or "Added..."; merge cosmetic-only work into a UI / UX updates umbrella line
- Each bullet point stays on one line and must respect the ${MAX_STANDUP_BULLET_WORDS}-word maximum for that bullet only
- Maintain a professional but friendly tone`;

// ============================================================================
// GIT COMMIT EXTRACTION
// ============================================================================

/**
 * Commits with committer date strictly after the last successful Zoho post through now.
 * Uses %cs so same-calendar-day commits made after posting appear on the next run.
 * @param {string} repoPath
 * @param {Date} sinceDate exclusive lower bound in local time (matches git log --since)
 * @param {Date} untilDate upper bound (now)
 * @returns {Array<{repo: string, message: string, date: string}>}
 */
function extractCommitsSince(repoPath, sinceDate, untilDate = new Date()) {
  const repoName = basename(repoPath);

  try {
    const sinceStr = formatLocalGitTimestamp(sinceDate);
    const untilStr = formatLocalGitTimestamp(untilDate);
    let command = `git -C "${repoPath}" log --since="${sinceStr}" --until="${untilStr}" --no-merges --pretty=format:"%cs%x09%s"`;

    if (GIT_AUTHOR_PATTERN) {
      command += ` --author="${GIT_AUTHOR_PATTERN}"`;
    }

    const output = execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }).trim();

    if (!output) {
      return [];
    }

    const commits = [];
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const tab = trimmed.indexOf("\t");
      if (tab === -1) {
        continue;
      }
      const dateStr = trimmed.slice(0, tab).trim();
      const message = trimmed.slice(tab + 1).trim();
      if (!message) {
        continue;
      }
      commits.push({
        repo: repoName,
        message,
        date: dateStr,
      });
    }

    return commits;
  } catch (error) {
    if (error.status === 128 || error.message.includes("not a git repository")) {
      console.warn(`⚠️  ${repoName}: Not a valid git repository or no commits found`);
    } else {
      console.warn(`⚠️  ${repoName}: ${error.message}`);
    }
    return [];
  }
}

/**
 * Collect commits after last post from every repo and sort for stable prompts.
 * @param {Date} sinceBoundary
 * @param {Date} untilDate
 */
function aggregateCommitsSince(sinceBoundary, untilDate = new Date()) {
  const label = formatDateDisplay(sinceBoundary);
  console.log(`🔍 Scanning commits after ${label} (exclusive) through now…\n`);

  const allCommits = [];

  for (const repoPath of REPO_PATHS) {
    const commits = extractCommitsSince(repoPath, sinceBoundary, untilDate);
    allCommits.push(...commits);

    if (commits.length > 0) {
      console.log(`✅ ${basename(repoPath)}: Found ${commits.length} commit(s)`);
    }
  }

  allCommits.sort((a, b) => a.date.localeCompare(b.date) || a.repo.localeCompare(b.repo) || a.message.localeCompare(b.message));

  return allCommits;
}

// ============================================================================
// AI SUMMARIZATION
// ============================================================================

/**
 * Summarize commits using Google Gemini AI
 * @param {Array<{repo: string, message: string, date: string}>} commits
 * @param {Array<string>} dateLabels - Labels for the dates being summarized
 * @returns {Promise<string>} Summarized standup message
 */
async function summarizeCommits(commits, dateLabels) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
    throw new Error("Gemini API key not configured. Please set GEMINI_API_KEY.");
  }

  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  // Format commits for the AI with date information
  const commitsText = commits.map((c) => `[${c.repo}] [${c.date}] ${c.message}`).join("\n");

  const isMultiDay = dateLabels.length > 1;
  const dateDescription = isMultiDay
    ? `from the following days: ${dateLabels.join(", ")}`
    : `from ${dateLabels[0] ?? "the latest session"}`;

  const userPrompt = `Here are my git commits ${dateDescription}:\n\n${commitsText}\n\nPlease generate my daily standup update. ${isMultiDay ? "Commits span multiple calendar days: keep chronological order; you may use plain subsection headings with full dates under a repo if helpful—do not prefix bullets with weekdays like Mon/Tue. " : ""}Commits that bump version in package.json (or similar) indicate a shipped build—call those out explicitly with version numbers. Each bullet point (each • line) must be at most ${MAX_STANDUP_BULLET_WORDS} words—count words only within that line after the bullet marker.`;

  console.log(`\n🤖 Sending to Gemini AI for summarization${isMultiDay ? " (multi-day)" : ""}...`);

  try {
    const response = await withRetries(
      () =>
        genAI.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          config: {
            systemInstruction: SYSTEM_PROMPT,
            temperature: 0.3, // Lower temperature for more consistent output
            maxOutputTokens: 1500, // Increased for multi-day updates
          },
        }),
      "Gemini API",
    );

    const summary = response.text?.trim();

    if (!summary) {
      throw new Error("AI returned empty response");
    }

    return summary;
  } catch (error) {
    console.error("❌ AI summarization failed:", error.message);
    throw error;
  }
}

// ============================================================================
// ZOHO CLIQ INTEGRATION
// ============================================================================

/**
 * Post message to Zoho Cliq via incoming webhook
 * @param {string} message - The standup message to post
 */
async function postToZohoCliq(message) {
  if (!ZOHO_WEBHOOK_URL || ZOHO_WEBHOOK_URL === "YOUR_ZOHO_WEBHOOK_URL_HERE") {
    throw new Error("Zoho webhook URL not configured. Please set ZOHO_WEBHOOK_URL.");
  }

  console.log("\n📤 Posting to Zoho Cliq...");

  const payload = {
    text: message,
  };

  try {
    await withRetries(async () => {
      const response = await fetch(ZOHO_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      return response;
    }, "Zoho Cliq webhook");

    console.log("✅ Successfully posted to Zoho Cliq!");
    return true;
  } catch (error) {
    console.error("❌ Failed to post to Zoho Cliq:", error.message);
    throw error;
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  console.log("=".repeat(60));
  console.log("📊 Daily Standup Bot");
  console.log("=".repeat(60));
  console.log(`🕐 Running at: ${new Date().toLocaleString()}`);
  console.log("");

  // Skip weekends - only run Monday through Friday
  const today = new Date();
  const dayOfWeek = today.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log("🌴 It's the weekend! Skipping standup update.");
    console.log("   (Monday to Friday only)");
    process.exit(0);
  }

  // Validate configuration
  if (REPO_PATHS.length === 0) {
    console.error("❌ No repositories configured. Please add paths to REPO_PATHS array.");
    process.exit(1);
  }

  // Check for missed days
  const lastRunDate = getLastRunDate();
  const now = new Date();
  const sinceBoundary = computeSinceBoundary(lastRunDate, now);

  if (lastRunDate) {
    console.log(`📅 Last successful post: ${lastRunDate.toLocaleString()}`);
    console.log(`📌 Gathering commits after that time (same-day commits you push later are included next run).\n`);
  } else {
    console.log("📅 First run: gathering commits since local midnight today.\n");
  }

  const commits = aggregateCommitsSince(sinceBoundary, now);
  const dateLabels = deriveDateLabels(commits);

  if (commits.length === 0) {
    console.log("\n📝 No new commits since the last post.");
    console.log("   No standup update will be posted.");
    console.log("   (.last-run is unchanged.)");
    process.exit(0);
  }

  const dateRangeText =
    dateLabels.length > 1 ? `${dateLabels[0]} → ${dateLabels[dateLabels.length - 1]}` : dateLabels[0];
  console.log(`\n📊 Total commits found (${dateRangeText}): ${commits.length}`);

  // Step 2: Summarize with AI
  let summary;
  try {
    summary = await summarizeCommits(commits, dateLabels);
  } catch (error) {
    // Fallback: format commits manually if AI fails
    console.log("\n⚠️  AI summarization failed. Using fallback formatting...");
    summary = formatCommitsManually(commits, dateLabels);
  }

  summary = enforceMaxWordsPerBullet(summary);

  // Step 3: Display the summary
  console.log("\n" + "=".repeat(60));
  console.log("📋 GENERATED STANDUP UPDATE:");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));

  // Step 4: Post to Zoho Cliq
  try {
    await postToZohoCliq(summary);
    console.log("\n🎉 Standup update completed successfully!");
    // Save successful run date
    saveLastRunDate();
  } catch (error) {
    console.error("\n❌ Failed to complete standup update.");
    // Don't save last run date on failure, so we retry the same days next time
    process.exit(1);
  }
}

/**
 * @param {string} text
 * @param {number} [maxWords]
 */
function truncateWords(text, maxWords = MAX_STANDUP_BULLET_WORDS) {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }
  return `${words.slice(0, maxWords).join(" ")}…`;
}

/**
 * Enforces {@link MAX_STANDUP_BULLET_WORDS} words max per bullet line (after •, -, *, or numbered markers).
 */
function enforceMaxWordsPerBullet(text, maxWords = MAX_STANDUP_BULLET_WORDS) {
  return text
    .split("\n")
    .map((line) => {
      const m = line.match(/^(\s*)(?:([•*\-])|(\d+\.))\s+(.*)$/);
      if (!m) {
        return line;
      }
      const [, indent, charMarker, numMarker, body] = m;
      const marker = charMarker ?? numMarker;
      return `${indent}${marker} ${truncateWords(body, maxWords)}`;
    })
    .join("\n");
}

/**
 * Best-effort semver fragment from a commit subject line.
 */
function extractSemverFromCommitMessage(message) {
  const m = message.match(/\bv?(\d+\.\d+\.\d+(?:[-+]?[a-zA-Z0-9.-]+)?)\b/);
  return m ? m[1] : null;
}

/**
 * Heuristic: version bump / release commits (e.g. "update version to 26.5.18 in package.json").
 */
function looksLikePackageVersionBump(message) {
  const lower = message.toLowerCase();
  const mentionsManifest =
    lower.includes("package.json") ||
    lower.includes("package-lock.json") ||
    lower.includes("package-lock");
  const mentionsVersioning =
    /(^|[\s,.])(bump|update)\s+version\b/i.test(message) ||
    /\bversion\s+bump\b/i.test(lower) ||
    /\b(chore:\s*)?(release|publish)\b/i.test(lower);
  const ver = extractSemverFromCommitMessage(message);
  return Boolean(ver) && (mentionsManifest || mentionsVersioning || /\b(deploy|release|publish)\b/i.test(lower));
}

/**
 * One fallback bullet per commit: deployment wording when detected, else truncated raw subject.
 */
function manualBulletFromCommit(repoName, rawMessage) {
  const ver = extractSemverFromCommitMessage(rawMessage);
  if (ver && looksLikePackageVersionBump(rawMessage)) {
    return truncateWords(`Deployed build ${ver}.`);
  }
  return truncateWords(rawMessage);
}

/**
 * Fallback manual formatting if AI fails
 * @param {Array<{repo: string, message: string, date: string}>} commits
 * @param {Array<string>} dateLabels - Labels for the dates
 * @returns {string} Manually formatted message
 */
function formatCommitsManually(commits, dateLabels) {
  const today = new Date();
  const isMultiDay = dateLabels.length > 1;

  const dateHeader = isMultiDay
    ? `${dateLabels[0]} to ${dateLabels[dateLabels.length - 1]}`
    : today.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

  // Group by repository and date
  const byRepoAndDate = commits.reduce((acc, commit) => {
    if (!acc[commit.repo]) {
      acc[commit.repo] = {};
    }
    if (!acc[commit.repo][commit.date]) {
      acc[commit.repo][commit.date] = [];
    }
    acc[commit.repo][commit.date].push(commit.message);
    return acc;
  }, {});

  let message = `📋 Daily Standup Update - ${dateHeader}\n\n`;

  for (const [repo, dates] of Object.entries(byRepoAndDate)) {
    message += `${repo}:\n`;

    // Sort dates chronologically
    const sortedDates = Object.keys(dates).sort();

    for (const date of sortedDates) {
      const messages = dates[date];
      if (isMultiDay) {
        const displayDate = new Date(date).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
        message += `  [${displayDate}]\n`;
      }
      for (const msg of messages) {
        message += `  • ${manualBulletFromCommit(repo, msg)}\n`;
      }
    }
    message += "\n";
  }

  return message.trim();
}

// Run the main function
main().catch((error) => {
  console.error("\n💥 Fatal error:", error.message);
  process.exit(1);
});
