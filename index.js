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

/**
 * Get an array of working days (Mon-Fri) between two dates (inclusive of end, exclusive of start)
 * @param {Date} startDate
 * @param {Date} endDate
 * @returns {Array<Date>} Array of working day dates
 */
function getMissedWorkingDays(startDate, endDate) {
  const missedDays = [];
  const current = new Date(startDate);
  current.setDate(current.getDate() + 1); // Start from the day after startDate

  while (current < endDate) {
    if (!isWeekend(current)) {
      missedDays.push(new Date(current));
    }
    current.setDate(current.getDate() + 1);
  }

  return missedDays;
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

// ============================================================================
// SYSTEM PROMPT FOR GEMINI
// ============================================================================

const SYSTEM_PROMPT = `You are a helpful assistant that transforms raw git commit messages into a professional daily standup update.

INPUT FORMAT:
You will receive a list of git commits in this format:
[repository-name] [YYYY-MM-DD] commit message here
[another-repo] [YYYY-MM-DD] another commit message

YOUR TASK:
1. Group commits by repository name AND date
2. Summarize related commits into coherent bullet points
3. Write in first person ("I") as if the developer is speaking
4. Keep it concise and professional
5. Focus on completed work, not technical implementation details
6. Use clear, business-friendly language

OUTPUT FORMAT:
Return ONLY the standup message content, formatted as:
📅 Daily Standup Update
Date: [Date range if multiple days, or single date]

[Repository Name]:
• [Date if multi-day] Completed [summary of work done]
• [Additional bullet if needed]

[Another Repository]:
• [Summary of work]

GUIDELINES:
- Convert technical commit messages into plain English accomplishments
- Merge multiple related commits into single bullet points
- If commits span multiple days, group by day within each repository
- Remove commit hashes, file names, and technical jargon
- If commits are bug fixes, phrase as "Fixed issue with..." or "Resolved..."
- If commits are features, phrase as "Implemented..." or "Added..."
- Keep each bullet to one line when possible
- Maintain a professional but friendly tone
- If multiple days are included, clearly label which day each item belongs to`;

// ============================================================================
// GIT COMMIT EXTRACTION
// ============================================================================

/**
 * Get a date range for a specific day
 * @param {Date} date - The date to get range for (defaults to today)
 * @param {boolean} includeUntilNow - If true, use current time as 'until'; if false, use end of day
 * @returns {{since: string, until: string, dateStr: string}} Date range and date string
 */
function getDateRange(date = new Date(), includeUntilNow = false) {
  const targetDate = new Date(date);
  const midnight = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0);
  const endOfDay = includeUntilNow
    ? new Date() // Use current time for today
    : new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59);

  // Format: YYYY-MM-DD HH:MM:SS
  const formatDate = (d) => {
    const pad = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  // Format: YYYY-MM-DD for display
  const formatDateStr = (d) => {
    const pad = (n) => n.toString().padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  return {
    since: formatDate(midnight),
    until: formatDate(endOfDay),
    dateStr: formatDateStr(targetDate),
  };
}

/**
 * Extract commits from a single repository for a specific date
 * @param {string} repoPath - Absolute path to git repository
 * @param {Date} date - The date to extract commits for
 * @param {boolean} isToday - Whether this is today's date (affects time range)
 * @returns {Array<{repo: string, message: string, date: string}>} Array of commit objects
 */
function extractCommitsFromRepo(repoPath, date = new Date(), isToday = false) {
  const repoName = basename(repoPath);

  try {
    const { since, until, dateStr } = getDateRange(date, isToday);

    // Build git log command
    // --since and --until for date range
    // --author to filter by author (if configured)
    // --no-merges to exclude merge commits
    // --pretty=format:"%s" to get only the subject line
    let command = `git -C "${repoPath}" log --since="${since}" --until="${until}" --no-merges --pretty=format:"%s"`;

    if (GIT_AUTHOR_PATTERN) {
      command += ` --author="${GIT_AUTHOR_PATTERN}"`;
    }

    // Execute git command
    const output = execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000, // 10 second timeout
    }).trim();

    if (!output) {
      return [];
    }

    // Parse commit messages
    const commits = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((message) => ({
        repo: repoName,
        message: message.trim(),
        date: dateStr,
      }));

    return commits;
  } catch (error) {
    // If git command fails (e.g., not a git repo, no commits), return empty
    if (error.status === 128 || error.message.includes("not a git repository")) {
      console.warn(`⚠️  ${repoName}: Not a valid git repository or no commits found`);
    } else if (error.message.includes("No commits")) {
      // Only show "no commits" message for today
      if (isToday) {
        console.log(`ℹ️  ${repoName}: No commits today`);
      }
    } else {
      console.warn(`⚠️  ${repoName}: ${error.message}`);
    }
    return [];
  }
}

