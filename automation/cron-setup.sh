#!/bin/bash
# Daily Standup Bot - Linux Cron Setup Script
# This script helps you configure the cron scheduler

echo "=========================================="
echo "Daily Standup Bot - Linux Cron Setup"
echo "=========================================="
echo ""

# Get the actual path to this script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INDEX_JS_PATH="${PROJECT_ROOT}/workers/daily-standup/index.js"

echo "Detected script location: ${INDEX_JS_PATH}"
echo ""

# Prompt for credentials
echo "Enter your Google Gemini API Key (get from https://aistudio.google.com/app/apikey):"
read -s GEMINI_KEY
echo ""

echo "Enter your Zoho Cliq Webhook URL:"
read ZOHO_WEBHOOK
echo ""

# Find node path
NODE_PATH=$(which node)
echo "Detected Node.js path: ${NODE_PATH}"
echo ""

# Create the cron job entry
CRON_JOB="0 17 * * * export GEMINI_API_KEY='${GEMINI_KEY}'; export ZOHO_WEBHOOK_URL='${ZOHO_WEBHOOK}'; cd ${PROJECT_ROOT} && ${NODE_PATH} workers/daily-standup/index.js >> /tmp/daily-standup-bot.log 2>&1"

echo "Generated cron job:"
echo "${CRON_JOB}"
echo ""

# Ask for confirmation
echo "This will add the above cron job to your crontab."
echo "Do you want to proceed? (y/n)"
read CONFIRM

if [[ $CONFIRM != "y" && $CONFIRM != "Y" ]]; then
    echo "Setup cancelled."
    exit 0
fi

# Get existing crontab and append new job
EXISTING_CRONTAB=$(crontab -l 2>/dev/null || echo "")
NEW_CRONTAB="${EXISTING_CRONTAB}

# Daily Standup Bot - runs at 5:00 PM every day
${CRON_JOB}"

# Install new crontab
echo "${NEW_CRONTAB}" | crontab -

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Cron job installed successfully!"
    echo ""
    echo "The script will run automatically every day at 5:00 PM"
    echo ""
    echo "Useful commands:"
    echo "  - View crontab: crontab -l"
    echo "  - View logs: tail -f /tmp/daily-standup-bot.log"
    echo "  - Edit crontab: crontab -e"
    echo "  - Remove all cron jobs: crontab -r"
else
    echo ""
    echo "❌ Failed to install cron job. Please check your permissions."
    exit 1
fi
