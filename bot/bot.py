import asyncio
import aiohttp
import logging
import json
import os
import uuid
from datetime import datetime, timedelta
from copy import deepcopy
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters
# Zona horaria local (España)
try:
    from zoneinfo import ZoneInfo as _ZI
    _TZ_MAD = _ZI("Europe/Madrid")
    def local_now():
        return datetime.now(_TZ_MAD).replace(tzinfo=None)
except Exception:
    def local_now():
        return datetime.now() + timedelta(hours=2)



# ============================================================
# CONFIGURACIÓN PRINCIPAL
# ============================================================
TELEGRAM_TOKEN   = "8467505098:AAEQfDx-TnSSitjVQwDbGHH8EdnPKajwyus"
ADMIN_ID         = 1207554638
ADMIN_IDS        = {1207554638, 2051653218}  # Todos los admins
PAGOS_GROUP_ID   = -5254902973
ODDS_API_KEY     = "250616a989efee88a4f31af49784c07e"
ODDS_API_BASE    = "https://api.the-odds-api.com/v4"
DB_FILE          = "/content/drive/MyDrive/fidesbot/bot_db.json"
BOT_USERNAME     = "perpleSurebetBot"

# ── DualStats Tracker ──────────────────────────────────────
DUALSTATS_API_URL = "https://dualstats-tracker.vercel.app/api/bot"
DUALSTATS_API_KEY = "f8c22003d898614fd5fe4df311785bd7e16b75599f30ec4d2f08416919ad13c0"
DUALSTATS_WEB_URL = "https://dualstats-tracker.vercel.app"

def ds_url(path: str = "", campaign: str = "") -> str:
    """Construye URL de DualStats con parámetros UTM para tracking de conversión bot→web."""
    params = f"?utm_source=fidesbot&utm_medium=bot&utm_campaign={campaign}" if campaign else ""
    return f"{DUALSTATS_WEB_URL}{path}{params}"

CREDITOS_INICIALES      = 5
CREDITOS_POR_REFERIDO   = 2
CREDITOS_POR_FREEBET    = 1

DEFAULT_USER_CONFIG = {
    "surebets_on": True, "middlebets_on": False, "valuebets_on": False,
    "surebets_live_on": True, "min_profit_surebet": 3.0,
    "min_profit_middle": 2.0, "min_prob_middle": 5.0, "min_profit_value": 5.0,
    "max_days": 2,
    "sports": {
        "soccer": True, "basketball_nba": True, "tennis": True,
        "americanfootball_nfl": True, "icehockey_nhl": True,
        "baseball_mlb": True, "rugbyleague": True, "cricket": True, "golf": True,
    },
    "bookmakers": {
        "bet365": True, "winamax": True, "pokerstars": True,
        "bwin": True, "betfair": True, "betsson": True, "leovegas": True,
        "marathonbet": True, "williamhill": True, "888sport": True,
        "codere": True, "sportium": True, "retabet": True,
    },
    "stake": 100.0,
}

BOT_CONFIG = {"scan_interval": 600}

# ============================================================
# ESTADO GLOBAL
# ============================================================
subscriptions    = {}
referrals        = {}
creditos         = {}
sent_surebets    = {}
SUREBET_TTL_HOURS = 2
last_surebet     = {}
ultimo_escaneo   = {}
stats = {
    "surebets_encontradas": 0, "middlebets_encontradas": 0,
    "valuebets_encontradas": 0, "ultima_actualizacion": None,
    "proxima_actualizacion": None,
}

# ── DualStats — nuevos estados ─────────────────────────────
pendientes           = {}   # {user_id: [lista de dicts]}
resultados_locales   = {}   # {user_id: [apuestas en PLACED pendientes de resultado]}
dualstats_vinculados = set() # conjunto de user_ids con DualStats vinculado
dualstats_plan       = {}   # {user_id: "PRO" | "PRO_TRACKER" | "ENTERPRISE"} — plan web del usuario
alerta_cache         = {}   # {"{uid}_{alert_id}": dict} — en memoria, se pierde al reiniciar
subscription_api_cache = {} # {user_id: {"subscribed": bool, "plan": str, "expiresAt": str|None, "daysLeft": int|None, "cached_at": datetime}}

# ============================================================
# MAPAS DE VISUALIZACIÓN
# ============================================================
SPORT_DISPLAY = {
    "soccer": ("⚽", "Fútbol"), "basketball_nba": ("🏀", "Baloncesto"),
    "tennis": ("🎾", "Tenis"), "americanfootball_nfl": ("🏈", "Fútbol Americano"),
    "icehockey_nhl": ("🏒", "Hockey Hielo"), "baseball_mlb": ("⚾", "Béisbol"),
    "rugbyleague": ("🏉", "Rugby"), "cricket": ("🏏", "Cricket"), "golf": ("⛳", "Golf"),
}
LEAGUE_MAP = {
    "soccer": "Fútbol", "basketball_nba": "NBA", "tennis": "ATP/WTA",
    "americanfootball_nfl": "NFL", "icehockey_nhl": "NHL", "baseball_mlb": "MLB",
    "rugbyleague": "Rugby League", "cricket": "Cricket", "golf": "Golf",
}
BOOKMAKER_NAMES = {
    "bet365": "Bet365", "winamax": "Winamax", "pokerstars": "PokerStars",
    "bwin": "Bwin", "betfair": "Betfair", "betsson": "Betsson", "leovegas": "LeoVegas",
    "marathonbet": "Marathonbet", "williamhill": "William Hill", "888sport": "888sport",
    "codere": "Codere", "sportium": "Sportium", "retabet": "Retabet",
}

CASAS_CLON = [
    {"kambi", "888sport", "leovegas", "betsson", "nordicbet", "unibet"},
    {"codere", "sportium"},
]

def son_casas_clon(bk1, bk2):
    for grupo in CASAS_CLON:
        if bk1 in grupo and bk2 in grupo:
            return True
    return False

BLOQUEADO_MSG = "⛔ Función solo disponible para usuarios suscritos.\n\nPulsa 💳 Suscribirse para activar tu cuenta."

SUSCRIPCION = """💳 *Suscribirse a FidesBot*
━━━━━━━━━━━━━━━━━━

📋 *¿Qué incluye cada plan?*

🆓 *FREE* — Gratis
  • Acceso básico al bot
  • Freebets y créditos
  • Sin alertas de surebets

💎 *PRO* — Alertas ilimitadas
  • ⚡ Alertas en tiempo real (surebets, middles, LIVE)
  • ⚙️ Configuración personalizada (casas, deportes, profit)
  • 🧮 Calculadora de stake automática

🔗 *PRO+Tracker* — PRO + web DualStats
  • Todo lo de PRO
  • ✅ Botones Hecha/No hecha en cada alerta
  • 📋 Registro automático en DualStats Tracker
  • 🏆 Estadísticas completas: ROI, P&L, win rate

━━━━━━━━━━━━━━━━━━
💰 *Precios:*
• PRO 1 semana: *17€*
• PRO 2 semanas: *25€*
• PRO 1 mes: *45€* _(1er mes 35€)_ 🎁
• PRO+Tracker 1 mes: *49,99€* _(1er mes 39,99€)_ 🎁

_🎁 Descuento aplicado automáticamente en tu primera compra_

━━━━━━━━━━━━━━━━━━
💳 *Pago seguro con Stripe*
Elige tu plan y pulsa el botón de pago.
Tu suscripción se activa *automáticamente* al completar el pago.

👇 *Elige tu plan:*"""

TERMINOS = """📋 *Términos y Condiciones — FidesBot*

_Última actualización: mayo 2026_

*1. Identificación del servicio*
FidesBot proporciona información sobre apuestas deportivas en tiempo real, incluyendo surebets, middlebets, valuebets y alertas en directo. No pertenece a ninguna casa de apuestas.

*2. Aceptación*
El uso implica aceptación plena de estos Términos.

*3. Requisitos*
Exclusivo para mayores de 18 años.

*4. Servicio*
FidesBot es una herramienta informativa. Las alertas en directo implican mayor volatilidad. La decisión de apostar es responsabilidad exclusiva del usuario.

⚠️ *No apuestes más dinero del que estés dispuesto a perder.*

*5. Condiciones económicas*
Reembolso en primeras 24h si no se ha hecho uso intensivo. Devolución proporcional si cesa el servicio.

*6. Prohibiciones*
Reventa, reenvío automático y compartir suscripciones están prohibidos. Incumplimiento: bloqueo permanente sin reembolso.

*7. Responsabilidad*
FidesBot no es asesor financiero. El usuario es responsable de sus apuestas.

*8. Contacto*
Contacta con el administrador a través del bot."""

SOPORTE_TEXTO = """🆘 *Soporte — FidesBot*
━━━━━━━━━━━━━━━━━━

📩 Escríbenos al administrador y te responderemos lo antes posible.

━━━━━━━━━━━━━━━━━━
📌 *Preguntas frecuentes:*

❓ *¿Cómo activo mi suscripción?*
Usa /id, realiza el pago con el concepto `FidesBot [tuID] 30D` y pulsa ✅ Ya he pagado.

❓ *¿Cómo funciona la calculadora de stake?*
Pulsa 🧮 Stake, introduce el importe total y el bot te dirá cuánto poner en cada casa.

❓ *¿Por qué no me llegan alertas?*
Comprueba en 🔔 Alertas que tienes activado lo que quieres, y en ⚙️ Configuración que el filtro de profit no sea demasiado alto.

❓ *¿Qué son los créditos?*
Los usuarios gratuitos tienen créditos para usar funciones premium. Ganas créditos invitando amigos (2 por referido) o reportando fallos al administrador.

❓ *¿Qué pasa si una cuota cambia antes de apostar?*
Si la cuota baja o se cierra el mercado, no entres. Es mejor perder la oportunidad que hacer una apuesta incompleta.

❓ *¿Cómo evito que las casas me limiten?*
1) Redondea las apuestas (47€ en vez de 47.32€).
2) No retires dinero constantemente.
3) Varía deportes y mercados.

❓ *¿Las alertas tienen en cuenta las reglas de cada casa?*
El bot filtra mercados compatibles, pero en Tenis las reglas por retirada varían. Revisa siempre los términos de cada casa.

━━━━━━━━━━━━━━━━━━"""

