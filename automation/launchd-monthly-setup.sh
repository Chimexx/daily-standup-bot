#!/bin/bash
# Monthly Cliq Worker — LaunchAgent (runs daily; worker sends only on configured day/time)

echo "=========================================="
echo "Monthly Cliq Worker — macOS Scheduler Setup"
echo "=========================================="
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKER_JS="${PROJECT_ROOT}/workers/monthly-cliq/index.js"
CONFIG_FILE="${PROJECT_ROOT}/monthly-cliq.config.json"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "⚠️  No config at ${CONFIG_FILE}"
  echo "   cp config/examples/monthly-cliq.config.example.json monthly-cliq.config.json"
  echo ""
fi

NODE_PATH=$(which node)
echo "Node: ${NODE_PATH}"
echo "Worker: ${WORKER_JS}"
echo ""

# Default run time — worker also checks dayOfMonth from config
HOUR=9
MINUTE=0
if [[ -f "${CONFIG_FILE}" ]]; then
  PARSED=$(node -e "
    const fs = require('fs');
    try {
      const c = JSON.parse(fs.readFileSync('${CONFIG_FILE}', 'utf8'));
      const s = c.schedule || {};
      process.stdout.write(String(s.hour ?? 9) + ' ' + String(s.minute ?? 0));
    } catch { process.stdout.write('9 0'); }
  " 2>/dev/null || echo "9 0")
  HOUR=$(echo "$PARSED" | awk '{print $1}')
  MINUTE=$(echo "$PARSED" | awk '{print $2}')
fi

echo "LaunchAgent will run daily at ${HOUR}:$(printf '%02d' "${MINUTE}") (worker only sends on configured dayOfMonth)."
echo ""

mkdir -p ~/Library/LaunchAgents
PLIST_PATH="${HOME}/Library/LaunchAgents/com.user.monthly-cliq-worker.plist"

cat > "${PLIST_PATH}" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.user.monthly-cliq-worker</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${WORKER_JS}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${HOUR}</integer>
        <key>Minute</key>
        <integer>${MINUTE}</integer>
    </dict>

    <key>StandardOutPath</key>
    <string>/tmp/monthly-cliq-worker.out</string>

    <key>StandardErrorPath</key>
    <string>/tmp/monthly-cliq-worker.err</string>

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
echo "Loading scheduler..."
launchctl load "${PLIST_PATH}" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "${PLIST_PATH}" 2>/dev/null || launchctl load "${PLIST_PATH}"

if [[ $? -eq 0 ]]; then
  echo "✅ Loaded"
  echo ""
  echo "  launchctl start com.user.monthly-cliq-worker"
  echo "  tail -f /tmp/monthly-cliq-worker.out"
  echo "  launchctl unload ${PLIST_PATH}"
else
  echo "❌ Failed to load plist."
  exit 1
fi
