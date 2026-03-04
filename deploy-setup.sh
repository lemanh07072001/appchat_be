#!/bin/bash
# ===========================================
# VPS Deployment Setup Script
# Ubuntu - NestJS Proxy Server
# ===========================================

set -e

echo "=== 1. Update system ==="
sudo apt update && sudo apt upgrade -y

echo "=== 2. Install Node.js 22 LTS ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

echo "=== 3. Install PM2 ==="
sudo npm install -g pm2

echo "=== 4. Install MongoDB 8 ==="
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo systemctl start mongod
sudo systemctl enable mongod

echo "=== 5. Install Redis ==="
sudo apt install -y redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server

echo "=== 6. Install Nginx ==="
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx

echo "=== 7. Install Git ==="
sudo apt install -y git

echo ""
echo "=== Setup complete! ==="
echo ""
echo "Next steps:"
echo "  1. Clone your repo:    git clone <your-repo-url> /home/$USER/proxy-server"
echo "  2. cd /home/$USER/proxy-server"
echo "  3. Copy env:           cp .env.example .env && nano .env"
echo "  4. Install deps:       npm install"
echo "  5. Build:              npm run build"
echo "  6. Create logs dir:    mkdir -p logs"
echo "  7. Start with PM2:     pm2 start ecosystem.config.js"
echo "  8. Save PM2:           pm2 save && pm2 startup"
echo "  9. Setup Nginx:        sudo cp nginx.conf /etc/nginx/sites-available/proxy-server"
echo "                         sudo ln -s /etc/nginx/sites-available/proxy-server /etc/nginx/sites-enabled/"
echo "                         sudo rm -f /etc/nginx/sites-enabled/default"
echo "                         sudo nginx -t && sudo systemctl reload nginx"
echo ""
