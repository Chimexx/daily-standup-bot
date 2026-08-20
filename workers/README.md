# Workers

Each automation lives in its own folder. Shared utilities are in `../lib/`.

| Worker | Entry | npm script |
|--------|-------|------------|
| Daily standup | `workers/daily-standup/index.js` | `npm start` |
| Weekly standup (Tuesdays) | `workers/weekly-standup/index.js` | `npm run weekly-standup` |
| Monthly Cliq DM | `workers/monthly-cliq/index.js` | `npm run monthly-cliq` |

Root-level `index.js` and `monthly-cliq-worker.js` are thin shims for backward compatibility.

## Adding a new worker

1. Create `workers/<name>/index.js`
2. Import from `../../lib/env.js`, `../../lib/paths.js`, etc.
3. Add an npm script in `package.json`
4. Optional: `scripts/run-<name>.sh` and `automation/launchd-<name>-setup.sh`
5. Document in `docs/`

Runtime config and state stay at the **project root** (`.env`, `repos.txt`, `.last-run`, …) unless overridden by env vars.
