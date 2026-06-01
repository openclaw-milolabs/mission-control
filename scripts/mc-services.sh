#!/usr/bin/env bash
# ============================================================
# OpenClaw Mission Control — Service Supervisor
# Manages all persistent services as background daemons.
#
# Usage:
#   mc-services start         — start all services in production mode
#   mc-services start --dev   — start all services, but Next.js in dev mode
#   mc-services stop          — stop all services
#   mc-services restart       — stop then start
#   mc-services restart --dev — stop then start, with Next.js in dev mode
#   mc-services status        — show running status + recent log lines 
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$PROJECT_ROOT/.runtime"
PID_DIR="$RUNTIME_DIR/pids"
LOG_DIR="$RUNTIME_DIR/logs"

mkdir -p "$PID_DIR" "$LOG_DIR"

# ── Load .env if present ────────────────────────────────────
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

# ── Service definitions ─────────────────────────────────────
# v2: agenda-worker removed — execution now via openclaw cron (no Redis/BullMQ needed)
SERVICES="gateway-sync bridge-logger agenda-scheduler nextjs"

# One-shot services run once and exit (e.g. a sync that imports state then quits).
# They don't get a persistent PID; success is "the command exited with code 0".
# Re-runs come from cron / the watchdog's own logic, not from this start loop.
ONESHOT_SERVICES="gateway-sync"

is_oneshot() {
  local target=$1
  case " $ONESHOT_SERVICES " in *" $target "*) return 0 ;; esac
  return 1
}

declare -A SERVICE_CMDS
declare -A SERVICE_LOG_FILES
declare -A SERVICE_PIDS

for svc in $SERVICES; do
  SERVICE_PIDS[$svc]="$PID_DIR/${svc}.pid"
  SERVICE_LOG_FILES[$svc]="$LOG_DIR/${svc}.log"
done

SERVICE_CMDS[gateway-sync]="node scripts/gateway-sync.mjs"
SERVICE_CMDS[bridge-logger]="node scripts/bridge-logger.mjs"
SERVICE_CMDS[agenda-scheduler]="node scripts/agenda-scheduler.mjs"

NEXTJS_DEV_CMD="cd \"$PROJECT_ROOT\" && env -u NODE_ENV NODE_ENV=development npx next dev"
NEXTJS_PROD_CMD="cd \"$PROJECT_ROOT\" && env -u NODE_ENV NODE_ENV=production npm run start"
SERVICE_CMDS[nextjs]="$NEXTJS_PROD_CMD"

NEXTJS_MODE="prod"

# ── Helpers ────────────────────────────────────────────────
pid_running() {
  local pid=$1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

kill_port() {
  local port=${1:-3000}
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
    sleep 1
  fi
  pkill -9 -f "next-server" 2>/dev/null || true
  local pid
  pid=$(lsof -ti:"${port}" 2>/dev/null) || true
  if [ -n "$pid" ]; then
    echo "$pid" | xargs -r kill -9 2>/dev/null || true
    sleep 0.5
  fi
}

start_service() {
  local svc=$1
  local pid_file="${SERVICE_PIDS[$svc]}"
  local log_file="${SERVICE_LOG_FILES[$svc]}"
  local cmd="${SERVICE_CMDS[$svc]}"

  if [ "$svc" = "nextjs" ]; then
    if [ "${NEXTJS_MODE:-prod}" = "dev" ]; then
      cmd="$NEXTJS_DEV_CMD"
    else
      cmd="$NEXTJS_PROD_CMD"
    fi
  fi

  cd "$PROJECT_ROOT"

  # One-shot path: run synchronously, log to file, success = exit 0.
  # Skip the PID liveness check entirely; record a last-run marker so
  # `status` can show when it ran.
  if is_oneshot "$svc"; then
    rm -f "$pid_file" 2>/dev/null || true
    echo -n "  Running $svc (one-shot)... "
    local ran_marker="$PID_DIR/${svc}.last-ran"
    if bash -c "$cmd" >> "$log_file" 2>&1; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$ran_marker"
      echo "OK"
      return 0
    else
      local rc=$?
      echo "FAILED (exit $rc) — check $log_file"
      return 1
    fi
  fi

  if [ "$svc" = "nextjs" ]; then
    if command -v fuser >/dev/null 2>&1; then
      fuser -k 3000/tcp 2>/dev/null || true
      for _ in $(seq 1 10); do
        fuser 3000/tcp >/dev/null 2>&1 || break
        sleep 0.5
      done
    fi
  fi

  if pid_running "$(cat "$pid_file" 2>/dev/null)"; then
    echo "  $svc — already running (pid $(cat "$pid_file"))"
    return 0
  fi

  echo -n "  Starting $svc... "
  nohup bash -c "$cmd" >> "$log_file" 2>&1 < /dev/null &
  local new_pid=$!
  echo "$new_pid" > "$pid_file"
  sleep 1

  if pid_running "$new_pid"; then
    echo "pid $new_pid"
  else
    echo "FAILED — check $log_file"
    rm -f "$pid_file"
    return 1
  fi
}

stop_service() {
  local svc=$1
  local pid_file="${SERVICE_PIDS[$svc]}"
  local pid
  pid="$(cat "$pid_file" 2>/dev/null)" || true

  if [ -n "$pid" ] && pid_running "$pid"; then
    echo -n "  Stopping $svc (pid $pid)... "
    kill "$pid" 2>/dev/null || true
    local count=0
    while pid_running "$pid" && [ $count -lt 10 ]; do
      sleep 0.5
      count=$((count + 1))
    done
    if pid_running "$pid"; then
      kill -9 "$pid" 2>/dev/null || true
      sleep 0.2
    fi
    echo "stopped"
  else
    case "$svc" in
      gateway-sync)
        pkill -f "gateway-sync.mjs" 2>/dev/null && echo "  $svc — killed via pkill" || echo "  $svc — not running"
        ;;
      bridge-logger)
        pkill -f "bridge-logger.mjs" 2>/dev/null && echo "  $svc — killed via pkill" || echo "  $svc — not running"
        ;;
      agenda-scheduler)
        pkill -f "agenda-scheduler.mjs" 2>/dev/null && echo "  $svc — killed via pkill" || echo "  $svc — not running"
        ;;

      nextjs)
        kill_port 3000
        echo "  $svc — port 3000 cleared"
        ;;
    esac
  fi
  rm -f "$pid_file"
}

