#!/usr/bin/env node
/**
 * Daily Standup Bot
 * Automatically generates daily standup updates from git commits across multiple repos
 * and posts them to Zoho Cliq via incoming webhook.
 *
 * Setup:
 * 1. Create a .env file with GEMINI_API_KEY and ZOHO_WEBHOOK_URL; copy repos.example.txt to repos.txt
 * 2. Optional: standup-notes.txt — lines starting with "-" for non-git work (cleared after a successful post)
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

/**
 * Parse REPO_PATHS env: colon-, semicolon-, or newline-separated absolute paths.
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function parseRepoPaths(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  const paths = raw
    .split(/[:;\r\n]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return [...new Set(paths)];
}

function resolveRepoPathsFile() {
  const configured = process.env.REPO_PATHS_FILE?.trim();
  if (configured) {
    return configured.startsWith("/") ? configured : join(__dirname, configured);
  }
  return join(__dirname, "repos.txt");
}

function loadRepoPathsFromFile(filePath) {
  if (!existsSync(filePath)) {
    return [];
  }
  return [
    ...new Set(
      readFileSync(filePath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    ),
  ];
}

function loadRepoPaths() {
  const filePath = resolveRepoPathsFile();
  const fromFile = loadRepoPathsFromFile(filePath);
  if (fromFile.length > 0) {
    return fromFile;
  }

  const fromEnv = parseRepoPaths(process.env.REPO_PATHS);
  if (fromEnv.length > 0) {
    console.warn(
      "⚠️  Using REPO_PATHS from .env — prefer repos.txt (see repos.example.txt).",
    );
    return fromEnv;
  }

  return [];
}

// ============================================================================
// CONFIGURATION - Edit these values
// ============================================================================

/** Your Google Gemini API Key (get free at https://ai.google.dev/) */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE";

/** Your Zoho Cliq Incoming Webhook URL (get from Zoho Cliq channel settings) */
const ZOHO_WEBHOOK_URL = process.env.ZOHO_WEBHOOK_URL || "YOUR_ZOHO_WEBHOOK_URL_HERE";

/** Absolute paths to local git repos — set in repos.txt (see repos.example.txt) */
const REPO_PATHS = loadRepoPaths();

/** Your git author name/email pattern to match commits */
const GIT_AUTHOR_PATTERN = process.env.GIT_AUTHOR || ""; // e.g., "john.doe@company.com" or "John Doe"

/** GitHub token for PR lookup (private repos). Repo basenames in PR_LINK_REPOS get PR URLs appended when eligible. */
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const PR_LINK_REPO_NAMES = (process.env.PR_LINK_REPOS || "mx-quick-manager-backend")
  .split(/[,;]+/)
  .map((name) => name.trim())
  .filter(Boolean);
const DEFAULT_GIT_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "development",
  "staging",
  "production",
]);

/** Model to use for summarization */
const GEMINI_MODEL = "gemini-2.5-flash";

/** Max words per standup bullet (AI prompt + manual fallback) */
const MAX_STANDUP_BULLET_WORDS = 30;

/** Oldest calendar day to scan when catching up (avoids huge git logs if .last-run is very old) */
const MAX_CATCHUP_CALENDAR_DAYS = 14;

/** Retries for outbound API calls (Wi‑Fi reconnecting after wake, transient errors) */
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1500;

/** Set DRY_RUN=1 to print the message without posting to Zoho or updating .last-run */
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");

/** File to track last successful run date */
const LAST_RUN_FILE = join(__dirname, ".last-run");

/**
 * Pending manual standup items (lines starting with "-"). Cleared only after a successful Zoho post.
 * Survives missed 5:30 runs and notes added after the scheduled post the same day.
 */
const MANUAL_NOTES_FILE = process.env.MANUAL_NOTES_FILE
  ? process.env.MANUAL_NOTES_FILE.startsWith("/")
    ? process.env.MANUAL_NOTES_FILE
    : join(__dirname, process.env.MANUAL_NOTES_FILE)
  : join(__dirname, "standup-notes.txt");

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

// ============================================================================
// MANUAL NOTES (non-git work)
// ============================================================================

