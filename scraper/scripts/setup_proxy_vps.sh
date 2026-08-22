#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# setup_proxy_vps.sh — Configura WireGuard + proxy residencial en el VPS
#
# Arquitectura:
#   Cudy LT500 (SIM Digi ES) ←—WireGuard tunnel—→ VPS OVH (152.228.232.151)
#                                                         ↓
#                                          microsocks (SOCKS5 relay)
#                                          → scrapers usan socks5://10.8.0.2:1080
#
# El router (tras CGNAT de Digi) NO tiene IP pública → el VPS es el servidor WG
# y el router es el cliente. Todo el tráfico de scraping sale por la SIM Digi (IP ES).
#
# Uso (en el VPS, como root):
#   sudo bash setup_proxy_vps.sh
#
# Requisitos en el router:
#   - OpenWrt o SSH root access
#   - Instalar: wireguard-tools + microsocks (ver sección ROUTER al final del script)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
WG_PORT=51820
VPS_WG_IP="10.8.0.1"
ROUTER_WG_IP="10.8.0.2"
PROXY_PORT=1080           # microsocks en el router escucha en este puerto
WG_IFACE="wg0"
WG_DIR="/etc/wireguard"
SCRAPER_ENV="/home/ubuntu/scraper/.env"

echo ""
echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  FidesBot — Setup WireGuard + Proxy Residencial ES           ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# ── [1/6] Instalar WireGuard ──────────────────────────────────────────────────
echo "=== [1/6] Instalando WireGuard ==="
apt-get update -qq
apt-get install -y wireguard wireguard-tools 2>&1 | grep -E "(installed|upgraded|already)" || true

# ── [2/6] Generar claves del servidor (VPS) ───────────────────────────────────
echo "=== [2/6] Generando claves WireGuard VPS ==="
mkdir -p "$WG_DIR"
chmod 700 "$WG_DIR"

if [[ -f "$WG_DIR/server_private.key" ]]; then
  echo "  → Claves existentes, reutilizando."
else
  wg genkey | tee "$WG_DIR/server_private.key" | wg pubkey > "$WG_DIR/server_public.key"
  chmod 600 "$WG_DIR/server_private.key"
  echo "  → Claves generadas."
fi
SERVER_PRIV=$(cat "$WG_DIR/server_private.key")
SERVER_PUB=$(cat "$WG_DIR/server_public.key")

# ── [3/6] Generar claves del cliente (router) ────────────────────────────────
echo "=== [3/6] Generando claves WireGuard Router ==="
if [[ -f "$WG_DIR/router_private.key" ]]; then
  echo "  → Claves router existentes, reutilizando."
else
  wg genkey | tee "$WG_DIR/router_private.key" | wg pubkey > "$WG_DIR/router_public.key"
  chmod 600 "$WG_DIR/router_private.key"
  echo "  → Claves router generadas."
fi
ROUTER_PRIV=$(cat "$WG_DIR/router_private.key")
ROUTER_PUB=$(cat "$WG_DIR/router_public.key")

# ── [4/6] Crear config wg0 ────────────────────────────────────────────────────
echo "=== [4/6] Configurando wg0 en VPS ==="
cat > "$WG_DIR/$WG_IFACE.conf" << WGCONF
[Interface]
PrivateKey = ${SERVER_PRIV}
Address = ${VPS_WG_IP}/24
ListenPort = ${WG_PORT}

[Peer]
# Cudy LT500 (SIM Digi ES)
PublicKey = ${ROUTER_PUB}
AllowedIPs = ${ROUTER_WG_IP}/32
PersistentKeepalive = 25
WGCONF
chmod 600 "$WG_DIR/$WG_IFACE.conf"
echo "  → /etc/wireguard/wg0.conf creado."

# Habilitar IP forwarding
sysctl -w net.ipv4.ip_forward=1 > /dev/null
grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf || echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf

# Abrir puerto WG en UFW si está activo
if ufw status 2>/dev/null | grep -q "active"; then
  ufw allow "${WG_PORT}/udp" comment "WireGuard FidesBot proxy" 2>/dev/null || true
  echo "  → UFW: puerto ${WG_PORT}/udp abierto."
fi

