#!/bin/bash
# Daily Standup Bot - macOS LaunchAgent Setup Script
# This script helps you configure the launchd scheduler

echo "=========================================="
echo "Daily Standup Bot - macOS Scheduler Setup"
echo "=========================================="
echo ""

# Get the actual path to this script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INDEX_JS_PATH="${SCRIPT_DIR}/index.js"

echo "Detected script location: ${INDEX_JS_PATH}"
echo ""

ENV_FILE="${SCRIPT_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
    echo "⚠️  No .env file found at: ${ENV_FILE}"
    echo "   Create it with GEMINI_API_KEY and ZOHO_WEBHOOK_URL (see comments at the top of index.js)."
    echo ""
fi

# Find node path
NODE_PATH=$(which node)
echo "Detected Node.js path: ${NODE_PATH}"

# Create LaunchAgents directory if it doesn't exist
mkdir -p ~/Library/LaunchAgents

# Create the plist file
PLIST_PATH="${HOME}/Library/LaunchAgents/com.user.daily-standup-bot.plist"

cat > "${PLIST_PATH}" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.daily-standup-bot</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${INDEX_JS_PATH}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${SCRIPT_DIR}</string>
    
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>17</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    
    <key>StandardOutPath</key>
    <string>/tmp/daily-standup-bot.out</string>
    
    <key>StandardErrorPath</key>
    <string>/tmp/daily-standup-bot.err</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

echo "✅ Created: ${PLIST_PATH}"
echo ""

# Load the plist
echo "Loading the scheduler..."
launchctl load "${PLIST_PATH}"

if [ $? -eq 0 ]; then
    echo "✅ Scheduler loaded successfully!"
    echo ""
    echo "The script will run automatically every day at 5:30 PM"
    echo "Credentials are read from: ${ENV_FILE}"
    echo ""
    echo "Useful commands:"
    echo "  - Check status: launchctl list | grep daily-standup-bot"
    echo "  - View logs: tail -f /tmp/daily-standup-bot.out"
    echo "  - View errors: tail -f /tmp/daily-standup-bot.err"
    echo "  - Run now: launchctl start com.user.daily-standup-bot"
    echo "  - Unload: launchctl unload ${PLIST_PATH}"
else
    echo "❌ Failed to load scheduler. Check if the plist file is valid."
    exit 1
fi