status_service() {
  local svc=$1
  local pid_file="${SERVICE_PIDS[$svc]}"
  local log_file="${SERVICE_LOG_FILES[$svc]}"

  if is_oneshot "$svc"; then
    local ran_marker="$PID_DIR/${svc}.last-ran"
    if [ -f "$ran_marker" ]; then
      echo "  $svc — one-shot (last ran $(cat "$ran_marker"))"
    else
      echo "  $svc — one-shot (never ran)"
    fi
    return 0
  fi

  if pid_running "$(cat "$pid_file" 2>/dev/null)"; then
    echo "  $svc — RUNNING (pid $(cat "$pid_file"))"
    if [ -f "$log_file" ]; then
      echo "    Last:"
      tail -2 "$log_file" | sed 's/^/      /'
    fi
  else
    echo "  $svc — STOPPED"
  fi
}

is_valid_service() {
  local target=$1
  for svc in $SERVICES; do
    if [ "$svc" = "$target" ]; then
      return 0
    fi
  done
  return 1
}

WATCHDOG_PID_FILE="$PID_DIR/watchdog.pid"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
WATCHDOG_INTERVAL="${WATCHDOG_INTERVAL:-30}"
WATCHDOG_SKIP="gateway-sync"

run_watchdog() {
  # Re-source .env so restarted services have DATABASE_URL etc.
  local env_file="$PROJECT_ROOT/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
  echo "[watchdog] Started (pid $$, interval ${WATCHDOG_INTERVAL}s)" >> "$WATCHDOG_LOG"
  while true; do
    sleep "$WATCHDOG_INTERVAL"
    for svc in $SERVICES; do
      case " $WATCHDOG_SKIP " in *" $svc "*) continue ;; esac

      local pid_file="${SERVICE_PIDS[$svc]}"
      local pid
      pid="$(cat "$pid_file" 2>/dev/null)" || true

      if [ -z "$pid" ] || ! pid_running "$pid"; then
        echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) $svc is DOWN — restarting..." >> "$WATCHDOG_LOG"
        rm -f "$pid_file"
        cd "$PROJECT_ROOT"
        local cmd="${SERVICE_CMDS[$svc]}"
        local log_file="${SERVICE_LOG_FILES[$svc]}"

        if [ "$svc" = "nextjs" ]; then
          kill_port 3000
          sleep 1
          if [ "${NEXTJS_MODE:-prod}" = "dev" ]; then
            cmd="$NEXTJS_DEV_CMD"
          else
            cmd="$NEXTJS_PROD_CMD"
          fi
        fi

        nohup bash -c "$cmd" >> "$log_file" 2>&1 < /dev/null &
        local new_pid=$!
        echo "$new_pid" > "$pid_file"
        sleep 1
        if pid_running "$new_pid"; then
          echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) $svc restarted (pid $new_pid)" >> "$WATCHDOG_LOG"
        else
          echo "[watchdog] $(date -u +%Y-%m-%dT%H:%M:%SZ) $svc FAILED to restart — check $log_file" >> "$WATCHDOG_LOG"
          rm -f "$pid_file"
        fi
      fi
    done
  done
}

