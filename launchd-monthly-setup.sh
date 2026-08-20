#!/bin/bash
# Backward-compatible wrapper — see automation/launchd-monthly-setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${ROOT}/automation/launchd-monthly-setup.sh" "$@"