/**
 * Aggregate commits from all configured repositories for a specific date
 * @param {Date} date - The date to aggregate commits for
 * @param {boolean} isToday - Whether this is today's date
 * @returns {Array<{repo: string, message: string, date: string}>} All commits from all repos
 */
function aggregateCommitsForDate(date, isToday = false) {
  const dateLabel = isToday ? "today" : formatDateDisplay(date);
  if (isToday) {
    console.log("🔍 Scanning repositories for today's commits...\n");
  } else {
    console.log(`🔍 Scanning for commits on ${dateLabel}...\n`);
  }

  const allCommits = [];

  for (const repoPath of REPO_PATHS) {
    const commits = extractCommitsFromRepo(repoPath, date, isToday);
    allCommits.push(...commits);

    if (commits.length > 0) {
      console.log(`✅ ${basename(repoPath)}: Found ${commits.length} commit(s) on ${dateLabel}`);
    }
  }

  return allCommits;
}

/**
 * Aggregate commits from multiple dates (for catching up on missed days)
 * @param {Array<Date>} dates - Array of dates to aggregate commits for
 * @returns {{commits: Array, dateLabels: Array}} All commits and their date labels
 */
function aggregateCommitsForDates(dates) {
  const allCommits = [];
  const datesWithCommits = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const isToday = i === dates.length - 1; // Last date is today
    const commits = aggregateCommitsForDate(date, isToday);

    if (commits.length > 0) {
      allCommits.push(...commits);
      datesWithCommits.push(formatDateDisplay(date));
    }

    if (!isToday) {
      console.log(""); // Add spacing between dates
    }
  }

  return {
    commits: allCommits,
    dateLabels: datesWithCommits,
  };
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
    : "from today";

  const userPrompt = `Here are my git commits ${dateDescription}:\n\n${commitsText}\n\nPlease generate my daily standup update. ${isMultiDay ? "Since this spans multiple days, please clearly indicate which work was done on each day." : ""}`;

  console.log(`\n🤖 Sending to Gemini AI for summarization${isMultiDay ? " (multi-day)" : ""}...`);

  try {
    const response = await genAI.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        temperature: 0.3, // Lower temperature for more consistent output
        maxOutputTokens: 1500, // Increased for multi-day updates
      },
    });

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
  const datesToProcess = [today];
  let missedDaysCount = 0;

  if (lastRunDate) {
    const missedDays = getMissedWorkingDays(lastRunDate, today);
    if (missedDays.length > 0) {
      console.log(`📅 Last run: ${formatDateDisplay(lastRunDate)}`);
      console.log(`📝 Catching up on ${missedDays.length} missed working day(s):`);
      missedDays.forEach((day) => {
        console.log(`   - ${formatDateDisplay(day)}`);
        datesToProcess.unshift(day); // Add to beginning (chronological order)
      });
      missedDaysCount = missedDays.length;
      console.log("");
    }
  } else {
    console.log("📅 First run detected. No missed days to catch up.\n");
  }

  // Step 1: Aggregate commits from all dates
  const { commits, dateLabels } = aggregateCommitsForDates(datesToProcess);

  if (commits.length === 0) {
    console.log("\n📝 No commits found across all repositories.");
    console.log("   No standup update will be posted.");
    // Still save last run date to avoid re-scanning these days
    saveLastRunDate();
    process.exit(0);
  }

  const dateRangeText = dateLabels.length > 1
    ? `${dateLabels[0]} to ${dateLabels[dateLabels.length - 1]}`
    : dateLabels[0];
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
    if (missedDaysCount > 0) {
      console.log(`   (Included ${missedDaysCount} missed day(s) in this update)`);
    }
    // Save successful run date
    saveLastRunDate();
  } catch (error) {
    console.error("\n❌ Failed to complete standup update.");
    // Don't save last run date on failure, so we retry the same days next time
    process.exit(1);
  }
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
        message += `  • ${msg}\n`;
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