logging.basicConfig(format="%(asctime)s - %(levelname)s - %(message)s", level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================
# BASE DE DATOS — persistencia vía API (DualStats web)
# ============================================================
_db_dirty = False  # True cuando hay cambios pendientes de sincronizar

def guardar_db():
    """Marca el estado como sucio. Un job periódico lo sincroniza con la API."""
    global _db_dirty
    _db_dirty = True

def _parse_file_db(data: dict) -> tuple[dict, dict, dict]:
    """Parsea el JSON del fichero local → (subscriptions, referrals, creditos)."""
    subs = {}
    for uid_str, sub in data.get("subscriptions", {}).items():
        uid = int(uid_str)
        expires = datetime.fromisoformat(sub["expires"]) if sub.get("expires") else None
        cfg = sub.get("config", deepcopy(DEFAULT_USER_CONFIG))
        for k, v in DEFAULT_USER_CONFIG.items():
            if k not in cfg:
                cfg[k] = deepcopy(v)
        for bk in DEFAULT_USER_CONFIG["bookmakers"]:
            if bk not in cfg.get("bookmakers", {}):
                cfg.setdefault("bookmakers", {})[bk] = True
        subs[uid] = {"name": sub.get("name", str(uid)), "expires": expires, "config": cfg}
    refs  = {int(k): v for k, v in data.get("referrals", {}).items()}
    creds = {int(k): v for k, v in data.get("creditos", {}).items()}
    return subs, refs, creds

async def flush_to_api():
    """Envía el estado completo de subscriptions/credits/referrals a la API."""
    global _db_dirty
    if not subscriptions:
        return
    users = []
    for uid, sub in subscriptions.items():
        users.append({
            "telegramId":   str(uid),
            "telegramName": sub.get("name"),
            "plan":         dualstats_plan.get(uid, "PRO"),
            "expiresAt":    sub["expires"].isoformat() if sub.get("expires") else None,
            "config":       sub.get("config"),
            "credits":      creditos.get(uid, 0),
            "referredUsers": [str(x) for x in referrals.get(uid, [])],
            "referredBy":   None,
        })
    try:
        headers = {"x-bot-secret": DUALSTATS_API_KEY, "Content-Type": "application/json"}
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{DUALSTATS_API_URL}/users/sync",
                json={"users": users},
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                if resp.status == 200:
                    result = await resp.json()
                    logger.info(f"[DB] Sync OK — {result.get('synced', 0)} usuarios")
                    _db_dirty = False
                else:
                    logger.warning(f"[DB] Sync falló: HTTP {resp.status}")
    except Exception as e:
        logger.error(f"[DB] Error en flush_to_api: {e}")

async def cargar_db():
    """Carga estado desde la API. Si existe fichero local, lo migra primero."""
    global subscriptions, referrals, creditos
    global pendientes, resultados_locales, dualstats_vinculados, dualstats_plan

    # ── Migración one-time desde fichero local ──────────────
    file_subs, file_refs, file_creds = {}, {}, {}
    if os.path.exists(DB_FILE):
        try:
            with open(DB_FILE, "r", encoding="utf-8") as f:
                file_data = json.load(f)
            file_subs, file_refs, file_creds = _parse_file_db(file_data)
            # Pendientes/resultados del fichero (se usan en este arranque)
            pendientes         = {int(k): v for k, v in file_data.get("pendientes", {}).items()}
            resultados_locales = {int(k): v for k, v in file_data.get("resultados_locales", {}).items()}
            dualstats_vinculados = set(int(k) for k in file_data.get("dualstats_vinculados", []))
            dualstats_plan       = {int(k): v for k, v in file_data.get("dualstats_plan", {}).items()}
            logger.info(f"[DB] Fichero local encontrado: {len(file_subs)} usuarios — migrando a API…")
        except Exception as e:
            logger.error(f"[DB] Error leyendo fichero local: {e}")

    # ── Cargar desde la API ──────────────────────────────────
    api_ok = False
    try:
        headers = {"x-bot-secret": DUALSTATS_API_KEY}
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"{DUALSTATS_API_URL}/users",
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 200:
                    api_data = await resp.json()
                    api_ok = True

                    for sub in api_data.get("botSubscriptions", []):
                        uid  = int(sub["telegramId"])
                        exp_str = sub.get("expiresAt")
                        expires = None
                        if exp_str:
                            try:
                                expires = datetime.fromisoformat(exp_str.replace("Z", "+00:00")).replace(tzinfo=None)
                            except Exception:
                                pass
                        # Config: API primero, fichero como fallback
                        cfg = sub.get("config") or file_subs.get(uid, {}).get("config") or deepcopy(DEFAULT_USER_CONFIG)
                        for k, v in DEFAULT_USER_CONFIG.items():
                            if k not in cfg:
                                cfg[k] = deepcopy(v)
                        for bk in DEFAULT_USER_CONFIG["bookmakers"]:
                            if bk not in cfg.get("bookmakers", {}):
                                cfg.setdefault("bookmakers", {})[bk] = True
                        name = sub.get("telegramName") or file_subs.get(uid, {}).get("name", str(uid))
                        subscriptions[uid] = {"name": name, "expires": expires, "config": cfg}
                        creditos[uid]      = sub.get("credits") or file_creds.get(uid, 0)
                        if sub.get("referredUsers"):
                            referrals[uid] = [int(x) for x in sub["referredUsers"]]
                        elif uid in file_refs:
                            referrals[uid] = file_refs[uid]

                    for u in api_data.get("linkedUsers", []):
                        uid = int(u["telegramId"])
                        dualstats_vinculados.add(uid)
                        dualstats_plan[uid] = u["plan"]

                    logger.info(f"[DB] API cargada: {len(subscriptions)} suscripciones, {len(dualstats_vinculados)} vinculados")
    except Exception as e:
        logger.error(f"[DB] Error cargando desde API: {e}")

    # ── Fallback a fichero si API falló ──────────────────────
    if not api_ok and file_subs:
        subscriptions.update(file_subs)
        referrals.update(file_refs)
        creditos.update(file_creds)
        logger.warning("[DB] API no disponible — usando datos del fichero local")

    # ── Añadir usuarios del fichero que no están en la API ──
    for uid, sub in file_subs.items():
        if uid not in subscriptions:
            subscriptions[uid] = sub
            if uid in file_refs:  referrals[uid] = file_refs[uid]
            if uid in file_creds: creditos[uid]  = file_creds[uid]

    # ── Garantizar admins ────────────────────────────────────
    for admin_id in ADMIN_IDS:
        if admin_id not in subscriptions:
            subscriptions[admin_id] = {"name": "Admin", "expires": None, "config": deepcopy(DEFAULT_USER_CONFIG)}
            creditos[admin_id] = 999

    # ── Si había fichero local: sync a API y renombrar ───────
    if file_subs and api_ok:
        await flush_to_api()
        try:
            os.rename(DB_FILE, DB_FILE + ".migrated")
            logger.info(f"[DB] Fichero migrado → {DB_FILE}.migrated")
        except Exception as e:
            logger.error(f"[DB] No se pudo renombrar el fichero: {e}")

# ============================================================
# SUSCRIPCIONES Y CRÉDITOS
# ============================================================
async def refrescar_suscripcion(user_id: int):
    """Consulta la API web y actualiza el caché local de suscripción."""
    try:
        url = f"{DUALSTATS_API_URL}/subscription?telegram_id={user_id}"
        headers = {"x-bot-secret": DUALSTATS_API_KEY}
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    data["cached_at"] = datetime.now()
                    subscription_api_cache[user_id] = data
                    # Sincronizar con el dict local para compatibilidad
                    if data.get("subscribed"):
                        expires_str = data.get("expiresAt")
                        expires = None
                        if expires_str:
                            try:
                                expires = datetime.fromisoformat(expires_str.replace("Z", "+00:00")).replace(tzinfo=None)
                            except Exception:
                                pass
                        if user_id not in subscriptions:
                            subscriptions[user_id] = {"name": str(user_id), "expires": expires, "config": deepcopy(DEFAULT_USER_CONFIG)}
                        else:
                            subscriptions[user_id]["expires"] = expires
    except Exception as e:
        logger.error(f"Error refrescando suscripción API para {user_id}: {e}")

def tiene_suscripcion(user_id):
    # Primero consultar caché de API (TTL 5 min)
    cache = subscription_api_cache.get(user_id)
    if cache and (datetime.now() - cache["cached_at"]).seconds < 300:
        return cache.get("subscribed", False)
    # Fallback al dict local
    if user_id not in subscriptions: return False
    sub = subscriptions[user_id]
    if sub["expires"] is None: return True
    return sub["expires"] > datetime.now()

def dias_restantes(user_id):
    cache = subscription_api_cache.get(user_id)
    if cache and cache.get("subscribed") and cache.get("daysLeft") is not None:
        return cache["daysLeft"]
    if user_id not in subscriptions: return 0
    sub = subscriptions[user_id]
    if sub["expires"] is None: return 9999
    return max(0, (sub["expires"] - datetime.now()).days)

def get_config(user_id):
    if user_id in subscriptions: return subscriptions[user_id]["config"]
    return deepcopy(DEFAULT_USER_CONFIG)

def get_creditos(user_id): return creditos.get(user_id, 0)

def add_creditos(user_id, cantidad):
    creditos[user_id] = creditos.get(user_id, 0) + cantidad
    guardar_db()

def gastar_credito(user_id):
    if creditos.get(user_id, 0) <= 0: return False
    creditos[user_id] -= 1
    guardar_db()
    return True

def activar_usuario(user_id, nombre, dias):
    if user_id in subscriptions and subscriptions[user_id]["expires"] and subscriptions[user_id]["expires"] > datetime.now():
        subscriptions[user_id]["expires"] += timedelta(days=dias)
    else:
        subscriptions[user_id] = {
            "name": nombre,
            "expires": datetime.now() + timedelta(days=dias),
            "config": deepcopy(DEFAULT_USER_CONFIG),
        }
    if user_id not in creditos:
        creditos[user_id] = CREDITOS_INICIALES
    guardar_db()

def desactivar_usuario(user_id):
    if user_id in subscriptions and user_id not in ADMIN_IDS:
        del subscriptions[user_id]
        guardar_db()

def icono_suscripcion(dias):
    if dias == 9999: return "♾️"
    elif dias <= 5:  return "⚠️"
    return "🎫"

def get_ultimo_escaneo_str(user_id):
    if user_id not in ultimo_escaneo: return "nunca"
    delta = datetime.now() - ultimo_escaneo[user_id]
    mins = int(delta.total_seconds() / 60)
    if mins == 0:   return "hace <1 min"
    elif mins == 1: return "hace 1 min"
    return f"hace {mins} min"

# ============================================================
# TAREA FLUSH DB → API (cada 30s si hay cambios)
# ============================================================
async def tarea_flush_db(context: ContextTypes.DEFAULT_TYPE):
    if _db_dirty:
        await flush_to_api()

# ============================================================
# TAREA VERIFICAR SUSCRIPCIONES
# ============================================================
async def tarea_verificar_suscripciones(context: ContextTypes.DEFAULT_TYPE):
    for uid, sub in list(subscriptions.items()):
        if uid in ADMIN_IDS: continue
        if sub["expires"] and sub["expires"] <= datetime.now():
            try:
                await context.bot.send_message(chat_id=uid,
                    text="⚠️ *Tu suscripción a FidesBot ha caducado.*\n\nRenueva en /start → 💳 Suscribirse.",
                    parse_mode="Markdown")
            except: pass
    guardar_db()

# ============================================================
# ANTI-DUPLICADOS
# ============================================================
def clave_apuesta(event, apuesta, live, tipo="surebet"):
    legs_str = "_".join([f"{l['bookmaker']}{l['outcome']}{l['odd']}" for l in apuesta["legs"]])
    return f"{tipo}_{event['home_team']}_{event['away_team']}_{legs_str}_{'live' if live else 'pre'}"

def ya_enviada(clave):
    if clave not in sent_surebets: return False
    if datetime.now() - sent_surebets[clave] > timedelta(hours=SUREBET_TTL_HOURS):
        del sent_surebets[clave]; return False
    return True

def marcar_enviada(clave):
    sent_surebets[clave] = datetime.now()

# ============================================================
# CÁLCULO
# ============================================================
def calcular_surebet(odd1, odd2):
    if odd1 <= 1 or odd2 <= 1: return None
    implied = (1/odd1) + (1/odd2)
    if implied < 1.0:
        profit = ((1/implied) - 1) * 100
        return {"profit": round(profit,2),
                "stake1_pct": round((1/odd1)/implied*100,2),
                "stake2_pct": round((1/odd2)/implied*100,2)}
    return None

def calcular_middlebet(odd1, odd2, line1, line2):
    if line1 is None or line2 is None: return None
    gap = abs(line1 - line2)
    if gap <= 0: return None
    implied = (1/odd1) + (1/odd2)
    profit_base = ((1/implied) - 1) * 100
    prob_middle = min(gap * 8.5, 99.0)
    profit_max  = profit_base + (gap * odd1 * 2)
    return {"profit_base": round(profit_base,2), "profit_max": round(profit_max,2),
            "prob_middle": round(prob_middle,2), "gap": round(gap,1),
            "stake1_pct": round((1/odd1)/implied*100,2),
            "stake2_pct": round((1/odd2)/implied*100,2)}

def encontrar_apuestas(event, active_bookmakers, buscar_middles=False):
    apuestas = []
    outcomes_map = {}
    for bookmaker in event.get("bookmakers", []):
        if bookmaker["key"] not in active_bookmakers: continue
        for market in bookmaker.get("markets", []):
            market_key = market["key"]
            if market_key not in ["h2h", "totals"]: continue
            for outcome in market.get("outcomes", []):
                name = outcome["name"]
                key  = f"{market_key}_{name}"
                if key not in outcomes_map: outcomes_map[key] = []
                outcomes_map[key].append({
                    "bookmaker_title": bookmaker["title"],
                    "bookmaker_key":   bookmaker["key"],
                    "price":           outcome["price"],
                    "description":     outcome.get("description",""),
                    "point":           outcome.get("point", None),
                })
    h2h_names = list(set(k.replace("h2h_","") for k in outcomes_map if k.startswith("h2h_")))
    if len(h2h_names) == 2:
        e1 = outcomes_map.get(f"h2h_{h2h_names[0]}", [])
        e2 = outcomes_map.get(f"h2h_{h2h_names[1]}", [])
        if e1 and e2:
            b1 = max(e1, key=lambda x: x["price"])
            b2 = max(e2, key=lambda x: x["price"])
            if not son_casas_clon(b1["bookmaker_key"], b2["bookmaker_key"]):
                result = calcular_surebet(b1["price"], b2["price"])
                if result:
                    apuestas.append({"tipo":"surebet","profit":result["profit"],"legs":[
                        {"bookmaker":b1["bookmaker_title"],"outcome":h2h_names[0],
                         "odd":b1["price"],"stake_pct":result["stake1_pct"],
                         "point":b1["point"],"description":b1["description"]},
                        {"bookmaker":b2["bookmaker_title"],"outcome":h2h_names[1],
                         "odd":b2["price"],"stake_pct":result["stake2_pct"],
                         "point":b2["point"],"description":b2["description"]},
                    ]})
    if buscar_middles:
        overs  = outcomes_map.get("totals_Over", [])
        unders = outcomes_map.get("totals_Under", [])
        for oe in overs:
            for ue in unders:
                if oe["bookmaker_key"] != ue["bookmaker_key"] and oe["point"] and ue["point"] and oe["point"] != ue["point"]:
                    result = calcular_middlebet(oe["price"], ue["price"], oe["point"], ue["point"])
                    if result and result["gap"] >= 0.5:
                        apuestas.append({"tipo":"middlebet",
                            "profit_base":result["profit_base"],"profit_max":result["profit_max"],
                            "prob_middle":result["prob_middle"],"gap":result["gap"],
                            "profit":result["profit_base"],"legs":[
                            {"bookmaker":oe["bookmaker_title"],"outcome":"Over",
                             "odd":oe["price"],"stake_pct":result["stake1_pct"],"point":oe["point"],"description":""},
                            {"bookmaker":ue["bookmaker_title"],"outcome":"Under",
                             "odd":ue["price"],"stake_pct":result["stake2_pct"],"point":ue["point"],"description":""},
                        ]}); break
    return apuestas

def formatear_outcome(leg):
    outcome = leg["outcome"]; point = leg["point"]; desc = leg["description"]
    if point is not None:
        signo = "+" if point >= 0 else ""
        if desc: return f"{desc} {signo}{point} {outcome.lower()}"
        return f"{outcome} {signo}{point}"
    return outcome

def redondear_stake(amount):
    entero = int(amount); decimal = amount - entero
    if decimal < 0.25:  return float(entero)
    elif decimal < 0.75: return entero + 0.5
    else: return float(entero + 1)

def fmt_eur(v: float) -> str:
    """Formatea un importe: sin decimales si es entero, 2 decimales si no."""
    try:
        v = float(v)
        if abs(v - round(v)) < 0.001:
            return str(int(round(v)))
        return f"{v:.2f}"
    except Exception:
        return str(v)

def calcular_stakes(total, legs):
    lineas = []; total_redondeado = 0; stakes_redondeados = []
    for leg in legs:
        stake_exacto    = total * leg["stake_pct"] / 100
        stake_redondeado = redondear_stake(stake_exacto)
        stakes_redondeados.append(stake_redondeado)
        total_redondeado += stake_redondeado
    ganancia = round(stakes_redondeados[0] * legs[0]["odd"] - total_redondeado, 2)
    for i, leg in enumerate(legs):
        stake = stakes_redondeados[i]
        stake_str = f"{stake:.0f}" if stake == int(stake) else f"{stake:.1f}"
        lineas.append(f"📕 *{leg['bookmaker']}*\n   📍 {formatear_outcome(leg)}\n   🎲 Cuota: @{leg['odd']}\n   💶 Pon: *{stake_str}€*\n")
    return (f"🧮 *Distribución para {total}€*\n━━━━━━━━━━━━━━━━━━\n"
            + "\n".join(lineas)
            + f"━━━━━━━━━━━━━━━━━━\n💰 Ganancia garantizada: *~{ganancia}€*")

# ============================================================
# FETCH Y ESCANEO
# ============================================================
async def fetch_odds(sport_key, live=False):
    url = (f"{ODDS_API_BASE}/sports/{sport_key}/odds"
           f"?apiKey={ODDS_API_KEY}&regions=eu&markets=h2h,totals"
           f"&oddsFormat=decimal&inPlay={'true' if live else 'false'}")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                return await resp.json() if resp.status == 200 else []
    except Exception as e:
        logger.error(f"Error {sport_key}: {e}"); return []

def construir_mensaje_surebet(event, ap, sport_key, live):
    profit = ap["profit"]
    emoji, nombre_deporte = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
    liga = event.get("sport_title", LEAGUE_MAP.get(sport_key, ""))
    try: fecha_str = datetime.fromisoformat(event["commence_time"].replace("Z","")).strftime("%d/%m %H:%M")
    except: fecha_str = "??/??"
    cabecera  = f"💵 Beneficio: {profit}% - {profit}%\n📢 Alerta Surebets!{' 🎥 LIVE' if live else ''}"
    lineas    = "".join([f"📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']} 💰 {l['stake_pct']}%\n" for l in ap["legs"]])
    timestamp = local_now().strftime("%H:%M:%S")
    return (f"{cabecera}\n\n💎 Profit: {profit:.2f}%\n{emoji} {nombre_deporte} — {liga}\n"
            f"🗓️ {fecha_str}{' 🎥 LIVE' if live else ''}\n"
            f"🏆 {event['home_team']} – {event['away_team']}\n{lineas}"
            f"⏰ Generada a las {timestamp} — actúa rápido")

def construir_mensaje_middle(event, ap, sport_key, live):
    emoji, nombre_deporte = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
    liga = event.get("sport_title", LEAGUE_MAP.get(sport_key, ""))
    try: fecha_str = datetime.fromisoformat(event["commence_time"].replace("Z","")).strftime("%d/%m %H:%M")
    except: fecha_str = "??/??"
    lineas = "".join([f"📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']} 💰 {l['stake_pct']}%\n" for l in ap["legs"]])
    return (f"👑 Valor Esperado: MAX - MAX\n📢 Alerta Middlebets!{' 🎥 LIVE' if live else ''}\n\n"
            f"💎 Valor esperado: MAX (Sin riesgo)\n"
            f"📉 Mín. {ap['profit_base']:.2f}% | 📈 Máx. {ap['profit_max']:.2f}%\n"
            f"🍀 Probabilidad middle: {ap['prob_middle']:.2f}%\n\n"
            f"{emoji} {nombre_deporte} — {liga}\n🗓️ {fecha_str}\n"
            f"🏆 {event['home_team']} – {event['away_team']}\n{lineas}")

async def escanear_y_alertar(app, live=False, user_ids=None):
    global stats
    all_sports = set()
    targets    = user_ids or list(subscriptions.keys())
    for uid in targets:
        if not tiene_suscripcion(uid): continue
        cfg = get_config(uid)
        for sport, active in cfg["sports"].items():
            if active: all_sports.add(sport)
    if not all_sports: return 0
    total_surebets = 0; total_middles = 0
    now = datetime.utcnow()
    for sport_key in all_sports:
        events = await fetch_odds(sport_key, live=live)
        for event in events:
            try: commence = datetime.fromisoformat(event["commence_time"].replace("Z",""))
            except: commence = None
            for uid in targets:
                if not tiene_suscripcion(uid): continue
                cfg = get_config(uid)
                if not cfg["sports"].get(sport_key, False): continue
                if commence and not live:
                    if (commence - now).days > cfg["max_days"]: continue
                active_bks    = [k for k, v in cfg["bookmakers"].items() if v]
                buscar_middles = cfg.get("middlebets_on", False)
                apuestas = encontrar_apuestas(event, active_bks, buscar_middles)
                for ap in apuestas:
                    tipo = ap["tipo"]
                    if tipo == "surebet":
                        if not cfg.get("surebets_on", True): continue
                        if live and not cfg.get("surebets_live_on", True): continue
                        if ap["profit"] < cfg.get("min_profit_surebet", 3.0): continue
                        mensaje = construir_mensaje_surebet(event, ap, sport_key, live)
                        total_surebets += 1
                    elif tipo == "middlebet":
                        if not buscar_middles: continue
                        if ap["profit_base"] < cfg.get("min_profit_middle", 2.0): continue
                        if ap["prob_middle"]  < cfg.get("min_prob_middle", 5.0): continue
                        mensaje = construir_mensaje_middle(event, ap, sport_key, live)
                        total_middles += 1
                    else: continue
                    clave = f"{uid}_{clave_apuesta(event, ap, live, tipo)}"
                    if ya_enviada(clave): continue
                    marcar_enviada(clave)
                    ultimo_escaneo[uid] = datetime.now()
                    # ── Keyboard para usuarios con DualStats PRO_TRACKER ─
                    kb = None
                    if uid in dualstats_vinculados and tiene_tracker(uid):
                        alert_id  = uuid.uuid4().hex[:12]
                        cache_key = f"{uid}_{alert_id}"
                        alerta_cache[cache_key] = {
                            "evento":     f"{event['home_team']} – {event['away_team']}",
                            "sport_key":  sport_key,
                            "liga":       event.get("sport_title", LEAGUE_MAP.get(sport_key,"")),
                            "legs":       ap["legs"],
                            "profit":     ap["profit"],
                            "stake_sug":  cfg.get("stake", 100.0),
                            "tipo":       tipo,
                            "live":       live,
                            "mensaje":    mensaje,
                            "ts":         local_now().isoformat(),
                            "time":       event.get("commence_time", ""),
                        }
                        kb = InlineKeyboardMarkup([[
                            InlineKeyboardButton("✅ Hecha",    callback_data=f"AH_{uid}_{alert_id}"),
                            InlineKeyboardButton("❌ No hecha", callback_data=f"ANH_{uid}_{alert_id}"),
                        ]])
                    try:
                        sent = await app.bot.send_message(chat_id=uid, text=mensaje, reply_markup=kb)
                        # Guardar message_id para poder editar luego
                        if kb and cache_key in alerta_cache:
                            alerta_cache[cache_key]["msg_id"] = sent.message_id
                        last_surebet[uid] = ap
                        await asyncio.sleep(0.1)
                    except Exception as e:
                        logger.error(f"Error enviando a {uid}: {e}")
    if not user_ids:
        stats["surebets_encontradas"]  = total_surebets
        stats["middlebets_encontradas"] = total_middles
        stats["ultima_actualizacion"]   = datetime.now()
        stats["proxima_actualizacion"]  = datetime.now() + timedelta(seconds=BOT_CONFIG["scan_interval"])
    logger.info(f"Escaneo {'LIVE' if live else 'PRE'}: {total_surebets} surebets, {total_middles} middles")
    return total_surebets + total_middles

async def tarea_escaneo(context: ContextTypes.DEFAULT_TYPE):
    await escanear_y_alertar(context.application, live=False)
    await escanear_y_alertar(context.application, live=True)

# ============================================================
# MENÚ NO SUSCRITO
# ============================================================
async def menu_no_suscrito(update):
    keyboard = [
        [InlineKeyboardButton("💎 Surebets 🔒", callback_data="bloqueado"),
         InlineKeyboardButton("🎯 Middlebets 🔒", callback_data="bloqueado")],
        [InlineKeyboardButton("📊 Valuebets 🔒", callback_data="bloqueado"),
         InlineKeyboardButton("🎁 Freebets", callback_data="panel_freebets")],
        [InlineKeyboardButton("🔔 Alertas 🔒", callback_data="bloqueado"),
         InlineKeyboardButton("⚙️ Configuración 🔒", callback_data="bloqueado")],
        [InlineKeyboardButton("🔍 Escanear 🔒", callback_data="bloqueado"),
         InlineKeyboardButton("🧮 Stake 🔒", callback_data="bloqueado")],
        [InlineKeyboardButton("💰 Créditos", callback_data="mis_creditos"),
         InlineKeyboardButton("👥 Referidos", callback_data="mis_referidos")],
        [InlineKeyboardButton("🆘 Soporte / FAQ", callback_data="soporte"),
         InlineKeyboardButton("📋 TyC", callback_data="tyc")],
        [InlineKeyboardButton("💳 Suscribirse", callback_data="suscribirse")],
    ]
    texto = (
        "🤖 *FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        "🎫 Suscripción: *NO* ❌\n"
        "━━━━━━━━━━━━━━━━━━\n"
        "• 💎 Surebets 🔒\n• 🎯 Middlebets 🔒\n• 📊 Valuebets 🔒\n• ⚡ LIVE 🔒\n"
        "━━━━━━━━━━━━━━━━━━\n"
        "_Suscríbete para acceder a todas las funciones._\n"
        "Usa /id para obtener tu ID de Telegram."
    )
    if hasattr(update, "callback_query") and update.callback_query:
        await update.callback_query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    else:
        await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ============================================================
# COMANDOS
# ============================================================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user    = update.effective_user
    user_id = user.id
    args    = context.args

    # ── Vinculación DualStats (token CONNECT_xxxx) ─────────
    if args and args[0].startswith("CONNECT_"):
        token = args[0][len("CONNECT_"):]
        await cmd_procesar_token_vinculacion(update, context, user_id, user, token)
        return

    # ── Referido normal ────────────────────────────────────
    if args and args[0].isdigit():
        ref_id = int(args[0])
        if ref_id != user_id and ref_id in subscriptions:
            if ref_id not in referrals: referrals[ref_id] = []
            if user_id not in referrals[ref_id]:
                referrals[ref_id].append(user_id)
                add_creditos(ref_id, CREDITOS_POR_REFERIDO)
                if user_id not in creditos:
                    creditos[user_id] = CREDITOS_INICIALES; guardar_db()
                try:
                    await context.bot.send_message(chat_id=ref_id,
                        text=f"🔗 *Nuevo referido*\n{user.full_name} se unió con tu link.\n+{CREDITOS_POR_REFERIDO} créditos añadidos.",
                        parse_mode="Markdown")
                    await context.bot.send_message(chat_id=ADMIN_ID,
                        text=f"🔗 *Nuevo referido*\n{user.full_name} (ID: `{user_id}`) por ID `{ref_id}`",
                        parse_mode="Markdown")
                except: pass

    if user_id not in creditos:
        creditos[user_id] = CREDITOS_INICIALES; guardar_db()
    if not tiene_suscripcion(user_id):
        await menu_no_suscrito(update); return
    await menu_principal(update, context)

async def cmd_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    uid = update.effective_user.id
    await update.message.reply_text(
        f"🪪 *Tu ID de Telegram:*\n`{uid}`\n\n"
        f"📌 Concepto de pago: `FidesBot {uid} 30D`\n\n"
        "Dáselo al administrador para activar tu suscripción.",
        parse_mode="Markdown")

async def cmd_terms(update: Update, context: ContextTypes.DEFAULT_TYPE):
    volver = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.message.reply_text(TERMINOS,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    volver = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.message.reply_text(SOPORTE_TEXTO,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    ahora   = datetime.now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    casas_str   = "\n".join([f" • 🟢 {n}: Activa" for n in BOOKMAKER_NAMES.values()])
    total_subs  = len([u for u in subscriptions if tiene_suscripcion(u)])
    await update.message.reply_text(
        f"🤖 *Estado de FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"📡 *General:*\n • ✅ Servicio operativo\n"
        f" • ⏱️ Próx. actualización: {proxima}\n"
        f" • 👥 Suscriptores activos: {total_subs}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📡 *Casas monitorizadas:*\n{casas_str}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💎 Surebets: *{stats['surebets_encontradas']}* ⏳ {ultima}\n"
        f"🎯 Middlebets: *{stats['middlebets_encontradas']}* ⏳ {ultima}\n"
        f"📊 Valuebets: *{stats['valuebets_encontradas']}* ⏳ {ultima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"🆕 {ahora.strftime('%d/%m/%Y %H:%M')}\n"
        f"⏱️ Próx. informe: {proxima}\n"
        f"⚠️ Actualizado cada ~{BOT_CONFIG['scan_interval']//60} min",
        parse_mode="Markdown")

# ============================================================
# PANEL PRINCIPAL
# ============================================================
async def menu_principal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not tiene_suscripcion(user_id):
        await menu_no_suscrito(update); return
    cfg    = get_config(user_id)
    nombre = subscriptions.get(user_id, {}).get("name", "Usuario")
    dias   = dias_restantes(user_id)
    stake  = cfg.get("stake", 100.0)
    icono_sub = icono_suscripcion(dias)
    ultimo    = get_ultimo_escaneo_str(user_id)
    if dias == 9999:
        dias_str_completo = "∞ días restantes"
    else:
        expires_dt = subscriptions.get(user_id, {}).get("expires")
        fecha_str  = expires_dt.strftime("%d/%m/%y %H:%M") if expires_dt else "—"
        dias_str_completo = f"{dias} días restantes\n🗓️ Termina {fecha_str}"
    aviso = f"\n⚠️ *¡Suscripción caduca en {dias} días!* Renueva pronto." if dias != 9999 and dias <= 5 else ""

    # ── Botón DualStats con estado ─────────────────────────
    ds_label = "📈 DualStats ✅" if user_id in dualstats_vinculados else "📈 DualStats"

    keyboard = [
        [InlineKeyboardButton("💎 Surebets",  callback_data="panel_surebets"),
         InlineKeyboardButton("🎯 Middlebets", callback_data="panel_middles")],
        [InlineKeyboardButton("📊 Valuebets", callback_data="panel_valuebets"),
         InlineKeyboardButton("🎁 Freebets",  callback_data="panel_freebets")],
        [InlineKeyboardButton("🔔 Alertas",    callback_data="menu_alertas"),
         InlineKeyboardButton("⚙️ Configuración", callback_data="menu_config")],
        [InlineKeyboardButton(f"🔍 Escanear ({ultimo})", callback_data="escanear_ahora"),
         InlineKeyboardButton(f"🧮 Stake: {stake}€",     callback_data="set_stake")],
        [InlineKeyboardButton(ds_label,               callback_data="panel_dualstats"),
         InlineKeyboardButton(f"{icono_sub} Mi cuenta", callback_data="ver_estado")],
        [InlineKeyboardButton("👥 Referidos",    callback_data="mis_referidos"),
         InlineKeyboardButton("💰 Créditos",     callback_data="mis_creditos")],
        [InlineKeyboardButton("🆘 Soporte / FAQ", callback_data="soporte"),
         InlineKeyboardButton("📋 TyC",           callback_data="tyc")],
        [InlineKeyboardButton("💳 Suscribirse",   callback_data="suscribirse")],
    ]
    surebets_icon = "✅" if cfg.get("surebets_on", True) else "❌"
    middles_icon  = "✅" if cfg.get("middlebets_on", False) else "❌"
    valuebets_icon = "✅" if cfg.get("valuebets_on", False) else "❌"
    live_icon     = "✅" if cfg.get("surebets_live_on", True) else "❌"
    texto = (
        f"🤖 *FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"👤 *{nombre}* — {icono_sub} *{dias_str_completo}*\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"• 💎 Surebets {surebets_icon}\n• 🎯 Middlebets {middles_icon}\n"
        f"• 📊 Valuebets {valuebets_icon}\n• ⚡ LIVE {live_icon}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💵 Profit Surebet: *{cfg.get('min_profit_surebet',3.0)}%*\n"
        f"🎯 Profit Middle: *{cfg.get('min_profit_middle',2.0)}%* | Prob: *{cfg.get('min_prob_middle',5.0)}%*\n"
        f"📊 Profit Value: *{cfg.get('min_profit_value',5.0)}%*\n"
        f"🧮 Stake: *{stake}€* | 📆 Pre-partido: Máx. *{cfg['max_days']} días*\n"
        f"🏅 Deportes: *{sum(cfg['sports'].values())}/{len(cfg['sports'])}* | "
        f"🏦 Casas: *{sum(cfg['bookmakers'].values())}/{len(cfg['bookmakers'])}*\n"
        f"━━━━━━━━━━━━━━━━━━{aviso}"
    )
    if update.callback_query:
        await update.callback_query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    else:
        await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ============================================================
# PANELES ESTADÍSTICAS (sin cambios)
# ============================================================
async def panel_surebets(update, context):
    await update.callback_query.answer()
    ahora   = datetime.now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    await update.callback_query.edit_message_text(
        f"💎 *Panel Surebets*\n━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ Actualizado cada ~{BOT_CONFIG['scan_interval']//60} min\n\n"
        f"💎 Nº Surebets: *{stats['surebets_encontradas']}* ⏳ Act: {ultima}\n"
        f"🕐 Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Información:*\n• Garantizan beneficio sin riesgo mediante arbitraje.\n"
        f"• El bot detecta diferencias de cuotas entre casas.\n"
        f"• Revisa siempre las cuotas antes de apostar.\n\n"
        f"⚠️ *Atención:*\n• Puede haber datos ligeramente desactualizados.\n"
        f"━━━━━━━━━━━━━━━━━━\n🆕 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="menu_principal")]]),
        parse_mode="Markdown")

async def panel_middles(update, context):
    await update.callback_query.answer()
    ahora   = datetime.now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    await update.callback_query.edit_message_text(
        f"🎯 *Panel Middlebets*\n━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ Actualizado cada ~{BOT_CONFIG['scan_interval']//60} min\n\n"
        f"🎯 Nº Middlebets: *{stats['middlebets_encontradas']}* ⏳ Act: {ultima}\n"
        f"🕐 Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Información:*\n• Zona donde ganas las dos apuestas a la vez.\n"
        f"• Si el resultado cae en el middle, ganas las DOS apuestas.\n"
        f"• Riesgo 0 — matemáticamente superior a una surebet.\n\n"
        f"⚠️ *Atención:*\n• La probabilidad del middle es una estimación.\n"
        f"━━━━━━━━━━━━━━━━━━\n🆕 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="menu_principal")]]),
        parse_mode="Markdown")

async def panel_valuebets(update, context):
    await update.callback_query.answer()
    ahora   = datetime.now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    volver  = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.callback_query.edit_message_text(
        f"📊 *Panel Valuebets*\n━━━━━━━━━━━━━━━━━━\n"
        f"📊 Nº Valuebets: *{stats['valuebets_encontradas']}* ⏳ Act: {ultima}\n"
        f"🕐 Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Información:*\n• Apuestas con valor esperado positivo a largo plazo.\n"
        f"• No garantizan ganancia en cada apuesta individual.\n"
        f"• Requieren volumen para ver beneficio consistente.\n\n"
        f"⚠️ *Próximamente disponible.*\n"
        f"━━━━━━━━━━━━━━━━━━\n🆕 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def panel_freebets(update, context):
    await update.callback_query.answer()
    user_id = update.effective_user.id
    creds   = get_creditos(user_id)
    volver  = "menu_principal" if tiene_suscripcion(user_id) else "menu_no_suscrito"
    casas   = list(BOOKMAKER_NAMES.items())
    keyboard = []
    for i in range(0, len(casas), 2):
        fila = [InlineKeyboardButton(nombre, callback_data=f"freebet_casa_{key}") for key, nombre in casas[i:i+2]]
        keyboard.append(fila)
    keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data=volver)])
    await update.callback_query.edit_message_text(
        f"🎁 *Freebets*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"💰 Tus créditos: *{creds}*\n━━━━━━━━━━━━━━━━━━\n"
        f"🔥 Convierte Freebets en dinero real.\n✅ Ej: 100€ de Freebets → +60€ reales.\n\n"
        f"💡 *Información:*\n• Elige la casa donde tengas Freebets.\n"
        f"• Cada búsqueda cuesta *1 crédito*.\n• Los suscriptores no gastan créditos.\n\n"
        f"⚠️ *Elige la casa donde tengas Freebets:*",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def freebet_casa_seleccionada(update, context, casa_key):
    await update.callback_query.answer()
    user_id = update.effective_user.id
    casa_nombre = BOOKMAKER_NAMES.get(casa_key, casa_key)
    if not tiene_suscripcion(user_id):
        if not gastar_credito(user_id):
            await update.callback_query.edit_message_text(
                f"❌ *Sin créditos suficientes*\n\nNecesitas al menos 1 crédito.\n\n"
                f"💡 Gana créditos invitando amigos (+{CREDITOS_POR_REFERIDO} créditos)\nO suscríbete para acceso ilimitado 💳",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("👥 Mis referidos", callback_data="mis_referidos")],
                    [InlineKeyboardButton("💳 Suscribirse",   callback_data="suscribirse")],
                    [InlineKeyboardButton("🔙 Volver",        callback_data="panel_freebets")],
                ]), parse_mode="Markdown"); return
    creds = get_creditos(user_id)
    await update.callback_query.edit_message_text(
        f"🎁 *Freebets — {casa_nombre}*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"🏦 Casa implicada: *{casa_nombre}*\n\n"
        f"_Esta función está en desarrollo._\n"
        f"_Próximamente aparecerán aquí las mejores oportunidades para convertir tus freebets._\n\n"
        f"💰 Créditos restantes: *{creds}*",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="panel_freebets")]]),
        parse_mode="Markdown")

