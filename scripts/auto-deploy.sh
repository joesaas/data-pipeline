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
#
# Failure handling (this script never retries forever):
#   - A failing deploy backs off exponentially: 60s, 120s, 240s ... capped
#     at 30 minutes, instead of hammering pull/install/build every cycle.
#   - After MAX_FAILURES consecutive failures for the SAME remote SHA, the
#     script stops attempting that SHA entirely and waits silently until
#     the remote moves to a NEW commit. Retrying a SHA that deterministically
#     fails (bad build, unresolvable pull) can only burn CPU, disk and
#     network — and, when a restart step is involved, churn live services.
#     A new commit resets the counter; a manual ./deploy.sh deploy always
#     works regardless of this state.
#   - The deploy log is capped (see rotate_log) so a failure loop cannot
#     fill the disk while nobody is watching.
#
# NOTE: bash reads this script as it runs. Editing the file does NOT change
# the behaviour of an already-running instance — after a deploy pulls a new
# version of this script, run `pm2 restart auto-deploy` to pick it up.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
INTERVAL="${AUTO_DEPLOY_INTERVAL:-5}"
BRANCH="${AUTO_DEPLOY_BRANCH:-main}"
LOG_DIR="logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/auto-deploy.log"
STATE="$LOG_DIR/auto-deploy.state"
# Tunables (env overrides exist for testing; production uses the defaults).
MAX_FAILURES="${AUTO_DEPLOY_MAX_FAILURES:-3}"
MAX_BACKOFF="${AUTO_DEPLOY_MAX_BACKOFF:-1800}"
MAX_LOG_BYTES="${AUTO_DEPLOY_MAX_LOG_BYTES:-5242880}"
case "$MAX_FAILURES" in ''|*[!0-9]*) MAX_FAILURES=3;; esac
case "$MAX_BACKOFF" in ''|*[!0-9]*) MAX_BACKOFF=1800;; esac
case "$MAX_LOG_BYTES" in ''|*[!0-9]*) MAX_LOG_BYTES=5242880;; esac

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

# State file: FAILED_SHA=<sha or empty>, FAIL_COUNT=<n>. Written only by
# this script; survives restarts of the script itself.
read_state() {
  FAILED_SHA=""
  FAIL_COUNT=0
  if [ -f "$STATE" ]; then
    # shellcheck disable=SC1090
    source "$STATE" 2>/dev/null || true
  fi
}

write_state() {
  printf 'FAILED_SHA=%s\nFAIL_COUNT=%s\n' "$1" "$2" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

# Keep the log bounded: over the cap, retain only the newest lines.
rotate_log() {
  local size
  size="$(stat -c%s "$LOG" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

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
    read_state
    if [ "$remote" = "$FAILED_SHA" ] && [ "$FAIL_COUNT" -ge "$MAX_FAILURES" ]; then
      # Known-bad SHA: stay silent until the remote moves. (The "giving up"
      # line was logged when the counter hit MAX_FAILURES; logging every
      # poll here would spam the log we are trying to bound.)
      sleep "$INTERVAL"
      continue
    fi
    log "change detected: $local_head -> $remote; deploying"
    rotate_log
    # 推送工具不保留可执行位（远端 deploy.sh 恒为 100644）：没有这一行，
    # 只要上次推送动过 deploy.sh，这里的部署就会以 126 Permission denied
    # 失败——旧 auto-deploy 会无限重试，新版熔断会在 3 次后停手。
    chmod +x ./deploy.sh 2>/dev/null || true
    if ./deploy.sh deploy >>"$LOG" 2>&1; then
      log "deploy ok -> $(git rev-parse --short HEAD)"
      write_state "" 0
    else
      if [ "$remote" = "$FAILED_SHA" ]; then
        FAIL_COUNT=$((FAIL_COUNT + 1))
      else
        FAILED_SHA="$remote"
        FAIL_COUNT=1
      fi
      write_state "$FAILED_SHA" "$FAIL_COUNT"
      backoff=$((60 * (2 ** (FAIL_COUNT - 1))))
      [ "$backoff" -gt "$MAX_BACKOFF" ] && backoff="$MAX_BACKOFF"
      if [ "$FAIL_COUNT" -ge "$MAX_FAILURES" ]; then
        log "deploy FAILED ${FAIL_COUNT} times for $remote; giving up on this SHA until a new commit appears (manual ./deploy.sh deploy still works)"
      else
        log "deploy FAILED (attempt $FAIL_COUNT/$MAX_FAILURES for $remote); backing off ${backoff}s"
      fi
      sleep "$backoff"
      continue
    fi
  fi
  sleep "$INTERVAL"
done
