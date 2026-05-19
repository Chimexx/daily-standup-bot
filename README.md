# Daily Standup Bot

Local Node.js automation that collects **new git commits** across several repositories, summarizes them with **Google Gemini**, and posts a standup-style update to **Zoho Cliq** via incoming webhook.

## What it does

1. **Runs only Monday–Friday** (weekends exit immediately; nothing is posted).
2. **Collects commits after your last successful Cliq post** using `git log --since … --until now` (commit timestamps). On the **first run ever**, it uses **local midnight today** as the lower bound.
3. Writes **`.last-run`** with an ISO timestamp **only after Zoho accepts the webhook**, so failed runs retry the same window.
4. If there are **no commits and no manual notes**, it **does not post** and **does not** update `.last-run`.
5. **Manual notes** in `standup-notes.txt` (lines starting with `-`) are included in the Cliq message and **cleared only after a successful post**—so items added after 5:30 PM or on a missed run day roll into the next successful run.
6. **Summarizes** with Gemini (`gemini-2.5-flash`), with **retries** on Gemini and Zoho. If Gemini fails, it falls back to a simple manual formatter.
7. **Post-processing**: caps each bullet line to **30 words** max; the prompt asks for grouped themes (bug fixes, UI/UX, etc.) and treats **package.json version bumps** as **deployments**.

See `index.js` for constants such as `MAX_STANDUP_BULLET_WORDS`, `MAX_CATCHUP_CALENDAR_DAYS`, and retry settings.

## Prerequisites

