#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# BM v10 STAGE 2 — Tailscale 바이너리 다운로드 (Render build-time)
# ────────────────────────────────────────────────────────────────────
# Render Node runtime 은 Docker 가 아니라 Ubuntu 베이스 — apt 권한 없음.
# Tailscale 의 정적 바이너리를 프로젝트 디렉토리에 풀어서 사용한다.
# 이 디렉토리는 build 컨테이너 → runtime 컨테이너로 그대로 복사됨.
#
# 사용:
#   buildCommand: yarn ... ; bash ./scripts/install-tailscale.sh
#
# 환경변수:
#   TAILSCALE_VERSION (선택, 기본 1.78.1)
# ────────────────────────────────────────────────────────────────────
set -euo pipefail

TS_VERSION="${TAILSCALE_VERSION:-1.78.1}"
TS_DIR="./tailscale-bin"

if [ -f "${TS_DIR}/tailscaled" ] && [ -f "${TS_DIR}/tailscale" ]; then
  echo "[install-tailscale] 이미 설치됨: ${TS_DIR}"
  "${TS_DIR}/tailscale" version || true
  exit 0
fi

mkdir -p "${TS_DIR}"
echo "[install-tailscale] Tailscale ${TS_VERSION} 다운로드 중..."

curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_amd64.tgz" \
  | tar -xz -C "${TS_DIR}" --strip-components=1

chmod +x "${TS_DIR}/tailscale" "${TS_DIR}/tailscaled"

echo "[install-tailscale] 완료:"
"${TS_DIR}/tailscale" version
