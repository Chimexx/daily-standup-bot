#!/usr/bin/env node
/**
 * Weekly Standup Worker
 * Summarizes git commits from the previous Tuesday through the report Tuesday
 * and posts to Zoho Cliq (Amadioha bot by default).
 *
 * Setup: shared .env + repos.txt (see docs/WEEKLY-STANDUP.md)
 * Run:   npm run weekly-standup
 * Test:  DRY_RUN=1 WEEKLY_STANDUP_FORCE=1 npm run weekly-standup
 */

import { GoogleGenAI } from "@google/genai";
import { execSync } from "child_process";
import { basename, join } from "path";
import { existsSync, readFileSync } from "fs";
import { loadEnvFile } from "../../lib/env.js";
import { createRunErrorLogger } from "../../lib/error-log.js";
import { postToZohoCliq } from "../../lib/zoho-cliq-post.js";
import { PROJECT_ROOT, resolveEnvPath } from "../../lib/paths.js";
import {
  formatDateDisplay,
  formatLocalGitTimestamp,
  formatWeekRange,
  getWeeklyWindow,
} from "../../lib/weekly-window.js";

loadEnvFile(join(PROJECT_ROOT, ".env"));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ERROR_LOG_FILE = join(PROJECT_ROOT, "weekly-standup-errors.txt");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ZOHO_WEBHOOK_URL =
  process.env.ZOHO_WEEKLY_WEBHOOK_URL || process.env.ZOHO_WEBHOOK_URL || "";
const ZOHO_CHANNEL =
  process.env.ZOHO_WEEKLY_CHANNEL || process.env.ZOHO_CHANNEL || "";
const GIT_AUTHOR_PATTERNS = (process.env.GIT_AUTHOR || "")
  .split(/[,;]+/)
  .map((p) => p.trim())
  .filter(Boolean);
const GEMINI_MODEL = "gemini-2.5-flash";
const MAX_BULLETS = 4;
const MAX_WORDS_PER_BULLET = 25;
const API_RETRY_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = 1500;
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const FORCE_RUN = /^(1|true|yes)$/i.test(process.env.WEEKLY_STANDUP_FORCE || "");

const VERSION_BUMP_PATTERN =
  /^(chore(\([^)]+\))?:\s*)?(update|bump)\s+(the\s+)?version|^(chore|release)(\([^)]+\))?:.*\bversion\b/i;
const FEAT_COMMIT_PATTERN = /^feat(\([^)]+\))?:/i;

const runErrorLog = createRunErrorLogger(ERROR_LOG_FILE);

const SYSTEM_PROMPT = `You are a helpful assistant that turns git commits into a short weekly engineering update.

INPUT:
- Commit lines like [repo-name] commit message
- Optional "Web deployments" list: repos that had a merge to master this week (each merge = web deployment for that repo)

YOUR TASK:
- Produce AT MOST ${MAX_BULLETS} bullet points total across all repos
- Merge related commits into one point per theme or repo
- First person ("I"), very short, outcome-focused
- No commit hashes, file paths, or jargon
- Each bullet must be ${MAX_WORDS_PER_BULLET} words or fewer (count only the text after the bullet marker)

CLASSIFICATION — pick the right verb (do not default everything to "worked on"):
- FEATURE vs REFACTOR (primary rule — use the commit prefix):
  - Commit starts with "feat" or "feat(scope):" (conventional commits) → new feature → "I implemented..." / "I added..."
  - Any other code change (not feat, not fix) → "I refactored..."
- "I fixed..." — commits starting with fix/fix(scope): or clear bug fixes
- "I deployed..." — when deployment signals apply (see below); can combine with another verb, e.g. "I implemented X and deployed to web"

DEPLOYMENT SIGNALS — mention deployment in the bullet when any apply for that repo:
- Version-bump / release chore commits mean a release was cut — note that a deployment or release was made
- A repo appears in the "Web deployments" list — a merge to master happened; note that the repo was deployed to web/production

OUTPUT FORMAT (plain text only):
📅 Weekly Update (Tuesday)
Week: [previous Tuesday] – [report Tuesday]

Use exactly • for bullets. No more than ${MAX_BULLETS} bullets.
Output ONLY the formatted update — no preamble, explanation, or markdown.`;

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

