#!/usr/bin/env bash
set -euo pipefail

APP_PORT="${APP_PORT:-3000}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_FILE="${PROJECT_ROOT}/app.log"

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

echo "[1/4] Preparing app in ${PROJECT_ROOT}"
cd "${PROJECT_ROOT}"

if [ ! -f package.json ]; then
  echo "package.json not found in ${PROJECT_ROOT}" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "node_modules missing, installing dependencies..."
  npm install --no-audit --no-fund
fi

echo "[2/4] Restarting Node app on port ${APP_PORT}"
if command -v fuser >/dev/null 2>&1; then
  fuser -k "${APP_PORT}/tcp" >/dev/null 2>&1 || true
fi
pkill -f "node app.js" >/dev/null 2>&1 || true

nohup node app.js >>"${LOG_FILE}" 2>&1 &
APP_PID=$!
echo "Started node app.js with PID ${APP_PID}"

if command -v curl >/dev/null 2>&1; then
  for i in $(seq 1 25); do
    if curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null 2>&1; then
      echo "Node app is healthy on http://127.0.0.1:${APP_PORT}"
      break
    fi

    if [ "$i" -eq 25 ]; then
      echo "Node app did not become healthy in time. Last log lines:" >&2
      tail -n 60 "${LOG_FILE}" >&2 || true
      exit 1
    fi
    sleep 1
  done
else
  echo "curl not found; skipping health check."
fi

echo "[3/4] Starting and reloading Nginx"
run_root systemctl start nginx
run_root systemctl reload nginx

echo "[4/4] Stack started"
echo "- App:    http://127.0.0.1:${APP_PORT}"
echo "- Nginx:  active and reloaded"
echo "- Logs:   ${LOG_FILE}"
