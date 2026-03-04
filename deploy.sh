#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  Deploy script — chạy từ bước 6 trở đi
#  Usage: bash deploy.sh <REPO_URL> <DOMAIN>
#  VD:    bash deploy.sh https://github.com/user/proxy-server.git api.example.com
# ═══════════════════════════════════════════════════════════════

REPO_URL="${1:?Thiếu REPO_URL. VD: bash deploy.sh https://github.com/user/repo.git}"
DOMAIN="api.fastproxyvn.com"
APP_DIR="$HOME/proxy-server"

echo "══════════════════════════════════════"
echo "  REPO:   $REPO_URL"
echo "  DOMAIN: $DOMAIN"
echo "  DIR:    $APP_DIR"
echo "══════════════════════════════════════"

# ─── 6. Nginx ────────────────────────────────────────────────
echo "[6/11] Cài Nginx..."
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx

# ─── 7. Git ──────────────────────────────────────────────────
echo "[7/11] Cài Git..."
sudo apt install -y git

# ─── 8. Clone & Build ───────────────────────────────────────
echo "[8/11] Clone & build project..."
if [ -d "$APP_DIR" ]; then
  echo "  → Thư mục $APP_DIR đã tồn tại, pull code mới..."
  cd "$APP_DIR"
  git pull
else
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

if [ -f .env.example ] && [ ! -f .env ]; then
  cp .env.example .env
  echo "  → Đã tạo .env từ .env.example — hãy chỉnh sửa sau nếu cần"
fi

npm install
npm run build
mkdir -p logs

# ─── 9. PM2 ─────────────────────────────────────────────────
echo "[9/11] Khởi động PM2..."
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# Auto-start khi reboot
PM2_STARTUP_CMD=$(pm2 startup | grep "sudo" | head -1)
if [ -n "$PM2_STARTUP_CMD" ]; then
  eval "$PM2_STARTUP_CMD"
fi

# ─── 10. Nginx reverse proxy ────────────────────────────────
echo "[10/11] Cấu hình Nginx reverse proxy..."

sudo tee /etc/nginx/conf.d/proxy-server.conf > /dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:8080;
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
sudo rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
sudo nginx -t
sudo systemctl reload nginx

# ─── 11. SSL Let's Encrypt ───────────────────────────────────
echo "[11/11] Cài SSL Let's Encrypt..."
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

echo ""
echo "══════════════════════════════════════"
echo "  DEPLOY THÀNH CÔNG!"
echo "  URL: https://${DOMAIN}"
echo "  PM2: pm2 list / pm2 logs"
echo "══════════════════════════════════════"
