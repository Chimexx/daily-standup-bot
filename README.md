# Daily Standup Bot

A completely free, local automation script that generates daily standup updates from your git commits and posts them to Zoho Cliq.

## Overview

This Node.js script runs entirely on your local machine and:
1. Scans multiple git repositories for commits you authored today
2. Uses Google's Gemini AI (free tier) to summarize commits into a professional standup update
3. Posts the summary directly to a Zoho Cliq channel via webhook

## Prerequisites

- Node.js 18+ (LTS recommended)
- Git installed and configured
- A Google AI Studio API key (free)
- A Zoho Cliq incoming webhook URL

## 1. Project Setup

### Step 1: Move to a Private Location

Move this entire folder OUTSIDE your workspace repositories to a personal location:

```bash
# On macOS/Linux
mv /Users/macbook/Repos/Timart/auto-daily-report ~/personal-automation/daily-standup-bot

# Navigate to the new location
cd ~/personal-automation/daily-standup-bot
```

### Step 2: Install Dependencies

```bash
npm install
```

This installs the `@google/genai` SDK and other dependencies.

## 2. Configuration

### Get Your Credentials

1. **Google Gemini API Key** (Free):
   - Visit [Google AI Studio](https://aistudio.google.com/app/apikey)
   - Create a new API key
   - Copy the key for the next step

2. **Zoho Cliq Webhook URL**:
   - Open Zoho Cliq
   - Go to the channel where you want to post updates
   - Click the channel name → Settings → Integrations → Incoming Webhooks
   - Add a new webhook and copy the URL

### Configure the Script

Open `index.js` and edit the **CONFIGURATION** section at the top:

```javascript
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY_HERE";
const ZOHO_WEBHOOK_URL = "YOUR_ZOHO_WEBHOOK_URL_HERE";

const REPO_PATHS = [
  "/Users/macbook/Projects/company-frontend",
  "/Users/macbook/Projects/company-backend",
  "/Users/macbook/Projects/company-api",
];

const GIT_AUTHOR_PATTERN = "your.email@company.com"; // Optional: filter by your git email
```

## 3. Manual Testing

Run the script manually to test everything works:

```bash
npm start
# or
node index.js
```

You should see:
1. Repository scanning progress
2. Commit count per repository
3. AI-generated summary
4. Success confirmation from Zoho Cliq

## 4. Automation Setup

Choose ONE of these automation methods:

### Option A: macOS Scheduler (launchd) - Recommended for Mac

1. Create a plist file:

```bash
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.user.daily-standup-bot.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.daily-standup-bot</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>REPLACE_WITH_FULL_PATH_TO_INDEX_JS</string>
    </array>
    
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>17</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    
    <key>StandardOutPath</key>
    <string>/tmp/daily-standup-bot.out</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/daily-standup-bot.err</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>GEMINI_API_KEY</key>
        <string>YOUR_GEMINI_API_KEY_HERE</string>
        <key>ZOHO_WEBHOOK_URL</key>
        <string>YOUR_ZOHO_WEBHOOK_URL_HERE</string>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
```

2. Edit the plist file to add your paths and credentials:
   - Replace `REPLACE_WITH_FULL_PATH_TO_INDEX_JS` with the full path to your `index.js`
   - Add your actual API key and webhook URL in the EnvironmentVariables section

3. Load and start the scheduler:

```bash
launchctl load ~/Library/LaunchAgents/com.user.daily-standup-bot.plist
launchctl start com.user.daily-standup-bot
```

4. Verify it's loaded:

```bash
launchctl list | grep daily-standup-bot
```

5. To unload (if needed):

```bash
launchctl unload ~/Library/LaunchAgents/com.user.daily-standup-bot.plist
```

### Option B: Linux Cron Job

1. Open your crontab:

```bash
crontab -e
```

2. Add this line (runs daily at 5:00 PM):

```bash
# Daily Standup Bot - runs at 5:00 PM every day
0 17 * * * cd /path/to/daily-standup-bot && /usr/bin/node index.js >> /tmp/daily-standup-bot.log 2>&1
```

3. If you prefer environment variables in cron:

```bash
0 17 * * * export GEMINI_API_KEY="your-key"; export ZOHO_WEBHOOK_URL="your-webhook"; cd /path/to/daily-standup-bot && /usr/bin/node index.js >> /tmp/daily-standup-bot.log 2>&1
```

4. View logs:

```bash
tail -f /tmp/daily-standup-bot.log
```

### Option C: VS Code Global Task (Manual Trigger)

See `vscode-global-task.json` for the configuration to add to your VS Code global tasks.

This allows you to run the script via keyboard shortcut from any VS Code window.

## 5. Environment Variables (Alternative to Hardcoding)

Instead of editing the script, you can use environment variables:

```bash
export GEMINI_API_KEY="your-api-key"
export ZOHO_WEBHOOK_URL="your-webhook-url"
export GIT_AUTHOR="your.email@company.com"
node index.js
```

## Troubleshooting

### No commits found
- Verify your `REPO_PATHS` are correct absolute paths
- Check that `GIT_AUTHOR_PATTERN` matches your git config: `git config user.email`

### AI summarization fails
- Verify your Gemini API key is valid and has quota remaining
- Check that you're using a supported model (gemini-2.5-flash)

### Zoho Cliq posting fails
- Verify the webhook URL is correct and the webhook is active
- Check Zoho Cliq channel permissions

### Script doesn't run on schedule
- For macOS: Check `/tmp/daily-standup-bot.err` for errors
- For Linux: Check the cron log file
- Ensure Node.js path is correct in the scheduler config

## Security Notes

- This script stores credentials locally only
- Never commit this folder to any git repository
- The `launchd` plist stores credentials in the system keychain area
- Consider using environment variables instead of hardcoding credentials

## License

Private use only. Do not distribute credentials.
