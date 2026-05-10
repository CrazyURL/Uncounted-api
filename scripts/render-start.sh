#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# BM v10 STAGE 2 — Render 시작 스크립트 (Tailscale + Node)
# ────────────────────────────────────────────────────────────────────
# 동작:
#   1. TAILSCALE_AUTHKEY 가 설정됐으면 tailscaled 백그라운드 시작
#      (userspace networking + HTTP proxy on localhost:1055)
#   2. tailscale up 으로 인증 + Tailnet 합류 (ephemeral)
#   3. HTTP_PROXY/HTTPS_PROXY 를 localhost:1055 로 설정
#      → src/dev.ts 가 ProxyAgent 로 voice_api 호출 시 Tailnet 통과
#   4. yarn start 로 Node 앱 실행
#
#   TAILSCALE_AUTHKEY 미설정 시: Tailscale 없이 그냥 yarn start
#   (graceful degradation — 다른 환경 / 로컬에서도 동작)
# ────────────────────────────────────────────────────────────────────
set -e

if [ -z "${TAILSCALE_AUTHKEY:-}" ]; then
  echo "[render-start] TAILSCALE_AUTHKEY 미설정 — Tailscale 없이 시작"
  exec npm start
fi

TS_DIR="./tailscale-bin"
if [ ! -x "${TS_DIR}/tailscaled" ]; then
  echo "[render-start] tailscaled 바이너리 없음 — 재설치 시도"
  bash ./scripts/install-tailscale.sh
fi

LOG_FILE="/tmp/tailscaled.log"
SOCKET_FILE="/tmp/tailscaled.sock"
PROXY_PORT="${TAILSCALE_PROXY_PORT:-1055}"

echo "[render-start] tailscaled 시작 (userspace, HTTP proxy on localhost:${PROXY_PORT})"
"${TS_DIR}/tailscaled" \
  --tun=userspace-networking \
  --socks5-server="localhost:${PROXY_PORT}" \
  --outbound-http-proxy-listen="localhost:${PROXY_PORT}" \
  --socket="${SOCKET_FILE}" \
  --state=mem: \
  > "${LOG_FILE}" 2>&1 &
TAILSCALED_PID=$!
echo "[render-start] tailscaled PID=${TAILSCALED_PID}"

# daemon socket 이 뜰 때까지 대기 (max 15초)
for i in $(seq 1 15); do
  if [ -S "${SOCKET_FILE}" ]; then
    break
  fi
  sleep 1
done

# 인증 + Tailnet 합류
HOSTNAME_TAG="render-${RENDER_SERVICE_NAME:-api}-${RENDER_INSTANCE_ID:-$(hostname | tr -dc 'a-zA-Z0-9' | head -c 8)}"
echo "[render-start] tailscale up — hostname=${HOSTNAME_TAG}"
"${TS_DIR}/tailscale" --socket="${SOCKET_FILE}" up \
  --authkey="${TAILSCALE_AUTHKEY}" \
  --hostname="${HOSTNAME_TAG}" \
  --accept-routes

echo "[render-start] tailscale status:"
"${TS_DIR}/tailscale" --socket="${SOCKET_FILE}" status || true

# Node 앱이 사용할 proxy 환경변수
export HTTP_PROXY="http://localhost:${PROXY_PORT}"
export HTTPS_PROXY="http://localhost:${PROXY_PORT}"
export ALL_PROXY="socks5://localhost:${PROXY_PORT}"
echo "[render-start] HTTP_PROXY=${HTTP_PROXY}"

# graceful shutdown — Render SIGTERM 시 tailscaled 도 종료
trap 'kill ${TAILSCALED_PID} 2>/dev/null || true' SIGTERM SIGINT

echo "[render-start] npm start 실행..."
exec npm start