# ============================================================
# REFERIDOS Y CRÉDITOS
# ============================================================
async def mis_referidos(update, context):
    await update.callback_query.answer()
    user_id  = update.effective_user.id
    mis_refs = referrals.get(user_id, [])
    link     = f"https://t.me/{BOT_USERNAME}?start={user_id}"
    volver   = "menu_principal" if tiene_suscripcion(user_id) else "menu_no_suscrito"
    await update.callback_query.edit_message_text(
        f"👥 *Programa de referidos*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"📨 Personas invitadas: *{len(mis_refs)}*\n"
        f"💰 Créditos ganados: *{len(mis_refs)*CREDITOS_POR_REFERIDO}*\n\n"
        f"📱 *Tu enlace de referido:*\n{link}\n\n"
        f"💡 *Información:*\n• Comparte tu enlace con amigos.\n"
        f"• Al registrarse, recibiréis *{CREDITOS_POR_REFERIDO} créditos* cada uno.\n"
        f"• Sin límite de referidos.\n━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("📤 Compartir invitación",
                url=f"https://t.me/share/url?url={link}&text=Únete%20a%20FidesBot%20y%20gana%20créditos%20gratis!")],
            [InlineKeyboardButton("🔙 Volver", callback_data=volver)],
        ]), parse_mode="Markdown")

async def mis_creditos(update, context):
    await update.callback_query.answer()
    user_id = update.effective_user.id
    creds   = get_creditos(user_id)
    suscrito = tiene_suscripcion(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"
    await update.callback_query.edit_message_text(
        f"💰 *Tu saldo y estado*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"💰 Créditos: *{creds}*\n"
        f"💎 Suscripción: {'✅ ACTIVA' if suscrito else '❌ INACTIVA'}\n\n"
        f"💡 *Información:*\n• Disponible para usuarios gratuitos.\n"
        f"• Cada búsqueda de Freebets cuesta *1 crédito*.\n"
        f"• Los suscriptores no gastan créditos.\n"
        f"• Los créditos no caducan.\n"
        f"• Gana créditos con los referidos (+{CREDITOS_POR_REFERIDO} por referido).\n"
        f"━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("👥 Mis referidos", callback_data="mis_referidos")],
            [InlineKeyboardButton("💳 Suscribirse",   callback_data="suscribirse")],
            [InlineKeyboardButton("🔙 Volver",        callback_data=volver)],
        ]), parse_mode="Markdown")

# ============================================================
# MENÚ ALERTAS
# ============================================================
async def menu_alertas(update, context):
    await update.callback_query.answer()
    cfg = get_config(update.effective_user.id)
    s = cfg.get("surebets_on", True);  m = cfg.get("middlebets_on", False)
    v = cfg.get("valuebets_on", False); l = cfg.get("surebets_live_on", True)
    await update.callback_query.edit_message_text(
        f"🔔 *Alertas*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"• 💎 Surebets: {'✅ ON' if s else '❌ OFF'}\n  Arbitraje puro. Ganancia garantizada.\n\n"
        f"• 🎯 Middlebets: {'✅ ON' if m else '❌ OFF'}\n  Siempre ganas algo. Si cae en el middle, ganas las dos.\n\n"
        f"• 📊 Valuebets: {'✅ ON' if v else '❌ OFF'}\n  Apuestas con valor esperado positivo.\n\n"
        f"• ⚡ LIVE: {'✅ ON' if l else '❌ OFF'}\n  Alertas durante el partido en directo.\n\n"
        "━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(f"💎 Surebets {'✅' if s else '❌'}",   callback_data="toggle_surebets")],
            [InlineKeyboardButton(f"🎯 Middlebets {'✅' if m else '❌'}", callback_data="toggle_middles")],
            [InlineKeyboardButton(f"📊 Valuebets {'✅' if v else '❌'}",  callback_data="toggle_valuebets")],
            [InlineKeyboardButton(f"⚡ LIVE {'✅' if l else '❌'}",        callback_data="toggle_live")],
            [InlineKeyboardButton("✅ Activar todas",    callback_data="alertas_todas"),
             InlineKeyboardButton("❌ Desactivar todas", callback_data="alertas_ninguna")],
            [InlineKeyboardButton("🔙 Volver al panel",  callback_data="menu_principal")],
        ]), parse_mode="Markdown")

# ============================================================
# MENÚ CONFIGURACIÓN
# ============================================================
async def menu_config(update, context):
    await update.callback_query.answer()
    cfg = get_config(update.effective_user.id)
    await update.callback_query.edit_message_text(
        f"⚙️ *Configuración*\n━━━━━━━━━━━━━━━━━━\n"
        f"💎 Profit mín. Surebet: *{cfg.get('min_profit_surebet',3.0)}%*\n"
        f"🎯 Profit mín. Middle: *{cfg.get('min_profit_middle',2.0)}%*\n"
        f"🍀 Prob. mín. Middle: *{cfg.get('min_prob_middle',5.0)}%*\n"
        f"📊 Profit mín. Value: *{cfg.get('min_profit_value',5.0)}%*\n"
        f"📆 Filtro Pre-partido: *{cfg['max_days']} días*\n"
        f"🏅 Deportes: *{sum(cfg['sports'].values())}/{len(cfg['sports'])}*\n"
        f"🏦 Casas: *{sum(cfg['bookmakers'].values())}/{len(cfg['bookmakers'])}*\n"
        "━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(f"💎 Profit Surebet: {cfg.get('min_profit_surebet',3.0)}%", callback_data="cfg_profit_surebet")],
            [InlineKeyboardButton(f"🎯 Profit Middle: {cfg.get('min_profit_middle',2.0)}%",  callback_data="cfg_profit_middle")],
            [InlineKeyboardButton(f"🍀 Prob. Middle mín: {cfg.get('min_prob_middle',5.0)}%", callback_data="cfg_prob_middle")],
            [InlineKeyboardButton(f"📊 Profit Value: {cfg.get('min_profit_value',5.0)}%",    callback_data="cfg_profit_value")],
            [InlineKeyboardButton(f"📆 Filtro Pre-partido: {cfg['max_days']} días",           callback_data="cfg_days")],
            [InlineKeyboardButton("🏅 Deportes",         callback_data="cfg_deportes")],
            [InlineKeyboardButton("🏦 Casas de apuestas", callback_data="cfg_casas")],
            [InlineKeyboardButton("🔙 Volver al panel",   callback_data="menu_principal")],
        ]), parse_mode="Markdown")

async def menu_cfg_deportes(update, context):
    await update.callback_query.answer()
    cfg = get_config(update.effective_user.id)
    keyboard = [[InlineKeyboardButton(
        ("✅ " if cfg["sports"].get(k) else "❌ ") + emoji + " " + nombre,
        callback_data=f"sport_{k}")] for k, (emoji, nombre) in SPORT_DISPLAY.items()]
    keyboard.append([InlineKeyboardButton("✅ Todos", callback_data="deportes_todos"),
                     InlineKeyboardButton("❌ Ninguno", callback_data="deportes_ninguno")])
    keyboard.append([InlineKeyboardButton("💾 Guardar y volver", callback_data="menu_config")])
    await update.callback_query.edit_message_text(
        "🏅 *Deportes*\nToca para activar o desactivar.",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def menu_cfg_casas(update, context):
    await update.callback_query.answer()
    cfg = get_config(update.effective_user.id)
    keyboard = [[InlineKeyboardButton(
        ("✅ " if cfg["bookmakers"].get(k) else "❌ ") + n,
        callback_data=f"book_{k}")] for k, n in BOOKMAKER_NAMES.items()]
    keyboard.append([InlineKeyboardButton("✅ Todas",  callback_data="casas_todas"),
                     InlineKeyboardButton("❌ Ninguna", callback_data="casas_ninguna")])
    keyboard.append([InlineKeyboardButton("💾 Guardar y volver", callback_data="menu_config")])
    await update.callback_query.edit_message_text(
        "🏦 *Casas de apuestas*\nToca para activar o desactivar.",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ============================================================
# TECLADO NUMÉRICO
# ============================================================
TITULOS_NUMERICOS = {
    "profit_surebet": ("💎 *Profit mínimo Surebets*",  "min_profit_surebet", "%",     "menu_config"),
    "profit_middle":  ("🎯 *Profit mínimo Middlebets*", "min_profit_middle",  "%",     "menu_config"),
    "prob_middle":    ("🍀 *Probabilidad mínima Middle*","min_prob_middle",    "%",     "menu_config"),
    "profit_value":   ("📊 *Profit mínimo Valuebets*",  "min_profit_value",   "%",     "menu_config"),
    "days":           ("📆 *Filtro Pre-partido*",        "max_days",           " días", "menu_config"),
    "stake":          ("🧮 *Mi Stake*",                  "stake",              "€",     "menu_principal"),
}

def teclado_numerico(tipo, valor):
    _, _, _, volver = TITULOS_NUMERICOS.get(tipo, ("","","","menu_config"))
    display = f"  📟  {valor if valor else '0'}  "
    return [
        [InlineKeyboardButton(display, callback_data="NOOP")],
        [InlineKeyboardButton("  1  ", callback_data=f"NM|{tipo}|1"),
         InlineKeyboardButton("  2  ", callback_data=f"NM|{tipo}|2"),
         InlineKeyboardButton("  3  ", callback_data=f"NM|{tipo}|3")],
        [InlineKeyboardButton("  4  ", callback_data=f"NM|{tipo}|4"),
         InlineKeyboardButton("  5  ", callback_data=f"NM|{tipo}|5"),
         InlineKeyboardButton("  6  ", callback_data=f"NM|{tipo}|6")],
        [InlineKeyboardButton("  7  ", callback_data=f"NM|{tipo}|7"),
         InlineKeyboardButton("  8  ", callback_data=f"NM|{tipo}|8"),
         InlineKeyboardButton("  9  ", callback_data=f"NM|{tipo}|9")],
        [InlineKeyboardButton("  .  ", callback_data=f"NM|{tipo}|."),
         InlineKeyboardButton("  0  ", callback_data=f"NM|{tipo}|0"),
         InlineKeyboardButton("  ⌫  ", callback_data=f"NM|{tipo}|back")],
        [InlineKeyboardButton("  ✅  Guardar  ", callback_data=f"NM|{tipo}|confirm")],
        [InlineKeyboardButton("  🔙  Cancelar  ", callback_data=volver)],
    ]

def teclado_flow_numerico(field_code: str, pid: str, valor: str):
    """Teclado numerico inline para el flujo de completar apuesta (stakes/cuotas)."""
    prefix  = f"FKN|{field_code}|{pid}"
    display = f"  📟  {valor if valor else '0'}  "
    return [
        [InlineKeyboardButton(display, callback_data="NOOP")],
        [InlineKeyboardButton("  1  ", callback_data=f"{prefix}|1"),
         InlineKeyboardButton("  2  ", callback_data=f"{prefix}|2"),
         InlineKeyboardButton("  3  ", callback_data=f"{prefix}|3")],
        [InlineKeyboardButton("  4  ", callback_data=f"{prefix}|4"),
         InlineKeyboardButton("  5  ", callback_data=f"{prefix}|5"),
         InlineKeyboardButton("  6  ", callback_data=f"{prefix}|6")],
        [InlineKeyboardButton("  7  ", callback_data=f"{prefix}|7"),
         InlineKeyboardButton("  8  ", callback_data=f"{prefix}|8"),
         InlineKeyboardButton("  9  ", callback_data=f"{prefix}|9")],
        [InlineKeyboardButton("  .  ", callback_data=f"{prefix}|."),
         InlineKeyboardButton("  0  ", callback_data=f"{prefix}|0"),
         InlineKeyboardButton("  ⌫  ", callback_data=f"{prefix}|back")],
        [InlineKeyboardButton("  ✅  Confirmar  ", callback_data=f"{prefix}|confirm")],
        [InlineKeyboardButton("  ❌  Cancelar  ", callback_data="DS_pendientes")],
    ]


def teclado_cashout_numerico(rid: str, leg_idx: int, leg_count: int, valor: str):
    """Teclado numerico para introducir el importe de cashout por casa de apuestas.
    Usa una fila de pantalla fija para que los botones no cambien de anchura."""
    prefix  = f"CSH|{rid}|{leg_idx}"
    display = f"  💰  {valor if valor else '0'} €  "
    if leg_count > 1:
        btn_ok = f"  ✅  Confirmar  ({leg_idx + 1}/{leg_count})  "
    else:
        btn_ok = "  ✅  Confirmar cashout  "
    return [
        # Fila pantalla: texto fijo — evita que los botones numéricos se encojan
        [InlineKeyboardButton(display, callback_data="NOOP")],
        [InlineKeyboardButton("  1  ", callback_data=f"{prefix}|1"),
         InlineKeyboardButton("  2  ", callback_data=f"{prefix}|2"),
         InlineKeyboardButton("  3  ", callback_data=f"{prefix}|3")],
        [InlineKeyboardButton("  4  ", callback_data=f"{prefix}|4"),
         InlineKeyboardButton("  5  ", callback_data=f"{prefix}|5"),
         InlineKeyboardButton("  6  ", callback_data=f"{prefix}|6")],
        [InlineKeyboardButton("  7  ", callback_data=f"{prefix}|7"),
         InlineKeyboardButton("  8  ", callback_data=f"{prefix}|8"),
         InlineKeyboardButton("  9  ", callback_data=f"{prefix}|9")],
        [InlineKeyboardButton("  .  ", callback_data=f"{prefix}|."),
         InlineKeyboardButton("  0  ", callback_data=f"{prefix}|0"),
         InlineKeyboardButton("  ⌫  ", callback_data=f"{prefix}|back")],
        [InlineKeyboardButton(btn_ok, callback_data=f"{prefix}|confirm")],
        [InlineKeyboardButton("  ❌  Cancelar cashout  ", callback_data=f"CASH_CANCEL_{rid}")],
    ]

async def mostrar_teclado_numerico(update, context, tipo):
    user_id = update.effective_user.id
    cfg     = get_config(user_id)
    context.user_data[f"num_{tipo}"] = ""
    titulo, campo, unidad, _ = TITULOS_NUMERICOS[tipo]
    val_actual = cfg.get(campo, 0)
    await update.callback_query.edit_message_text(
        f"{titulo}\nActual: *{val_actual}{unidad}*\n\n⌨️ Valor: *_*",
        reply_markup=InlineKeyboardMarkup(teclado_numerico(tipo, "")),
        parse_mode="Markdown")

async def handle_numerico(update, context, tipo, accion):
    user_id = update.effective_user.id
    key     = f"num_{tipo}"
    valor   = context.user_data.get(key, "")
    cfg     = get_config(user_id)
    titulo, campo, unidad, volver = TITULOS_NUMERICOS.get(tipo, ("","","","menu_config"))
    if accion == "back":
        valor = valor[:-1]
    elif accion == "confirm":
        if not valor:
            await update.callback_query.answer("❌ Introduce un valor primero", show_alert=True); return
        try:
            num = float(valor)
            cfg[campo] = int(num) if campo == "max_days" else round(num, 2)
            guardar_db()
            await update.callback_query.answer(f"✅ Guardado: {cfg[campo]}{unidad}")
            context.user_data[key] = ""
            if volver == "menu_config": await menu_config(update, context)
            elif volver == "menu_principal":
                sb = last_surebet.get(user_id)
                if campo == "stake" and sb:
                    resultado = calcular_stakes(num, sb["legs"])
                    await update.callback_query.edit_message_text(resultado,
                        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver al panel", callback_data="menu_principal")]]),
                        parse_mode="Markdown"); return
                await menu_principal(update, context)
            return
        except ValueError:
            await update.callback_query.answer("❌ Valor no válido", show_alert=True); return
    else:
        if accion == "." and "." in valor:
            await update.callback_query.answer("Ya hay un punto decimal"); return
        if len(valor) >= 8:
            await update.callback_query.answer("Máximo 8 dígitos"); return
        valor = valor + accion
    context.user_data[key] = valor
    val_actual = cfg.get(campo, 0)
    display = valor if valor else "_"
    await update.callback_query.edit_message_text(
        f"{titulo}\nActual: *{val_actual}{unidad}*\n\n⌨️ Valor: *{display}*",
        reply_markup=InlineKeyboardMarkup(teclado_numerico(tipo, valor)),
        parse_mode="Markdown")

# ============================================================
# SUSCRIPCIÓN / SOPORTE / TYC / ESTADO
# ============================================================
def get_texto_plan(dias, user_id, tracker=False):
    iban     = "ES04 1583 0001 1191 8598 6678"
    titular  = "Juan Portal Bosch / Alejandro de Quevedo Gallego"
    sufijo   = "T" if tracker else ""
    concepto = f"FidesBot {user_id} {dias}D{sufijo}"
    base = (f"💳 *Transferencia bancaria*\nIBAN: `{iban}`\nTitular: {titular}\n\n"
            f"📌 *Concepto del pago:*\n`{concepto}`\n"
            f"Copia exactamente este concepto al hacer la transferencia\n\n"
            f"━━━━━━━━━━━━━━━━━━\n"
            f"Una vez realizado el pago pulsa el botón de abajo.\n"
            f"Recibirás confirmación lo antes posible 🚀")
    if tracker:
        return (f"🔗 *Plan PRO+Tracker — 1 mes — 49,99€*\n━━━━━━━━━━━━━━━━━━\n\n"
                f"✅ Incluye:\n• Todas las alertas de FidesBot\n"
                f"• Registro automático en DualStats Tracker\n"
                f"• Botones ✅/❌ en cada alerta\n"
                f"• Estadísticas web completas (ROI, P&L…)\n\n"
                f"🎁 *1er mes: 39,99€* _(luego 49,99€)_\n\n{base}")
    if dias == 7:    return f"🗓️ *Plan PRO 1 semana — 17€*\n━━━━━━━━━━━━━━━━━━\n\n{base}"
    elif dias == 14: return f"📅 *Plan PRO 2 semanas — 25€*\n━━━━━━━━━━━━━━━━━━\n\n{base}"
    else: return (f"💎 *Plan PRO 1 mes — 45€* ⭐\n━━━━━━━━━━━━━━━━━━\n\n"
                  f"🎁 *OFERTA NUEVO USUARIO: 35€*\n_(45€ los meses siguientes)_\n\n{base}")

async def pagar_plan_stripe(update, context, plan_key: str):
    """Genera un link de Stripe y lo manda al usuario."""
    query = update.callback_query
    await query.answer()
    user_id = update.effective_user.id
    msg = await query.edit_message_text("⏳ Generando enlace de pago seguro…")
    try:
        url_api = f"{DUALSTATS_API_URL}/checkout"
        headers = {"x-bot-secret": DUALSTATS_API_KEY, "Content-Type": "application/json"}
        payload = {"telegram_id": user_id, "plan_key": plan_key}
        async with aiohttp.ClientSession() as session:
            async with session.post(url_api, json=payload, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                data = await resp.json()
        checkout_url = data.get("url")
        if not checkout_url:
            await msg.edit_text("❌ Error al generar el enlace. Inténtalo de nuevo más tarde.")
            return
        plan_info = {
            "bot_7":       ("🗓️ PRO 1 semana",          "17€"),
            "bot_14":      ("📅 PRO 2 semanas",          "25€"),
            "bot_30":      ("💎 PRO 1 mes",              "45€"),
            "bot_tracker": ("🔗 PRO+Tracker 1 mes",      "49,99€"),
        }
        label, precio = plan_info.get(plan_key, ("Plan", ""))
        await msg.edit_text(
            f"💳 *{label} — {precio}*\n\n"
            f"Pulsa el botón para pagar de forma segura con Stripe.\n"
            f"Tu suscripción se activará *automáticamente* al completar el pago ✅",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton(f"💳 Pagar {precio} con Stripe", url=checkout_url)],
                [InlineKeyboardButton("🔙 Volver a planes", callback_data="suscribirse")],
            ])
        )
    except Exception as e:
        logger.error(f"Error generando checkout Stripe para {user_id}: {e}")
        await msg.edit_text("❌ Error al conectar con el servidor de pagos. Inténtalo de nuevo.")

