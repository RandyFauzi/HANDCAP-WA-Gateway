#!/bin/bash

echo "🔄 Pulling update terbaru..."
git pull origin main

echo "📦 Install dependency baru (jika ada)..."
npm install --omit=dev --silent

echo "🔁 Restart server..."
if command -v pm2 &> /dev/null; then
  pm2 restart handcap
else
  pkill -f "node src/index.js" 2>/dev/null || true
  sleep 1
  nohup node src/index.js >> logs/server.log 2>&1 &
fi

echo "✅ Update selesai!"
