#!/usr/bin/env bash
# proxy_health.sh — Monitoriza el proxy SOCKS5 (microsocks en router vía WireGuard)
# PM2 lo reinicia si muere. Hace check cada 60s y manda alerta si el proxy cae.

ROUTER_WG_IP="10.8.0.2"
PROXY_PORT=1080
CHECK_INTERVAL=60
FAIL_COUNT=0
MAX_FAILS=3

check_proxy() {
  local ip
  ip=$(curl -s --max-time 8 --proxy "socks5h://${ROUTER_WG_IP}:${PROXY_PORT}" https://api.ipify.org 2>/dev/null)
  echo "$ip"
}

echo "[proxy-relay] Iniciando health check — socks5://${ROUTER_WG_IP}:${PROXY_PORT}"

while true; do
  RESULT=$(check_proxy)
  if [[ -n "$RESULT" ]]; then
    if [[ "$FAIL_COUNT" -gt 0 ]]; then
      echo "[proxy-relay] ✅ Proxy recuperado — IP: ${RESULT}"
    else
      echo "[proxy-relay] OK — IP pública: ${RESULT}"
    fi
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "[proxy-relay] ⚠️  Proxy no responde (fallo #${FAIL_COUNT}/${MAX_FAILS})"
    if [[ "$FAIL_COUNT" -ge "$MAX_FAILS" ]]; then
      echo "[proxy-relay] ❌ CRITICAL — proxy caído tras ${MAX_FAILS} fallos. Revisar router Cudy LT500."
      # PM2 reiniciará este script; el scraper recibirá errores de proxy en los logs
      exit 1
    fi
  fi
  sleep "$CHECK_INTERVAL"
done
