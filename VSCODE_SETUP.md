# VS Code Global Task Setup

This guide explains how to configure a **Global VS Code Task** that lets you run the Daily Standup Bot from any VS Code window using a keyboard shortcut.

## Why Global Tasks?

Unlike workspace tasks (`.vscode/tasks.json` inside a project), **User Tasks** are stored in VS Code's global configuration and are available from ANY workspace. This means:
- No files created in your work repositories
- No risk of accidentally committing automation files
- Works from any VS Code window

## Setup Instructions

### Step 1: Open Global tasks.json

1. Open VS Code Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Linux)
2. Type: `Tasks: Open User Tasks`
3. Select `Others` (Example running an arbitrary external command)

### Step 2: Copy the Configuration

Copy the content from `vscode-global-task.json` in this folder and paste it into your global `tasks.json` file.

### Step 3: Update the Path

Edit the path in the configuration to point to where you moved this script:

```json
"args": [
    "${userHome}/personal-automation/daily-standup-bot/index.js"
]
```

### Step 4: Add a Keyboard Shortcut (Optional)

To run the standup bot with a keyboard shortcut:

1. Open VS Code Command Palette
2. Type: `Preferences: Open Keyboard Shortcuts (JSON)`
3. Add this to your `keybindings.json`:

```json
[
    {
        "key": "cmd+shift+s",
        "command": "workbench.action.tasks.runTask",
        "args": "Generate Daily Standup",
        "when": "editorTextFocus"
    }
]
```

> Replace `cmd+shift+s` with your preferred shortcut. On Linux, use `ctrl+shift+s`.

## Usage

### Method 1: Command Palette
1. Open Command Palette (`Cmd+Shift+P`)
2. Type: `Tasks: Run Task`
3. Select: `Generate Daily Standup`

### Method 2: Keyboard Shortcut
If you configured a shortcut, simply press it to run the standup bot.

### Method 3: Terminal
Open any terminal and run:

```bash
~/personal-automation/daily-standup-bot/launchd-setup.sh
# Or directly:
node ~/personal-automation/daily-standup-bot/index.js
```

## Full Example Global tasks.json

Here's a complete example of what your global `tasks.json` should look like:

```json
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Generate Daily Standup",
            "type": "shell",
            "command": "node",
            "args": [
                "${userHome}/personal-automation/daily-standup-bot/index.js"
            ],
            "group": {
                "kind": "build",
                "isDefault": true
            },
            "presentation": {
                "echo": true,
                "reveal": "always",
                "focus": true,
                "panel": "shared"
            },
            "problemMatcher": [],
            "detail": "Generate and post daily standup update from git commits"
        }
    ]
}
```

## Troubleshooting

### Task not appearing
- Make sure you opened **User Tasks**, not Workspace Tasks
- Reload VS Code window after editing tasks.json

### "command not found" error
- Ensure the path in `args` is correct
- Use `${userHome}` variable for cross-platform compatibility

### Node.js not found
- Make sure Node.js is in your system PATH
- You can specify the full path to node: `"command": "/usr/local/bin/node"`