function loadRepoPaths() {
  const filePath = resolveEnvPath(process.env.REPO_PATHS_FILE, "repos.txt");
  if (existsSync(filePath)) {
    const fromFile = [
      ...new Set(
        readFileSync(filePath, "utf-8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("#")),
      ),
    ];
    if (fromFile.length > 0) {
      return fromFile;
    }
  }

  const fromEnv = (process.env.REPO_PATHS || "")
    .split(/[:;\r\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (fromEnv.length > 0) {
    console.warn("⚠️  Using REPO_PATHS from .env — prefer repos.txt.");
    return [...new Set(fromEnv)];
  }

  return [];
}

const REPO_PATHS = loadRepoPaths();

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

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

function runGitLog(repoPath, sinceStr, untilStr, { mergesOnly = false } = {}) {
  const mergeFlag = mergesOnly ? "--merges" : "--no-merges";
  let command = `git -C "${repoPath}" log --branches ${mergeFlag} --since="${sinceStr}" --until="${untilStr}" --pretty=format:"%s"`;
  for (const pattern of GIT_AUTHOR_PATTERNS) {
    command += ` --author=${JSON.stringify(pattern)}`;
  }
  return execSync(command, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  }).trim();
}

function isVersionBumpCommit(message) {
  return VERSION_BUMP_PATTERN.test(message.trim());
}

function isFeatCommit(message) {
  return FEAT_COMMIT_PATTERN.test(message.trim());
}

function extractCommits(repoPath, since, until) {
  const repoName = basename(repoPath);
  try {
    const output = runGitLog(
      repoPath,
      formatLocalGitTimestamp(since),
      formatLocalGitTimestamp(until),
    );
    if (!output) {
      return [];
    }
    return output.split("\n").filter(Boolean).map((message) => {
      const trimmed = message.trim();
      return {
        repo: repoName,
        message: trimmed,
        versionBump: isVersionBumpCommit(trimmed),
        isFeat: isFeatCommit(trimmed),
      };
    });
  } catch (error) {
    if (error.status === 128 || error.message.includes("not a git repository")) {
      console.warn(`⚠️  ${repoName}: Not a valid git repository`);
    } else {
      console.warn(`⚠️  ${repoName}: ${error.message}`);
    }
    return [];
  }
}

function extractMasterMerges(repoPath, since, until) {
  const repoName = basename(repoPath);
  try {
    execSync(`git -C "${repoPath}" rev-parse --verify master`, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
  } catch {
    return [];
  }

  try {
    const command = `git -C "${repoPath}" log master --since="${formatLocalGitTimestamp(since)}" --until="${formatLocalGitTimestamp(until)}" --merges --pretty=format:"%s"`;
    const output = execSync(command, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
    }).trim();
    if (!output) {
      return [];
    }
    return output.split("\n").filter(Boolean).map((message) => ({
      repo: repoName,
      message: message.trim(),
    }));
  } catch (error) {
    console.warn(`⚠️  ${repoName}: could not read master merges (${error.message})`);
    return [];
  }
}

function aggregateCommits(since, until) {
  const commits = [];
  const masterDeploys = [];

  for (const repoPath of REPO_PATHS) {
    const repoCommits = extractCommits(repoPath, since, until);
    commits.push(...repoCommits);
    if (repoCommits.length > 0) {
      console.log(`✅ ${basename(repoPath)}: ${repoCommits.length} commit(s)`);
    }

    const merges = extractMasterMerges(repoPath, since, until);
    if (merges.length > 0) {
      masterDeploys.push({ repo: basename(repoPath), merges });
      console.log(`🚀 ${basename(repoPath)}: ${merges.length} merge(s) to master`);
    }
  }

  return { commits, masterDeploys };
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

function buildSummarizePrompt(commits, masterDeploys, weekLabel) {
  const commitLines = commits.map((c) => {
    const tags = [];
    if (c.isFeat) {
      tags.push("feat/new-feature");
    } else if (!c.versionBump && !/^(fix|hotfix|bugfix)(\(|:)/i.test(c.message)) {
      tags.push("refactor");
    }
    if (c.versionBump) {
      tags.push("version-bump/deploy");
    }
    const suffix = tags.length > 0 ? ` {${tags.join(", ")}}` : "";
    return `[${c.repo}] ${c.message}${suffix}`;
  });

  const sections = [`Weekly window: ${weekLabel}`, "", "Commits:", commitLines.join("\n")];

  if (masterDeploys.length > 0) {
    sections.push(
      "",
      "Web deployments (merge to master this week):",
      masterDeploys
        .map(({ repo, merges }) => `- ${repo} (${merges.length} merge${merges.length === 1 ? "" : "s"})`)
        .join("\n"),
    );
  }

  sections.push("", `Write at most ${MAX_BULLETS} bullets. Week line in header must use: ${weekLabel}`);
  return sections.join("\n");
}

function truncateWords(text, maxWords = MAX_WORDS_PER_BULLET) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return words.join(" ");
  }
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function normalizeBulletLines(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)[*\-]\s+/, "$1• "))
    .join("\n");
}

function countBullets(text) {
  return text.split("\n").filter((line) => /^\s*•\s+/.test(line)).length;
}

function enforceMaxBulletsAndWords(text) {
  const lines = normalizeBulletLines(text).split("\n");
  let bulletCount = 0;
  return lines
    .map((line) => {
      const m = line.match(/^(\s*•\s+)(.*)$/);
      if (!m) {
        return line;
      }
      bulletCount++;
      if (bulletCount > MAX_BULLETS) {
        return null;
      }
      return `${m[1]}${truncateWords(m[2])}`;
    })
    .filter((line) => line !== null)
    .join("\n");
}

