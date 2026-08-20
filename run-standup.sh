#!/bin/bash
# Backward-compatible wrapper — see scripts/run-daily-standup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${ROOT}/scripts/run-daily-standup.sh" "$@"
