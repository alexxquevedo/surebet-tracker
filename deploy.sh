#!/usr/bin/env bash
set -euo pipefail

SCRAPER_DIR="$HOME/scraper"
BOT_DIR="$HOME/surebet-tracker/bot"

echo "=== [1/4] Verificando compilación TypeScript ==="
cd "$SCRAPER_DIR"
npx tsc --noEmit
npm run build

echo "=== [2/4] Reiniciando proceso PM2: fidesbot-scanner ==="
pm2 restart fidesbot-scanner --update-env

echo "=== [3/4] Reiniciando proceso PM2: fidesbot ==="
cd "$BOT_DIR"
pm2 restart fidesbot --update-env

echo "=== [4/4] Estado y memoria ==="
free -h
pm2 status
