# Weekly Standup (Tuesdays)

Summarizes your git commits from the **past 7 days** into up to **4 short bullets** and posts to Zoho Cliq.

## What it does

1. Collects commits from **last Tuesday 00:00** through **now** across repos in `repos.txt` (all local branches).
2. Summarizes with Gemini (`gemini-2.5-flash`), with manual fallback if AI fails.
3. Posts to Zoho Cliq via bot `/message` or a named channel.

The shell wrapper (`run-weekly-standup.sh`) always runs when Shortcuts triggers it — scheduling is handled by your Shortcut, not by a day-of-week check inside the script.

## Setup

Uses the same **`.env`** and **`repos.txt`** as the daily standup.

```bash
npm install
cp .env.example .env          # if needed
cp config/examples/repos.example.txt repos.txt
```

| Variable | Required? | Notes |
|----------|-----------|-------|
| `GEMINI_API_KEY` | Yes | Same as daily standup |
| `ZOHO_WEEKLY_WEBHOOK_URL` | Yes* | **Use the Amadioha bot webhook** (`/bots/amadioha/...`) — do not reuse the daily `#devteam` channel URL |
| `ZOHO_WEBHOOK_URL` | Fallback | Daily standup channel URL; only used for weekly if `ZOHO_WEEKLY_WEBHOOK_URL` is unset |
| `ZOHO_WEEKLY_CHANNEL` | No | Channel unique name — posts to channel instead of bot DM |
| `GIT_AUTHOR` | No | Git `--author` filter |

## macOS Shortcuts (recommended)

Create a **Personal Automation** that runs **every Tuesday at 11:45 AM** (or whatever time you prefer).

1. Open **Shortcuts** → **Automation** → **+** → **Time of Day**
2. Set **Tuesday**, **11:45 AM**, **Run Immediately**
3. Add action **Run Shell Script**
   - Shell: **`/bin/zsh`**
   - Script:

```bash
/Users/macbook/daily-standup-bot/run-weekly-standup.sh
```

4. Optional: add **Show Notification** after the shell step (“Weekly standup finished”)

After a run, check the log:

```bash
tail -40 /tmp/weekly-standup-bot-shortcut.log
```

You should see `RUN END exit=0` and either “Posted to Zoho Cliq” or “No commits in the past week”.

## Run manually

```bash
npm run weekly-standup
# or
/Users/macbook/daily-standup-bot/run-weekly-standup.sh
```

Preview without posting (any day):

```bash
DRY_RUN=1 WEEKLY_STANDUP_FORCE=1 npm run weekly-standup
```

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Shortcut does nothing | Check `/tmp/weekly-standup-bot-shortcut.log` — no new `RUN START` block means Shortcuts didn’t fire |
| `node not found` in log | Re-run the shortcut; wrapper checks common Node paths |
| Exits immediately, no post | Old builds skipped non-Tuesday runs — re-run with the current `run-weekly-standup.sh` |
| No post, exit 0, “No commits” | Usually `GIT_AUTHOR` mismatch or commits on another branch — script now scans all branches and supports comma-separated authors |
| Zoho HTTP error | Check webhook URL; see `weekly-standup-errors.txt` |
