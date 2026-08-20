# Daily Report

Run the **daily report** (git commits → Cliq standup) from any VS Code or Cursor window using a **global User Task** and optional keyboard shortcut.

Separate from launchd / Shortcuts — useful for on-demand runs while coding.

## Why global tasks?

Unlike workspace tasks (`.vscode/tasks.json` inside a project), **User Tasks** live in your editor profile and work from **any** workspace:

- No files added to work repositories
- No risk of committing automation config
- Same shortcut everywhere you code

## Quick start

1. Open Command Palette → **`Tasks: Open User Tasks`** → choose **Others**
2. Copy the task from **`vscode-global-task.json`** at the project root into your user `tasks.json`
3. Update the path to your install, e.g.  
   `"${userHome}/daily-standup-bot/scripts/run-daily-standup.sh"`
4. **Tasks: Run Task** → **Generate Daily Report**

## Keyboard shortcut (optional)

Command Palette → **Preferences: Open Keyboard Shortcuts (JSON)**:

```json
[
  {
    "key": "cmd+shift+s",
    "command": "workbench.action.tasks.runTask",
    "args": "Generate Daily Report",
    "when": "editorTextFocus"
  }
]
```

On Linux, use `ctrl+shift+s` instead of `cmd+shift+s`.

## Full example `tasks.json`

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Generate Daily Report",
      "type": "shell",
      "command": "/Users/macbook/daily-standup-bot/scripts/run-daily-standup.sh",
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
      "detail": "Generate and post daily report from git commits"
    }
  ]
}
```

Prefer **`run-daily-standup.sh`** over bare `node` — it logs to `/tmp/daily-standup-bot-shortcut.log` and resolves Node from Homebrew.

Secrets stay in **`.env`** at the project root; do not put API keys in `tasks.json`.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Task not listed | Open **User Tasks**, not Workspace Tasks; reload the window after editing |
| `command not found` | Use full paths; wrapper script path above |
| Node not found | Use `run-daily-standup.sh` or set `"command": "/opt/homebrew/opt/node@20/bin/node"` |
| No Cliq message | Check `/tmp/daily-standup-bot-shortcut.log` — same as Shortcuts / manual runs |

## Related

- Main setup: [README.md](../README.md)
- Monthly Cliq worker: [MONTHLY-CLIQ.md](./MONTHLY-CLIQ.md)
- Task snippet source: [vscode-global-task.json](../vscode-global-task.json)