/**
 * Read standup-notes.txt (or MANUAL_NOTES_FILE). Each line starting with "-" is one item.
 * @returns {string[]}
 */
const STANDUP_NOTES_EXAMPLE_FILE = join(__dirname, "standup-notes.example.txt");

/**
 * Warn when bullets were added to the example file but not standup-notes.txt (common mistake).
 */
function warnIfNotesOnlyInExampleFile() {
  if (existsSync(MANUAL_NOTES_FILE) || !existsSync(STANDUP_NOTES_EXAMPLE_FILE)) {
    return;
  }
  try {
    const exampleNotes = readFileSync(STANDUP_NOTES_EXAMPLE_FILE, "utf-8")
      .split("\n")
      .filter((line) => line.trim().startsWith("-") && !line.trim().startsWith("#"));
    if (exampleNotes.length > 0) {
      console.warn(
        `⚠️  Found ${exampleNotes.length} bullet line(s) in standup-notes.example.txt, but the bot reads standup-notes.txt only.`,
      );
      console.warn(`   Copy or rename: cp standup-notes.example.txt standup-notes.txt\n`);
    }
  } catch {
    // ignore
  }
}

function loadManualNotes() {
  if (!existsSync(MANUAL_NOTES_FILE)) {
    return [];
  }
  try {
    const lines = readFileSync(MANUAL_NOTES_FILE, "utf-8").split("\n");
    const notes = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (!line.startsWith("-")) {
        continue;
      }
      const text = line.replace(/^-\s*/, "").trim();
      if (text.length > 0) {
        notes.push(text);
      }
    }
    return notes;
  } catch (error) {
    console.warn(`⚠️  Could not read manual notes (${MANUAL_NOTES_FILE}):`, error.message);
    return [];
  }
}

/** Clear manual notes after a successful post (file kept, content emptied). */
function clearManualNotes() {
  try {
    writeFileSync(MANUAL_NOTES_FILE, "", "utf-8");
  } catch (error) {
    console.warn(`⚠️  Could not clear manual notes (${MANUAL_NOTES_FILE}):`, error.message);
  }
}

/**
 * Append a guaranteed section so manual items are never dropped (used when git commits are also present).
 * @param {string} summary
 * @param {string[]} notes
 */
function appendManualNotesSection(summary, notes) {
  if (notes.length === 0) {
    return summary;
  }
  const lines = notes.map((n) => `• ${truncateWords(n)}`);
  return `${summary.trim()}\n\nOther (not from git):\n${lines.join("\n")}`;
}

/**
 * Standup from manual notes only (no commits in this run).
 * @param {string[]} notes
 */
