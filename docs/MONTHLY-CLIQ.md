# Monthly Cliq DM

Sends a Cliq message **from you** to one person, **once per month**.

## What you fill in

### `.env` — Zoho login (one-time setup)

```bash
ZOHO_CLIENT_ID=...
ZOHO_CLIENT_SECRET=...
ZOHO_REFRESH_TOKEN=...
```

Get these from [Zoho API Console](https://api-console.zoho.com/) → Self Client → scope **`ZohoCliq.Webhooks.CREATE`**.

### `monthly-cliq.config.json` — who, what, when

```bash
cp config/examples/monthly-cliq.config.example.json monthly-cliq.config.json
```

```json
{
  "enabled": true,
  "recipient": "manager@company.com",
  "message": "Hi — monthly check-in from me.",
  "dayOfMonth": 1
}
```

| Field | Required? | Notes |
|-------|-----------|-------|
| `enabled` | Yes | `true` to run, `false` to turn off |
| `recipient` | Yes | Their Cliq email |
| `message` | Yes | Plain text to send |
| `dayOfMonth` | No | Day each month (default: `1`). Sends around 9:00 AM local time. |

That's it. No `delivery`, no `schedule` block, no bot URL.

## Run

```bash
npm run monthly-cliq
```

Preview without sending:

```bash
DRY_RUN=1 MONTHLY_CLIQU_FORCE=1 npm run monthly-cliq
```

## Auto-run monthly (macOS)

```bash
chmod +x automation/launchd-monthly-setup.sh scripts/run-monthly-cliq.sh
./automation/launchd-monthly-setup.sh
```

Schedule the job to run **once a day**; the script only sends on your `dayOfMonth` and won't send twice in the same month.

## Turn off

Set `"enabled": false` in the config.
