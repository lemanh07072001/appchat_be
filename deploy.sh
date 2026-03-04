#!/bin/bash
set -e

# ═══════════════════════════════════════════════════════════════
#  Cấu hình Nginx reverse proxy + SSL
#  Usage: bash deploy.sh
# ═══════════════════════════════════════════════════════════════

DOMAIN="api.fastproxyvn.com"

echo "══════════════════════════════════════"
echo "  DOMAIN: $DOMAIN"
echo "══════════════════════════════════════"

# ─── 1. Nginx reverse proxy ─────────────────────────────────
echo "[1/2] Cấu hình Nginx reverse proxy..."

sudo mkdir -p /etc/nginx/conf.d
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

# ─── 2. SSL Let's Encrypt ───────────────────────────────────
echo "[2/2] Cài SSL Let's Encrypt..."
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

echo ""
echo "══════════════════════════════════════"
echo "  DONE! https://${DOMAIN}"
echo "══════════════════════════════════════"