async def mostrar_suscripcion(update, context):
    await update.callback_query.answer()
    user_id  = update.effective_user.id
    suscrito = tiene_suscripcion(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"
    await update.callback_query.edit_message_text(SUSCRIPCION,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("— PRO —", callback_data="bloqueado")],
            [InlineKeyboardButton("🗓️ 1 semana — 17€",              callback_data="stripe_bot_7")],
            [InlineKeyboardButton("📅 2 semanas — 25€",             callback_data="stripe_bot_14")],
            [InlineKeyboardButton("💎 1 mes — 45€ (35€ 1er mes) ⭐", callback_data="stripe_bot_30")],
            [InlineKeyboardButton("— PRO+Tracker —",                callback_data="bloqueado")],
            [InlineKeyboardButton("🔗 1 mes — 49,99€ (39,99€ 1er mes)", callback_data="stripe_bot_tracker")],
            [InlineKeyboardButton("🔙 Volver", callback_data=volver)],
        ]), parse_mode="Markdown")

async def mostrar_plan(update, context, dias, tracker=False):
    user_id = update.effective_user.id
    if tracker:
        label = "PRO+Tracker (1 mes)"
        cb    = "pago_plan_tracker_30"
    else:
        label = {7:"PRO 1 semana", 14:"PRO 2 semanas"}.get(dias,"PRO 1 mes")
        cb    = f"pago_plan_{dias}"
    texto = get_texto_plan(dias, user_id, tracker=tracker)
    await update.callback_query.edit_message_text(texto,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(f"✅ Ya he pagado — {label}", callback_data=cb)],
            [InlineKeyboardButton("🔙 Volver a planes", callback_data="suscribirse")],
        ]), parse_mode="Markdown")

async def pago_realizado(update, context, dias=30, tracker=False):
    await update.callback_query.answer()
    user   = update.effective_user
    user_id = user.id; nombre = user.full_name
    suscrito = tiene_suscripcion(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"
    if tracker:
        plan_label = "PRO+TRACKER (1 mes)"
        concepto   = f"FidesBot {user_id} 30DT"
    else:
        plan_label = {7:"PRO 1 SEMANA", 14:"PRO 2 SEMANAS"}.get(dias,"PRO 1 MES")
        concepto   = f"FidesBot {user_id} {dias}D"
    if suscrito:
        await update.callback_query.edit_message_text(
            f"ℹ️ *Ya tienes una suscripción activa*\n\n"
            f"Si quieres renovar o ampliar tu suscripción, contacta directamente con el administrador.\n\n"
            f"Tu ID: `{user_id}`\nConcepto de pago: `{concepto}`",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]])); return
    try:
        sufijo_t = "_T" if tracker else ""
        await context.bot.send_message(chat_id=PAGOS_GROUP_ID,
            text=f"💰 *Nuevo pago notificado*\n━━━━━━━━━━━━━━━━━━\n"
                 f"👤 *{nombre}*\n🪪 ID: `{user_id}`\n📅 Plan: *{plan_label}*\n━━━━━━━━━━━━━━━━━━\nPulsa el botón para activar:",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton(
                f"✅ Activar {plan_label}",
                callback_data=f"admin_activar_rapido_{user_id}_{nombre.split()[0]}_{dias}{sufijo_t}"
            )]]), parse_mode="Markdown")
    except Exception as e:
        logger.error(f"Error notificando grupo: {e}")
        try:
            await context.bot.send_message(chat_id=ADMIN_ID,
                text=f"💰 *Nuevo pago notificado*\n👤 *{nombre}*\n🪪 ID: `{user_id}`\nPlan: {plan_label}\n\nPara activar:\n`activar {user_id} {nombre.split()[0]} {dias}`",
                parse_mode="Markdown")
        except: pass
    await update.callback_query.edit_message_text(
        f"✅ *¡Notificación enviada!*\n\n"
        f"El administrador ha recibido tu solicitud.\nRecibirás confirmación lo antes posible 🚀\n\n"
        f"Tu ID: `{user_id}`\nPlan elegido: *{plan_label}*",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]))

async def mostrar_soporte(update, context):
    await update.callback_query.answer()
    volver = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.callback_query.edit_message_text(SOPORTE_TEXTO,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def mostrar_tyc(update, context):
    await update.callback_query.answer()
    volver = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.callback_query.edit_message_text(TERMINOS,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def ver_estado(update, context):
    await update.callback_query.answer()
    user_id = update.effective_user.id
    cfg     = get_config(user_id)
    dias    = dias_restantes(user_id)
    nombre  = subscriptions.get(user_id, {}).get("name", "Usuario")
    deportes_activos = [f"{emoji} {n}" for k, (emoji, n) in SPORT_DISPLAY.items() if cfg["sports"].get(k)]
    casas_activas    = [n for k, n in BOOKMAKER_NAMES.items() if cfg["bookmakers"].get(k)]
    mis_refs = referrals.get(user_id, [])
    creds    = get_creditos(user_id)
    await update.callback_query.edit_message_text(
        f"{icono_suscripcion(dias)} *Mi cuenta*\n━━━━━━━━━━━━━━━━━━\n"
        f"👤 *{nombre}*\n"
        f"📅 Días restantes: *{'∞' if dias==9999 else dias}*\n"
        f"💰 Créditos: *{creds}*\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"• 💎 Surebets: {'✅' if cfg.get('surebets_on') else '❌'}\n"
        f"• 🎯 Middlebets: {'✅' if cfg.get('middlebets_on') else '❌'}\n"
        f"• 📊 Valuebets: {'✅' if cfg.get('valuebets_on') else '❌'}\n"
        f"• ⚡ LIVE: {'✅' if cfg.get('surebets_live_on') else '❌'}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"👥 Referidos: *{len(mis_refs)}*\n\n"
        "🏅 *Deportes:*\n" + "\n".join(deportes_activos) + "\n\n"
        "🏦 *Casas:*\n" + ", ".join(casas_activas),
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver al panel", callback_data="menu_principal")]]),
        parse_mode="Markdown")

# ============================================================
# PANEL ADMIN
# ============================================================
async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    total = len([u for u in subscriptions if tiene_suscripcion(u)])
    keyboard = [
        [InlineKeyboardButton("➕ Activar usuario",   callback_data="admin_activar"),
         InlineKeyboardButton("➖ Desactivar usuario", callback_data="admin_desactivar")],
        [InlineKeyboardButton("👥 Ver suscriptores",  callback_data="admin_lista")],
        [InlineKeyboardButton("📢 Mensaje a todos",   callback_data="admin_broadcast")],
        [InlineKeyboardButton("💰 Dar créditos",      callback_data="admin_creditos")],
        [InlineKeyboardButton("🔗 Link de referido",  callback_data="admin_reflink")],
    ]
    await update.message.reply_text(
        f"👑 *Panel Admin — FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"👥 Suscriptores activos: *{total}*\n"
        f"💎 Surebets: *{stats['surebets_encontradas']}*\n"
        f"🎯 Middles: *{stats['middlebets_encontradas']}*\n━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def handle_admin_callback(update, context):
    query = update.callback_query; data = query.data
    if data == "admin_activar":
        await query.edit_message_text("➕ *Activar usuario*\n\n`activar ID NOMBRE DIAS`\n\nEj: `activar 123456789 Juan 30`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = "activar"
    elif data == "admin_desactivar":
        await query.edit_message_text("➖ *Desactivar usuario*\n\n`desactivar ID`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = "desactivar"
    elif data == "admin_creditos":
        await query.edit_message_text("💰 *Dar créditos*\n\n`creditos ID CANTIDAD`\n\nEj: `creditos 123456789 10`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = "creditos"
    elif data == "admin_lista":
        lines = ["👥 *Suscriptores:*\n"]
        for uid, sub in subscriptions.items():
            if uid in ADMIN_IDS: continue
            estado = "✅" if tiene_suscripcion(uid) else "❌"
            ds_ico = "📊" if uid in dualstats_vinculados else ""
            lines.append(f"{estado}{ds_ico} {sub['name']} — `{uid}` — {dias_restantes(uid)} días")
        texto = "\n".join(lines) if len(lines) > 1 else "👥 No hay suscriptores aún."
        await query.edit_message_text(texto,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]),
            parse_mode="Markdown")
    elif data == "admin_broadcast":
        await query.edit_message_text("📢 Escribe el mensaje para todos:")
        context.user_data["admin_waiting"] = "broadcast"
    elif data == "admin_reflink":
        link = f"https://t.me/{BOT_USERNAME}?start={ADMIN_ID}"
        await query.edit_message_text(f"🔗 *Tu link de referido:*\n`{link}`",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]),
            parse_mode="Markdown")
    elif data == "admin_volver":
        total = len([u for u in subscriptions if tiene_suscripcion(u)])
        await query.edit_message_text(
            f"👑 *Panel Admin — FidesBot*\n━━━━━━━━━━━━━━━━━━\n👥 *{total}* suscriptores\n━━━━━━━━━━━━━━━━━━",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("➕ Activar usuario",   callback_data="admin_activar"),
                 InlineKeyboardButton("➖ Desactivar usuario", callback_data="admin_desactivar")],
                [InlineKeyboardButton("👥 Ver suscriptores",  callback_data="admin_lista")],
                [InlineKeyboardButton("📢 Mensaje a todos",   callback_data="admin_broadcast")],
                [InlineKeyboardButton("💰 Dar créditos",      callback_data="admin_creditos")],
                [InlineKeyboardButton("🔗 Link de referido",  callback_data="admin_reflink")],
            ]))

# ============================================================
# ██████╗ ██╗   ██╗ █████╗ ██╗     ███████╗████████╗ █████╗ ████████╗███████╗
# ██╔══██╗██║   ██║██╔══██╗██║     ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██╔════╝
# ██║  ██║██║   ██║███████║██║     ███████╗   ██║   ███████║   ██║   ███████╗
# ██║  ██║██║   ██║██╔══██║██║     ╚════██║   ██║   ██╔══██║   ██║   ╚════██║
# ██████╔╝╚██████╔╝██║  ██║███████╗███████║   ██║   ██║  ██║   ██║   ███████║
# INTEGRACIÓN DUALSTATS TRACKER
# ============================================================

# ── Helpers de pendientes ─────────────────────────────────

def tiene_tracker(user_id: int) -> bool:
    """True si el usuario tiene plan PRO_TRACKER o ENTERPRISE en DualStats web.
    Si el plan no está guardado aún (usuario vinculado antes de v23), devuelve True
    para no bloquear a usuarios existentes — la API hará la comprobación final."""
    plan = dualstats_plan.get(user_id)
    if plan is None:
        return True   # plan desconocido → dejar pasar, la API web lo validará
    return plan in ("PRO_TRACKER", "ENTERPRISE")

def _uid_pendientes(user_id):
    """Devuelve la lista de pendientes del usuario (crea si no existe)."""
    if user_id not in pendientes:
        pendientes[user_id] = []
    return pendientes[user_id]

def get_pendiente(user_id, pid):
    """Busca un pendiente por su ID corto."""
    for p in _uid_pendientes(user_id):
        if p["id"] == pid:
            return p
    return None

def agregar_pendiente(user_id, datos: dict):
    """Añade un pendiente y persiste la DB."""
    _uid_pendientes(user_id).append(datos)
    guardar_db()

def eliminar_pendiente(user_id, pid):
    """Elimina un pendiente por ID y persiste la DB."""
    pendientes[user_id] = [p for p in _uid_pendientes(user_id) if p["id"] != pid]
    guardar_db()

def _uid_resultados(user_id):
    if user_id not in resultados_locales:
        resultados_locales[user_id] = []
    return resultados_locales[user_id]

def agregar_resultado_local(user_id, datos: dict):
    _uid_resultados(user_id).append(datos)
    guardar_db()

def _tiempo_relativo(ts_str: str) -> str:
    try:
        ts   = datetime.fromisoformat(ts_str)
        diff = local_now() - ts
        mins = int(diff.total_seconds() / 60)
        if mins < 60:  return f"hace {mins} min"
        horas = mins // 60
        if horas < 24: return f"hace {horas}h"
        return f"hace {horas//24}d"
    except:
        return ""

# ── Llamada a la API de DualStats ─────────────────────────

async def llamar_api_dualstats(endpoint: str, payload: dict, method: str = "POST") -> dict | None:
    """
    Llama a la API de DualStats. Si DUALSTATS_API_KEY está vacía o falla,
    devuelve None sin lanzar excepción.
    """
    if not DUALSTATS_API_KEY:
        return None
    url = f"{DUALSTATS_API_URL}/{endpoint}"
    headers = {"x-bot-secret": DUALSTATS_API_KEY, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.request(method, url, json=payload, headers=headers,
                                       timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status in (200, 201):
                    return await resp.json()
                logger.warning(f"DualStats API {method} {endpoint} → {resp.status}")
                return None
    except Exception as e:
        logger.error(f"Error llamando DualStats API {method} {endpoint}: {e}")
        return None

# ── Vinculación de cuentas ────────────────────────────────

async def cmd_procesar_token_vinculacion(update, context, user_id, user, token):
    """
    Llamado desde /start cuando el deep link tiene el formato CONNECT_<token>.
    El bot llama a la API web para vincular el telegram_id con el userId.
    """
    msg = await update.message.reply_text("🔗 Vinculando tu cuenta con DualStats Tracker…")
    resultado = await llamar_api_dualstats("connect", {
        "telegram_id":       user_id,
        "telegram_username": user.username or user.full_name,
        "token":             token,
        "is_admin":          user_id in ADMIN_IDS,
    })
    if resultado and resultado.get("success"):
        dualstats_vinculados.add(user_id)
        plan_web = resultado.get("plan", "FREE")
        if plan_web:
            dualstats_plan[user_id] = plan_web
        # Si el plan web es PRO_TRACKER, activar también la suscripción del bot
        if plan_web in ("PRO_TRACKER", "ENTERPRISE"):
            expires_str = resultado.get("planExpiresAt")
            if expires_str:
                try:
                    expires = datetime.fromisoformat(expires_str.replace("Z", "+00:00")).replace(tzinfo=None)
                    if user_id not in subscriptions:
                        subscriptions[user_id] = {"name": user.full_name or str(user_id), "expires": expires, "config": deepcopy(DEFAULT_USER_CONFIG)}
                    else:
                        subscriptions[user_id]["expires"] = expires
                except Exception:
                    pass
        guardar_db()
        # Refrescar caché de suscripción desde la API
        await refrescar_suscripcion(user_id)
        try: await msg.delete()
        except: pass
        plan_badge = " (PRO+Tracker ✨)" if plan_web in ("PRO_TRACKER", "ENTERPRISE") else ""
        await update.message.reply_text(
            f"✅ *¡Cuenta vinculada con éxito!{plan_badge}*\n\n"
            "Tu cuenta de FidesBot y DualStats Tracker están conectadas.\n\n"
            "A partir de ahora, cuando pulses *✅ Hecha* en una alerta, "
            "podrás registrar la apuesta directamente desde aquí.",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("📋 Ver pendientes", callback_data="DS_pendientes"),
                InlineKeyboardButton("🏠 Menú",           callback_data="menu_principal"),
            ]]))
    elif resultado is None and not DUALSTATS_API_KEY:
        # API no configurada aún — modo desarrollo
        dualstats_vinculados.add(user_id)
        guardar_db()
        try: await msg.delete()
        except: pass
        await update.message.reply_text(
            "✅ *Vinculación registrada (modo desarrollo)*\n\n"
            "La API de DualStats aún no está configurada, pero tu cuenta "
            "queda marcada como vinculada para pruebas.",
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("🏠 Menú", callback_data="menu_principal"),
            ]]))
    else:
        try: await msg.delete()
        except: pass
        await update.message.reply_text(
            "❌ *El enlace de vinculación no es válido o ha expirado.*\n\n"
            "Ve a DualStats Tracker → Configuración → Conectar FidesBot "
            "y genera un nuevo enlace.",
            parse_mode="Markdown")
    # Abrir menú si ya es suscriptor
    if tiene_suscripcion(user_id):
        await menu_principal(update, context)