function formatNotesOnlyManually(notes) {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const lines = notes.map((n) => `• ${truncateWords(n)}`);
  return `📅 Daily Update\nDate: ${date}\n\nOther (not from git):\n${lines.join("\n")}`;
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

/** Full calendar label for a commit date (YYYY-MM-DD), e.g. "Saturday, May 17, 2026". */
function formatCommitCalendarDay(ymd) {
  return new Date(`${ymd}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatYmd(date) {
  const d = new Date(date);
  const pad = (n) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isWeekendYmd(ymd) {
  return isWeekend(new Date(`${ymd}T12:00:00`));
}

/**
 * Relabel Saturday/Sunday commit dates to the posting weekday so weekend work
 * is grouped under Monday (or whichever weekday this standup is successfully sent).
 * @returns {{ commits: typeof commits, relabeled: number }}
 */
function normalizeWeekendCommitsToPostDay(commits, postDate) {
  const postYmd = formatYmd(postDate);
  let relabeled = 0;
  const normalized = commits.map((c) => {
    if (isWeekendYmd(c.date)) {
      relabeled++;
      return { ...c, date: postYmd };
    }
    return c;
  });
  return { commits: normalized, relabeled };
}

/** Extra Gemini instructions when commits span multiple calendar days (incl. catch-up). */
function buildMultiDayPromptHint(commits) {
  const distinctDays = new Set(commits.map((c) => c.date)).size;
  if (distinctDays <= 1) {
    return "";
  }

  return "Commits span multiple calendar days (catch-up since the last successful post). Use Date: as the full span in the header. Under EACH repository, add a plain subsection heading for every distinct commit date before that day's bullets (full calendar date from each [YYYY-MM-DD] line). ";
}

/**
 * Log when this run is catching up after a missed day (or several) since the last successful post.
 */
function logCatchUpWindow(lastRunDate, now, commits) {
  if (!lastRunDate || commits.length === 0) {
    return;
  }

  const lastPostDay = startOfLocalDay(new Date(lastRunDate));
  const todayDay = startOfLocalDay(now);
  const commitDays = [...new Set(commits.map((c) => c.date))].sort();
  const missedPostDay = lastPostDay < todayDay;

  if (!missedPostDay && commitDays.length <= 1) {
    return;
  }

  console.log("📦 Catch-up mode: combining work since your last successful post into this update.");
  console.log(`   Last successful post: ${new Date(lastRunDate).toLocaleString()}`);

  if (missedPostDay) {
    console.log(
      "   At least one calendar day had no successful post; commits from those days are included now.",
    );
  }

  if (commitDays.length > 1) {
    const labels = deriveDateLabels(commits);
    console.log(`   Commit dates in this update: ${labels.join(" → ")}`);
  }
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
The standup header Date: line shows the span of commit dates (or a single date). Do not prefix bullets with short weekdays (Mon, Tue, …).
When commits span more than one calendar day, under each repository insert a plain (non-bullet) subsection heading for every distinct commit date before that day's bullets (full calendar date from each [YYYY-MM-DD] line). Weekend commits are already dated to the posting weekday in the input—group them with that day's work, not under Saturday/Sunday headings.

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
- If commits span multiple days, keep chronological order and required per-date subsection headings (full calendar dates from the input)
- Remove commit hashes, file names, and technical jargon (except version numbers for deployment bullets)
- If commits are substantive bug fixes, you may still phrase as "Fixed issue with..." or "Resolved..."; merge tiny fixes into a Bug fixes umbrella line
- If commits are substantive features, phrase as "Implemented..." or "Added..."; merge cosmetic-only work into a UI / UX updates umbrella line
- Each bullet point stays on one line and must respect the ${MAX_STANDUP_BULLET_WORDS}-word maximum for that bullet only
- Maintain a professional but friendly tone
- When the user message says manual items are appended separately under "Other (not from git)", summarize git commits only and do not repeat those manual items`;

// ============================================================================
// GIT COMMIT EXTRACTION
// ============================================================================

/**
 * Commits with committer date strictly after the last successful Zoho post through now.
 * Uses %cs so same-calendar-day commits made after posting appear on the next run.
 * @param {string} repoPath
 * @param {Date} sinceDate exclusive lower bound in local time (matches git log --since)
 * @param {Date} untilDate upper bound (now)
 * @returns {Array<{repo: string, message: string, date: string, sha: string}>}
 */
function extractCommitsSince(repoPath, sinceDate, untilDate = new Date()) {
  const repoName = basename(repoPath);

  try {
    const sinceStr = formatLocalGitTimestamp(sinceDate);
    const untilStr = formatLocalGitTimestamp(untilDate);
    let command = `git -C "${repoPath}" log --since="${sinceStr}" --until="${untilStr}" --no-merges --pretty=format:"%H%x09%cs%x09%s"`;

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
      const parts = trimmed.split("\t");
      if (parts.length < 3) {
        continue;
      }
      const [sha, dateStr, message] = parts;
      if (!sha || !message) {
        continue;
      }
      commits.push({
        repo: repoName,
        message: message.trim(),
        date: dateStr.trim(),
        sha: sha.trim(),
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
// GITHUB PULL REQUEST LINKS (selected repos)
// ============================================================================

/**
 * @param {string} repoPath
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGitHubRemote(repoPath) {
  try {
    const url = execSync(`git -C "${repoPath}" remote get-url origin`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i);
    if (!match) {
      return null;
    }
    return { owner: match[1], repo: match[2] };
  } catch {
    return null;
  }
}

/**
 * @param {string} repoPath
 * @param {string} sha
 * @returns {string[]}
 */
function getBranchesContainingCommit(repoPath, sha) {
  try {
    const output = execSync(
      `git -C "${repoPath}" branch -a --contains "${sha}" --format="%(refname:short)"`,
      {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      },
    ).trim();
    if (!output) {
      return [];
    }
    return [
      ...new Set(
        output
          .split("\n")
          .map((branch) => branch.trim().replace(/^origin\//, ""))
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
}

/**
 * Prefer a feature branch over main/master-style defaults.
 * @param {string} repoPath
 * @param {string} sha
 * @returns {string | null}
 */
function getFeatureBranchForCommit(repoPath, sha) {
  const branches = getBranchesContainingCommit(repoPath, sha);
  const feature = branches.find((branch) => {
    const leaf = branch.split("/").pop() ?? branch;
    return !DEFAULT_GIT_BRANCHES.has(leaf);
  });
  return feature ?? null;
}

/**
 * Include PR link on the post day, or on the first weekday after a weekend PR open.
 * Skip if the PR was opened on an earlier weekday (already surfaced in a prior post).
 * @param {string | Date} prCreatedAt
 * @param {Date} postDate
 */
function shouldIncludePrLink(prCreatedAt, postDate) {
  const created = new Date(prCreatedAt);
  if (sameLocalCalendarDay(created, postDate)) {
    return true;
  }

  const createdDay = startOfLocalDay(created);
  const postDay = startOfLocalDay(postDate);
  if (createdDay >= postDay) {
    return false;
  }

  if (!isWeekend(created)) {
    return false;
  }

  let cursor = addCalendarDays(createdDay, 1);
  while (cursor < postDay) {
    if (!isWeekend(cursor)) {
      return false;
    }
    cursor = addCalendarDays(cursor, 1);
  }

  return !isWeekend(postDate);
}

function sameLocalCalendarDay(a, b) {
  const left = startOfLocalDay(a);
  const right = startOfLocalDay(b);
  return left.getTime() === right.getTime();
}

/**
 * @param {string} path
 * @param {string} token
 * @returns {Promise<unknown>}
 */
async function githubApiRequest(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }
  return response.json();
}

/**
 * @typedef {{ number: number, html_url: string, title: string, created_at: string }} GitHubPullRequest
 */

/**
 * @param {string} owner
 * @param {string} repo
 * @param {string} repoPath
 * @param {string} sha
 * @param {string} token
 * @returns {Promise<GitHubPullRequest | null>}
 */
async function findPullRequestForCommit(owner, repo, repoPath, sha, token) {
  /** @type {GitHubPullRequest[] | null} */
  const fromCommit = await githubApiRequest(
    `/repos/${owner}/${repo}/commits/${sha}/pulls`,
    token,
  );
  if (Array.isArray(fromCommit) && fromCommit.length > 0) {
    return fromCommit[0];
  }

  const branch = getFeatureBranchForCommit(repoPath, sha);
  if (!branch) {
    return null;
  }

  const head = `${owner}:${branch}`;
  /** @type {GitHubPullRequest[] | null} */
  const fromBranch = await githubApiRequest(
    `/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(head)}&per_page=5`,
    token,
  );
  if (Array.isArray(fromBranch) && fromBranch.length > 0) {
    return fromBranch[0];
  }

  return null;
}

/**
 * @param {string} repoName
 * @returns {string | null}
 */
function resolveRepoPathForPrLinks(repoName) {
  return (
    REPO_PATHS.find((repoPath) => basename(repoPath) === repoName) ??
    REPO_PATHS.find((repoPath) => repoPath.endsWith(`/${repoName}`)) ??
    null
  );
}

/**
 * @param {Array<{repo: string, message: string, date: string, sha: string}>} commits
 * @param {Date} postDate
 * @returns {Promise<Array<{ url: string, title: string, number: number }>>}
 */
async function collectEligiblePrLinks(commits, postDate) {
  if (!GITHUB_TOKEN || PR_LINK_REPO_NAMES.length === 0) {
    if (PR_LINK_REPO_NAMES.length > 0 && commits.some((c) => PR_LINK_REPO_NAMES.includes(c.repo))) {
      console.warn(
        "⚠️  Set GITHUB_TOKEN in .env to append pull request links for mx-quick-manager-backend.",
      );
    }
    return [];
  }

  const eligible = [];

  for (const repoName of PR_LINK_REPO_NAMES) {
    const repoCommits = commits.filter((commit) => commit.repo === repoName);
    if (repoCommits.length === 0) {
      continue;
    }

    const repoPath = resolveRepoPathForPrLinks(repoName);
    if (!repoPath) {
      console.warn(`⚠️  PR links: ${repoName} is configured but not found in repos.txt.`);
      continue;
    }

    const github = parseGitHubRemote(repoPath);
    if (!github) {
      console.warn(`⚠️  PR links: could not parse GitHub remote for ${repoName}.`);
      continue;
    }

    const seen = new Set();
    const uniqueShas = [...new Set(repoCommits.map((commit) => commit.sha))];
    let skippedOlderPr = 0;

    for (const sha of uniqueShas) {
      let pullRequest;
      try {
        pullRequest = await findPullRequestForCommit(
          github.owner,
          github.repo,
          repoPath,
          sha,
          GITHUB_TOKEN,
        );
      } catch (error) {
        console.warn(`⚠️  PR lookup failed for ${repoName}@${sha.slice(0, 7)}: ${error.message}`);
        continue;
      }

      if (!pullRequest || seen.has(pullRequest.number)) {
        continue;
      }

      if (!shouldIncludePrLink(pullRequest.created_at, postDate)) {
        skippedOlderPr++;
        console.log(
          `   ↳ PR #${pullRequest.number} skipped (opened ${new Date(pullRequest.created_at).toLocaleDateString()}, not eligible for today's link).`,
        );
        continue;
      }

      seen.add(pullRequest.number);
      eligible.push({
        url: pullRequest.html_url,
        title: pullRequest.title,
        number: pullRequest.number,
      });
    }

    if (skippedOlderPr > 0) {
      console.log(
        `   (${skippedOlderPr} PR(s) found for ${repoName} but omitted — opened before today on a weekday.)`,
      );
    }
  }

  eligible.sort((a, b) => a.number - b.number);
  return eligible;
}

/**
 * @param {string} summary
 * @param {Array<{ url: string, title: string, number: number }>} prLinks
 */
function appendPrLinksSection(summary, prLinks) {
  if (prLinks.length === 0) {
    return summary;
  }
  const lines = prLinks.map((pr) => `• ${pr.url}`);
  return `${summary.trim()}\n\n🔗 Pull requests:\n${lines.join("\n")}`;
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
async function summarizeCommits(commits, dateLabels, manualNotes = []) {
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

  const manualNoteHint =
    manualNotes.length > 0
      ? " Non-git manual items will be appended automatically under \"Other (not from git)\"—summarize commits only and do not list those items. "
      : "";

  const catchUpHint = buildMultiDayPromptHint(commits);

  const userPrompt = `Here are my git commits ${dateDescription}:\n\n${commitsText}\n\nPlease generate my daily standup update.${manualNoteHint}${catchUpHint}Commits that bump version in package.json (or similar) indicate a shipped build—call those out explicitly with version numbers. Each bullet point (each • line) must be at most ${MAX_STANDUP_BULLET_WORDS} words—count words only within that line after the bullet marker.`;

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

/**
 * Standup when there are manual notes but no new git commits in the window.
 * @param {string[]} notes
 */
async function summarizeNotesOnly(notes) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
    throw new Error("Gemini API key not configured. Please set GEMINI_API_KEY.");
  }

  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const notesText = notes.map((n, i) => `${i + 1}. ${n}`).join("\n");

  const userPrompt = `I have no new git commits to report, but here is other work I did (not in git):\n\n${notesText}\n\nGenerate my daily standup update using the standard header and an "Other (not from git)" section with one • bullet per item (you may lightly polish wording). Each bullet must be at most ${MAX_STANDUP_BULLET_WORDS} words.`;

  console.log("\n🤖 Sending manual notes to Gemini AI for summarization...");

  const response = await withRetries(
    () =>
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.3,
          maxOutputTokens: 1000,
        },
      }),
    "Gemini API",
  );

  const summary = response.text?.trim();
  if (!summary) {
    throw new Error("AI returned empty response");
  }
  return summary;
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
    console.error(
      "❌ No repositories configured. Copy repos.example.txt to repos.txt and add your local git paths.",
    );
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

  const manualNotes = loadManualNotes();
  if (manualNotes.length === 0) {
    warnIfNotesOnlyInExampleFile();
  }
  if (manualNotes.length > 0) {
    console.log(`📝 Manual notes: ${manualNotes.length} item(s) in ${basename(MANUAL_NOTES_FILE)}`);
    console.log("   (Kept until a successful post—includes notes added after a missed or early run.)\n");
  }

  let commits = aggregateCommitsSince(sinceBoundary, now);
  const { commits: normalizedCommits, relabeled: weekendRelabeled } =
    normalizeWeekendCommitsToPostDay(commits, now);
  commits = normalizedCommits;

  if (weekendRelabeled > 0) {
    console.log(
      `📅 Grouped ${weekendRelabeled} weekend commit(s) under ${formatCommitCalendarDay(formatYmd(now))} for this post.\n`,
    );
  }

  let dateLabels = deriveDateLabels(commits);

  logCatchUpWindow(lastRunDate, now, commits);

  if (commits.length === 0 && manualNotes.length === 0) {
    console.log("\n📝 No new commits since the last post and no manual notes.");
    console.log("   No standup update will be posted.");
    console.log("   (.last-run and standup-notes are unchanged.)");
    process.exit(0);
  }

  if (dateLabels.length === 0 && manualNotes.length > 0) {
    dateLabels = [formatDateDisplay(now)];
  }

  if (commits.length > 0) {
    const dateRangeText =
      dateLabels.length > 1 ? `${dateLabels[0]} → ${dateLabels[dateLabels.length - 1]}` : dateLabels[0];
    console.log(`\n📊 Total commits found (${dateRangeText}): ${commits.length}`);
  } else {
    console.log("\n📊 No new commits; posting manual notes only.");
  }

  // Step 2: Summarize with AI
  let summary;
  try {
    if (commits.length === 0) {
      summary = await summarizeNotesOnly(manualNotes);
    } else {
      summary = await summarizeCommits(commits, dateLabels, manualNotes);
    }
  } catch (error) {
    console.log("\n⚠️  AI summarization failed. Using fallback formatting...");
    summary =
      commits.length === 0
        ? formatNotesOnlyManually(manualNotes)
        : formatCommitsManually(commits, dateLabels);
  }

  if (commits.length > 0 && manualNotes.length > 0) {
    summary = appendManualNotesSection(summary, manualNotes);
  }

  summary = enforceMaxWordsPerBullet(summary);

  const prLinks = await collectEligiblePrLinks(commits, now);
  if (prLinks.length > 0) {
    console.log(`\n🔗 Appending ${prLinks.length} pull request link(s) opened for this post.`);
    summary = appendPrLinksSection(summary, prLinks);
  }

  // Step 3: Display the summary
  console.log("\n" + "=".repeat(60));
  console.log("📋 GENERATED STANDUP UPDATE:");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));

  // Step 4: Post to Zoho Cliq
  if (DRY_RUN) {
    console.log("\n🧪 DRY_RUN: Skipping Zoho post (.last-run and standup-notes unchanged).");
    process.exit(0);
  }

  try {
    await postToZohoCliq(summary);
    console.log("\n🎉 Standup update completed successfully!");
    saveLastRunDate();
    if (manualNotes.length > 0) {
      clearManualNotes();
      console.log(`   Cleared ${basename(MANUAL_NOTES_FILE)} after successful post.`);
    }
  } catch (error) {
    console.error("\n❌ Failed to complete standup update.");
    console.error("   .last-run and standup-notes were not changed.");
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
        message += `${formatCommitCalendarDay(date)}\n`;
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
