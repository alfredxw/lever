#!/bin/bash
set -euo pipefail

if [ "$(uname -s)" != Darwin ]; then
    echo "Error: this script requires macOS." >&2
    exit 1
fi
if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
    echo "Usage: $0 [--data-dir PATH]"
    exit 0
fi
if ! [[ $# -eq 0 || ( $# -eq 2 && "$1" == --data-dir ) || ( $# -eq 1 && "$1" == --data-dir=* ) ]]; then
    echo "Usage: $0 [--data-dir PATH]" >&2
    exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${ROOT_DIR}"
DEV_PATH="${ROOT_DIR}/bin/desktop/Lever"
LAUNCHER="${ROOT_DIR}/web/scripts/dev-desktop.mjs"
if [ -x "${DEV_PATH}" ]; then
    DATA_DIR="$("${DEV_PATH}" --print-data-dir "$@")"
    while IFS= read -r pid; do
        [ "$(ps -ww -p "${pid}" -o comm=)" = "${DEV_PATH}" ] || continue
        parent="$(ps -p "${pid}" -o ppid=)" || continue
        parent="${parent//[[:space:]]/}"
        command="$(ps -ww -p "${parent}" -o command=)" || continue
        # A launcher from before this change has no SIGUSR2 handler.
        if [[ "${command} " == "node ${LAUNCHER} --prebuilt --reload-on-sighup "* ]]; then
            kill -USR2 "${parent}"
            echo "Requested a desktop frontend restart."
            exit 0
        fi
    done < <(lsof -w -t -- "${DATA_DIR}/desktop.log" 2>/dev/null || true)
fi

echo "Error: no reloadable desktop for this checkout and data directory. Start it with scripts/restart-backend.sh." >&2
exit 1