async def cmd_vincular(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Comando /vincular — explica cómo vincular la cuenta."""
    await update.message.reply_text(
        "🔗 *Vincular FidesBot con DualStats Tracker*\n━━━━━━━━━━━━━━━━━━\n\n"
        "Para vincular tu cuenta:\n\n"
        "1️⃣ Ve a *dualstats-tracker.vercel.app*\n"
        "2️⃣ Inicia sesión con tu cuenta\n"
        "3️⃣ Abre *Configuración → Conectar FidesBot*\n"
        "4️⃣ Pulsa el botón y acepta en Telegram\n\n"
        "Una vez vinculado, las alertas mostrarán botones ✅/❌ "
        "para registrar tus apuestas automáticamente.",
        parse_mode="Markdown")

# ── Panel DualStats en el menú principal ─────────────────

async def panel_dualstats(update, context):
    await update.callback_query.answer()
    user_id   = update.effective_user.id
    vinculado = user_id in dualstats_vinculados
    n_pend      = len(_uid_pendientes(user_id))
    todos_res   = _uid_resultados(user_id)
    n_res       = len([r for r in todos_res if r.get("estado") == "PLACED"])
    cerradas    = [r for r in todos_res if r.get("estado") in ("WON","LOST","VOID","CASHOUT")]
    n_ganadas   = sum(1 for r in cerradas if r.get("estado") == "WON")
    n_perdidas  = sum(1 for r in cerradas if r.get("estado") == "LOST")
    pnl_total   = sum(r.get("ganancia_real", r.get("ganancia_est", 0)) for r in cerradas)

    DS_URL = "https://dualstats-tracker.vercel.app"

    info_txt = (
        "📊 Tu plataforma para llevar la contabilidad de todas tus surebets y middlebets.\n\n"
        "📝 Registra cada apuesta, marca el resultado y analiza tu rendimiento:\n"
        "💰 P&L  ·  📈 ROI  ·  🏆 Win rate por deporte  ·  🏦 Rendimiento por casa\n\n"
        f"🌐 *{DS_URL}*"
    )

    plan_web = dualstats_plan.get(user_id)
    PLAN_LABELS = {
        "PRO":         "💎 PRO",
        "PRO_TRACKER": "🔗 PRO+Tracker",
        "ENTERPRISE":  "👑 Enterprise",
    }
    plan_label = PLAN_LABELS.get(plan_web, "💎 PRO") if plan_web else "💎 PRO"
    es_tracker  = tiene_tracker(user_id)

    if vinculado:
        keyboard = []
        if es_tracker:
            keyboard.append([
                InlineKeyboardButton(f"📋 Pendientes ({n_pend})", callback_data="DS_pendientes"),
                InlineKeyboardButton(f"🏆 Resultados ({n_res})",  callback_data="DS_resultados"),
            ])
        keyboard.append([InlineKeyboardButton("🌐 Abrir DualStats", url=ds_url("/", "panel_open"))])
        keyboard.append([InlineKeyboardButton("🔓 Desvincular",     callback_data="DS_desvincular")])
        keyboard.append([InlineKeyboardButton("🔙 Volver",          callback_data="menu_principal")])

        signo   = "+" if pnl_total >= 0 else ""
        pnl_str = f"{signo}{fmt_eur(pnl_total)}€"
        estado_txt  = f"✅ *Conectado · {plan_label}*\n\n"
        estado_txt += f"✅ Ganadas: {n_ganadas}  |  ❌ Perdidas: {n_perdidas}  |  💰 P&L: {pnl_str}\n"
        estado_txt += f"📋 Pendientes de registrar: {n_pend}  |  🏆 Pendientes de resultado: {n_res}\n\n"
        if es_tracker:
            estado_txt += "💡 Cuando pulses *Hecha* en una alerta, la apuesta se guarda automaticamente."
        else:
            estado_txt += "⚠️ Tu plan *PRO* no incluye integración con el bot.\nActualiza a *PRO+Tracker* para usar /pendientes y /resultados."
    else:
        keyboard = [
            [InlineKeyboardButton("🌐 Abrir DualStats", url=ds_url("/", "panel_open"))],
            [InlineKeyboardButton("🔗 Como vincular",   callback_data="DS_info_vincular")],
            [InlineKeyboardButton("🔙 Volver",          callback_data="menu_principal")],
        ]
        estado_txt = "❌ *No conectado*\n\n"
        estado_txt += "🔗 Vincula tu cuenta para que las alertas se registren automaticamente.\n💎 Necesitas plan *PRO+Tracker* en DualStats para vincular."

    await update.callback_query.edit_message_text(
        f"📈 *DualStats Tracker*\n"
        f"━━━━━━━━━━━━━━━━━━\n\n"
        f"{info_txt}\n\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"{estado_txt}",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ── Mostrar pendientes ────────────────────────────────────

PER_PAGE_PENDIENTES = 5

async def mostrar_pendientes(update_or_query, context, user_id=None, edit=True, page=0):
    """Muestra la lista de apuestas pendientes (bot + borradores web) con paginación."""
    if hasattr(update_or_query, "callback_query"):
        query   = update_or_query.callback_query
        user_id = user_id or update_or_query.effective_user.id
    else:
        query   = update_or_query
        user_id = user_id or query.from_user.id

    # Cargar borradores web en paralelo con la lista local
    drafts_web = await sync_drafts_desde_web(user_id)
    lista      = _uid_pendientes(user_id)

    if not lista and not drafts_web:
        texto = ("📋 *Pendientes*\n━━━━━━━━━━━━━━━━━━\n\n"
                 "✅ No tienes apuestas pendientes de registrar.")
        kb = [[InlineKeyboardButton("🔙 Volver", callback_data="panel_dualstats")]]
        if edit:
            await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(kb), parse_mode="Markdown")
        return

    total    = len(lista)
    n_pages  = max(1, (total + PER_PAGE_PENDIENTES - 1) // PER_PAGE_PENDIENTES)
    page     = max(0, min(page, n_pages - 1))
    chunk    = lista[page * PER_PAGE_PENDIENTES : (page + 1) * PER_PAGE_PENDIENTES]
    offset   = page * PER_PAGE_PENDIENTES

    keyboard = []

    # ── Sección 1: pendientes del bot (requieren completar registro) ──────────
    if lista:
        pagina_txt = f" · Pág. {page+1}/{n_pages}" if n_pages > 1 else ""
        texto = f"📋 *Pendientes ({total}){pagina_txt}*\n━━━━━━━━━━━━━━━━━━\n\n"

        for i, p in enumerate(chunk, offset + 1):
            emoji, _   = SPORT_DISPLAY.get(p.get("sport_key",""), ("🏅",""))
            tiempo     = _tiempo_relativo(p["ts"])
            tipo_label = "🎯 Middle" if p.get("tipo") == "middlebet" else "⚡ Surebet"
            live_badge = " 🎥 *LIVE*" if p.get("live") else ""
            leg_lines  = "".join(
                f"   📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']} 💰 {l['stake_pct']}%\n"
                for l in p["legs"]
            )
            texto += (f"*{i}.* {emoji} {tipo_label}{live_badge}\n"
                      f"🏆 *{p['evento']}* — {p.get('liga','')}\n"
                      f"{leg_lines}"
                      f"   _{tiempo}_\n\n")
            keyboard.append([
                InlineKeyboardButton(f"✏️ Registrar {i}", callback_data=f"PC_{p['id']}"),
                InlineKeyboardButton("🗑",                  callback_data=f"PE_{p['id']}"),
            ])
    else:
        texto = "📋 *Pendientes*\n━━━━━━━━━━━━━━━━━━\n\n"

    # ── Sección 2: borradores de la web (capital inicial no configurado) ──────
    if drafts_web:
        WEB_URL = "https://dualstats-tracker.vercel.app"
        texto += f"⚠️ *Borradores en la web ({len(drafts_web)})*\n"
        texto += "_Estas apuestas están bloqueadas porque alguna casa no tiene capital inicial._\n\n"
        for d in drafts_web[:5]:  # máximo 5 para no saturar el mensaje
            tipo_label = {"ARBITRAGE": "⚡ Surebet", "MIDDLE": "🎯 Middle"}.get(d.get("type",""), "📋 Apuesta")
            tiempo     = _tiempo_relativo(d.get("datePlaced",""))
            missing    = ", ".join(d.get("missingCapital", [])) or "alguna casa"
            texto += (f"  {tipo_label}: *{d.get('title') or '—'}*\n"
                      f"  ⚠️ Sin capital: _{missing}_\n"
                      f"  _{tiempo}_\n\n")
        keyboard.append([
            InlineKeyboardButton("🏦 Configurar capital inicial",
                                 url=ds_url("/bookmakers", "pendientes_draft"))
        ])

    # Navegación de páginas (solo si hay pendientes locales)
    if lista:
        nav = []
        if page > 0:
            nav.append(InlineKeyboardButton("◀️ Anterior", callback_data=f"DS_pendientes_p{page-1}"))
        if page < n_pages - 1:
            nav.append(InlineKeyboardButton("Siguiente ▶️", callback_data=f"DS_pendientes_p{page+1}"))
        if nav:
            keyboard.append(nav)

    keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data="panel_dualstats")])

    if edit:
        await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ── Botones ✅/❌ en alertas ──────────────────────────────

async def handle_flow_numerico(update, context, field_code, pid, accion):
    query   = update.callback_query
    user_id = update.effective_user.id
    flow    = context.user_data.get("ds_flow", {})
    p       = get_pendiente(user_id, pid)
    if not p:
        await query.answer("Apuesta no encontrada", show_alert=True); return
    key      = f"fn_{field_code}_{pid}"
    valor    = context.user_data.get(key, "")
    is_stake = field_code.startswith("s")
    leg_idx  = int(field_code[1])
    leg      = p["legs"][leg_idx]
    if accion == "back":
        valor = valor[:-1]
    elif accion == "confirm":
        if not valor:
            await query.answer("Introduce un valor primero", show_alert=True); return
        try:
            num = float(valor)
            if is_stake:
                if num <= 0: raise ValueError
                flow["stakes"][leg_idx] = num
                context.user_data["ds_flow"] = flow
                context.user_data[key] = ""
                next_idx = leg_idx + 1
                if next_idx < len(p["legs"]):
                    await _preguntar_stake_leg(update, context, p, next_idx)
                else:
                    await _mostrar_odds_confirm(query, context, p, flow)
            else:
                if num <= 1.0: raise ValueError
                flow["odds"][leg_idx] = num
                context.user_data["ds_flow"] = flow
                context.user_data[key] = ""
                next_idx = leg_idx + 1
                if next_idx < len(p["legs"]):
                    await _preguntar_odd_leg(update, context, p, next_idx)
                else:
                    await _mostrar_resumen(query, context, p, flow)
            return
        except (ValueError, TypeError):
            msg = "Stake > 0" if is_stake else "Cuota > 1.0"
            await query.answer(msg, show_alert=True); return
    else:
        if accion == "." and "."  in valor:
            await query.answer("Ya hay un punto decimal"); return
        if len(valor) >= 8:
            await query.answer("Maximo 8 digitos"); return
        valor = valor + accion
    context.user_data[key] = valor
    if is_stake:
        stake_sug = redondear_stake(p["stake_sug"] * leg["stake_pct"] / 100)
        titulo = (f"*Stake en {leg['bookmaker']}*\nSugerido: {fmt_eur(stake_sug)}€\n\nValor: *{valor if valor else '_'}*")
    else:
        titulo = (f"*Cuota en {leg['bookmaker']}*\nAlerta: @{leg['odd']}\n\nValor: *{valor if valor else '_'}*")
    await query.edit_message_text(titulo, parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(teclado_flow_numerico(field_code, pid, valor)))


async def mostrar_correccion_selector(query, context, p, flow):
    keyboard = []
    for i, leg in enumerate(p["legs"]):
        keyboard.append([
            InlineKeyboardButton(f"Cantidad {leg['bookmaker']}", callback_data=f"FK_s{i}_{p['id']}"),
            InlineKeyboardButton(f"Cuota {leg['bookmaker']}",    callback_data=f"FK_o{i}_{p['id']}"),
        ])
    keyboard.append([InlineKeyboardButton("Volver al resumen", callback_data=f"FL_verres_{p['id']}"  )])
    await query.edit_message_text(
        f"*Que quieres corregir?*\n{p['evento']}",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")


async def handle_alerta_hecha(update, context, uid, alert_id):
    """Usuario pulsó ✅ Hecha en una alerta."""
    query     = update.callback_query
    cache_key = f"{uid}_{alert_id}"
    datos     = alerta_cache.get(cache_key)

    # Guards: solo usuarios con bot activo + DualStats vinculado
    if not tiene_suscripcion(uid):
        await query.answer("Necesitas suscripcion activa al bot para usar DualStats.", show_alert=True); return
    if uid not in dualstats_vinculados:
        await query.answer("Necesitas vincular tu cuenta de DualStats primero.", show_alert=True); return
    if not tiene_tracker(uid):
        await query.answer("Tu plan DualStats (PRO) no incluye integración con el bot. Actualiza a PRO+Tracker.", show_alert=True); return

    if not datos:
        await query.answer("⚠️ Alerta expirada (el bot se reinició). Ve a /start.", show_alert=True)
        return

    # Crear pendiente con los datos de la alerta
    pid = uuid.uuid4().hex[:10]
    pendiente = {
        "id":        pid,
        "ts":        local_now().isoformat(),
        "evento":    datos["evento"],
        "sport_key": datos["sport_key"],
        "liga":      datos["liga"],
        "legs":      datos["legs"],
        "profit":    datos["profit"],
        "stake_sug": datos["stake_sug"],
        "tipo":      datos["tipo"],
        "live":      datos.get("live", False),
        "time":      datos.get("time", ""),
        "estado":    "PENDIENTE",
    }
    agregar_pendiente(uid, pendiente)

    # Editar el mensaje original para quitar los botones
    try:
        await context.bot.edit_message_text(
            chat_id=uid, message_id=datos["msg_id"],
            text=datos["mensaje"] + "\n\n✅ *Hecha · Pendiente de registrar*\nUsa /pendientes cuando puedas.",
            parse_mode="Markdown")
    except: pass

    await query.answer("✅ Guardada en pendientes")

    # Notificación de seguimiento
    await context.bot.send_message(
        chat_id=uid,
        text=(f"✅ *Guardada en tus pendientes.*\n\n"
              f"Completa los detalles cuando acabes apostando.\n\n"
              f"📋 /pendientes"),
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("📋 Ir a pendientes", callback_data="DS_pendientes"),
        ]]))

async def handle_alerta_nohecha(update, context, uid, alert_id):
    """Usuario pulsó ❌ No hecha en una alerta."""
    query     = update.callback_query
    cache_key = f"{uid}_{alert_id}"
    datos     = alerta_cache.get(cache_key)

    # Editar el mensaje original para quitar los botones
    if datos:
        try:
            await context.bot.edit_message_text(
                chat_id=uid, message_id=datos["msg_id"],
                text=datos["mensaje"] + "\n\n❌ *No realizada*",
                parse_mode="Markdown")
        except: pass

    await query.answer("❌ Registrado como no realizada")

# ── Flujo de completar un pendiente ──────────────────────

def _resumen_flow(pendiente, stakes, odds) -> str:
    """Genera el texto de resumen con los datos reales del usuario."""
    total_inv   = sum(stakes)
    ganancia    = round(stakes[0] * odds[0] - total_inv, 2)
    emoji, _    = SPORT_DISPLAY.get(pendiente.get("sport_key",""), ("🏅",""))
    lineas = []
    for i, leg in enumerate(pendiente["legs"]):
        lineas.append(
            f"📕 *{leg['bookmaker']}* · {formatear_outcome(leg)}\n"
            f"   🎲 @{odds[i]}  💶 {fmt_eur(stakes[i])}€"
        )
    profit_real = (ganancia / total_inv * 100) if total_inv > 0 else 0
    aviso = ""
    if profit_real < 0:
        aviso = f"\n\n⚠️ _Con estas cuotas/stakes el ROI es {profit_real:.2f}% (perdida esperada)._"

    return (f"📋 *RESUMEN DE TU APUESTA*\n━━━━━━━━━━━━━━━━━━\n"
            f"{emoji} {pendiente['evento']}\n\n"
            + "\n".join(lineas) + "\n\n"
            + f"━━━━━━━━━━━━━━━━━━\n"
            + f"💰 Total invertido: *{fmt_eur(total_inv)}€*\n"
            + f"📈 ROI real: *{profit_real:+.2f}%*\n"
            + f"💵 Ganancia estimada: *{ganancia:+.2f}€*"
            + aviso)

async def iniciar_completar_pendiente(update, context, user_id, pid):
    """Arranca el flujo de completar un pendiente."""
    query    = update.callback_query
    p        = get_pendiente(user_id, pid)
    if not p:
        await query.answer("⚠️ Pendiente no encontrado", show_alert=True); return

    # Inicializar el estado del flujo
    context.user_data["ds_flow"] = {
        "pid":    pid,
        "uid":    user_id,
        "step":   "stake_confirm",
        "stakes": [None] * len(p["legs"]),
        "odds":   [None] * len(p["legs"]),
    }

    # Mostrar paso 1: ¿Stakes correctos?
    stakes_str = "  /  ".join(
        f"{p['legs'][i]['bookmaker']}: €{fmt_eur(redondear_stake(p['stake_sug']*p['legs'][i]['stake_pct']/100))}"
        for i in range(len(p["legs"]))
    )
    await query.edit_message_text(
        f"✏️ *Completar apuesta*\n━━━━━━━━━━━━━━━━━━\n"
        f"📌 {p['evento']}\n\n"
        f"*Paso 1/2 — Stakes*\n"
        f"¿Pusiste los stakes que te sugerí?\n\n"
        f"_{stakes_str}_",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("✅ Sí, exacto",      callback_data=f"FL_sc_yes_{pid}"),
             InlineKeyboardButton("✏️ No, los cambié",  callback_data=f"FL_sc_no_{pid}")],
            [InlineKeyboardButton("❌ Cancelar",         callback_data="DS_pendientes")],
        ]), parse_mode="Markdown")

async def _preguntar_stake_leg(update_or_query, context, p, leg_idx):
    """Muestra teclado numerico para el stake real de la pata leg_idx."""
    leg        = p["legs"][leg_idx]
    stake_sug  = redondear_stake(p["stake_sug"] * leg["stake_pct"] / 100)
    field_code = f"s{leg_idx}"
    context.user_data["ds_flow"]["step"] = f"stake_leg_{leg_idx}"
    context.user_data[f"fn_{field_code}_{p['id']}"] = ""
    titulo = (f"*Stake en {leg['bookmaker']}*\n"
              f"Sugerido: {fmt_eur(stake_sug)}€\n\n"
              f"Introduce el importe real:")
    kb = InlineKeyboardMarkup(teclado_flow_numerico(field_code, p["id"], ""))
    if hasattr(update_or_query, "callback_query"):
        await update_or_query.callback_query.edit_message_text(titulo, parse_mode="Markdown", reply_markup=kb)
    else:
        await update_or_query.message.reply_text(titulo, parse_mode="Markdown", reply_markup=kb)

async def _preguntar_odd_leg(update_or_query, context, p, leg_idx):
    """Muestra teclado numerico para la cuota real de la pata leg_idx."""
    leg        = p["legs"][leg_idx]
    field_code = f"o{leg_idx}"
    context.user_data["ds_flow"]["step"] = f"odds_leg_{leg_idx}"
    context.user_data[f"fn_{field_code}_{p['id']}"] = ""
    titulo = (f"*Cuota en {leg['bookmaker']}*\n"
              f"Alerta: @{leg['odd']}\n\n"
              f"Introduce la cuota real:")
    kb = InlineKeyboardMarkup(teclado_flow_numerico(field_code, p["id"], ""))
    if hasattr(update_or_query, "callback_query"):
        await update_or_query.callback_query.edit_message_text(titulo, parse_mode="Markdown", reply_markup=kb)
    else:
        await update_or_query.message.reply_text(titulo, parse_mode="Markdown", reply_markup=kb)

async def _mostrar_odds_confirm(query, context, p, flow):
    """Paso 2: ¿Las cuotas eran las mismas?"""
    flow["step"] = "odds_confirm"
    context.user_data["ds_flow"] = flow
    odds_str = "  /  ".join(
        f"{p['legs'][i]['bookmaker']}: @{p['legs'][i]['odd']}" for i in range(len(p["legs"]))
    )
    await query.edit_message_text(
        f"🎲 *Paso 2/2 — Cuotas*\n"
        f"¿Las cuotas eran las mismas que te mostré?\n\n"
        f"_{odds_str}_",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("✅ Sí, las mismas",   callback_data=f"FL_oc_yes_{p['id']}"),
             InlineKeyboardButton("⚠️ No, cambiaron",    callback_data=f"FL_oc_no_{p['id']}")],
            [InlineKeyboardButton("❌ Cancelar",          callback_data="DS_pendientes")],
        ]), parse_mode="Markdown")

async def _mostrar_resumen(query, context, p, flow):
    """Muestra el resumen final antes de registrar."""
    flow["step"] = "summary"
    context.user_data["ds_flow"] = flow
    # Rellenar con valores de la alerta si son None
    stakes = [flow["stakes"][i] if flow["stakes"][i] is not None
              else redondear_stake(p["stake_sug"] * p["legs"][i]["stake_pct"] / 100)
              for i in range(len(p["legs"]))]
    odds   = [flow["odds"][i] if flow["odds"][i] is not None
              else p["legs"][i]["odd"]
              for i in range(len(p["legs"]))]
    flow["stakes"] = stakes
    flow["odds"]   = odds
    resumen = _resumen_flow(p, stakes, odds)
    vinculado = p.get("uid", query.from_user.id) in dualstats_vinculados or query.from_user.id in dualstats_vinculados
    btn_label = "✅ Registrar en DualStats" if vinculado else "✅ Guardar localmente"
    await query.edit_message_text(
        resumen + "\n\n━━━━━━━━━━━━━━━━━━\n¿Todo correcto?",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(btn_label,          callback_data=f"FL_confirm_{p['id']}"),
             InlineKeyboardButton("Corregir",          callback_data=f"FK_sel_{p['id']}")],
            [InlineKeyboardButton("❌ Cancelar",        callback_data="DS_pendientes")],
        ]), parse_mode="Markdown")

async def handle_flow_confirmado(update, context, user_id, pid):
    """El usuario confirma el registro de la apuesta."""
    query = update.callback_query
    flow  = context.user_data.get("ds_flow", {})
    p     = get_pendiente(user_id, pid)
    if not p:
        await query.answer("⚠️ Pendiente no encontrado", show_alert=True); return

    stakes = flow.get("stakes", [])
    odds   = flow.get("odds", [])

    # Rellenar huecos con datos de la alerta si el usuario no los cambió
    for i in range(len(p["legs"])):
        if i >= len(stakes) or stakes[i] is None:
            stakes.append(redondear_stake(p["stake_sug"] * p["legs"][i]["stake_pct"] / 100))
        if i >= len(odds) or odds[i] is None:
            odds.append(p["legs"][i]["odd"])

    # Intentar registrar en DualStats
    registrado_en_web = False
    if user_id in dualstats_vinculados:
        event_time = p.get("time") or None
        payload = {
            "telegram_id":    user_id,
            "bot_pending_id": pid,
            "eventDate":      event_time,
            "apuesta": {
                "evento":     p["evento"],
                "sport":      p["sport_key"],
                "liga":       p["liga"],
                "legs":       [{"bookmaker": p["legs"][i]["bookmaker"],
                                "outcome":   formatear_outcome(p["legs"][i]),
                                "odd":       odds[i],
                                "stake":     stakes[i]} for i in range(len(p["legs"]))],
                "profit":     p["profit"],
                "tipo":       p["tipo"],
                "fuente":     "telegram",
            }
        }
        resultado = await llamar_api_dualstats("records", payload)
        registrado_en_web = resultado is not None

        # Apuesta ya existente (aprox.) — actualizar cuotas si el usuario las cambió
        if resultado and resultado.get("duplicate"):
            registrado_en_web = True
            orig_odds = [p["legs"][i]["odd"] for i in range(len(p["legs"]))]
            user_flow_odds = flow.get("odds") or []
            changed_legs = [
                {"leg_index": i, "odds": user_flow_odds[i]}
                for i in range(len(p["legs"]))
                if i < len(user_flow_odds)
                and user_flow_odds[i] is not None
                and abs(user_flow_odds[i] - orig_odds[i]) > 0.001
            ]
            if changed_legs:
                await llamar_api_dualstats("records", {
                    "telegram_id":    user_id,
                    "bot_pending_id": pid,
                    "legs":           changed_legs,
                }, method="PATCH")

        # Apuesta registrada como BORRADOR (casas sin capital inicial)
        if resultado and resultado.get("draft"):
            missing = resultado.get("missing_capital", [])
            missing_lines = "".join(f"\n  ⚠️ *{bm}*" for bm in missing) if missing else "\n  ⚠️ alguna casa"
            eliminar_pendiente(user_id, pid)
            if "ds_flow" in context.user_data:
                del context.user_data["ds_flow"]
            await query.edit_message_text(
                f"⚠️ *Apuesta guardada como Borrador*\n\n"
                f"Se registró en DualStats pero en estado *Borrador* porque las siguientes casas "
                f"aún no tienen capital inicial registrado:{missing_lines}\n\n"
                f"👉 Registra el capital en *Casas de Apuestas* y confírmala desde la web.",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton("🌐 Ir a Casas de Apuestas",
                                         url=ds_url("/bookmakers", "alert_draft"))],
                    [InlineKeyboardButton("🏠 Menú principal", callback_data="menu_principal")],
                ]),
                parse_mode="Markdown",
            )
            guardar_db()
            return

    # Mover de pendientes a resultados_locales
    total_inv = sum(stakes)
    ganancia  = round(stakes[0] * odds[0] - total_inv, 2)
    registro  = {
        "id":        pid,
        "ts":        p["ts"],
        "ts_reg":    local_now().isoformat(),
        "evento":    p["evento"],
        "sport_key": p["sport_key"],
        "legs":      p["legs"],
        "stakes":    stakes,
        "odds":      odds,
        "stake_total": total_inv,
        "ganancia_est": ganancia,
        "tipo":      p["tipo"],
        "estado":    "PLACED",
        "web_sync":  registrado_en_web,
    }
    agregar_resultado_local(user_id, registro)
    eliminar_pendiente(user_id, pid)
    del context.user_data["ds_flow"]

    web_txt = "✅ Registrado en DualStats Tracker." if registrado_en_web else "📱 Guardado localmente."
    await query.edit_message_text(
        f"✅ *¡Apuesta registrada!*\n\n{web_txt}\n\n"
        f"Cuando conozcas el resultado, ve a /resultados para actualizarlo.",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🏆 Ver resultados pendientes", callback_data="DS_resultados")],
            [InlineKeyboardButton("📋 Pendientes",                callback_data="DS_pendientes")],
            [InlineKeyboardButton("🏠 Menú",                      callback_data="menu_principal")],
        ]), parse_mode="Markdown")

# ── Sección /resultados ───────────────────────────────────

PER_PAGE_RESULTADOS = 5

async def sync_drafts_desde_web(user_id: int) -> list:
    """
    Llama a GET /api/bot/records/draft?telegram_id=... y devuelve la lista
    de apuestas DRAFT de la web (borradores por falta de capital inicial).
    Retorna [] si el usuario no está vinculado o falla la llamada.
    """
    if user_id not in dualstats_vinculados:
        return []
    url     = f"{DUALSTATS_API_URL}/records/draft"
    headers = {"x-bot-secret": DUALSTATS_API_KEY}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"telegram_id": user_id},
                                   headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
                return data.get("drafts", []) if data.get("success") else []
    except Exception as e:
        logger.warning(f"sync_drafts_desde_web: {e}")
        return []


async def sync_resultados_desde_web(user_id: int):
    """
    Llama a GET /api/bot/records/pending?telegram_id=... y fusiona los registros
    PLACED de la web con el estado local. Los registros web tienen prioridad.
    """
    url     = f"{DUALSTATS_API_URL}/records/pending"
    headers = {"x-bot-secret": DUALSTATS_API_KEY}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"telegram_id": user_id},
                                   headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=8)) as resp:
                if resp.status != 200:
                    return
                data = await resp.json()
                if not data.get("success"):
                    return
                web_records = data.get("records", [])
    except Exception as e:
        logger.warning(f"sync_resultados_desde_web: {e}")
        return

    lista_local = _uid_resultados(user_id)
    ids_locales = {r["id"] for r in lista_local}
    added = 0
    for wr in web_records:
        pid = wr.get("botPendingId")
        if not pid or pid in ids_locales:
            continue
        # Normalizar al formato local
        legs_web = wr.get("legs", [])
        registro = {
            "id":         pid,
            "webId":      wr.get("id"),
            "ts":         wr.get("datePlaced", ""),
            "ts_reg":     wr.get("datePlaced", ""),
            "evento":     wr.get("title") or wr.get("evento", "—"),
            "sport_key":  wr.get("sport", ""),
            "legs":       [{"bookmaker": l.get("bookmaker", ""), "stake_pct": 50} for l in legs_web],
            "stakes":     [l.get("stake", 0) for l in legs_web],
            "odds":       [l.get("odds", 0) for l in legs_web],
            "stake_total": wr.get("totalStake", 0),
            "tipo":       "middlebet" if wr.get("type") == "MIDDLE" else "surebet",
            "estado":     "PLACED",
            "web_sync":   True,
        }
        lista_local.append(registro)
        added += 1

    if added:
        guardar_db()

async def mostrar_resultados(update_or_query, context, user_id=None, edit=True, page=0):
    """Muestra apuestas en PLACED pendientes de resultado, con paginación y badges."""
    if hasattr(update_or_query, "callback_query"):
        query   = update_or_query.callback_query
        user_id = user_id or update_or_query.effective_user.id
    else:
        query   = update_or_query
        user_id = user_id or query.from_user.id

    # Sincronizar con la web antes de mostrar (si el usuario está vinculado)
    if user_id in dualstats_vinculados:
        await sync_resultados_desde_web(user_id)

    lista = [r for r in _uid_resultados(user_id) if r.get("estado") == "PLACED"]
    if not lista:
        texto = ("🏆 *Resultados*\n━━━━━━━━━━━━━━━━━━\n\n"
                 "✅ No tienes apuestas pendientes de resultado.\n\n"
                 "_Las apuestas aparecerán aquí una vez completadas._")
        kb = [[InlineKeyboardButton("🔙 Volver", callback_data="panel_dualstats")]]
        if edit:
            await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(kb), parse_mode="Markdown")
        return

    total   = len(lista)
    n_pages = max(1, (total + PER_PAGE_RESULTADOS - 1) // PER_PAGE_RESULTADOS)
    page    = max(0, min(page, n_pages - 1))
    chunk   = lista[page * PER_PAGE_RESULTADOS : (page + 1) * PER_PAGE_RESULTADOS]
    offset  = page * PER_PAGE_RESULTADOS

    pagina_txt = f" · Pág. {page+1}/{n_pages}" if n_pages > 1 else ""
    texto = f"🏆 *Resultados pendientes ({total}){pagina_txt}*\n━━━━━━━━━━━━━━━━━━\n\n"
    keyboard = []

    for i, r in enumerate(chunk, offset + 1):
        emoji, _   = SPORT_DISPLAY.get(r.get("sport_key",""), ("🏅",""))
        tiempo     = _tiempo_relativo(r["ts"])
        tipo_label = "🎯 Middle" if r.get("tipo") == "middlebet" else "⚡ Surebet"
        live_badge = " 🎥 *LIVE*" if r.get("live") else ""
        stake_txt  = f"{fmt_eur(float(r['stake_total']))}€ apostados" if r.get("stake_total") else ""
        leg_lines  = "".join(
            f"   📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']}\n"
            for l in r.get("legs", [])
        )
        texto += (f"*{i}.* {emoji} {tipo_label}{live_badge}\n"
                  f"🏆 *{r['evento']}* — {r.get('liga','')}\n"
                  f"{leg_lines}"
                  f"   {stake_txt}  _{tiempo}_\n\n")
        keyboard.append([
            InlineKeyboardButton(f"✅ Ganada",  callback_data=f"RES_ganada_{r['id']}"),
            InlineKeyboardButton(f"❌ Perdida", callback_data=f"RES_lost_{r['id']}"),
            InlineKeyboardButton(f"🔄 Void",   callback_data=f"RES_void_{r['id']}"),
            InlineKeyboardButton(f"💸 Cash",   callback_data=f"RES_cash_{r['id']}"),
        ])

    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀️ Anterior", callback_data=f"DS_resultados_p{page-1}"))
    if page < n_pages - 1:
        nav.append(InlineKeyboardButton("Siguiente ▶️", callback_data=f"DS_resultados_p{page+1}"))
    if nav:
        keyboard.append(nav)
    keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data="panel_dualstats")])
    if edit:
        await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def handle_ganada_selector(update, context, user_id, rid):
    """Muestra sub-menu: en qué casa se ganó la apuesta."""
    query = update.callback_query
    lista = _uid_resultados(user_id)
    reg   = next((r for r in lista if r["id"] == rid), None)
    if not reg:
        await query.answer("Apuesta no encontrada", show_alert=True); return

    es_middle  = reg.get("tipo") == "middlebet"
    legs       = reg.get("legs", [])
    emoji, _   = SPORT_DISPLAY.get(reg.get("sport_key", ""), ("🏅", ""))
    live_badge = " 🎥 LIVE" if reg.get("live") else ""
    tipo_txt   = "🎯 Middlebet" if es_middle else "⚡ Surebet"

    # Resumen de legs
    legs_txt = "".join(
        f"   {'🔵' if i==0 else '🔴'} *{l['bookmaker']}* — {formatear_outcome(l)} @{l['odd']}\n"
        for i, l in enumerate(legs)
    )

    texto = (
        f"✅ *¿En qué casa ganaste?*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"{emoji} *{reg['evento']}*{live_badge}\n"
        f"🏆 {reg.get('liga','')}  |  {tipo_txt}\n\n"
        f"{legs_txt}\n"
        f"{'↓ Selecciona la pata ganadora:' if not es_middle else '↓ Selecciona el resultado:'}"
    )

    keyboard = []
    if es_middle:
        if len(legs) >= 2:
            keyboard.append([
                InlineKeyboardButton(f"🔵 Ganó {legs[0]['bookmaker']}", callback_data=f"RES_won0_{rid}"),
                InlineKeyboardButton(f"🔴 Ganó {legs[1]['bookmaker']}", callback_data=f"RES_won1_{rid}"),
            ])
            keyboard.append([InlineKeyboardButton("🏆 ¡Ambas ganadas! (middle se cumplió)", callback_data=f"RES_wonB_{rid}")])
    else:
        for i, leg in enumerate(legs[:2]):
            icon = "🔵" if i == 0 else "🔴"
            keyboard.append([InlineKeyboardButton(
                f"{icon} Ganó en {leg['bookmaker']} (@{leg['odd']})",
                callback_data=f"RES_won{i}_{rid}"
            )])

    keyboard.append([InlineKeyboardButton("↩️ Cancelar", callback_data="DS_resultados")])
    await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")


async def handle_resultado(update, context, user_id, rid, resultado_str, won_leg=None):
    """Actualiza el resultado de una apuesta registrada."""
    query  = update.callback_query
    LABELS = {"WON": "Ganada", "LOST": "Perdida", "VOID": "Void/Anulada", "CASHOUT": "Cashout"}

    lista = _uid_resultados(user_id)
    reg   = next((r for r in lista if r["id"] == rid), None)
    if not reg:
        await query.answer("Apuesta no encontrada", show_alert=True); return

    stakes = reg.get("stakes", [])
    odds   = reg.get("odds",   [])
    total  = sum(stakes) if stakes else 0.0

    # Calcular ganancia real segun que pata gano
    ganancia_real = None
    legs_resultado = []

    if resultado_str == "WON" and won_leg is not None and stakes and odds:
        if won_leg == "both":
            # Middle se cumplio: ambas patas ganan
            ganancia_real = round(
                sum(stakes[i] * odds[i] for i in range(len(stakes))) - total, 2
            )
            legs_resultado = [{"leg": i, "estado": "WON"} for i in range(len(stakes))]
        else:
            # Solo una pata gano, la otra perdio
            idx = int(won_leg)
            if idx < len(stakes) and idx < len(odds):
                ganancia_real = round(stakes[idx] * odds[idx] - total, 2)
            legs_resultado = [
                {"leg": i, "estado": "WON" if i == idx else "LOST"}
                for i in range(len(stakes))
            ]

    reg["estado"]         = resultado_str
    reg["ts_result"]      = local_now().isoformat()
    if ganancia_real is not None:
        reg["ganancia_real"]  = ganancia_real
    if legs_resultado:
        reg["legs_resultado"] = legs_resultado
    guardar_db()

    # Intentar actualizar en DualStats
    if user_id in dualstats_vinculados:
        payload = {
            "telegram_id": user_id,
            "apuesta_id":  rid,
            "resultado":   resultado_str,
        }
        if ganancia_real is not None:
            payload["ganancia_real"] = ganancia_real
        if legs_resultado:
            payload["legs_resultado"] = legs_resultado
        await llamar_api_dualstats("records/result", payload)

    # ── Mensaje de confirmación en el chat ───────────────────────────────────
    emoji_dep, _ = SPORT_DISPLAY.get(reg.get("sport_key", ""), ("🏅", ""))
    evento_txt   = reg.get("evento", "")

    if resultado_str == "WON":
        signo = "+" if (ganancia_real or 0) >= 0 else ""
        pnl_txt = f"*{signo}{fmt_eur(ganancia_real)}€*" if ganancia_real is not None else ""
        await query.answer("✅ ¡Ganada registrada!", show_alert=False)
        await context.bot.send_message(
            chat_id=user_id,
            text=(
                f"🎉 *¡Resultado registrado en DualStats!* ✅\n━━━━━━━━━━━━━━━━━━\n\n"
                f"{emoji_dep} *{evento_txt}*\n"
                f"{'💰 Ganancia: ' + pnl_txt if pnl_txt else ''}\n\n"
                f"¡Buen trabajo! Sigue así 💪"
            ),
            parse_mode="Markdown"
        )
    elif resultado_str == "LOST":
        await query.answer("❌ Pérdida registrada", show_alert=False)
        await context.bot.send_message(
            chat_id=user_id,
            text=(
                f"📋 *Registrado en DualStats*\n━━━━━━━━━━━━━━━━━━\n\n"
                f"{emoji_dep} *{evento_txt}*\n\n"
                f"😔 Lamentamos la pérdida. ¡Ánimo, la próxima será! 💪"
            ),
            parse_mode="Markdown"
        )
    elif resultado_str == "VOID":
        await query.answer("🔄 Apuesta anulada", show_alert=False)
        await context.bot.send_message(
            chat_id=user_id,
            text=(
                f"📋 *Registrado en DualStats*\n━━━━━━━━━━━━━━━━━━\n\n"
                f"{emoji_dep} *{evento_txt}*\n\n"
                f"🔄 Apuesta anulada y registrada. Tu stake será devuelto. 📋"
            ),
            parse_mode="Markdown"
        )
    elif resultado_str == "CASHOUT":
        signo = "+" if (ganancia_real or 0) >= 0 else ""
        pnl_txt = f"*{signo}{fmt_eur(ganancia_real)}€*" if ganancia_real is not None else ""
        await query.answer(f"💸 Cashout registrado{' — ' + (signo + fmt_eur(ganancia_real) + '€') if ganancia_real is not None else ''}", show_alert=False)
        await context.bot.send_message(
            chat_id=user_id,
            text=(
                f"📋 *Registrado en DualStats*\n━━━━━━━━━━━━━━━━━━\n\n"
                f"{emoji_dep} *{evento_txt}*\n"
                f"{'💰 Cashout: ' + pnl_txt if pnl_txt else ''}\n\n"
                f"💰 ¡Cashout registrado! Has asegurado tu beneficio anticipado. 💵"
            ),
            parse_mode="Markdown"
        )

    await mostrar_resultados(query, context, user_id=user_id, edit=True)


# ── Cashout: flujo de 2 pasos (preguntar importe) ─────────────────────────

async def handle_cashout_pregunta(update, context, user_id, rid):
    """
    Intercepta el botón CASHOUT: inicia el flujo per-pierna con teclado numérico.
    Pregunta el importe cerrado en CADA casa de apuestas por separado.
    """
    query = update.callback_query
    lista = _uid_resultados(user_id)
    reg   = next((r for r in lista if r["id"] == rid), None)
    if not reg:
        await query.answer("Apuesta no encontrada", show_alert=True)
        return

    legs_raw   = reg.get("legs", [])
    stakes_raw = reg.get("stakes", [])
    total      = sum(s for s in stakes_raw if s) if stakes_raw else 0.0
    evento_txt = reg.get("evento", "Apuesta")

    legs_info = []
    for i, leg in enumerate(legs_raw):
        stake = (stakes_raw[i] if i < len(stakes_raw) else None) or 0.0
        legs_info.append({
            "bookmaker": leg.get("bookmaker", f"Casa {i + 1}"),
            "stake":     round(stake, 2),
        })

    if not legs_info:
        await query.answer("Sin piernas registradas", show_alert=True)
        return

    context.user_data["pending_cashout"] = {
        "rid":           rid,
        "evento_txt":    evento_txt,
        "total":         total,
        "legs_info":     legs_info,
        "leg_amounts":   [],
        "current_valor": "",
    }

    leg_count = len(legs_info)
    leg_0     = legs_info[0]
    await query.answer()
    await query.edit_message_text(
        f"💸 *Cashout — {evento_txt}*\n"
        f"━━━━━━━━━━━━━━━━━━\n\n"
        f"*Casa {1}/{leg_count}: {leg_0['bookmaker']}*\n"
        f"Stake apostado: *{fmt_eur(leg_0['stake'])}€*\n\n"
        f"¿Por cuánto has cerrado en esta casa?",
        reply_markup=InlineKeyboardMarkup(
            teclado_cashout_numerico(rid, 0, leg_count, "")
        ),
        parse_mode="Markdown",
    )


async def handle_cashout_numerico(update, context, user_id, rid, leg_idx, accion):
    """Procesa los pulsadores del teclado de cashout (CSH|rid|leg_idx|accion)."""
    query   = update.callback_query
    pending = context.user_data.get("pending_cashout", {})

    if not pending or pending.get("rid") != rid:
        await query.answer("Sesión expirada. Pulsa Cashout de nuevo.", show_alert=True)
        return

    legs_info  = pending.get("legs_info", [])
    leg_count  = len(legs_info)
    leg_amounts = pending.get("leg_amounts", [])
    valor       = pending.get("current_valor", "")

    if leg_idx != len(leg_amounts):
        await query.answer()
        return

    if accion == "back":
        valor = valor[:-1]
    elif accion == "confirm":
        if not valor:
            await query.answer("Introduce un importe primero", show_alert=True)
            return
        try:
            amount = round(float(valor), 2)
            if amount < 0:
                raise ValueError()
        except ValueError:
            await query.answer("Importe no válido", show_alert=True)
            return

        leg_amounts.append(amount)
        pending["leg_amounts"]   = leg_amounts
        pending["current_valor"] = ""
        context.user_data["pending_cashout"] = pending

        if len(leg_amounts) >= leg_count:
            await _finalizar_cashout(update, context, user_id)
        else:
            next_idx = len(leg_amounts)
            next_leg = legs_info[next_idx]
            prev_leg = legs_info[leg_idx]
            await query.answer()
            await query.edit_message_text(
                f"💸 *Cashout — {pending['evento_txt']}*\n"
                f"━━━━━━━━━━━━━━━━━━\n\n"
                f"✅ {prev_leg['bookmaker']}: *{fmt_eur(amount)}€*\n\n"
                f"*Casa {next_idx + 1}/{leg_count}: {next_leg['bookmaker']}*\n"
                f"Stake apostado: *{fmt_eur(next_leg['stake'])}€*\n\n"
                f"¿Por cuánto has cerrado en esta casa?",
                reply_markup=InlineKeyboardMarkup(
                    teclado_cashout_numerico(rid, next_idx, leg_count, "")
                ),
                parse_mode="Markdown",
            )
        return
    elif accion == ".":
        if "." in valor:
            await query.answer("Ya hay un punto decimal")
            return
        valor = valor + "."
    elif len(valor) >= 8:
        await query.answer("Máximo 8 dígitos")
        return
    else:
        valor = valor + accion

    pending["current_valor"] = valor
    context.user_data["pending_cashout"] = pending

    current_leg = legs_info[leg_idx]
    await query.edit_message_text(
        f"💸 *Cashout — {pending['evento_txt']}*\n"
        f"━━━━━━━━━━━━━━━━━━\n\n"
        f"*Casa {leg_idx + 1}/{leg_count}: {current_leg['bookmaker']}*\n"
        f"Stake apostado: *{fmt_eur(current_leg['stake'])}€*\n\n"
        f"¿Por cuánto has cerrado en esta casa?",
        reply_markup=InlineKeyboardMarkup(
            teclado_cashout_numerico(rid, leg_idx, leg_count, valor)
        ),
        parse_mode="Markdown",
    )
    await query.answer()


async def _finalizar_cashout(update, context, user_id):
    """Una vez recogidos todos los importes por pierna, actualiza BD y llama a DualStats."""
    query       = update.callback_query
    pending     = context.user_data.pop("pending_cashout", {})
    rid         = pending.get("rid")
    evento_txt  = pending.get("evento_txt", "")
    legs_info   = pending.get("legs_info", [])
    leg_amounts = pending.get("leg_amounts", [])
    total       = pending.get("total", 0.0)

    total_cashout = round(sum(leg_amounts), 2)
    ganancia_real = round(total_cashout - total, 2)

    # Actualizar BD local
    lista = _uid_resultados(user_id)
    reg   = next((r for r in lista if r["id"] == rid), None)
    if reg:
        reg["estado"]           = "CASHOUT"
        reg["ts_result"]        = local_now().isoformat()
        reg["ganancia_real"]    = ganancia_real
        reg["cashout_amount"]   = total_cashout
        reg["cashout_per_leg"]  = leg_amounts
        guardar_db()

    # Enviar a DualStats con importes por pierna
    if user_id in dualstats_vinculados:
        per_leg = [{"leg": i, "amount": amt} for i, amt in enumerate(leg_amounts)]
        payload = {
            "telegram_id":    user_id,
            "apuesta_id":     rid,
            "resultado":      "CASHOUT",
            "per_leg_cashout": per_leg,
            "ganancia_real":  ganancia_real,
        }
        await llamar_api_dualstats("records/result", payload)

    # Confirmación
    signo    = "+" if ganancia_real >= 0 else ""
    pnl_txt  = f"*{signo}{fmt_eur(ganancia_real)}€*"
    sport_key = reg.get("sport_key", "") if reg else ""
    emoji_dep, _ = SPORT_DISPLAY.get(sport_key, ("🏅", ""))

    legs_detail = "\n".join(
        f"   📕 {legs_info[i]['bookmaker']}: *{fmt_eur(leg_amounts[i])}€*"
        for i in range(len(leg_amounts))
        if i < len(legs_info)
    )

    await query.edit_message_text(
        f"✅ *Cashout registrado*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"{emoji_dep} *{evento_txt}*\n\n"
        f"Importes recibidos:\n{legs_detail}\n\n"
        f"💰 Total: *{fmt_eur(total_cashout)}€*\n"
        f"📊 P&L: {pnl_txt}",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🏆 Resultados", callback_data="DS_resultados"),
            InlineKeyboardButton("🏠 Menú",       callback_data="menu_principal"),
        ]]),
        parse_mode="Markdown",
    )


# ── Recordatorios automáticos (tarea periódica) ──────────

async def tarea_recordatorios_pendientes(context: ContextTypes.DEFAULT_TYPE):
    """
    Cada hora verifica pendientes sin completar y envía recordatorios
    a las 12h y 24h. A las 48h auto-registra con datos aproximados.
    """
    ahora = local_now()
    for user_id, lista in list(pendientes.items()):
        for p in list(lista):
            if p.get("estado") != "PENDIENTE":
                continue
            try:
                ts    = datetime.fromisoformat(p["ts"])
                horas = (ahora - ts).total_seconds() / 3600
            except:
                continue

            recordatorio_12 = p.get("rec_12", False)
            recordatorio_24 = p.get("rec_24", False)

            # Recordatorio 12h
            if horas >= 12 and not recordatorio_12:
                p["rec_12"] = True
                try:
                    await context.bot.send_message(chat_id=user_id,
                        text=(f"⏰ *Recordatorio — Tienes apuestas pendientes*\n\n"
                              f"Llevas {int(horas)}h con apuestas sin registrar:\n\n"
                              f"• {p['evento']}\n\n"
                              f"Registrarlas te lleva menos de 1 minuto."),
                        parse_mode="Markdown",
                        reply_markup=InlineKeyboardMarkup([[
                            InlineKeyboardButton("✏️ Ir a pendientes", callback_data="DS_pendientes"),
                        ]]))
                except: pass
                guardar_db()

            # Recordatorio 24h
            elif horas >= 24 and not recordatorio_24:
                p["rec_24"] = True
                try:
                    await context.bot.send_message(chat_id=user_id,
                        text=(f"⏰ *Último aviso — Apuesta pendiente*\n\n"
                              f"Han pasado {int(horas)}h desde que la marcaste como hecha.\n\n"
                              f"• {p['evento']}\n\n"
                              f"En ~{int(48-horas)}h se registrará automáticamente con los datos de la alerta original."),
                        parse_mode="Markdown",
                        reply_markup=InlineKeyboardMarkup([[
                            InlineKeyboardButton("✏️ Completar ahora", callback_data=f"PC_{p['id']}"),
                        ]]))
                except: pass
                guardar_db()

            # Auto-registro a las 48h
            elif horas >= 48:
                stakes = [redondear_stake(p["stake_sug"] * p["legs"][i]["stake_pct"] / 100)
                          for i in range(len(p["legs"]))]
                odds   = [p["legs"][i]["odd"] for i in range(len(p["legs"]))]
                total  = sum(stakes)
                registro = {
                    "id":          p["id"],
                    "ts":          p["ts"],
                    "ts_reg":      ahora.isoformat(),
                    "evento":      p["evento"],
                    "sport_key":   p["sport_key"],
                    "legs":        p["legs"],
                    "stakes":      stakes,
                    "odds":        odds,
                    "stake_total": total,
                    "ganancia_est": round(stakes[0]*odds[0]-total, 2),
                    "tipo":        p["tipo"],
                    "estado":      "PLACED",
                    "aproximado":  True,
                    "web_sync":    False,
                }
                agregar_resultado_local(user_id, registro)
                eliminar_pendiente(user_id, p["id"])
                # Intentar sincronizar con DualStats
                if user_id in dualstats_vinculados:
                    payload = {
                        "telegram_id":    user_id,
                        "bot_pending_id": p["id"],
                        "apuesta": {
                            "evento":     p["evento"],
                            "sport":      p["sport_key"],
                            "legs":       [{"bookmaker": p["legs"][i]["bookmaker"],
                                            "outcome":   formatear_outcome(p["legs"][i]),
                                            "odd":       odds[i], "stake": stakes[i]}
                                           for i in range(len(p["legs"]))],
                            "tipo":       p["tipo"],
                            "fuente":     "auto",
                            "aproximado": True,
                        }
                    }
                    await llamar_api_dualstats("records", payload)
                try:
                    await context.bot.send_message(chat_id=user_id,
                        text=(f"📥 *Auto-registrada en DualStats*\n\n"
                              f"La siguiente apuesta se ha registrado automáticamente "
                              f"con los datos de la alerta original _(pueden no ser exactos)_:\n\n"
                              f"• {p['evento']}\n"
                              f"⚠️ Marcada como *Datos aproximados*\n\n"
                              f"Puedes corregir los datos reales desde la web o usando /resultados."),
                        parse_mode="Markdown",
                        reply_markup=InlineKeyboardMarkup([[
                            InlineKeyboardButton("🏆 Ver resultados", callback_data="DS_resultados"),
                        ]]))
                except: pass

# ── Desvincular cuenta ────────────────────────────────────

async def handle_desvincular(update, context):
    query   = update.callback_query
    user_id = update.effective_user.id
    dualstats_vinculados.discard(user_id)
    guardar_db()
    await query.edit_message_text(
        "🔓 *Cuenta desvinculada*\n\n"
        "Tu cuenta de FidesBot ya no está conectada a DualStats Tracker.\n"
        "Puedes volver a vincularla desde Configuración en la web.",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🔙 Volver", callback_data="menu_principal"),
        ]]), parse_mode="Markdown")

# ── Texto del flujo de completar ─────────────────────────

async def handle_flow_texto(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Intercepta texto durante el flujo de completar un pendiente."""
    flow    = context.user_data.get("ds_flow", {})
    step    = flow.get("step", "")
    user_id = update.effective_user.id
    text    = update.message.text.strip().replace(",", ".")
    pid     = flow.get("pid")
    p       = get_pendiente(user_id, pid) if pid else None

    if not p:
        del context.user_data["ds_flow"]
        await update.message.reply_text(
            "❌ La apuesta ya no existe. Usa /pendientes para ver tus pendientes.")
        return

    if step.startswith("stake_leg_"):
        leg_idx = int(step.split("_")[-1])
        try:
            value = float(text)
            if value <= 0: raise ValueError
        except ValueError:
            await update.message.reply_text("❌ Introduce un importe válido (ej: 95 o 47.5)")
            return
        flow["stakes"][leg_idx] = value
        next_idx = leg_idx + 1
        if next_idx < len(p["legs"]):
            await _preguntar_stake_leg(update, context, p, next_idx)
        else:
            # Todos los stakes recogidos → preguntar cuotas
            await update.message.reply_text(
                "✅ Stakes registrados.",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("✅ Sí, mismas cuotas",  callback_data=f"FL_oc_yes_{pid}"),
                    InlineKeyboardButton("⚠️ No, cambiaron",      callback_data=f"FL_oc_no_{pid}"),
                ]]))
            flow["step"] = "odds_confirm"
        context.user_data["ds_flow"] = flow

    elif step.startswith("odds_leg_"):
        leg_idx = int(step.split("_")[-1])
        try:
            value = float(text)
            if value <= 1.0: raise ValueError
        except ValueError:
            await update.message.reply_text("❌ Introduce una cuota válida (ej: 2.10)")
            return
        flow["odds"][leg_idx] = value
        next_idx = leg_idx + 1
        if next_idx < len(p["legs"]):
            await _preguntar_odd_leg(update, context, p, next_idx)
        else:
            # Todas las cuotas recogidas → mostrar resumen
            context.user_data["ds_flow"] = flow
            # Necesitamos editar un mensaje existente, pero venimos de texto.
            # Enviamos un nuevo mensaje de resumen.
            stakes = [flow["stakes"][i] if flow["stakes"][i] is not None
                      else redondear_stake(p["stake_sug"]*p["legs"][i]["stake_pct"]/100)
                      for i in range(len(p["legs"]))]
            odds   = [flow["odds"][i] if flow["odds"][i] is not None
                      else p["legs"][i]["odd"]
                      for i in range(len(p["legs"]))]
            flow["stakes"] = stakes; flow["odds"] = odds
            flow["step"]   = "summary"
            context.user_data["ds_flow"] = flow
            resumen   = _resumen_flow(p, stakes, odds)
            vinculado = user_id in dualstats_vinculados
            btn_label = "✅ Registrar en DualStats" if vinculado else "✅ Guardar localmente"
            await update.message.reply_text(
                resumen + "\n\n━━━━━━━━━━━━━━━━━━\n¿Todo correcto?",
                reply_markup=InlineKeyboardMarkup([
                    [InlineKeyboardButton(btn_label,    callback_data=f"FL_confirm_{pid}"),
                     InlineKeyboardButton("Corregir",    callback_data=f"FK_sel_{pid}")],
                    [InlineKeyboardButton("❌ Cancelar", callback_data="DS_pendientes")],
                ]), parse_mode="Markdown")
        context.user_data["ds_flow"] = flow

