#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [ "$(uname -s)" != Darwin ]; then
    echo "Error: this script requires macOS." >&2
    exit 1
fi
case "$(uname -m)" in
    arm64) DESKTOP_ARCH=arm64 ;;
    x86_64) DESKTOP_ARCH=amd64 ;;
    *) echo "Error: unsupported macOS architecture." >&2; exit 1 ;;
esac

for tool in go node pnpm shlock osascript lsof ps; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "Error: ${tool} is required." >&2
        exit 1
    fi
done

cd "${ROOT_DIR}"
BUNDLE_DIR="${ROOT_DIR}/desktop/dist/darwin-${DESKTOP_ARCH}"
DEV_PATH="${ROOT_DIR}/bin/desktop/Lever"
mkdir -p bin/desktop
LOCK_PATH="${ROOT_DIR}/bin/.restart-desktop.lock"
if ! shlock -f "${LOCK_PATH}" -p "$$"; then
    echo "Error: another desktop restart is in progress or the build directory is not writable." >&2
    exit 1
fi
trap 'rm -f "${LOCK_PATH}"' EXIT

checkout_desktop() {
    local executable cwd
    executable="$(ps -ww -p "$1" -o comm=)" || return 1
    case "${executable}" in
        "${DEV_PATH}"|"${ROOT_DIR}/bin/lever-desktop"|"${BUNDLE_DIR}/"[Ll]ever.app/Contents/MacOS/[Ll]ever) return 0 ;;
        */lever-desktop)
            # go run places the executable outside the checkout.
            cwd="$(lsof -a -d cwd -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p')" || return 1
            [ "${cwd}" = "${ROOT_DIR}" ] ;;
        *) return 1 ;;
    esac
}

echo "==> Installing frontend dependencies and building the Go desktop and backend"
pnpm --dir web install --frozen-lockfile
go build -tags dev -o "${DEV_PATH}" ./cmd/lever-desktop
DATA_DIR="$("${DEV_PATH}" --print-data-dir "$@")"
[ -n "${DATA_DIR}" ] || exit 0  # --help already printed usage.

# Keep legacy in-process executions accessible until they finish. Newer
# backends confirm the handoff under their admission lock before shutting down.
announced=false
while holders="$(lsof -w -t -- "${DATA_DIR}/lever.lock" 2>/dev/null)"; do
    for pid in ${holders}; do
        if ! checkout_desktop "${pid}" && kill -0 "${pid}" 2>/dev/null; then
            echo "Error: ${DATA_DIR} is in use by another Lever server (PID ${pid})." >&2
            exit 1
        fi
    done
    busy="$("${DEV_PATH}" --data-dir "${DATA_DIR}" --print-restart-busy)"
    [ "${busy}" = true ] || break
    if [ "${announced}" = false ]; then
        echo "==> Waiting for runs without an independent provider worker. The current window stays open for approvals (Ctrl+C cancels the restart)."
        announced=true
    fi
    sleep 1
done

echo "==> Closing desktop windows for ${DATA_DIR}"
# Each window holds desktop.log open in its own data directory. The backend
# holds lever.lock independently and shuts down after the last window detaches.
WINDOW_PIDS=()
while IFS= read -r pid; do
    if checkout_desktop "${pid}"; then
        WINDOW_PIDS+=("${pid}")
    fi
done < <(lsof -w -t -- "${DATA_DIR}/desktop.log" 2>/dev/null || true)
osascript -l JavaScript - ${WINDOW_PIDS[@]+"${WINDOW_PIDS[@]}"} <<'JXA'
ObjC.import('AppKit')

function run(pids) {
    const apps = pids.map(pid => $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(pid)))
        .filter(app => !app.isNil() && !app.isTerminated)
    for (const app of apps) {
        if (!app.isTerminated && !app.terminate && !app.isTerminated) {
            throw new Error('Could not request a normal quit. Quit Lever and rerun this script.')
        }
    }

    const deadline = Date.now() + 120000
    while (apps.some(app => !app.isTerminated)) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for Lever to quit. Quit Lever and rerun this script.')
        }
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25))
    }
}
JXA

rm -f "${LOCK_PATH}"
trap - EXIT
echo "==> Starting the newly built Go backend and desktop with Vite hot updates"
exec node "${ROOT_DIR}/web/scripts/dev-desktop.mjs" --prebuilt --reload-on-sighup --fresh-backend "$@"
