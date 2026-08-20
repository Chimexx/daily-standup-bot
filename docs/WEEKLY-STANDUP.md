# Weekly Standup (Tuesdays)

Summarizes git commits from **the previous Tuesday** through **the report Tuesday** and posts to Zoho Cliq (Amadioha bot).

## Commit window

Each report covers exactly one week, aligned to Tuesdays:

| Boundary | Meaning |
|----------|---------|
| **Since** | Previous Tuesday, 00:00 (local) |
| **Until** | Report Tuesday — current time if you run that day; end of day if you run later |

**Example:** shortcut runs **Tuesday, Aug 20 at 11:45 AM**

- Includes commits from **Tue Aug 13 00:00** through **Tue Aug 20 11:45**
- Header shows: `Week: Tue, Aug 13, 2026 – Tue, Aug 20, 2026`

Date logic lives in `lib/weekly-window.js`.

## Setup

Uses the same **`.env`** and **`repos.txt`** as the daily standup.

| Variable | Required? | Notes |
|----------|-----------|-------|
| `GEMINI_API_KEY` | Yes | Same as daily standup |
| `ZOHO_WEEKLY_WEBHOOK_URL` | Yes | Amadioha bot webhook (`/bots/amadioha/...`) |
| `GIT_AUTHOR` | No | Comma-separated emails (same as daily) |

## macOS Shortcuts (recommended)

1. **Automation** → **Time of Day** → **Tuesday**, **11:45 AM**, **Run Immediately**
2. **Run Shell Script** (`/bin/zsh`):

```bash
/Users/macbook/daily-standup-bot/run-weekly-standup.sh
```

3. Check log: `tail -40 /tmp/weekly-standup-bot-shortcut.log`

## Run manually

```bash
npm run weekly-standup
DRY_RUN=1 WEEKLY_STANDUP_FORCE=1 npm run weekly-standup   # preview any day
```