# ============================================================
# CALLBACKS — MANEJADOR PRINCIPAL
# ============================================================
async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query   = update.callback_query
    await query.answer()
    data    = query.data
    user_id = update.effective_user.id

    # ── Admin ──────────────────────────────────────────────
    if data.startswith("admin_"):
        if user_id in ADMIN_IDS: await handle_admin_callback(update, context)
        return

    # ── Sin suscripción ────────────────────────────────────
    if data == "bloqueado":
        await query.answer(BLOQUEADO_MSG, show_alert=True); return
    if data == "menu_no_suscrito": await menu_no_suscrito(update); return
    if data == "suscribirse":          await mostrar_suscripcion(update, context); return
    # Nuevos botones Stripe
    if data == "stripe_bot_7":       await pagar_plan_stripe(update, context, "bot_7"); return
    if data == "stripe_bot_14":      await pagar_plan_stripe(update, context, "bot_14"); return
    if data == "stripe_bot_30":      await pagar_plan_stripe(update, context, "bot_30"); return
    if data == "stripe_bot_tracker": await pagar_plan_stripe(update, context, "bot_tracker"); return
    # Callbacks legacy (por si hay mensajes viejos en caché de Telegram)
    if data == "plan_7":               await pagar_plan_stripe(update, context, "bot_7"); return
    if data == "plan_14":              await pagar_plan_stripe(update, context, "bot_14"); return
    if data == "plan_30":              await pagar_plan_stripe(update, context, "bot_30"); return
    if data == "plan_tracker_30":      await pagar_plan_stripe(update, context, "bot_tracker"); return
    if data.startswith("admin_activar_rapido_") and user_id in ADMIN_IDS:
        parts        = data.split("_")
        uid_activar  = int(parts[3]); nombre_activar = parts[4]; dias_activar = int(parts[5])
        es_tracker   = len(parts) > 6 and parts[6] == "T"
        activar_usuario(uid_activar, nombre_activar, dias_activar)
        plan_txt = "PRO+Tracker" if es_tracker else "PRO"
        await query.edit_message_text(
            f"✅ *Activado correctamente*\n\n👤 {nombre_activar} (ID: `{uid_activar}`)\n📅 {dias_activar} días — {plan_txt}",
            parse_mode="Markdown")
        try:
            msg_plan = "🔗 *FidesBot PRO+Tracker*\n✅ Alertas ilimitadas + DualStats Tracker incluido." if es_tracker else "💎 *FidesBot PRO*\n✅ Alertas ilimitadas activadas."
            await context.bot.send_message(chat_id=uid_activar,
                text=f"🎉 ¡Tu suscripción ha sido activada!\n\n{msg_plan}\n\n"
                     f"Tienes *{dias_activar} días* de acceso.\n\nEscribe /start para acceder.",
                parse_mode="Markdown")
        except: pass
        return
    if data == "soporte":       await mostrar_soporte(update, context); return
    if data == "tyc":           await mostrar_tyc(update, context); return
    if data == "panel_freebets":  await panel_freebets(update, context); return
    if data == "panel_valuebets": await panel_valuebets(update, context); return
    if data == "mis_referidos":   await mis_referidos(update, context); return
    if data == "mis_creditos":    await mis_creditos(update, context); return
    if data.startswith("freebet_casa_"):
        await freebet_casa_seleccionada(update, context, data.replace("freebet_casa_","")); return

    # ── Requiere suscripción ───────────────────────────────
    if not tiene_suscripcion(user_id):
        await query.answer(BLOQUEADO_MSG, show_alert=True); return

    cfg = get_config(user_id)

    # ── Navegación básica ──────────────────────────────────
    if   data == "menu_principal":  await menu_principal(update, context)
    elif data == "panel_surebets":  await panel_surebets(update, context)
    elif data == "panel_middles":   await panel_middles(update, context)
    elif data == "menu_alertas":    await menu_alertas(update, context)
    elif data == "menu_config":     await menu_config(update, context)
    elif data == "cfg_deportes":    await menu_cfg_deportes(update, context)
    elif data == "cfg_casas":       await menu_cfg_casas(update, context)
    elif data == "cfg_profit_surebet": await mostrar_teclado_numerico(update, context, "profit_surebet")
    elif data == "cfg_profit_middle":  await mostrar_teclado_numerico(update, context, "profit_middle")
    elif data == "cfg_prob_middle":    await mostrar_teclado_numerico(update, context, "prob_middle")
    elif data == "cfg_profit_value":   await mostrar_teclado_numerico(update, context, "profit_value")
    elif data == "cfg_days":        await mostrar_teclado_numerico(update, context, "days")
    elif data == "set_stake":       await mostrar_teclado_numerico(update, context, "stake")
    elif data == "ver_estado":      await ver_estado(update, context)

    elif data == "toggle_surebets":
        cfg["surebets_on"] = not cfg.get("surebets_on", True); guardar_db()
        await menu_alertas(update, context)
    elif data == "toggle_middles":
        cfg["middlebets_on"] = not cfg.get("middlebets_on", False); guardar_db()
        await menu_alertas(update, context)
    elif data == "toggle_valuebets":
        cfg["valuebets_on"] = not cfg.get("valuebets_on", False); guardar_db()
        await menu_alertas(update, context)
    elif data == "toggle_live":
        cfg["surebets_live_on"] = not cfg.get("surebets_live_on", True); guardar_db()
        await menu_alertas(update, context)
    elif data == "alertas_todas":
        cfg["surebets_on"]=True; cfg["middlebets_on"]=True
        cfg["valuebets_on"]=True; cfg["surebets_live_on"]=True
        guardar_db(); await menu_alertas(update, context)
    elif data == "alertas_ninguna":
        cfg["surebets_on"]=False; cfg["middlebets_on"]=False
        cfg["valuebets_on"]=False; cfg["surebets_live_on"]=False
        guardar_db(); await menu_alertas(update, context)
    elif data == "deportes_todos":
        for k in cfg["sports"]: cfg["sports"][k] = True
        guardar_db(); await menu_cfg_deportes(update, context)
    elif data == "deportes_ninguno":
        for k in cfg["sports"]: cfg["sports"][k] = False
        guardar_db(); await menu_cfg_deportes(update, context)
    elif data == "casas_todas":
        for k in cfg["bookmakers"]: cfg["bookmakers"][k] = True
        guardar_db(); await menu_cfg_casas(update, context)
    elif data == "casas_ninguna":
        for k in cfg["bookmakers"]: cfg["bookmakers"][k] = False
        guardar_db(); await menu_cfg_casas(update, context)
    elif data.startswith("sport_"):
        k = data.replace("sport_","")
        if k in cfg["sports"]: cfg["sports"][k] = not cfg["sports"][k]; guardar_db()
        await menu_cfg_deportes(update, context)
    elif data.startswith("book_"):
        k = data.replace("book_","")
        if k in cfg["bookmakers"]: cfg["bookmakers"][k] = not cfg["bookmakers"][k]; guardar_db()
        await menu_cfg_casas(update, context)
    elif data.startswith("NM|"):
        parts = data.split("|")
        await handle_numerico(update, context, parts[1], parts[2])
    elif data == "escanear_ahora":
        await query.edit_message_text("🔍 Escaneando apuestas... espera un momento.")
        total_pre  = await escanear_y_alertar(context.application, live=False, user_ids=[user_id])
        total_live = await escanear_y_alertar(context.application, live=True,  user_ids=[user_id])
        total = total_pre + total_live
        ultimo_escaneo[user_id] = datetime.now()
        if total == 0:
            await query.edit_message_text(
                "🔍 *Escaneo completado*\n\n❌ No se han encontrado apuestas con tu configuración.\n\n"
                "💡 Prueba a bajar el profit mínimo en ⚙️ Configuración.",
                parse_mode="Markdown")
        else:
            await query.edit_message_text(f"✅ *{total} apuesta(s) encontradas y enviadas.*", parse_mode="Markdown")
        await asyncio.sleep(3)
        await menu_principal(update, context)

    # ── DualStats callbacks ────────────────────────────────
    elif data == "panel_dualstats":    await panel_dualstats(update, context)
    elif data == "DS_pendientes" or data.startswith("DS_pendientes_p"):
        page = 0
        if data.startswith("DS_pendientes_p"):
            try: page = int(data[len("DS_pendientes_p"):])
            except: page = 0
        await mostrar_pendientes(update, context, page=page)
    elif data == "DS_resultados" or data.startswith("DS_resultados_p"):
        page = 0
        if data.startswith("DS_resultados_p"):
            try: page = int(data[len("DS_resultados_p"):])
            except: page = 0
        await mostrar_resultados(update, context, page=page)
    elif data == "DS_desvincular":     await handle_desvincular(update, context)
    elif data == "DS_info_vincular":
        await query.edit_message_text(
            "🔗 *Cómo vincular FidesBot con DualStats Tracker*\n━━━━━━━━━━━━━━━━━━\n\n"
            "1️⃣ Ve a *dualstats-tracker.vercel.app*\n"
            "2️⃣ Inicia sesión con tu cuenta\n"
            "3️⃣ Abre *Configuración → Conectar FidesBot*\n"
            "4️⃣ Pulsa el botón y acepta en Telegram\n\n"
            "Una vez vinculado, las alertas mostrarán botones ✅/❌.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="panel_dualstats")]]),
            parse_mode="Markdown")

    # ── Alertas ✅/❌ ──────────────────────────────────────
    elif data.startswith("AH_"):
        parts = data.split("_", 2)
        if len(parts) == 3:
            await handle_alerta_hecha(update, context, int(parts[1]), parts[2])
    elif data.startswith("ANH_"):
        parts = data.split("_", 2)
        if len(parts) == 3:
            await handle_alerta_nohecha(update, context, int(parts[1]), parts[2])

    # ── Completar pendiente ────────────────────────────────
    elif data.startswith("PC_"):
        pid = data[3:]
        await iniciar_completar_pendiente(update, context, user_id, pid)

    # ── Eliminar pendiente ─────────────────────────────────
    elif data.startswith("PE_"):
        pid = data[3:]
        p   = get_pendiente(user_id, pid)
        if not p:
            await query.answer("⚠️ No encontrado", show_alert=True); return
        await query.edit_message_text(
            f"🗑 *¿Eliminar este pendiente?*\n\n"
            f"• {p['evento']}\n\n"
            f"_Esta acción no se puede deshacer._",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("✅ Sí, eliminar", callback_data=f"PEC_{pid}"),
                 InlineKeyboardButton("← Cancelar",     callback_data="DS_pendientes")],
            ]), parse_mode="Markdown")
    elif data.startswith("PEC_"):
        pid = data[4:]
        eliminar_pendiente(user_id, pid)
        await query.answer("🗑 Pendiente eliminado")
        await mostrar_pendientes(update, context)

    # ── Flujo — respuestas de botones ──────────────────────
    elif data.startswith("FL_sc_yes_"):
        pid  = data[len("FL_sc_yes_"):]
        flow = context.user_data.get("ds_flow", {"pid": pid, "stakes": [], "odds": [], "step": ""})
        flow["pid"] = pid; flow["stakes"] = [None]*len(get_pendiente(user_id,pid)["legs"])
        flow["odds"] = [None]*len(get_pendiente(user_id,pid)["legs"])
        context.user_data["ds_flow"] = flow
        await _mostrar_odds_confirm(query, context, get_pendiente(user_id, pid), flow)

    elif data.startswith("FL_sc_no_"):
        pid  = data[len("FL_sc_no_"):]
        p    = get_pendiente(user_id, pid)
        flow = context.user_data.get("ds_flow", {})
        flow.update({"pid": pid, "stakes": [None]*len(p["legs"]), "odds": [None]*len(p["legs"])})
        context.user_data["ds_flow"] = flow
        await _preguntar_stake_leg(update, context, p, 0)

    elif data.startswith("FL_oc_yes_"):
        pid  = data[len("FL_oc_yes_"):]
        p    = get_pendiente(user_id, pid)
        flow = context.user_data.get("ds_flow", {"pid": pid, "stakes": [None]*len(p["legs"]), "odds": [None]*len(p["legs"])})
        context.user_data["ds_flow"] = flow
        await _mostrar_resumen(query, context, p, flow)

    elif data.startswith("FL_oc_no_"):
        pid  = data[len("FL_oc_no_"):]
        p    = get_pendiente(user_id, pid)
        flow = context.user_data.get("ds_flow", {"pid": pid, "stakes": [None]*len(p["legs"]), "odds": [None]*len(p["legs"])})
        context.user_data["ds_flow"] = flow
        await _preguntar_odd_leg(update, context, p, 0)

    elif data.startswith("FL_confirm_"):
        pid = data[len("FL_confirm_"):]
        await handle_flow_confirmado(update, context, user_id, pid)

    # ── Correccion teclado numerico (FK_sel, FK_s/o, FKN|) ────────────────
    elif data.startswith("FK_sel_"):
        pid = data[7:]
        p   = get_pendiente(user_id, pid)
        flow = context.user_data.get("ds_flow", {})
        if p: await mostrar_correccion_selector(query, context, p, flow)
        else: await query.answer("Pendiente no encontrado", show_alert=True)

    elif data.startswith("FK_s") or data.startswith("FK_o"):
        # FK_s0_pid  /  FK_o1_pid
        parts      = data.split("_", 2)   # ['FK', 's0', pid]  or  ['FK', 'o1', pid]
        field_code = parts[1]
        pid        = parts[2]
        p          = get_pendiente(user_id, pid)
        if not p:
            await query.answer("Pendiente no encontrado", show_alert=True); return
        context.user_data.setdefault("ds_flow", {}).setdefault("stakes", [None]*len(p["legs"]))
        context.user_data["ds_flow"].setdefault("odds",   [None]*len(p["legs"]))
        context.user_data["ds_flow"]["pid"] = pid
        context.user_data[f"fn_{field_code}_{pid}"] = ""
        is_stake   = field_code.startswith("s")
        leg_idx    = int(field_code[1])
        if is_stake:
            await _preguntar_stake_leg(update, context, p, leg_idx)
        else:
            await _preguntar_odd_leg(update, context, p, leg_idx)

    elif data.startswith("FKN|"):
        parts = data.split("|")   # ['FKN', 'field_code', 'pid', 'action']
        if len(parts) == 4:
            await handle_flow_numerico(update, context, parts[1], parts[2], parts[3])

    elif data.startswith("FL_verres_"):
        pid  = data[10:]
        p    = get_pendiente(user_id, pid)
        flow = context.user_data.get("ds_flow", {})
        if p: await _mostrar_resumen(query, context, p, flow)
        else: await query.answer("Pendiente no encontrado", show_alert=True)

    # ── Resultados ─────────────────────────────────────────
    elif data.startswith("RES_ganada_"):
        await handle_ganada_selector(update, context, user_id, data[11:])
    elif data.startswith("RES_won0_"):
        await handle_resultado(update, context, user_id, data[9:],  "WON", won_leg=0)
    elif data.startswith("RES_won1_"):
        await handle_resultado(update, context, user_id, data[9:],  "WON", won_leg=1)
    elif data.startswith("RES_wonB_"):
        await handle_resultado(update, context, user_id, data[9:],  "WON", won_leg="both")
    elif data.startswith("RES_lost_"):
        await handle_resultado(update, context, user_id, data[9:],  "LOST")
    elif data.startswith("RES_void_"):
        await handle_resultado(update, context, user_id, data[9:],  "VOID")
    elif data.startswith("RES_cash_"):
        await handle_cashout_pregunta(update, context, user_id, data[9:])
    elif data.startswith("CSH|"):
        parts = data.split("|")   # ['CSH', rid, leg_idx, accion]
        if len(parts) == 4:
            await handle_cashout_numerico(update, context, user_id, parts[1], int(parts[2]), parts[3])
    elif data == "NOOP":
        await query.answer()
    elif data.startswith("CASH_CANCEL_"):
        context.user_data.pop("pending_cashout", None)
        await query.answer("Cashout cancelado", show_alert=False)
        await query.edit_message_text("❌ Cashout cancelado.")

