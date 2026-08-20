#!/bin/bash
# Backward-compatible wrapper — see automation/cron-setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${ROOT}/automation/cron-setup.sh" "$@"
