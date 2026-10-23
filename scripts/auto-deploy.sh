#!/usr/bin/env bash
# auto-deploy: poll the git remote every INTERVAL seconds; when main moves,
# redeploy via deploy.sh (pull -> install -> build -> restart -> export).
#
# Run it under pm2 on the server:
#   pm2 start scripts/auto-deploy.sh --name auto-deploy --interpreter bash
#   pm2 save
# Stop / inspect:
#   pm2 stop auto-deploy | pm2 logs auto-deploy | pm2 delete auto-deploy
#
# Env: AUTO_DEPLOY_INTERVAL (seconds, default 5), AUTO_DEPLOY_BRANCH (default main)
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
INTERVAL="${AUTO_DEPLOY_INTERVAL:-5}"
BRANCH="${AUTO_DEPLOY_BRANCH:-main}"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/auto-deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# One deploy at a time: the poll interval (5s) is far shorter than a deploy.
exec 9>"/tmp/data-pipeline-auto-deploy.lock"
if ! flock -n 9; then
  log "another auto-deploy instance is running; exit"
  exit 0
fi

log "auto-deploy watching origin/$BRANCH every ${INTERVAL}s (deploy = ./deploy.sh deploy)"

while true; do
  remote="$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}')"
  local_head="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ -n "$remote" ] && [ "$remote" != "$local_head" ]; then
    log "change detected: $local_head -> $remote; deploying"
    if ./deploy.sh deploy >>"$LOG" 2>&1; then
      log "deploy ok -> $(git rev-parse --short HEAD)"
    else
      log "deploy FAILED (see above); backing off 60s"
      sleep 60
    fi
  fi
  sleep "$INTERVAL"
done
