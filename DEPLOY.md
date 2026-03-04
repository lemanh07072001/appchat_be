# Deploy NestJS Proxy Server lên VPS Ubuntu

## Kiến trúc

```
                    ┌─────────────────────┐
  Client ──────────►│    Nginx (port 80)  │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  proxy-server (PM2)  │  ← HTTP API + Scheduler backup
                    │     dist/main.js     │
                    └─────────┬───────────┘
                              │ LPUSH
                    ┌─────────▼───────────┐
                    │   Redis (port 6379) │  ← orders:pending (List)
                    └─────────┬───────────┘
                              │ BRPOP (realtime)
                    ┌─────────▼───────────┐
                    │  proxy-worker (PM2)  │  ← Xử lý order, gọi Provider API
                    │    dist/worker.js    │
                    └─────────────────────┘
                              │
                    ┌─────────▼───────────┐
                    │  MongoDB (port 27017)│
                    └─────────────────────┘
```

**Flow xử lý order:**
1. User gọi `POST /api/orders/buy` → lưu order (PENDING) vào MongoDB → `LPUSH` order ID vào Redis List
2. Worker `BRPOP` nhận order ID **ngay lập tức** → gọi Provider API → update order → PROCESSING
3. Scheduler backup (30 phút/lần) re-push PENDING orders bị miss (VD: Redis restart)
4. Processing scheduler (60 giây/lần) poll provider lấy proxy → insert proxy → order ACTIVE

## Yeu cau

- VPS Ubuntu 22.04/24.04
- SSH access (root hoac user co sudo)

---

## 1. Update he thong

```bash
sudo apt update && sudo apt upgrade -y
```

---

## 2. Cai Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Kiem tra:

```bash
node -v    # v22.x.x
npm -v     # 10.x.x
```

---

## 3. Cai PM2

```bash
sudo npm install -g pm2
```

Kiem tra:

```bash
pm2 -v
```

---

## 4. Cai MongoDB 8

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | \
  sudo gpg -o /usr/share/keyrings/mongodb-server-8.0.gpg --dearmor

echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] \
  https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/8.0 multiverse" | \
  sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list

sudo apt update
sudo apt install -y mongodb-org
```

Khoi dong va bat auto-start:

```bash
sudo systemctl start mongod
sudo systemctl enable mongod
sudo systemctl status mongod    # Kiem tra dang chay
```

---

## 5. Cai Redis

```bash
sudo apt install -y redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

Kiem tra:

```bash
redis-cli ping    # Tra ve PONG la OK
```

> Redis duoc su dung lam queue (Redis List) de worker xu ly order realtime qua BRPOP.

---

## 6. Cai Nginx

```bash
sudo apt install -y nginx
sudo systemctl start nginx
sudo systemctl enable nginx
```

Kiem tra: mo trinh duyet vao `http://<IP-VPS>` se thay trang Welcome cua Nginx.

---

## 7. Cai Git

```bash
sudo apt install -y git
git --version
```

---

## 8. Clone va build project

```bash
git clone <your-repo-url> ~/proxy-server
cd ~/proxy-server
cp .env.example .env
nano .env    # Chinh sua cau hinh (xem ben duoi)
npm install
npm run build
mkdir -p logs
```

### Cau hinh .env

| Bien | Mo ta | Mac dinh |
|------|-------|----------|
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/proxydb` |
| `PORT` | HTTP server port | `8080` |
| `REDIS_HOST` | Redis host | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (bo trong neu khong dat) | _(trong)_ |
| `REDIS_DB` | Redis database index | `0` |

---

## 9. Chay app voi PM2

```bash
pm2 start ecosystem.config.js
```

Se khoi dong 2 process:
- **proxy-server** (`dist/main.js`) — HTTP API + scheduler backup 30 phut
- **proxy-worker** (`dist/worker.js`) — BRPOP worker xu ly order realtime

Kiem tra:

```bash
pm2 list              # Xem danh sach process
pm2 logs              # Xem logs realtime
pm2 logs proxy-server # Logs rieng HTTP server
pm2 logs proxy-worker # Logs rieng worker
```

Luu va tu khoi dong khi reboot:

```bash
pm2 save
pm2 startup    # Chay lenh ma no in ra
```

---

## 10. Cau hinh Nginx reverse proxy

```bash
sudo cp nginx.conf /etc/nginx/sites-available/proxy-server
sudo ln -s /etc/nginx/sites-available/proxy-server /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

> Sua `server_name` trong file neu can:
> `sudo nano /etc/nginx/sites-available/proxy-server`

Test va reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 11. (Tuy chon) Cai SSL voi Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot se tu dong gia han SSL.

---

## Cac lenh PM2 thuong dung

| Lenh | Mo ta |
|------|-------|
| `pm2 list` | Xem trang thai cac process |
| `pm2 logs` | Xem logs realtime |
| `pm2 restart all` | Restart tat ca |
| `pm2 reload all` | Zero-downtime reload |
| `pm2 stop all` | Dung tat ca |
| `pm2 monit` | Monitor CPU/RAM |

---

## Cap nhat code (moi lan deploy moi)

```bash
cd ~/proxy-server
git pull
npm install
npm run build
pm2 reload all
```

---

## Troubleshooting

### Worker khong xu ly order
```bash
# Kiem tra Redis co dang chay khong
redis-cli ping

# Kiem tra Redis list co order pending khong
redis-cli llen orders:pending

# Xem logs worker
pm2 logs proxy-worker --lines 50
```

### Order bi miss (PENDING qua lau)
- Scheduler backup chay moi 30 phut se re-push PENDING orders vao Redis
- Kiem tra worker co dang chay: `pm2 list`
- Kiem tra Redis connection: `redis-cli ping`
