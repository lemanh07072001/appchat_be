#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
#  setup-be.sh — Cài BACKEND (NestJS) cho api.tainguyenproxy.com
#  Chạy TRÊN server. Gồm: .env, build, seed admin, PM2, Nginx + SSL cho api.
#
#  Usage:
#     bash setup-be.sh           # cài đầy đủ + SSL cho api.
#     bash setup-be.sh --no-ssl  # bỏ qua SSL (khi DNS api. chưa trỏ)
# ═══════════════════════════════════════════════════════════════════════════

# ─── Cấu hình ──────────────────────────────────────────────────────────────
BE_DIR="/var/www/tainguyenproxy_be"        # NestJS (repo appchat_be)
API_DOMAIN="api.tainguyenproxy.com"
DOMAIN="tainguyenproxy.com"                 # dùng cho CORS (origin frontend)
WWW_DOMAIN="www.tainguyenproxy.com"         # dùng cho CORS
DB_NAME="tainguyenproxy"
BE_PORT=8080
LE_EMAIL="omocaptcha@gmail.com"

DO_SSL=1
[[ "${1:-}" == "--no-ssl" ]] && DO_SSL=0

log() { echo -e "\n\033[1;36m══ $* \033[0m"; }
die() { echo -e "\033[1;31mLỖI: $*\033[0m" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Hãy chạy bằng root (hoặc sudo bash setup-be.sh)."
[[ -d "$BE_DIR" ]] || die "Không thấy backend tại $BE_DIR — sửa BE_DIR trong script."

# ─── 0. Môi trường + công cụ build native (bcrypt, sharp) ──────────────────
log "0. Kiểm tra môi trường"
command -v node  >/dev/null || die "Chưa có Node.js."
command -v npm   >/dev/null || die "Chưa có npm."
command -v pm2   >/dev/null || { echo "  PM2 chưa có → cài..."; npm install -g pm2; }
command -v nginx >/dev/null || die "Chưa có Nginx."
echo "  Node: $(node -v)   npm: $(npm -v)   pm2: $(pm2 -v)"
if ! command -v gcc >/dev/null; then
    echo "  Thiếu build tools → cài build-essential python3..."
    apt-get update -qq && apt-get install -y build-essential python3
fi

# ─── 1. MongoDB + Redis ────────────────────────────────────────────────────
log "1. Khởi động MongoDB + Redis"
systemctl enable --now mongod        2>/dev/null || systemctl enable --now mongodb 2>/dev/null || echo "  ! Không start được mongod — kiểm tra MongoDB."
systemctl enable --now redis-server  2>/dev/null || systemctl enable --now redis   2>/dev/null || echo "  ! Không start được redis — kiểm tra Redis."
redis-cli ping 2>/dev/null | grep -q PONG && echo "  Redis: PONG" || echo "  ! Redis chưa phản hồi PONG."

# ─── 2. .env ───────────────────────────────────────────────────────────────
log "2. Cấu hình .env"
cd "$BE_DIR"
if [[ -f .env ]]; then
    echo "  .env đã tồn tại → GIỮ NGUYÊN (bảo toàn JWT secret hiện có)."
else
    JWT_SECRET=$(openssl rand -hex 48)
    JWT_REFRESH_SECRET=$(openssl rand -hex 48)
    cat > .env <<ENV
MONGO_URI=mongodb://localhost:27017/${DB_NAME}
PORT=${BE_PORT}

# Redis (queue cho worker)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

# JWT (sinh ngẫu nhiên — KHÔNG để lộ)
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET}

# URL gốc để build link ảnh upload
UPLOAD_BASE_URL=https://${API_DOMAIN}

# Telegram thông báo (điền nếu dùng)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ORDER_BOT_TOKEN=
TELEGRAM_ORDER_CHAT_ID=

# Cổng thanh toán (điền nếu dùng)
PAYS=
SEPAY_WEBHOOK_API_KEY=
BINANCE_PAY_WEBHOOK_SECRET=
ENV
    echo "  Đã tạo .env (DB=${DB_NAME}, PORT=${BE_PORT}, JWT secret ngẫu nhiên)."
fi

# ─── 3. Install + build ────────────────────────────────────────────────────
log "3. Install + build"
npm install
npm run build
mkdir -p logs uploads

# ─── 4. Seed admin ─────────────────────────────────────────────────────────
log "4. Seed tài khoản admin"
node scripts/seed-admin.js || echo "  ! Seed admin lỗi (bỏ qua) — chạy tay: cd $BE_DIR && node scripts/seed-admin.js"

# ─── 5. PM2 ────────────────────────────────────────────────────────────────
log "5. PM2 (proxy-server + proxy-worker)"
pm2 delete proxy-server proxy-worker 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ─── 6. Nginx (api. + CORS + WebSocket) ────────────────────────────────────
log "6. Nginx reverse proxy + CORS"
# Map echo lại origin được phép (backend chưa bật CORS ở app → xử lý ở Nginx).
tee /etc/nginx/conf.d/00-cors-map.conf > /dev/null <<MAP
map \$http_origin \$cors_origin {
    default "";
    "https://${DOMAIN}"     "https://${DOMAIN}";
    "https://${WWW_DOMAIN}" "https://${WWW_DOMAIN}";
}
MAP

tee /etc/nginx/conf.d/proxy-server.conf > /dev/null <<NGINX
server {
    listen 80;
    server_name ${API_DOMAIN};

    location / {
        if (\$request_method = OPTIONS) {
            add_header Access-Control-Allow-Origin \$cors_origin always;
            add_header Access-Control-Allow-Credentials true always;
            add_header Access-Control-Allow-Methods "GET, POST, PUT, PATCH, DELETE, OPTIONS" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type, Accept, Origin, X-Requested-With" always;
            add_header Access-Control-Max-Age 86400 always;
            add_header Content-Length 0;
            return 204;
        }
        add_header Access-Control-Allow-Origin \$cors_origin always;
        add_header Access-Control-Allow-Credentials true always;

        proxy_pass http://127.0.0.1:${BE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    client_max_body_size 10M;
}
NGINX

rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
systemctl reload nginx

# ─── 7. SSL ────────────────────────────────────────────────────────────────
if [[ $DO_SSL -eq 1 ]]; then
    log "7. SSL Let's Encrypt cho ${API_DOMAIN} (DNS api. phải trỏ về IP server)"
    command -v certbot >/dev/null || apt-get install -y certbot python3-certbot-nginx
    if certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect; then
        echo "  SSL OK."
    else
        echo "  ! Cấp SSL THẤT BẠI (thường do DNS chưa trỏ). API vẫn chạy ở HTTP."
        echo "    Trỏ DNS xong chạy lại: certbot --nginx -d $API_DOMAIN --redirect -m $LE_EMAIL --agree-tos -n"
    fi
else
    log "7. SSL — BỎ QUA (--no-ssl)"
fi

log "XONG — BACKEND"
cat <<DONE

  API   : https://${API_DOMAIN}   (PM2: proxy-server + proxy-worker → 127.0.0.1:${BE_PORT})
  Admin : admin@fastproxyvn.com / Admin@12345   (đổi mật khẩu sau khi đăng nhập!)

  Kiểm tra:  pm2 status
             pm2 logs proxy-server
             curl -I http://127.0.0.1:${BE_PORT}
DONE