- **Node.js 18+** (20 LTS is fine)
- **Git**
- **Gemini API key** ([Google AI Studio](https://aistudio.google.com/app/apikey))
- **Zoho Cliq incoming webhook URL**
- Local clones of every repo listed in **`REPO_PATHS`** (`.env`)

## Quick start

```bash
cd /path/to/daily-standup-bot
npm install
cp .env.example .env
```

Edit **`.env`**:

- **`GEMINI_API_KEY`**, **`ZOHO_WEBHOOK_URL`** (required)
- **`REPO_PATHS`** (required) — see below
- **`GIT_AUTHOR`** (optional; omit to include all authors in the commit window)

Run manually:

```bash
npm start
# or
node index.js
```

The script loads **`.env`** from the **same directory as `index.js`** (it does not overwrite variables already set in the shell).

## Configuration (`.env`)

| Variable | Required | Notes |
|----------|----------|--------|
| `GEMINI_API_KEY` | Yes | Unless already exported in the environment |
| `ZOHO_WEBHOOK_URL` | Yes | Incoming webhook URL |
| `REPO_PATHS` | Yes | Absolute paths to git repos, separated by **`:`** (you may also use **`;`** or **newlines**). Duplicates are ignored. Example: `/Users/me/a:/Users/me/b` |
| `GIT_AUTHOR` | No | Passed through as git `--author` filter; omit for all authors |

Copy from `.env.example` and fill in real values. **Do not commit `.env`.**

Paths must exist on the machine where the script runs (`launchd`, cron, Shortcuts, etc.).

## Manual notes (non-git work)

Create **`standup-notes.txt`** next to `index.js` (see **`standup-notes.example.txt`**):

```text
- Had a planning meeting with product
- Reviewed PRs for the team
```

- One **`-` line** = one item (lines starting with `#` are ignored).
- The file is **not** cleared on failed posts or weekends—only after **Zoho accepts** the webhook.
- With **commits + notes**: Gemini summarizes commits; notes are appended under **Other (not from git)** so nothing is dropped.
- With **notes only** (no new commits): still posts if the file has items.
- Override path: **`MANUAL_NOTES_FILE`** in `.env` (absolute or relative to the project folder).

## Scheduling (pick one)

Running twice successfully on the same day with **new commits after the first post** can produce **two Cliq messages**; that is expected with the current `.last-run` design.

### macOS — LaunchAgent (recommended): `launchd-setup.sh`

Uses **`launchd`** with **no secrets in the plist**; credentials come from **`.env`** next to `index.js`.

```bash
cd /path/to/daily-standup-bot
chmod +x launchd-setup.sh
./launchd-setup.sh
```

Default schedule: **every day at 17:30** (5:30 PM) local time. Logs:

- stdout: `/tmp/daily-standup-bot.out`
- stderr: `/tmp/daily-standup-bot.err`

Useful commands:

```bash
launchctl list | grep daily-standup-bot
launchctl start com.user.daily-standup-bot    # run once now
launchctl unload ~/Library/LaunchAgents/com.user.daily-standup-bot.plist
```

**Sleep:** If the Mac is asleep at the scheduled time, that run may be skipped. The next successful run still collects commits **after the last successful post**, so work is not lost—as long as the job runs again while awake.

If you change install location, re-run `./launchd-setup.sh` (unload the old plist first if needed).

### macOS — Shortcuts

Shortcuts often runs with a **minimal PATH** and shows **no terminal output**, so failures look like “nothing happened.” Use the project wrapper (recommended):

**Run Shell Script** — Shell: **`/bin/zsh`**, script:

```bash
/Users/macbook/daily-standup-bot/run-standup.sh
```

Then check the log after a run:

```bash
tail -50 /tmp/daily-standup-bot-shortcut.log
```

Or run Node directly (must use **full paths**):

```bash
cd "/Users/macbook/daily-standup-bot" && /opt/homebrew/opt/node@20/bin/node index.js
```

**Common reasons nothing posts:**

| Cause | What you’ll see in the log |
|--------|----------------------------|
| Wrong file / path | `node not found` or `Cannot find module` |
| No `.env` or empty `REPO_PATHS` | `No repositories configured` |
| No new commits **and** empty `standup-notes.txt` | `No standup update will be posted` (exit 0 — shortcut “succeeds” but Cliq is silent) |
| Weekend | `It's the weekend!` |
| Zoho/Gemini error | `Failed to post` / `AI summarization failed` |

Edit **`standup-notes.txt`** (not `standup-notes.example.txt`). Add **Show Notification** after the shell step if you want a visible “finished” signal in Shortcuts.

#### How to verify Shortcuts actually ran the script

1. **Use the wrapper in Shortcuts** (not bare `node index.js`):

   ```bash
   /Users/macbook/daily-standup-bot/run-standup.sh
   ```

2. **Right after triggering the shortcut**, open Terminal and run:

   ```bash
   tail -40 /tmp/daily-standup-bot-shortcut.log
   ```

   You should see a new block like:

   ```text
   ========== RUN START Mon May 19 ... ==========
   ...
   ========== RUN END exit=0 Mon May 19 ... ==========
   ```

   - **No new block** → Shortcuts did not run the script (wrong shortcut, automation disabled, or Mac asleep).
   - **`RUN END exit=0`** and log shows **“Successfully posted to Zoho Cliq”** → script ran and posted.
   - **`RUN END exit=0`** and **“No standup update will be posted”** → script ran but chose not to post (no commits + no notes).
   - **`exit=1` or `127`** → error; read the lines above `RUN END`.

3. **Other signals**
   - **`.last-run`** file timestamp updates only after a **successful** Cliq post.
   - **`standup-notes.txt`** is **cleared** only after a successful post (if it had `-` lines).

4. **Optional in Shortcuts:** add **Show Notification** after the shell action: “Standup script finished — check log” (the shell step itself does not show output in the notification unless you wire it up).

### Linux — Cron

**Preferred:** `cd` into the project so `.env` is loaded automatically:

```cron
30 17 * * * cd /path/to/daily-standup-bot && /usr/bin/node index.js >> /tmp/daily-standup-bot.log 2>&1
```

Adjust the Node binary path (`which node`) and time as needed.

Optional helper **`cron-setup.sh`** exists but **embeds API keys in your crontab**; prefer `.env` + the line above unless you know why you need the script.

### VS Code task

See **`vscode-global-task.json`**. Copy the tasks into your user `tasks.json` and:

- Replace **`${userHome}/personal-automation/daily-standup-bot`** with your real project path (or use a variable you prefer).
- Prefer relying on **`.env`** in that folder instead of storing secrets in task JSON.

## Troubleshooting

### Reset the commit window

Deleting **`.last-run`** in the project folder resets bookkeeping; the next weekday run treats the lower bound like a **first run** (commits since **local midnight today**). A new **`.last-run`** is written after the next **successful** Cliq post.

### No commits / no post

- Confirm **`REPO_PATHS`** in `.env` is set and each path exists and is a git repo.
- Remember the window is **since last successful Zoho post**, not “calendar today only.”
- If **`GIT_AUTHOR`** is set, it must match `git log` author filtering (`git config user.email`).
- Add items to **`standup-notes.txt`** (lines starting with `-`) to post when there are no new commits.

### Weekend

If you run on Saturday/Sunday, the script exits with a short message and posts nothing.

### AI or webhook errors

- Check Gemini quota and API key.
- Confirm webhook URL and channel permissions.
- Inspect **`/tmp/daily-standup-bot.err`** (launchd) or your cron log.

### Node / modules

```bash
npm install
```

If `Cannot find package '@google/genai'`, dependencies are missing.

## Security

- Keep **`.env`** local and **gitignored**.
- **launchd plist** from `launchd-setup.sh` only sets **`PATH`**; secrets stay in **`.env`**.
- Avoid committing webhook URLs or API keys into **tasks**, **shell history**, or **crontab** when `.env` is enough.

## License

MIT (see `package.json`). Treat credentials as confidential.