function classifyCommitVerb(message) {
  if (/^(fix|hotfix|bugfix)(\(|:)/i.test(message)) {
    return "fixed";
  }
  if (isFeatCommit(message)) {
    return "implemented";
  }
  return "refactored";
}

function formatCommitsManually(commits, masterDeploys, weekLabel) {
  const deployedRepos = new Set(masterDeploys.map((d) => d.repo));
  const header = `📅 Weekly Update (Tuesday)\nWeek: ${weekLabel}\n`;
  const bullets = commits.slice(0, MAX_BULLETS).map((c) => {
    const msg = truncateWords(c.message);
    let verb = c.versionBump ? "deployed" : classifyCommitVerb(c.message);
    let line = `• I ${verb} ${msg}`;
    if (deployedRepos.has(c.repo) && verb !== "deployed") {
      line += " and deployed to web";
    }
    return `${line} (${c.repo}).`;
  });
  return `${header}\n${bullets.join("\n")}`.trim();
}

async function summarizeWeekly(commits, masterDeploys, weekLabel) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await withRetries(
    () =>
      genAI.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: buildSummarizePrompt(commits, masterDeploys, weekLabel) }] }],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0.3,
          maxOutputTokens: 1024,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    "Gemini API",
  );

  if (response.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("AI response truncated (MAX_TOKENS)");
  }

  const summary = response.text?.trim();
  if (!summary) {
    throw new Error("AI returned empty response");
  }

  const normalized = enforceMaxBulletsAndWords(summary);
  if (countBullets(normalized) === 0) {
    throw new Error("AI returned no bullet points");
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  runErrorLog.init();

  console.log("=".repeat(60));
  console.log("📊 Weekly Standup (Tuesday)");
  console.log("=".repeat(60));
  console.log(`🕐 Running at: ${new Date().toLocaleString()}\n`);

  const now = new Date();
  if (!FORCE_RUN && now.getDay() !== 2) {
    console.log("📅 Scheduled for Tuesdays. Exiting (Shortcuts sets WEEKLY_STANDUP_FORCE=1).");
    process.exit(0);
  }

  if (REPO_PATHS.length === 0) {
    const message = "No repositories configured. Copy config/examples/repos.example.txt to repos.txt.";
    runErrorLog.record(message);
    console.error(`❌ ${message}`);
    process.exit(1);
  }

  if (!ZOHO_WEBHOOK_URL) {
    const message = "ZOHO_WEEKLY_WEBHOOK_URL is not configured in .env";
    runErrorLog.record(message);
    console.error(`❌ ${message}`);
    process.exit(1);
  }

  const window = getWeeklyWindow(now);
  const weekLabel = formatWeekRange(window);

  console.log(`📆 Report Tuesday: ${formatDateDisplay(window.reportTuesday)}`);
  console.log(`📆 Commit window:  ${weekLabel}`);
  console.log(`   (since ${formatLocalGitTimestamp(window.since)} → until ${formatLocalGitTimestamp(window.until)})\n`);
  console.log("🔍 Scanning repositories…\n");

  const { commits, masterDeploys } = aggregateCommits(window.since, window.until);

  if (commits.length === 0) {
    console.log("\n📝 No commits in this Tuesday-to-Tuesday window. Nothing posted.");
    process.exit(0);
  }

  console.log(`\n📊 Total commits: ${commits.length}`);
  if (masterDeploys.length > 0) {
    console.log(`🚀 Web deployments: ${masterDeploys.map((d) => d.repo).join(", ")}`);
  }

  let summary;
  try {
    summary = await summarizeWeekly(commits, masterDeploys, weekLabel);
  } catch (error) {
    console.log(`\n⚠️  AI failed (${error.message}); using fallback formatting.`);
    summary = enforceMaxBulletsAndWords(formatCommitsManually(commits, masterDeploys, weekLabel));
  }

  console.log("\n" + "=".repeat(60));
  console.log("📋 WEEKLY UPDATE:");
  console.log("=".repeat(60));
  console.log(summary);
  console.log("=".repeat(60));

  if (DRY_RUN) {
    console.log("\n🧪 DRY_RUN: Skipping Cliq post.");
    process.exit(0);
  }

  try {
    console.log("\n📤 Posting to Zoho Cliq…");
    await postToZohoCliq({
      webhookUrl: ZOHO_WEBHOOK_URL,
      channelName: ZOHO_CHANNEL,
      text: summary,
      retryAttempts: API_RETRY_ATTEMPTS,
      retryDelayMs: API_RETRY_DELAY_MS,
    });
    console.log("\n✅ Posted to Zoho Cliq.");
  } catch (error) {
    runErrorLog.record("Failed to post weekly standup to Zoho Cliq", error);
    console.error("\n❌ Failed to post to Zoho Cliq.");
    console.error("   See weekly-standup-errors.txt for details.");
    process.exit(1);
  }
}

main().catch((error) => {
  if (!runErrorLog.initialized) {
    runErrorLog.init();
  }
  runErrorLog.record("Fatal error", error);
  console.error("\n💥 Fatal error:", error.message);
  process.exit(1);
});