# ============================================================
# HANDLER DE TEXTO
# ============================================================
async def handle_texto(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text    = update.message.text.strip()

    # ── Flujo DualStats activo (tiene prioridad sobre admin) ──
    if "ds_flow" in context.user_data:
        step = context.user_data["ds_flow"].get("step","")
        if step.startswith("stake_leg_") or step.startswith("odds_leg_"):
            await handle_flow_texto(update, context)
            return

    # ── Solo admin a partir de aquí ───────────────────────
    if user_id not in ADMIN_IDS: return
    waiting = context.user_data.get("admin_waiting")

    if waiting == "activar":
        parts = text.split()
        if len(parts) >= 4 and parts[0].lower() == "activar":
            try:
                uid, nombre, dias = int(parts[1]), parts[2], int(parts[3])
                activar_usuario(uid, nombre, dias)
                await update.message.reply_text(
                    f"✅ *{nombre}* (ID: `{uid}`) activado por *{dias} días*. 💾 Guardado.",
                    parse_mode="Markdown")
                try:
                    await context.bot.send_message(chat_id=uid,
                        text=f"🎉 ¡Bienvenido a *FidesBot*!\n\n✅ Tu suscripción está activa por *{dias} días*.\n\nEscribe /start para acceder.",
                        parse_mode="Markdown")
                except: pass
            except:
                await update.message.reply_text("❌ Formato: `activar ID NOMBRE DIAS`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    elif waiting == "desactivar":
        parts = text.split()
        if len(parts) >= 2 and parts[0].lower() == "desactivar":
            try:
                uid    = int(parts[1])
                nombre = subscriptions.get(uid, {}).get("name", "Usuario")
                desactivar_usuario(uid)
                await update.message.reply_text(f"✅ *{nombre}* desactivado.", parse_mode="Markdown")
            except:
                await update.message.reply_text("❌ Formato: `desactivar ID`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    elif waiting == "creditos":
        parts = text.split()
        if len(parts) >= 3 and parts[0].lower() == "creditos":
            try:
                uid, cantidad = int(parts[1]), int(parts[2])
                add_creditos(uid, cantidad)
                await update.message.reply_text(
                    f"✅ +{cantidad} créditos añadidos a `{uid}`. Total: *{get_creditos(uid)}*",
                    parse_mode="Markdown")
                try:
                    await context.bot.send_message(chat_id=uid,
                        text=f"🎁 *¡Has recibido {cantidad} créditos!*\n\nTotal: *{get_creditos(uid)} créditos*.",
                        parse_mode="Markdown")
                except: pass
            except:
                await update.message.reply_text("❌ Formato: `creditos ID CANTIDAD`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    elif waiting == "broadcast":
        enviados = 0
        for uid in list(subscriptions.keys()):
            if uid in ADMIN_IDS: continue
            if tiene_suscripcion(uid):
                try:
                    await context.bot.send_message(chat_id=uid,
                        text=f"📢 *Mensaje del administrador:*\n\n{text}", parse_mode="Markdown")
                    enviados += 1
                    await asyncio.sleep(0.1)
                except: pass
        await update.message.reply_text(f"✅ Enviado a *{enviados}* usuarios.", parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    # ── Comandos de texto especiales del admin ─────────────
    elif text.lower().startswith("vincular_ds "):
        # Admin puede marcar un usuario como vinculado manualmente (para pruebas)
        try:
            uid = int(text.split()[1])
            dualstats_vinculados.add(uid)
            guardar_db()
            await update.message.reply_text(f"✅ Usuario `{uid}` marcado como vinculado a DualStats.", parse_mode="Markdown")
        except:
            await update.message.reply_text("❌ Formato: `vincular_ds ID`", parse_mode="Markdown")

    elif text.lower().startswith("desvincular_ds "):
        try:
            uid = int(text.split()[1])
            dualstats_vinculados.discard(uid)
            guardar_db()
            await update.message.reply_text(f"✅ Usuario `{uid}` desvinculado de DualStats.", parse_mode="Markdown")
        except:
            await update.message.reply_text("❌ Formato: `desvincular_ds ID`", parse_mode="Markdown")

# ============================================================
# COMANDOS /pendientes y /resultados
# ============================================================
async def cmd_testalerta(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Solo admin. Envia alerta de prueba con formato real.
    Uso: /testalerta [middle] [deporte]
    Deportes: futbol, baloncesto, tenis, golf, hockey, rugby, beisbol, americano, cricket
    Ejemplos:
      /testalerta               -> surebet fútbol
      /testalerta middle        -> middle baloncesto
      /testalerta tenis         -> surebet tenis
      /testalerta middle hockey -> middle hockey
    """
    if update.effective_user.id not in ADMIN_IDS:
        return

    # ── Datos fake por deporte ────────────────────────────────────────────────
    FAKE_EVENTS = {
        "soccer": {
            "home": "Real Madrid", "away": "Barcelona",
            "sport_key": "soccer", "liga": "La Liga",
            "time": "2026-06-10T20:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Real Madrid", "odd": 2.10, "stake_pct": 48.78, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Barcelona",   "odd": 2.15, "stake_pct": 51.22, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bet365",  "outcome": "Over",  "odd": 1.90, "stake_pct": 50.0, "point": 2.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.05, "stake_pct": 50.0, "point": 3.5, "description": ""},
            ],
            "profit_sure": 2.37, "profit_base": 0.8, "profit_max": 7.2, "prob_mid": 28.0,
        },
        "basketball_nba": {
            "home": "Lakers", "away": "Warriors",
            "sport_key": "basketball_nba", "liga": "NBA",
            "time": "2026-06-10T21:30:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Lakers",  "odd": 2.05, "stake_pct": 50.0, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Warriors","odd": 2.08, "stake_pct": 50.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bet365",  "outcome": "Over",  "odd": 1.95, "stake_pct": 50.0, "point": 218.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.10, "stake_pct": 50.0, "point": 221.5, "description": ""},
            ],
            "profit_sure": 1.82, "profit_base": 1.2, "profit_max": 8.5, "prob_mid": 34.0,
        },
        "tennis": {
            "home": "Alcaraz", "away": "Sinner",
            "sport_key": "tennis", "liga": "ATP Masters",
            "time": "2026-06-11T14:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bwin",    "outcome": "Alcaraz", "odd": 1.85, "stake_pct": 54.05, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Sinner",  "odd": 2.20, "stake_pct": 45.95, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bet365",  "outcome": "Over",  "odd": 1.88, "stake_pct": 50.0, "point": 21.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.00, "stake_pct": 50.0, "point": 23.5, "description": ""},
            ],
            "profit_sure": 2.94, "profit_base": 0.5, "profit_max": 6.3, "prob_mid": 22.0,
        },
        "golf": {
            "home": "Rory McIlroy", "away": "Scottie Scheffler",
            "sport_key": "golf", "liga": "PGA Tour",
            "time": "2026-06-12T16:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "McIlroy",  "odd": 2.20, "stake_pct": 47.73, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Scheffler", "odd": 2.25, "stake_pct": 52.27, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bwin",    "outcome": "Over",  "odd": 1.92, "stake_pct": 50.0, "point": 68.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.05, "stake_pct": 50.0, "point": 70.5, "description": ""},
            ],
            "profit_sure": 2.17, "profit_base": 0.9, "profit_max": 5.8, "prob_mid": 19.0,
        },
        "icehockey_nhl": {
            "home": "Toronto Maple Leafs", "away": "Boston Bruins",
            "sport_key": "icehockey_nhl", "liga": "NHL",
            "time": "2026-06-10T22:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Toronto", "odd": 2.15, "stake_pct": 49.0, "point": None, "description": ""},
                {"bookmaker": "Marathonbet","outcome": "Boston","odd": 2.12, "stake_pct": 51.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bet365",  "outcome": "Over",  "odd": 1.91, "stake_pct": 50.0, "point": 5.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.08, "stake_pct": 50.0, "point": 6.5, "description": ""},
            ],
            "profit_sure": 2.05, "profit_base": 0.7, "profit_max": 7.0, "prob_mid": 26.0,
        },
        "rugbyleague": {
            "home": "Wigan Warriors", "away": "St Helens",
            "sport_key": "rugbyleague", "liga": "Super League",
            "time": "2026-06-11T18:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Wigan",     "odd": 2.00, "stake_pct": 51.0, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "St Helens", "odd": 2.05, "stake_pct": 49.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bwin",    "outcome": "Over",  "odd": 1.93, "stake_pct": 50.0, "point": 44.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.06, "stake_pct": 50.0, "point": 47.5, "description": ""},
            ],
            "profit_sure": 1.50, "profit_base": 0.6, "profit_max": 6.5, "prob_mid": 24.0,
        },
        "baseball_mlb": {
            "home": "New York Yankees", "away": "Los Angeles Dodgers",
            "sport_key": "baseball_mlb", "liga": "MLB",
            "time": "2026-06-12T19:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Yankees", "odd": 2.10, "stake_pct": 49.0, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Dodgers", "odd": 2.12, "stake_pct": 51.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Marathonbet","outcome": "Over",  "odd": 1.90, "stake_pct": 50.0, "point": 8.5,  "description": ""},
                {"bookmaker": "Betfair",    "outcome": "Under", "odd": 2.05, "stake_pct": 50.0, "point": 10.5, "description": ""},
            ],
            "profit_sure": 1.96, "profit_base": 0.9, "profit_max": 8.0, "prob_mid": 30.0,
        },
        "americanfootball_nfl": {
            "home": "Kansas City Chiefs", "away": "San Francisco 49ers",
            "sport_key": "americanfootball_nfl", "liga": "NFL",
            "time": "2026-06-15T21:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "Chiefs",  "odd": 2.05, "stake_pct": 50.0, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "49ers",   "odd": 2.10, "stake_pct": 50.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Bwin",    "outcome": "Over",  "odd": 1.95, "stake_pct": 50.0, "point": 47.5, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Under", "odd": 2.08, "stake_pct": 50.0, "point": 50.5, "description": ""},
            ],
            "profit_sure": 2.20, "profit_base": 1.0, "profit_max": 9.0, "prob_mid": 32.0,
        },
        "cricket": {
            "home": "India", "away": "Australia",
            "sport_key": "cricket", "liga": "Test Match",
            "time": "2026-06-13T10:00:00Z",
            "legs_sure": [
                {"bookmaker": "Bet365",  "outcome": "India",     "odd": 2.15, "stake_pct": 48.0, "point": None, "description": ""},
                {"bookmaker": "Betfair", "outcome": "Australia", "odd": 2.20, "stake_pct": 52.0, "point": None, "description": ""},
            ],
            "legs_mid": [
                {"bookmaker": "Marathonbet","outcome": "Over",  "odd": 1.88, "stake_pct": 50.0, "point": 295.5, "description": ""},
                {"bookmaker": "Betfair",    "outcome": "Under", "odd": 2.02, "stake_pct": 50.0, "point": 305.5, "description": ""},
            ],
            "profit_sure": 2.45, "profit_base": 0.7, "profit_max": 6.8, "prob_mid": 20.0,
        },
    }

    # Alias de nombres para el arg del usuario
    SPORT_ALIAS = {
        "futbol": "soccer", "fútbol": "soccer", "football": "soccer",
        "baloncesto": "basketball_nba", "basket": "basketball_nba", "nba": "basketball_nba",
        "tenis": "tennis", "tennis": "tennis",
        "golf": "golf",
        "hockey": "icehockey_nhl", "nhl": "icehockey_nhl",
        "rugby": "rugbyleague",
        "beisbol": "baseball_mlb", "béisbol": "baseball_mlb", "mlb": "baseball_mlb",
        "americano": "americanfootball_nfl", "nfl": "americanfootball_nfl",
        "cricket": "cricket",
    }

    try:
        user_id = update.effective_user.id
        args    = [a.lower() for a in (context.args or [])]

        # Parsear argumentos: /testalerta [middle] [deporte]
        es_middle  = "middle" in args
        sport_args = [a for a in args if a != "middle"]
        sport_input = sport_args[0] if sport_args else None

        # Resolver sport_key
        if sport_input:
            sport_key = SPORT_ALIAS.get(sport_input)
            if not sport_key:
                await update.message.reply_text(
                    f"❓ Deporte '{sport_input}' no reconocido.\n\n"
                    "Deportes disponibles: futbol, baloncesto, tenis, golf, hockey, rugby, beisbol, americano, cricket"
                )
                return
        else:
            sport_key = "basketball_nba" if es_middle else "soccer"

        datos = FAKE_EVENTS[sport_key]
        dualstats_vinculados.add(user_id)
        stake_sug = 100.0
        try:
            stake_sug = float(get_config(user_id).get("stake", 100.0))
        except Exception:
            pass

        event_fake = {
            "home_team": datos["home"], "away_team": datos["away"],
            "commence_time": datos["time"], "sport_title": datos["liga"],
        }

        if es_middle:
            legs_fake = datos["legs_mid"]
            ap_fake   = {"profit_base": datos["profit_base"], "profit_max": datos["profit_max"],
                         "prob_middle": datos["prob_mid"], "legs": legs_fake}
            profit_v  = datos["profit_base"]
            tipo      = "middlebet"
            mensaje   = construir_mensaje_middle(event_fake, ap_fake, sport_key, False)
        else:
            legs_fake = datos["legs_sure"]
            ap_fake   = {"profit": datos["profit_sure"], "legs": legs_fake}
            profit_v  = datos["profit_sure"]
            tipo      = "surebet"
            mensaje   = construir_mensaje_surebet(event_fake, ap_fake, sport_key, False)

        mensaje += "\n\n⚠️ PRUEBA - NO APOSTAR"

        alert_id  = uuid.uuid4().hex[:12]
        cache_key = f"{user_id}_{alert_id}"
        evento    = f"{datos['home']} - {datos['away']}"

        alerta_cache[cache_key] = {
            "evento":    evento,
            "sport_key": sport_key,
            "liga":      datos["liga"],
            "legs":      legs_fake,
            "profit":    profit_v,
            "stake_sug": stake_sug,
            "tipo":      tipo,
            "mensaje":   mensaje,
            "ts":        local_now().isoformat(),
            "time":      datos["time"],
            "msg_id":    0,
        }

        kb = InlineKeyboardMarkup([[
            InlineKeyboardButton("✅ Hecha",    callback_data=f"AH_{user_id}_{alert_id}"),
            InlineKeyboardButton("❌ No hecha", callback_data=f"ANH_{user_id}_{alert_id}"),
        ]])

        sent = await update.message.reply_text(mensaje, reply_markup=kb)
        alerta_cache[cache_key]["msg_id"] = sent.message_id
        emoji, nombre = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
        tipo_label = "Middle" if es_middle else "Surebet"
        await update.message.reply_text(
            f"✅ Alerta de prueba enviada: {tipo_label} {emoji} {nombre}\n"
            f"Cuenta marcada como vinculada para poder probar el registro."
        )

    except Exception as e:
        logger.error(f"Error en cmd_testalerta: {e}", exc_info=True)
        try:
            await update.message.reply_text(f"❌ ERROR: {type(e).__name__}: {e}")
        except Exception:
            pass
async def cmd_resetstats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /resetstats — Borra el historial local de apuestas del usuario (ganadas/perdidas/P&L).
    Solo admins, o el propio usuario para sus propios datos.
    Uso: /resetstats           → borra tus propios stats
         /resetstats 123456789 → (admin) borra stats de otro usuario
    """
    caller_id = update.effective_user.id
    # Determinar a quién borrar
    if context.args and caller_id in ADMIN_IDS:
        try:
            target_id = int(context.args[0])
        except ValueError:
            await update.message.reply_text("❌ ID inválido.")
            return
    else:
        target_id = caller_id

    if resultados_locales.get(target_id):
        n = len(resultados_locales[target_id])
        resultados_locales[target_id] = []
        guardar_db()
        if target_id == caller_id:
            await update.message.reply_text(
                f"🗑️ Historial borrado. Se han eliminado {n} apuesta(s) del registro local.\n\n"
                "Tus estadísticas empiezan desde cero. Las nuevas apuestas se registrarán normalmente."
            )
        else:
            await update.message.reply_text(f"🗑️ Historial del usuario {target_id} borrado ({n} apuesta(s)).")
    else:
        await update.message.reply_text("ℹ️ No hay historial local que borrar.")

async def cmd_pendientes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not tiene_suscripcion(user_id):
        await update.message.reply_text(BLOQUEADO_MSG); return
    lista = _uid_pendientes(user_id)
    if not lista:
        await update.message.reply_text(
            "📋 *Pendientes*\n━━━━━━━━━━━━━━━━━━\n\n"
            "✅ No tienes apuestas pendientes de registrar.",
            parse_mode="Markdown"); return

    total   = len(lista)
    n_pages = max(1, (total + PER_PAGE_PENDIENTES - 1) // PER_PAGE_PENDIENTES)
    chunk   = lista[:PER_PAGE_PENDIENTES]
    pagina_txt = f" · Pág. 1/{n_pages}" if n_pages > 1 else ""
    texto   = f"📋 *Pendientes ({total}){pagina_txt}*\n━━━━━━━━━━━━━━━━━━\n\n"
    keyboard = []
    for i, p in enumerate(chunk, 1):
        emoji, _   = SPORT_DISPLAY.get(p.get("sport_key",""), ("🏅",""))
        tiempo     = _tiempo_relativo(p["ts"])
        tipo_label = "🎯 Middle" if p.get("tipo") == "middlebet" else "⚡ Surebet"
        live_badge = " 🎥 *LIVE*" if p.get("live") else ""
        leg_lines  = "".join(
            f"   📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']} 💰 {l['stake_pct']}%\n"
            for l in p["legs"]
        )
        texto += (f"*{i}.* {emoji} {tipo_label}{live_badge}\n"
                  f"🏆 *{p['evento']}* — {p.get('liga','')}\n"
                  f"{leg_lines}"
                  f"   _{tiempo}_\n\n")
        keyboard.append([
            InlineKeyboardButton(f"✏️ Registrar {i}", callback_data=f"PC_{p['id']}"),
            InlineKeyboardButton("🗑",                  callback_data=f"PE_{p['id']}"),
        ])
    if n_pages > 1:
        keyboard.append([InlineKeyboardButton("Siguiente ▶️", callback_data="DS_pendientes_p1")])
    keyboard.append([InlineKeyboardButton("🏠 Menú", callback_data="menu_principal")])
    await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def cmd_resultados(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not tiene_suscripcion(user_id):
        await update.message.reply_text(BLOQUEADO_MSG); return
    lista = [r for r in _uid_resultados(user_id) if r.get("estado") == "PLACED"]
    if not lista:
        await update.message.reply_text(
            "🏆 *Resultados*\n━━━━━━━━━━━━━━━━━━\n\n"
            "✅ No tienes apuestas pendientes de resultado.",
            parse_mode="Markdown"); return

    total   = len(lista)
    n_pages = max(1, (total + PER_PAGE_RESULTADOS - 1) // PER_PAGE_RESULTADOS)
    chunk   = lista[:PER_PAGE_RESULTADOS]
    pagina_txt = f" · Pág. 1/{n_pages}" if n_pages > 1 else ""
    texto   = f"🏆 *Resultados pendientes ({total}){pagina_txt}*\n━━━━━━━━━━━━━━━━━━\n\n"
    keyboard = []
    for i, r in enumerate(chunk, 1):
        emoji, _   = SPORT_DISPLAY.get(r.get("sport_key",""), ("🏅",""))
        tiempo     = _tiempo_relativo(r["ts"])
        tipo_label = "🎯 Middle" if r.get("tipo") == "middlebet" else "⚡ Surebet"
        live_badge = " 🎥 *LIVE*" if r.get("live") else ""
        stake_txt  = f"{fmt_eur(float(r['stake_total']))}€" if r.get("stake_total") else ""
        leg_lines  = "".join(
            f"   📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']}\n"
            for l in r.get("legs", [])
        )
        texto += (f"*{i}.* {emoji} {tipo_label}{live_badge}\n"
                  f"🏆 *{r['evento']}* — {r.get('liga','')}\n"
                  f"{leg_lines}"
                  f"   {stake_txt}  _{tiempo}_\n\n")
        keyboard.append([
            InlineKeyboardButton(f"✅ Ganada",  callback_data=f"RES_ganada_{r['id']}"),
            InlineKeyboardButton(f"❌ Perdida", callback_data=f"RES_lost_{r['id']}"),
            InlineKeyboardButton(f"🔄 Void",   callback_data=f"RES_void_{r['id']}"),
            InlineKeyboardButton(f"💸 Cash",   callback_data=f"RES_cash_{r['id']}"),
        ])
    if n_pages > 1:
        keyboard.append([InlineKeyboardButton("Siguiente ▶️", callback_data="DS_resultados_p1")])
    keyboard.append([InlineKeyboardButton("🏠 Menú", callback_data="menu_principal")])
    await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

# ============================================================
# MAIN
# ============================================================
async def main():
    await cargar_db()
    app = Application.builder().token(TELEGRAM_TOKEN).build()

    # Comandos existentes
    app.add_handler(CommandHandler("start",     start))
    app.add_handler(CommandHandler("id",        cmd_id))
    app.add_handler(CommandHandler("menu",      menu_principal))
    app.add_handler(CommandHandler("admin",     cmd_admin))
    app.add_handler(CommandHandler("terms",     cmd_terms))
    app.add_handler(CommandHandler("help",      cmd_help))
    app.add_handler(CommandHandler("status",    cmd_status))

    # Nuevos comandos DualStats
    app.add_handler(CommandHandler("vincular",      cmd_vincular))
    app.add_handler(CommandHandler("pendientes",    cmd_pendientes))
    app.add_handler(CommandHandler("resultados",    cmd_resultados))
    app.add_handler(CommandHandler("testalerta",    cmd_testalerta))
    app.add_handler(CommandHandler("resetstats",    cmd_resetstats))

    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_texto))

    # Tareas periódicas
    app.job_queue.run_repeating(tarea_flush_db,                    interval=30,    first=30)   # sync DB → API cada 30s
    app.job_queue.run_repeating(tarea_escaneo,                    interval=BOT_CONFIG["scan_interval"], first=15)
    app.job_queue.run_repeating(tarea_verificar_suscripciones,    interval=3600,  first=60)
    app.job_queue.run_repeating(tarea_recordatorios_pendientes,   interval=3600,  first=120)  # cada 1h

    logger.info("🚀 FidesBot v22 iniciado — DualStats Tracker integration active.")
    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)
    await asyncio.Event().wait()

await main()