# ── [5/6] Arrancar WireGuard ──────────────────────────────────────────────────
echo "=== [5/6] Arrancando WireGuard ==="
systemctl enable "wg-quick@${WG_IFACE}" --now 2>/dev/null || wg-quick up "$WG_IFACE" || {
  # ya estaba arriba → reload
  wg syncconf "$WG_IFACE" <(wg-quick strip "$WG_IFACE")
}
echo "  → WireGuard activo."

# ── [6/6] Actualizar .env del scraper ────────────────────────────────────────
echo "=== [6/6] Actualizando .env del scraper ==="
PROXY_URL="socks5://${ROUTER_WG_IP}:${PROXY_PORT}"
ALL_PROXY_VARS=(
  KAMBI_PROXY_URL
  ALTENAR_PROXY_URL
  SPORTIUM_PROXY_URL
  DAZNBET_PROXY_URL
  BET365_PROXY_URL
  BWIN_PROXY_URL
  WILLIAMHILL_PROXY_URL
  BETFAIR_PROXY_URL
  BETWAY_PROXY_URL
  INTERWETTEN_PROXY_URL
  BETANO_PROXY_URL
)

if [[ -f "$SCRAPER_ENV" ]]; then
  for VAR in "${ALL_PROXY_VARS[@]}"; do
    if grep -q "^${VAR}=" "$SCRAPER_ENV" 2>/dev/null; then
      sed -i "s|^${VAR}=.*|${VAR}=${PROXY_URL}|" "$SCRAPER_ENV"
    else
      echo "${VAR}=${PROXY_URL}" >> "$SCRAPER_ENV"
    fi
    echo "  → ${VAR}=${PROXY_URL}"
  done
  echo "  → .env actualizado."
else
  echo "  ⚠  No se encontró $SCRAPER_ENV — añade manualmente las variables de proxy."
fi

# ── Resumen final ─────────────────────────────────────────────────────────────
VPS_PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo "<obtén con: curl ifconfig.me>")

echo ""
echo "╔═══════════════════════════════════════════════════════════════════════╗"
echo "║  VPS configurado correctamente                                        ║"
echo "║  VPS IP pública  : ${VPS_PUBLIC_IP}"
echo "║  VPS WG IP       : ${VPS_WG_IP} (wg0)"
echo "║  Router WG IP    : ${ROUTER_WG_IP} (asignada al Cudy LT500)"
echo "║  Proxy SOCKS5    : socks5://${ROUTER_WG_IP}:${PROXY_PORT}"
echo "╚═══════════════════════════════════════════════════════════════════════╝"
echo ""
echo "═══════════════════════════════════════════════════════════════════════"
echo "  PASO SIGUIENTE: Configurar el router Cudy LT500"
echo "═══════════════════════════════════════════════════════════════════════"
echo ""
echo "1. En el router, instala WireGuard + microsocks (ver router_setup.md)."
echo ""
echo "2. Crea /etc/wireguard/wg0.conf en el ROUTER con este contenido:"
echo "   ────────────────────────────────────────────────────────────────"
cat << ROUTER_CONF

[Interface]
PrivateKey = ${ROUTER_PRIV}
Address = ${ROUTER_WG_IP}/24
DNS = 8.8.8.8

[Peer]
# VPS OVH — servidor WireGuard
PublicKey = ${SERVER_PUB}
Endpoint = ${VPS_PUBLIC_IP}:${WG_PORT}
AllowedIPs = ${VPS_WG_IP}/32
PersistentKeepalive = 25

ROUTER_CONF
echo "   ────────────────────────────────────────────────────────────────"
echo ""
echo "3. En el router, arranca microsocks en la interfaz wg0:"
echo "   microsocks -i ${ROUTER_WG_IP} -p ${PROXY_PORT} -d"
echo ""
echo "4. Arranca WireGuard en el router:"
echo "   wg-quick up wg0"
echo ""
echo "5. Verifica el proxy desde el VPS:"
echo "   curl --proxy socks5h://${ROUTER_WG_IP}:${PROXY_PORT} https://api.ipify.org"
echo "   → debe devolver la IP de la SIM Digi (IP española)"
echo ""
echo "6. Reinicia el scraper:"
echo "   pm2 restart fidesbot-scanner --update-env"
echo ""
echo "¡Listo! Cuando el Cudy LT500 conecte, todas las casas bloqueadas estarán activas."
