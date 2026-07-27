#!/bin/bash

# ============================================================
#  HANDCAP WA Gateway — Deploy Script
#  Usage: bash deploy.sh
# ============================================================

set -e  # Exit immediately if any command fails

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="handcap"

echo ""
echo "============================================================"
echo "  HANDCAP — Pull & Deploy dari GitHub"
echo "  Dir : $APP_DIR"
echo "  Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================================"
echo ""

cd "$APP_DIR"

# ── 1. Pull dari GitHub ───────────────────────────────────────
echo "[1/4] Pulling update dari GitHub..."
git fetch origin
git reset --hard origin/main
echo "      ✓ Code updated ke commit: $(git log -1 --format='%h %s')"
echo ""

# ── 2. Install dependencies ───────────────────────────────────
echo "[2/4] Install npm dependencies..."
npm install --omit=dev --silent
echo "      ✓ Dependencies ready"
echo ""

# ── 3. Restart server ─────────────────────────────────────────
echo "[3/4] Restart server..."

if command -v pm2 &> /dev/null; then
  # Pakai PM2 kalau tersedia
  if pm2 list | grep -q "$APP_NAME"; then
    pm2 restart "$APP_NAME"
    echo "      ✓ PM2 process '$APP_NAME' restarted"
  else
    pm2 start src/index.js --name "$APP_NAME"
    pm2 save
    echo "      ✓ PM2 process '$APP_NAME' started (baru)"
  fi
else
  # Fallback: kill node lama & start baru
  echo "      ⚠ PM2 tidak ditemukan, menggunakan node langsung..."
  pkill -f "node src/index.js" 2>/dev/null || true
  sleep 1
  nohup node src/index.js >> logs/server.log 2>&1 &
  echo "      ✓ Server berjalan (PID: $!)"
  echo "      ℹ Log: $APP_DIR/logs/server.log"
fi
echo ""

# ── 4. Status ─────────────────────────────────────────────────
echo "[4/4] Status:"
if command -v pm2 &> /dev/null; then
  pm2 list | grep "$APP_NAME" || echo "      (Cek dengan: pm2 status)"
else
  sleep 2
  if pgrep -f "node src/index.js" > /dev/null; then
    echo "      ✓ Server aktif (port 3001)"
  else
    echo "      ✗ Server gagal start — cek log: logs/server.log"
  fi
fi

echo ""
echo "============================================================"
echo "  Deploy selesai! ✓"
echo "============================================================"
echo ""
