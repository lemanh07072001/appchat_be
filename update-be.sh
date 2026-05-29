#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
#  update-be.sh — Deploy bản mới cho BACKEND: git pull → install → build → reload
#  Chạy TRÊN server (sau khi đã setup-be.sh lần đầu).
#  Usage: bash update-be.sh
# ═══════════════════════════════════════════════════════════════════════════

BE_DIR="/var/www/tainguyenproxy_be"        # NestJS

log() { echo -e "\n\033[1;36m══ $* \033[0m"; }
die() { echo -e "\033[1;31mLỖI: $*\033[0m" >&2; exit 1; }

log "BACKEND ($BE_DIR)"
cd "$BE_DIR" || die "Không thấy $BE_DIR"
git pull
npm install
npm run build
pm2 reload proxy-server proxy-worker

log "XONG — pm2 status:"
pm2 status