start_watchdog() {
  if pid_running "$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)"; then
    echo "  watchdog — already running (pid $(cat "$WATCHDOG_PID_FILE"))"
    return 0
  fi
  nohup bash -c "
$(declare -p SERVICES SERVICE_CMDS SERVICE_LOG_FILES SERVICE_PIDS WATCHDOG_INTERVAL WATCHDOG_LOG WATCHDOG_SKIP PROJECT_ROOT PID_DIR LOG_DIR NEXTJS_MODE NEXTJS_DEV_CMD NEXTJS_PROD_CMD 2>/dev/null)
$(declare -f run_watchdog pid_running kill_port)
run_watchdog" >> "$WATCHDOG_LOG" 2>&1 < /dev/null &
  local wpid=$!
  echo "$wpid" > "$WATCHDOG_PID_FILE"
  echo "  watchdog — started (pid $wpid, checking every ${WATCHDOG_INTERVAL}s)"
}

stop_watchdog() {
  local wpid
  wpid="$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)" || true
  if [ -n "$wpid" ] && pid_running "$wpid"; then
    kill "$wpid" 2>/dev/null || true
    echo "  watchdog — stopped"
  else
    echo "  watchdog — not running"
  fi
  rm -f "$WATCHDOG_PID_FILE"
}

CMD="${1:-status}"
TARGET_SERVICE=""
DEV_MODE=0

for arg in "$@"; do
  case "$arg" in
    start|stop|restart|status|watch)
      CMD="$arg"
      ;;
    --dev)
      DEV_MODE=1
      ;;
    *)
      if [ -z "$TARGET_SERVICE" ] && [ "${arg:0:1}" != "-" ] && [ "$arg" != "$CMD" ]; then
        TARGET_SERVICE="$arg"
      fi
      ;;
  esac
done

if [ "$DEV_MODE" -eq 1 ]; then
  NEXTJS_MODE="dev"
else
  NEXTJS_MODE="prod"
fi

if [ -n "$TARGET_SERVICE" ]; then
  if ! is_valid_service "$TARGET_SERVICE"; then
    echo "Unknown service: $TARGET_SERVICE"
    echo "Available services: $SERVICES"
    exit 1
  fi
fi

case "$CMD" in
  start)
    if [ -n "$TARGET_SERVICE" ]; then
      echo "[mc-services] Starting $TARGET_SERVICE..."
      start_service "$TARGET_SERVICE" || true
    else
      if [ "$NEXTJS_MODE" = "dev" ]; then
        echo "[mc-services] Starting services (Next.js in dev mode)..."
      else
        echo "[mc-services] Starting services (Next.js in production mode)..."
      fi
      # Don't let one failing service abort the cascade. We log per-service
      # status above and surface a summary at the end.
      any_failed=0
      for svc in $SERVICES; do
        if ! start_service "$svc"; then
          any_failed=1
        fi
      done
      if [ "$any_failed" -eq 0 ]; then
        echo "[mc-services] All services started."
      else
        echo "[mc-services] Some services failed to start — see per-service messages above."
      fi
      start_watchdog
    fi
    ;;
  stop)
    if [ -n "$TARGET_SERVICE" ]; then
      echo "[mc-services] Stopping $TARGET_SERVICE..."
      stop_service "$TARGET_SERVICE"
    else
      echo "[mc-services] Stopping services..."
      stop_watchdog
      for svc in $SERVICES; do
        stop_service "$svc"
      done
      echo "[mc-services] All services stopped."
    fi
    ;;
  restart)
    if [ -n "$TARGET_SERVICE" ]; then
      echo "[mc-services] Restarting $TARGET_SERVICE..."
      stop_service "$TARGET_SERVICE"
      sleep 1
      start_service "$TARGET_SERVICE"
    else
      "$0" stop
      sleep 1
      if [ "$NEXTJS_MODE" = "dev" ]; then
        "$0" start --dev
      else
        "$0" start
      fi
    fi
    ;;
  status)
    if [ -n "$TARGET_SERVICE" ]; then
      echo "[mc-services] Service status:"
      status_service "$TARGET_SERVICE"
    else
      echo "[mc-services] Service status:"
      for svc in $SERVICES; do
        status_service "$svc"
      done
      if pid_running "$(cat "$WATCHDOG_PID_FILE" 2>/dev/null)"; then
        echo "  watchdog — RUNNING (pid $(cat "$WATCHDOG_PID_FILE"))"
      else
        echo "  watchdog — STOPPED"
      fi
    fi
    ;;
  watch)
    start_watchdog
    ;;
  *)
    echo "Usage: mc-services {start|stop|restart|status|watch} [service-name] [--dev]"
    echo "Services: $SERVICES"
    exit 1
    ;;
esac
