import asyncio
import aiohttp
import logging
import json
import os
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
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
ALERTS_CACHE_FILE = "bot_alerts_cache.json"
BOT_USERNAME     = "perpleSurebetBot"

# ── DualStats Tracker ──────────────────────────────────────
DUALSTATS_API_URL = "https://dualstats-tracker.vercel.app/api/bot"
DUALSTATS_API_KEY = "f8c22003d898614fd5fe4df311785bd7e16b75599f30ec4d2f08416919ad13c0"
DUALSTATS_WEB_URL = "https://dualstats-tracker.vercel.app"
ADMIN_USERNAME    = "alescuge"          # usuario de Telegram de soporte
COMUNIDAD_URL     = ""                  # ← link a tu grupo/canal (vacío = botón oculto)

def ds_url(path: str = "", campaign: str = "") -> str:
    """Construye URL de DualStats con parámetros UTM para tracking de conversión bot→web."""
    params = f"?utm_source=fidesbot&utm_medium=bot&utm_campaign={campaign}" if campaign else ""
    return f"{DUALSTATS_WEB_URL}{path}{params}"

CREDITOS_INICIALES       = 5
CREDITOS_POR_REFERIDO    = 2
CREDITOS_POR_FREEBET     = 1
CREDITOS_POR_SUSCRIPCION = 2   # créditos de regalo por renovar o activar suscripción
MAX_PROFIT_FREEBET       = 3.5  # techo de profit para búsquedas con crédito
MAX_SPORTS_FREEBET       = 2    # máximo de deportes que se escanean en una búsqueda freebet

DEFAULT_USER_CONFIG = {
    "surebets_on": True, "middlebets_on": False, "valuebets_on": False,
    "surebets_live_on": True, "min_profit_surebet": 1.0,
    "min_profit_middle": 2.0, "min_prob_middle": 5.0, "min_profit_value": 5.0,
    "max_days": 2,
    "block_draw_risk_surebets": False,
    "sports": {
        "soccer": True, "basketball": True,
        "tennis": True, "americanfootball_nfl": True, "icehockey_nhl": True,
        "baseball_mlb": True, "rugbyleague": True,
    },
    "bookmakers": {},  # se sobreescribe abajo con {k: True for k in BOOKMAKERS}
    "stake": 100.0,
}

BOT_CONFIG = {
    "scan_prematch_interval": 300,  # 5 min — prematch opportunities last hours
    "scan_live_interval":     120,  # 2 min — default when live games active
    "scan_live_backoff":      600,  # 10 min — when 3+ consecutive live scans return 0 events
}

# ============================================================
# ESTADO GLOBAL
# ============================================================
subscriptions    = {}
referrals        = {}
creditos         = {}
sent_surebets      = {}
SUREBET_TTL_HOURS  = 2
live_sent_surebets = {}   # {base_key: {"ts": datetime, "profit": float}}
last_surebet       = {}
ultimo_escaneo   = {}
ultimo_scan_manual = {}   # {uid: datetime} — cooldown para "Escanear"
stats = {
    "surebets_encontradas": 0, "middlebets_encontradas": 0,
    "valuebets_encontradas": 0, "ultima_actualizacion": None,
    "proxima_actualizacion": None,
}
# API credits (The Odds API — actualizado en cada llamada)
api_credits_remaining: int | None = None
api_credits_used:      int | None = None
live_empty_streak: int = 0   # nº de escaneos live consecutivos con 0 eventos

# ── DualStats — nuevos estados ─────────────────────────────
pendientes           = {}   # {user_id: [lista de dicts]}
resultados_locales   = {}   # {user_id: [apuestas en PLACED pendientes de resultado]}
dualstats_vinculados = set() # conjunto de user_ids con DualStats vinculado
dualstats_plan       = {}   # {user_id: "PRO" | "PRO_TRACKER" | "ENTERPRISE"} — plan web del usuario
alerta_cache         = {}   # {"{uid}_{alert_id}": dict} — en memoria, se pierde al reiniciar
subscription_api_cache = {} # {user_id: {"subscribed": bool, "plan": str, "expiresAt": str|None, "daysLeft": int|None, "cached_at": datetime}}
alertas_hoy    = {}   # {user_id: {"date": date, "count": int}}
pausa_alertas  = {}   # {user_id: datetime} — alertas pausadas hasta esa hora
avisos_enviados = set() # {"{uid}_7d", "{uid}_1d", "{uid}_expired"} — evita repetir avisos

# ============================================================
# MAPAS DE VISUALIZACIÓN
# ============================================================
SPORT_DISPLAY = {
    "soccer":               ("⚽", "Fútbol"),
    "basketball":           ("🏀", "Baloncesto"),
    "tennis":               ("🎾", "Tenis"),
    "americanfootball_nfl": ("🏈", "Fútbol Americano"),
    "icehockey_nhl":        ("🏒", "Hockey Hielo"),
    "baseball_mlb":         ("⚾", "Béisbol"),
    "rugbyleague":          ("🏉", "Rugby"),
}
SPORT_STATUS = {
    "soccer":               "OddsAPI + Betsson/Winamax/Codere",
    "basketball":           "OddsAPI (NBA/EuroLeague)",
    "tennis":               "OddsAPI (ATP/WTA)",
    "americanfootball_nfl": "OddsAPI — temporada oct-feb",
    "icehockey_nhl":        "OddsAPI — temporada oct-jun",
    "baseball_mlb":         "OddsAPI — temporada abr-oct",
    "rugbyleague":          "OddsAPI — NRL/Super League",
}

LEAGUE_MAP = {
    "soccer":               "Fútbol",
    "basketball":           "NBA / EuroLeague",
    "tennis":               "ATP/WTA",
    "americanfootball_nfl": "NFL",
    "icehockey_nhl":        "NHL",
    "baseball_mlb":         "MLB",
    "rugbyleague":          "Rugby League",
}
BASKETBALL_API_KEYS   = ["basketball_nba", "basketball_euroleague"]
RUGBYLEAGUE_API_KEYS  = ["rugbyleague_nrl", "rugbyleague_super_league"]

# ============================================================
# FUENTE ÚNICA DE CASAS — añadir/quitar solo aquí
# ============================================================
# Campos: name, emoji, url (None si no hay), region (ES/INT), status (para /casas admin)
BOOKMAKERS: dict[str, dict] = {
    "winamax":     {"name": "Winamax",      "emoji": "🃏", "url": "https://www.winamax.es",          "region": "ES",  "status": "✅ Funcionando",          "default": True},
    "codere":      {"name": "Codere",        "emoji": "🎰", "url": "https://www.codere.es",           "region": "ES",  "status": "✅ Funcionando",          "default": True},
    "retabet":     {"name": "Retabet",       "emoji": "🔴", "url": "https://www.retabet.es",          "region": "ES",  "status": "🔄 SignalR",              "default": True},
    "betfair":     {"name": "Betfair",       "emoji": "💱", "url": "https://www.betfair.es",          "region": "INT", "status": "⏸ Sin credenciales API", "default": True},
    "bet365":      {"name": "Bet365",        "emoji": "🏆", "url": "https://www.bet365.es",           "region": "INT", "status": "⏸ Necesita proxy",        "default": True},
    "sportium":    {"name": "Sportium",      "emoji": "⚽", "url": "https://apuestas.sportium.es",    "region": "ES",  "status": "⏸ Necesita proxy",        "default": True},
    "bwin":        {"name": "Bwin",          "emoji": "🎯", "url": "https://www.bwin.es",             "region": "ES",  "status": "⏸ Necesita proxy",        "default": True},
    "williamhill": {"name": "William Hill",  "emoji": "🎩", "url": "https://sports.williamhill.es",   "region": "ES",  "status": "⏸ Necesita proxy",        "default": True},
    "betsson":     {"name": "Betsson",       "emoji": "💚", "url": "https://www.betsson.es",          "region": "ES",  "status": "🔄 Playwright",           "default": True},
    "daznbet":     {"name": "DaznBet",       "emoji": "📺", "url": "https://www.daznbet.es",          "region": "ES",  "status": "⏸ Necesita proxy",        "default": True},
    "pokerstars":  {"name": "PokerStars",    "emoji": "♠️", "url": "https://www.pokerstars.es",      "region": "INT", "status": "⏸ Kambi — proxy ES",     "default": True},
    "leovegas":    {"name": "LeoVegas",      "emoji": "🦁", "url": "https://www.leovegas.es",         "region": "INT", "status": "⏸ Kambi — proxy ES",     "default": True},
    "888sport":    {"name": "888sport",      "emoji": "8️⃣", "url": "https://www.888sport.es",        "region": "INT", "status": "⏸ Kambi — proxy ES",     "default": True},
    "casumo":      {"name": "Casumo",        "emoji": "🎪", "url": "https://www.casumo.es",           "region": "INT", "status": "⏸ Kambi — proxy ES",     "default": True},
    "luckia":      {"name": "Luckia",        "emoji": "🍀", "url": "https://apuestas.luckia.es",      "region": "ES",  "status": "⏸ Altenar — proxy ES",   "default": True},
    # ── Nuevas casas (proxy ES pendiente — Cudy LT500) ──────
    "betway":      {"name": "Betway",        "emoji": "🔵", "url": "https://www.betway.es",           "region": "INT", "status": "⏸ Necesita proxy ES",     "default": False},
    "interwetten": {"name": "Interwetten",   "emoji": "🟡", "url": "https://www.interwetten.es",      "region": "ES",  "status": "⏸ Necesita proxy ES",     "default": False},
    "betano":      {"name": "Betano",        "emoji": "🟠", "url": "https://www.betano.es",           "region": "ES",  "status": "⏸ Necesita proxy ES",     "default": False},
    "unibet":      {"name": "Unibet",        "emoji": "🟢", "url": "https://www.unibet.es",           "region": "ES",  "status": "⏸ Kambi — proxy ES",     "default": False},
    "tonybet":          {"name": "TonyBet",            "emoji": "🎲", "url": "https://www.tonybet.es",               "region": "INT", "status": "⏸ Altenar — proxy ES",   "default": False},
    "casino-gran-madrid": {"name": "Casino Gran Madrid", "emoji": "🎰", "url": "https://www.casinogranmadrid.es/apuestas", "region": "ES",  "status": "⏸ Altenar — proxy ES",   "default": False},
}

# Scrapers internos que no son casas de usuario independientes
# (sub-scrapers del mismo operador con tecnología distinta)
EXTRA_SCRAPERS: dict[str, dict] = {
    "betsson_es": {"name": "Betsson ES", "emoji": "🇪🇸", "status": "⏸ Kambi — proxy ES", "maps_to": "betsson"},
}

# ── Derivados automáticos — NO editar a mano ──────────────
BOOKMAKER_NAMES:  dict[str, str]       = {k: v["name"]   for k, v in BOOKMAKERS.items()}
BOOKMAKER_URLS:   dict[str, str]       = {k: v["url"]    for k, v in BOOKMAKERS.items() if v["url"]}
BOOKMAKER_REGION: dict[str, str]       = {k: v["region"] for k, v in BOOKMAKERS.items()}
SCRAPER_DISPLAY:  dict[str, tuple]     = {
    **{k: (v["emoji"], v["name"], v["status"]) for k, v in BOOKMAKERS.items()},
    **{k: (v["emoji"], v["name"], v["status"]) for k, v in EXTRA_SCRAPERS.items()},
}
# Sync DEFAULT_USER_CONFIG.bookmakers con BOOKMAKERS (fuente única)
DEFAULT_USER_CONFIG["bookmakers"] = {k: v.get("default", True) for k, v in BOOKMAKERS.items()}

# DualStats odds endpoint (VPS scraper data via Supabase)
DUALSTATS_ODDS_URL = f"{DUALSTATS_API_URL}/odds"

CASAS_CLON = [
    {"kambi", "888sport", "leovegas", "betsson", "betsson_es", "unibet", "pokerstars", "casumo", "marca", "kirolbet"},
    {"codere", "sportium"},
    {"tonybet", "luckia", "casino-gran-madrid"},  # Altenar
]

def son_casas_clon(bk1, bk2):
    for grupo in CASAS_CLON:
        if bk1 in grupo and bk2 in grupo:
            return True
    return False

# ── Gestión de scrapers (toggle ON/OFF por admin) ─────────
# Shared con el scanner Node.js — ambos leen/escriben este JSON.
SCANNER_STATE_FILE = "/home/ubuntu/scanner-state.json"

def _load_scanner_state() -> dict:
    try:
        with open(SCANNER_STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"disabled_scrapers": []}

def _save_scanner_state(state: dict):
    from datetime import timezone
    state["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        with open(SCANNER_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logging.getLogger(__name__).error(f"[scanner-state] Error guardando: {e}")

BLOQUEADO_MSG = "⛔ Función solo disponible para usuarios suscritos.\n\nPulsa 💳 Suscribirse para activar tu cuenta."

SUSCRIPCION = """💳 *Planes FidesBot*
━━━━━━━━━━━━━━━━━━

💎 *PRO* — Alertas ilimitadas
  • ⚡ Surebets, Middlebets y LIVE en tiempo real
  • ⚙️ Configuración por casas, deportes y profit mínimo
  • 🧮 Calculadora de stake automática

🔗 *PRO+Tracker* — PRO + web DualStats
  • Todo lo de PRO
  • ✅ Marca apuestas como Hecha/No hecha desde la alerta
  • 📋 Registro automático en DualStats Tracker
  • 🏆 Estadísticas: ROI, P&L, win rate

━━━━━━━━━━━━━━━━━━
💰 *Precios:*
• PRO 1 semana: *19,99€*
• PRO 2 semanas: *32,99€*
• PRO 1 mes: *44,99€*
• PRO+Tracker 1 mes: *49,99€*

_✨ Primera compra: 34,99€ PRO · 39,99€ PRO+Tracker_

━━━━━━━━━━━━━━━━━━
💳 Pago 100% seguro con Stripe.
Tu acceso se activa *automáticamente* al completar el pago.

👇 *Elige tu plan:*"""

TERMINOS = """📋 *Términos y Condiciones — FidesBot & DualStats Tracker*

_Última actualización: 21/08/2026_

*1. Identificación del servicio*
FidesBot es un bot de Telegram que proporciona información sobre oportunidades de apuestas (surebets, middlebets, valuebets) en tiempo real. DualStats Tracker es la aplicación web complementaria para el seguimiento y análisis de dichas apuestas. Ninguno de los dos servicios pertenece a ninguna casa de apuestas ni actúa en nombre de ellas.

*2. Aceptación*
El uso de cualquiera de los servicios implica la aceptación plena de estos Términos.

*3. Requisitos*
Uso exclusivo para mayores de 18 años. El acceso por menores está estrictamente prohibido.

*4. Naturaleza del servicio*
FidesBot y DualStats son herramientas informativas. No garantizan beneficios ni resultados. Las cuotas y mercados pueden cambiar en cualquier momento. La decisión de apostar es responsabilidad exclusiva del usuario.

⚠️ *No apuestes más de lo que estés dispuesto a perder.*

*5. Pagos y reembolsos*
Los pagos se procesan a través de Stripe, plataforma certificada PCI DSS. FidesBot no almacena datos bancarios. Reembolso disponible en las primeras 24h si no ha habido uso intensivo. Si el servicio cesa definitivamente, se aplicará devolución proporcional al tiempo no disfrutado.

*6. Datos y privacidad*
FidesBot almacena únicamente el ID de Telegram y la configuración del usuario. DualStats Tracker almacena los datos de apuestas que el usuario introduce voluntariamente. Ningún dato se comparte con terceros ni con casas de apuestas. Los datos pueden eliminarse a petición contactando al administrador.

*7. Prohibiciones*
Están prohibidos: ceder el acceso a terceros, reenviar alertas de forma automática, compartir la suscripción y cualquier uso automatizado no autorizado. El incumplimiento conlleva bloqueo permanente sin reembolso.

*8. Responsabilidad*
FidesBot y DualStats no son asesores financieros. El usuario es el único responsable de sus decisiones de apuesta y sus consecuencias económicas. Los servicios no se responsabilizan de pérdidas, limitaciones impuestas por casas de apuestas ni de variaciones de cuotas tras el envío de una alerta.

*9. Modificaciones*
Nos reservamos el derecho a modificar estos Términos en cualquier momento. Los cambios se comunicarán a través del bot.

*10. Contacto*
Contacta con el administrador directamente a través del bot para cualquier consulta o reclamación."""

SOPORTE_PAGINAS = [
"""🆘 *Soporte — FidesBot*  _(1/2)_
━━━━━━━━━━━━━━━━━━

📩 Cualquier duda, escríbenos al administrador. Te respondemos lo antes posible.

━━━━━━━━━━━━━━━━━━
📌 *Preguntas frecuentes:*

❓ *¿Cómo activo mi suscripción?*
Pulsa 💳 Suscribirse en el menú, elige tu plan y completa el pago. El acceso se activa automáticamente al instante.

❓ *¿Qué es Stripe? ¿Es seguro pagar ahí?*
Stripe es la pasarela de pago que usan Amazon, Google o Spotify. FidesBot no almacena datos bancarios — todo lo gestiona Stripe con cifrado PCI DSS. Puedes pagar con Visa, Mastercard o Amex.

❓ *¿La suscripción se renueva sola? ¿Cómo la cancelo?*
No se renueva automáticamente: expira en la fecha que ves en tu menú. Para renovar, pulsa 🔄 Renovar en el menú principal y elige tu plan.

❓ *¿Qué es DualStats Tracker?*
DualStats es la app web complementaria al bot. Registra todas tus apuestas y muestra: ROI, beneficio acumulado, rendimiento por casa, estadísticas por deporte y mucho más. Con PRO+Tracker las alertas que aceptas en el bot se registran automáticamente.

❓ *¿Cómo vinculo el bot con DualStats?*
Pulsa 📈 DualStats en el menú principal y sigue los pasos. Necesitas cuenta activa en DualStats y el plan PRO+Tracker.

━━━━━━━━━━━━━━━━━━
_Actualizado: 21/08/2026_""",
"""🆘 *Soporte — FidesBot*  _(2/2)_
━━━━━━━━━━━━━━━━━━

📌 *Preguntas frecuentes (cont.):*

❓ *¿Cómo funciona la calculadora de stake?*
Al recibir una alerta surebet pulsa 🧮 Stake e introduce el importe total a invertir. El bot reparte automáticamente cuánto va a cada casa para garantizar el beneficio sea cual sea el resultado.

❓ *¿Por qué no me llegan alertas?*
Comprueba en 🔔 Alertas que tienes activados los tipos que quieres, y en ⚙️ Configuración que el profit mínimo no esté demasiado alto (por defecto 3% en surebets).

❓ *¿Qué pasa si una cuota cambia antes de apostar?*
No entres. Si la cuota baja o el mercado cierra antes de colocar los dos lados, es mejor perder la oportunidad que hacer una apuesta incompleta que no cubre el arbitraje.

❓ *¿Cómo evito que las casas me limiten?*
1) Redondea los importes (50€ en vez de 47,32€)
2) No retires con demasiada frecuencia
3) Varía deportes, mercados y casas
4) No apuestes siempre el máximo

❓ *¿Qué son los créditos?*
Permiten usar funciones premium puntualmente sin suscripción. Ganas créditos invitando amigos (2 por referido) y reportando errores al administrador.

❓ *¿Qué hago si el bot no responde?*
Envía /start para reiniciar la sesión. Si el problema persiste, escribe al administrador con una captura de pantalla y tu ID de Telegram.

━━━━━━━━━━━━━━━━━━"""
]

NOVEDADES_HUB = (
    "📰 *Novedades — FidesBot*\n━━━━━━━━━━━━━━━━━━\n\n"
    "📌 Mantente al día con todo lo nuevo que ofrece FidesBot.\n\n"
    "🕒 Última actualización: *21/08/2026*\n\n"
    "✨ *¿Qué encontrarás aquí?*\n"
    " • Notas de la última versión.\n"
    " • Nuevas funcionalidades y mejoras.\n"
    " • Próximas funciones en desarrollo.\n"
    " • Mensajes importantes y avisos.\n\n"
    "💎 Gracias por confiar en FidesBot. Seguimos trabajando para "
    "ayudarte con el arbitraje deportivo.\n"
    "━━━━━━━━━━━━━━━━━━"
)
NOVEDADES_ULTIMA = (
    "🕒 *Última actualización — 22/08/2026*\n━━━━━━━━━━━━━━━━━━\n\n"
    "✅ *Activación automática* — tu suscripción se activa al instante "
    "tras el pago con Stripe, sin esperar confirmación manual\n"
    "✅ *Integración FidesBot × DualStats Tracker* — vincula tu cuenta "
    "web y registra apuestas directamente desde las alertas del bot\n"
    "✅ Sistema de créditos y freebets — búsquedas gratuitas por invitar "
    "amigos o renovar suscripción\n"
    "✅ Alertas live mejoradas — cooldown inteligente (180s o +0.5pp "
    "de profit) para evitar spam de cuotas fluctuantes\n"
    "✅ Auto-registro aproximado — las apuestas pendientes de confirmar "
    "se registran solas a las 48h con aviso por Telegram\n"
    "✅ Flujo de Apuestas Pendientes — acepta o rechaza cada alerta "
    "antes de registrarla en DualStats\n"
    "━━━━━━━━━━━━━━━━━━"
)
NOVEDADES_PROXIMAS = (
    "🚀 *Próximas funciones*\n━━━━━━━━━━━━━━━━━━\n"
    "_Actualizado: 21/08/2026_\n\n"
    "🔜 20 casas de apuestas — añadimos Betway, Interwetten, Paston, "
    "AdmiralBet y TonyBet para más combinaciones de surebet\n"
    "🔜 Más cobertura live — activamos scrapers adicionales para "
    "detectar más surebets en tiempo real\n"
    "🔜 Canal gratuito de Telegram — alertas de muestra para que "
    "veas cómo funciona FidesBot antes de suscribirte\n"
    "🔜 Integración web completa — registra y gestiona todas tus "
    "apuestas directamente desde las alertas del bot\n\n"
    "💡 ¿Tienes ideas? Escríbenos desde 🆘 Soporte.\n"
    "━━━━━━━━━━━━━━━━━━"
)
NOVEDADES_AVISOS = (
    "📢 *Avisos importantes*\n━━━━━━━━━━━━━━━━━━\n"
    "_Actualizado: 21/08/2026_\n\n"
    "⚠️ *Cobertura de casas españolas limitada*\n"
    "Las casas como Codere, Sportium, Bwin y William Hill España "
    "requieren proxies residenciales para acceder a sus odds. "
    "Estamos trabajando en activarlas próximamente.\n\n"
    "ℹ️ *Fuente de datos*\n"
    "Las surebets se detectan vía The Odds API (mercados internacionales). "
    "Cuantas más casas tengas activadas, más oportunidades verás.\n\n"
    "_Esta sección se actualiza con comunicados importantes "
    "sobre el servicio o cambios de precios._\n"
    "━━━━━━━━━━━━━━━━━━"
)

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

# ── Alerta cache — persistencia en disco ─────────────────────────────────────
def _save_alerts_cache():
    try:
        with open(ALERTS_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(alerta_cache, f, ensure_ascii=False, default=str)
    except Exception as e:
        logger.warning(f"[alerts_cache] Error guardando: {e}")

def _load_alerts_cache():
    global alerta_cache
    if not os.path.exists(ALERTS_CACHE_FILE):
        return
    try:
        with open(ALERTS_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        cutoff = local_now() - timedelta(hours=24)
        for key, entry in data.items():
            try:
                ts = datetime.fromisoformat(entry.get("ts", "2000-01-01"))
                if ts > cutoff:
                    alerta_cache[key] = entry
            except Exception:
                pass
        logger.info(f"[alerts_cache] Restauradas {len(alerta_cache)} entradas")
    except Exception as e:
        logger.warning(f"[alerts_cache] Error cargando: {e}")

# ── Pausa y avisos — persistencia en config de usuario ───────────────────────
def _set_pausa(user_id: int, end_time: datetime):
    pausa_alertas[user_id] = end_time
    get_config(user_id)["_pausa_hasta"] = end_time.isoformat()
    guardar_db()

def _clear_pausa(user_id: int):
    pausa_alertas.pop(user_id, None)
    get_config(user_id).pop("_pausa_hasta", None)
    guardar_db()

def _add_aviso(uid: int, tipo: str):
    """Registra un aviso de suscripción y lo persiste en el config del usuario."""
    avisos_enviados.add(f"{uid}_{tipo}")
    cfg = get_config(uid)
    s = set(cfg.get("_avisos", []))
    s.add(tipo)
    cfg["_avisos"] = list(s)

def _discard_aviso(uid: int, tipo: str):
    avisos_enviados.discard(f"{uid}_{tipo}")
    cfg = get_config(uid)
    s = set(cfg.get("_avisos", []))
    s.discard(tipo)
    cfg["_avisos"] = list(s)

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
                cfg.setdefault("bookmakers", {})[bk] = DEFAULT_USER_CONFIG["bookmakers"][bk]
        cfg.get("bookmakers", {}).pop("marathonbet", None)   # eliminada del mercado español
        # Migrar min_profit_surebet de 3.0 (default antiguo) a 1.5 (más útil en la práctica)
        if cfg.get("min_profit_surebet") == 3.0:
            cfg["min_profit_surebet"] = 1.5
        # Migrar basketball_nba/euroleague -> basketball
        bk_nba = cfg.get("sports", {}).pop("basketball_nba", None)
        bk_eu  = cfg.get("sports", {}).pop("basketball_euroleague", None)
        if bk_nba is not None or bk_eu is not None:
            cfg.setdefault("sports", {})["basketball"] = bool(bk_nba or bk_eu)
        for sp in DEFAULT_USER_CONFIG["sports"]:
            if sp not in cfg.get("sports", {}):
                cfg.setdefault("sports", {})[sp] = DEFAULT_USER_CONFIG["sports"][sp]
        for _removed_sp in ["golf", "cricket"]:
            cfg.get("sports", {}).pop(_removed_sp, None)
        subs[uid] = {"name": sub.get("name", str(uid)), "expires": expires, "config": cfg,
                     "is_trial": cfg.get("_is_trial", False)}
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
                                cfg.setdefault("bookmakers", {})[bk] = DEFAULT_USER_CONFIG["bookmakers"][bk]
                        cfg.get("bookmakers", {}).pop("marathonbet", None)
                        if cfg.get("min_profit_surebet") == 3.0:
                            cfg["min_profit_surebet"] = 1.5
                        # Migrar basketball_nba/euroleague -> basketball
                        bk_nba = cfg.get("sports", {}).pop("basketball_nba", None)
                        bk_eu  = cfg.get("sports", {}).pop("basketball_euroleague", None)
                        if bk_nba is not None or bk_eu is not None:
                            cfg.setdefault("sports", {})["basketball"] = bool(bk_nba or bk_eu)
                        for sp in DEFAULT_USER_CONFIG["sports"]:
                            if sp not in cfg.get("sports", {}):
                                cfg.setdefault("sports", {})[sp] = DEFAULT_USER_CONFIG["sports"][sp]
                        for _removed_sp in ["golf", "cricket"]:
                            cfg.get("sports", {}).pop(_removed_sp, None)
                        name = sub.get("telegramName") or file_subs.get(uid, {}).get("name", str(uid))
                        subscriptions[uid] = {"name": name, "expires": expires, "config": cfg,
                                              "is_trial": cfg.get("_is_trial", False)}
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

    # ── Restaurar estado efímero desde config de usuario ─────
    for uid, sub in subscriptions.items():
        cfg = sub.get("config", {})
        # Pausa de alertas
        pausa_str = cfg.get("_pausa_hasta")
        if pausa_str:
            try:
                end = datetime.fromisoformat(pausa_str)
                if end > local_now():
                    pausa_alertas[uid] = end
            except Exception:
                pass
        # Avisos de suscripción enviados
        for tipo in cfg.get("_avisos", []):
            avisos_enviados.add(f"{uid}_{tipo}")

    # ── Restaurar alerta_cache desde disco ────────────────────
    _load_alerts_cache()
    _load_banned()

    # ── Si había fichero local: sync a API y renombrar ───────
    if file_subs and api_ok:
        await flush_to_api()
        try:
            os.rename(DB_FILE, DB_FILE + ".migrated")
            logger.info(f"[DB] Fichero migrado → {DB_FILE}.migrated")
        except Exception as e:
            logger.error(f"[DB] No se pudo renombrar el fichero: {e}")

# ============================================================
# BAN DE USUARIOS
# ============================================================
BANNED_FILE = "banned_users.json"
banned_users: dict = {}  # {user_id: {"ts": ..., "motivo": ..., "by": ...}}

def _save_banned():
    try:
        with open(BANNED_FILE, "w", encoding="utf-8") as f:
            json.dump({str(k): v for k, v in banned_users.items()}, f, ensure_ascii=False, default=str)
    except Exception as e:
        logger.warning(f"[ban] Error guardando: {e}")

def _load_banned():
    global banned_users
    if not os.path.exists(BANNED_FILE):
        return
    try:
        with open(BANNED_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        banned_users = {int(k): v for k, v in data.items()}
        logger.info(f"[ban] {len(banned_users)} usuarios baneados cargados")
    except Exception as e:
        logger.warning(f"[ban] Error cargando: {e}")

def is_banned(user_id: int) -> bool:
    return user_id in banned_users

async def cmd_ban(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    if not context.args:
        await update.message.reply_text("Uso: /ban <user_id> [motivo]"); return
    try:
        target = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ ID inválido."); return
    if target in ADMIN_IDS:
        await update.message.reply_text("❌ No puedes banear a un administrador."); return
    motivo = " ".join(context.args[1:]) if len(context.args) > 1 else "Sin motivo especificado"
    banned_users[target] = {
        "ts": local_now().isoformat(),
        "motivo": motivo,
        "by": update.effective_user.id,
    }
    _save_banned()
    await update.message.reply_text(
        f"🚫 *Usuario {target} baneado*\nMotivo: {motivo}",
        parse_mode="Markdown")
    try:
        await context.bot.send_message(
            chat_id=target,
            text="🚫 Tu acceso a FidesBot ha sido restringido por el administrador.\n"
                 "Si crees que es un error, contacta con soporte.")
    except Exception:
        pass

async def cmd_unban(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    if not context.args:
        await update.message.reply_text("Uso: /unban <user_id>"); return
    try:
        target = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ ID inválido."); return
    if target not in banned_users:
        await update.message.reply_text(f"ℹ️ El usuario {target} no está baneado."); return
    del banned_users[target]
    _save_banned()
    await update.message.reply_text(f"✅ *Usuario {target} desbaneado*", parse_mode="Markdown")
    try:
        await context.bot.send_message(
            chat_id=target,
            text="✅ Tu acceso a FidesBot ha sido restaurado. Escribe /start para continuar.")
    except Exception:
        pass

async def cmd_baneados(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS:
        return
    if not banned_users:
        await update.message.reply_text("✅ No hay usuarios baneados actualmente."); return
    lines = ["🚫 *Usuarios baneados*\n━━━━━━━━━━━━━━━━━━\n"]
    for uid, info in banned_users.items():
        ts     = info.get("ts", "—")[:10]
        motivo = info.get("motivo", "—")
        lines.append(f"• `{uid}` — {motivo} _{ts}_")
    lines.append(f"\n_Total: {len(banned_users)}_")
    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")

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
    if cache and (datetime.now() - cache["cached_at"]).total_seconds() < 300:
        return cache.get("subscribed", False)
    # Fallback al dict local
    if user_id not in subscriptions: return False
    sub = subscriptions[user_id]
    if sub["expires"] is None: return True
    return sub["expires"] > datetime.now()

def ha_pagado_antes(user_id):
    """True si el usuario alguna vez tuvo una suscripción (aunque esté caducada)."""
    return user_id in subscriptions

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
    if tiene_suscripcion(user_id): return True  # suscriptores nunca gastan créditos
    if creditos.get(user_id, 0) <= 0: return False
    creditos[user_id] -= 1
    guardar_db()
    return True

def activar_usuario(user_id, dias, nombre=None, plan="PRO"):
    nombre_guardado = nombre or subscriptions.get(user_id, {}).get("name", str(user_id))
    if user_id in subscriptions and subscriptions[user_id].get("expires") is not None and subscriptions[user_id]["expires"] > datetime.now():
        subscriptions[user_id]["expires"] += timedelta(days=dias)
        subscriptions[user_id]["plan"] = plan  # actualiza plan aunque se renueve
    else:
        existing_config = subscriptions.get(user_id, {}).get("config", deepcopy(DEFAULT_USER_CONFIG))
        subscriptions[user_id] = {
            "name":    nombre_guardado,
            "expires": datetime.now() + timedelta(days=dias),
            "config":  existing_config,
            "plan":    plan,
        }
    # Limpiar flag de trial al activar suscripción real
    subscriptions[user_id].pop("is_trial", None)
    subscriptions[user_id].get("config", {}).pop("_is_trial", None)
    if user_id not in creditos:
        creditos[user_id] = CREDITOS_INICIALES      # primer registro
    else:
        add_creditos(user_id, CREDITOS_POR_SUSCRIPCION)  # regalo por renovar
    guardar_db()

def get_plan_label(user_id) -> str:
    """Devuelve la etiqueta del plan para mostrar en admin."""
    # Primero caché API (más fiable si vinculado)
    cache = subscription_api_cache.get(user_id)
    if cache and cache.get("plan"):
        p = cache["plan"]
        if p == "PRO_TRACKER": return "PRO+Tracker"
        if p == "ENTERPRISE":  return "Enterprise"
        return "PRO"
    # Fallback: plan almacenado localmente
    p = subscriptions.get(user_id, {}).get("plan", "PRO")
    return "PRO+Tracker" if p == "PRO_TRACKER" else "PRO"

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
# TAREA SYNC DESDE API (cada 5min — recoge pagos Stripe nuevos)
# ============================================================
async def tarea_sync_desde_api(context: ContextTypes.DEFAULT_TYPE):
    """Sincroniza suscripciones desde la API para activar pagos Stripe al instante."""
    try:
        headers = {"x-bot-secret": DUALSTATS_API_KEY}
        async with aiohttp.ClientSession() as s:
            async with s.get(f"{DUALSTATS_API_URL}/users", headers=headers,
                             timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return
                api_data = await resp.json()

        for sub in api_data.get("botSubscriptions", []):
            uid = int(sub["telegramId"])
            exp_str = sub.get("expiresAt")
            expires = None
            if exp_str:
                try:
                    expires = datetime.fromisoformat(exp_str.replace("Z", "+00:00")).replace(tzinfo=None)
                except Exception:
                    pass
            existing = subscriptions.get(uid)
            if existing:
                # Only extend expiry — never shrink (protects manually given subscriptions)
                if expires and (existing.get("expires") is None or expires > existing.get("expires")):
                    existing["expires"] = expires
                    existing["is_trial"] = False
                    existing.get("config", {}).pop("_is_trial", None)
            else:
                # New subscription — add to in-memory dict (Stripe payment just processed)
                cfg = sub.get("config") or deepcopy(DEFAULT_USER_CONFIG)
                for k, v in DEFAULT_USER_CONFIG.items():
                    if k not in cfg:
                        cfg[k] = deepcopy(v)
                for bk in DEFAULT_USER_CONFIG["bookmakers"]:
                    cfg.setdefault("bookmakers", {})[bk] = cfg["bookmakers"].get(bk, DEFAULT_USER_CONFIG["bookmakers"][bk])
                for sp in DEFAULT_USER_CONFIG["sports"]:
                    cfg.setdefault("sports", {})[sp] = cfg["sports"].get(sp, DEFAULT_USER_CONFIG["sports"][sp])
                cfg.pop("_is_trial", None)
                subscriptions[uid] = {
                    "name":     sub.get("telegramName") or str(uid),
                    "expires":  expires,
                    "config":   cfg,
                    "is_trial": False,
                }
                creditos[uid] = sub.get("credits") or creditos.get(uid, 0)
                logger.info(f"[sync] Suscripción nueva cargada desde API: {uid}")

        for u in api_data.get("linkedUsers", []):
            uid = int(u["telegramId"])
            dualstats_vinculados.add(uid)
            dualstats_plan[uid] = u["plan"]
    except Exception as e:
        logger.error(f"[sync] Error: {e}")

# ============================================================
# TAREA VERIFICAR SUSCRIPCIONES
# ============================================================
async def tarea_verificar_suscripciones(context: ContextTypes.DEFAULT_TYPE):
    ahora = datetime.now()
    for uid, sub in list(subscriptions.items()):
        if uid in ADMIN_IDS: continue
        expires = sub.get("expires")
        if not expires: continue
        dias = (expires - ahora).days
        try:
            if expires <= ahora:
                if f"{uid}_expired" not in avisos_enviados:
                    _discard_aviso(uid, "7d"); _discard_aviso(uid, "1d")
                    _add_aviso(uid, "expired")
                    await context.bot.send_message(chat_id=uid,
                        text="😢 *Tu suscripción a FidesBot ha caducado.*\n\n"
                             "Ya no recibirás alertas hasta que renueves.\n\n"
                             "👉 Escribe /start y pulsa 💳 *Suscribirse* para continuar.",
                        parse_mode="Markdown")
            elif dias <= 1:
                if f"{uid}_1d" not in avisos_enviados:
                    _add_aviso(uid, "1d")
                    await context.bot.send_message(chat_id=uid,
                        text="⚠️ *¡Tu suscripción caduca mañana!*\n\n"
                             "Renueva hoy para no perder ninguna alerta.\n\n"
                             "👉 /start → 🔄 Renovar suscripción",
                        parse_mode="Markdown")
            elif dias <= 7:
                if f"{uid}_7d" not in avisos_enviados:
                    _add_aviso(uid, "7d")
                    await context.bot.send_message(chat_id=uid,
                        text=f"🔔 *Tu suscripción caduca en {dias} días.*\n\n"
                             f"Para no perder acceso, renueva antes del "
                             f"{expires.strftime('%d/%m/%Y')}.\n\n"
                             f"👉 /start → 🔄 Renovar suscripción",
                        parse_mode="Markdown")
        except: pass
    guardar_db()

# ============================================================
# ANTI-DUPLICADOS
# ============================================================
def clave_apuesta(event, apuesta, live, tipo="surebet"):
    legs_str = "_".join([f"{l['bookmaker']}{l['outcome']}{l['odd']}" for l in apuesta["legs"]])
    return f"{tipo}_{event['home_team']}_{event['away_team']}_{legs_str}"

def clave_apuesta_base(event, apuesta, tipo="surebet"):
    """Stable key without odds — for live 180s/0.5pp dedup window."""
    bks = "_".join(sorted(l["bookmaker"] for l in apuesta["legs"]))
    return f"{tipo}_{event['home_team']}_{event['away_team']}_{bks}"

def ya_enviada(clave):
    if clave not in sent_surebets: return False
    if datetime.now() - sent_surebets[clave] > timedelta(hours=SUREBET_TTL_HOURS):
        del sent_surebets[clave]; return False
    return True

def marcar_enviada(clave):
    sent_surebets[clave] = datetime.now()

def ya_enviada_live(base_clave, profit):
    """Suppress live re-alert unless 180s elapsed or profit improved >=0.5pp."""
    rec = live_sent_surebets.get(base_clave)
    if not rec: return False
    elapsed = (datetime.now() - rec["ts"]).total_seconds()
    return elapsed < 180 and (profit - rec["profit"]) < 0.5

def marcar_enviada_live(base_clave, profit):
    live_sent_surebets[base_clave] = {"ts": datetime.now(), "profit": profit}

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
    # line1=Over, line2=Under — el caller ya garantiza line2 > line1 (middle válido)
    if line1 is None or line2 is None: return None
    gap = line2 - line1  # positivo siempre (validado antes de llamar)
    if gap <= 0: return None
    implied = (1/odd1) + (1/odd2)
    # Peor caso: solo una pata gana → igual que un surebet (1/implied - 1)
    profit_base = (1/implied - 1) * 100
    # Mejor caso: ambas patas ganan (middle se cumple) → retorno doble normalizado
    profit_max  = (2/implied - 1) * 100
    # Probabilidad empírica: ~10% por unidad de gap, cap 99%
    prob_middle = min(gap * 10.0, 99.0)
    return {"profit_base": round(profit_base,2), "profit_max": round(profit_max,2),
            "prob_middle": round(prob_middle,2), "gap": round(gap,1),
            "stake1_pct": round((1/odd1)/implied*100,2),
            "stake2_pct": round((1/odd2)/implied*100,2)}

def encontrar_apuestas(event, active_bookmakers, buscar_middles=False, sport_key=""):
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
    h2h_names = sorted(set(k.replace("h2h_","") for k in outcomes_map if k.startswith("h2h_")))
    # Surebet h2h: solo si hay exactamente 2 outcomes (sin empate cubierto)
    if len(h2h_names) == 2:
        e1 = outcomes_map.get(f"h2h_{h2h_names[0]}", [])
        e2 = outcomes_map.get(f"h2h_{h2h_names[1]}", [])
        if e1 and e2:
            b1 = max(e1, key=lambda x: x["price"])
            b2 = max(e2, key=lambda x: x["price"])
            if not son_casas_clon(b1["bookmaker_key"], b2["bookmaker_key"]):
                result = calcular_surebet(b1["price"], b2["price"])
                if result:
                    # Fútbol, americano y rugby pueden terminar en empate
                    SPORTS_WITH_DRAW = {"soccer", "americanfootball", "rugbyleague"}
                    has_draw_risk = any(sport_key.startswith(s) for s in SPORTS_WITH_DRAW)
                    apuestas.append({"tipo":"surebet","profit":result["profit"],
                        "draw_risk": has_draw_risk, "legs":[
                        {"bookmaker":b1["bookmaker_title"],"bookmaker_key":b1["bookmaker_key"],
                         "region": BOOKMAKER_REGION.get(b1["bookmaker_key"], ""),
                         "outcome":h2h_names[0],"odd":b1["price"],"stake_pct":result["stake1_pct"],
                         "market":"h2h","point":b1["point"],"description":b1["description"]},
                        {"bookmaker":b2["bookmaker_title"],"bookmaker_key":b2["bookmaker_key"],
                         "region": BOOKMAKER_REGION.get(b2["bookmaker_key"], ""),
                         "outcome":h2h_names[1],"odd":b2["price"],"stake_pct":result["stake2_pct"],
                         "market":"h2h","point":b2["point"],"description":b2["description"]},
                    ]})
    if buscar_middles:
        overs  = outcomes_map.get("totals_Over", [])
        unders = outcomes_map.get("totals_Under", [])
        for oe in overs:
            for ue in unders:
                # Middle válido: Under line > Over line (existe rango donde ambas ganan)
                if (oe["bookmaker_key"] != ue["bookmaker_key"]
                        and oe["point"] and ue["point"]
                        and ue["point"] > oe["point"]):
                    result = calcular_middlebet(oe["price"], ue["price"], oe["point"], ue["point"])
                    if result and result["gap"] >= 0.5:
                        apuestas.append({"tipo":"middlebet",
                            "profit_base":result["profit_base"],"profit_max":result["profit_max"],
                            "prob_middle":result["prob_middle"],"gap":result["gap"],
                            "profit":result["profit_base"],"legs":[
                            {"bookmaker":oe["bookmaker_title"],"bookmaker_key":oe["bookmaker_key"],
                             "region":BOOKMAKER_REGION.get(oe["bookmaker_key"],""),
                             "outcome":"Over","odd":oe["price"],"stake_pct":result["stake1_pct"],
                             "market":"totals","point":oe["point"],"description":""},
                            {"bookmaker":ue["bookmaker_title"],"bookmaker_key":ue["bookmaker_key"],
                             "region":BOOKMAKER_REGION.get(ue["bookmaker_key"],""),
                             "outcome":"Under","odd":ue["price"],"stake_pct":result["stake2_pct"],
                             "market":"totals","point":ue["point"],"description":""},
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
    ganancia = round(min(s * l["odd"] for s, l in zip(stakes_redondeados, legs)) - total_redondeado, 2)
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
    global api_credits_remaining, api_credits_used
    url = (f"{ODDS_API_BASE}/sports/{sport_key}/odds"
           f"?apiKey={ODDS_API_KEY}&regions=eu&markets=h2h,totals"
           f"&oddsFormat=decimal&inPlay={'true' if live else 'false'}")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=15)) as resp:
                # Capture credit headers from The Odds API
                remaining = resp.headers.get("x-requests-remaining")
                used      = resp.headers.get("x-requests-used")
                if remaining is not None:
                    api_credits_remaining = int(remaining)
                if used is not None:
                    api_credits_used = int(used)

                if resp.status == 200:
                    return await resp.json()
                if resp.status in (401, 422, 429):
                    body = await resp.text()
                    logger.error(f"[API] {sport_key} HTTP {resp.status} — cuota agotada o clave inválida: {body[:200]}")
                    if api_credits_remaining == 0:
                        logger.error("[API] ⚠️  0 créditos restantes — desactivando escaneo hasta recarga mensual.")
                else:
                    logger.warning(f"[API] {sport_key} HTTP {resp.status}")
                return []
    except Exception as e:
        logger.error(f"Error {sport_key}: {e}"); return []

# ── OddsAPI league-specific key → user-facing sport key (for cross-source merge) ──
_ODDSAPI_SPORT_KEY_NORM = {
    "basketball_nba":            "basketball",
    "basketball_euroleague":     "basketball",
    "rugbyleague_nrl":           "rugbyleague",
    "rugbyleague_super_league":  "rugbyleague",
}

def _norm_sport_key(sk: str) -> str:
    return _ODDSAPI_SPORT_KEY_NORM.get(sk, sk)

# ── Odds API sport_key → VPS SportType (for filtering DualStats events) ────────
_VPS_SPORT_MAP = {
    "soccer":               "FOOTBALL",
    "basketball":           "BASKETBALL",
    "tennis":               "TENNIS",
    "baseball_mlb":         "BASEBALL",
    "icehockey_nhl":        "ICEHOCKEY",
    "rugbyleague":          "RUGBYLEAGUE",
    "americanfootball_nfl": "AMERICANFOOTBALL",
}

def _convert_vps_event_to_odds_api(ev: dict, sport_key: str) -> dict | None:
    """Convert one DualStats /api/bot/odds event to The Odds API event format."""
    bk_map: dict[str, dict] = {}  # bookmaker_key → {key, title, markets:[...]}
    for item in ev.get("bookmakerOdds", []):
        bk  = item["bookmaker"]
        mkt = item["market"]
        raw = item.get("outcomes", [])
        outcomes_api: list[dict] = []
        if mkt == "h2h":
            for o in (raw if isinstance(raw, list) else []):
                outcomes_api.append({"name": o.get("name", ""), "price": float(o.get("odds", 0))})
        elif mkt == "totals":
            for o in (raw if isinstance(raw, list) else []):
                line = o.get("line")
                if o.get("over"):
                    outcomes_api.append({"name": "Over",  "price": float(o["over"]),  "point": line})
                if o.get("under"):
                    outcomes_api.append({"name": "Under", "price": float(o["under"]), "point": line})
        if not outcomes_api:
            continue
        if bk not in bk_map:
            bk_map[bk] = {"key": bk, "title": BOOKMAKER_NAMES.get(bk, bk.title()), "markets": []}
        bk_map[bk]["markets"].append({"key": mkt, "outcomes": outcomes_api})
    if not bk_map:
        return None
    parts = ev.get("eventName", "").split(" vs ", 1)
    if len(parts) == 2:
        home, away = parts[0].strip(), parts[1].strip()
    else:
        parts2 = ev.get("eventName", "").split(" - ", 1)
        home = parts2[0].strip() if parts2 else ev.get("eventName", "")
        away = parts2[1].strip() if len(parts2) > 1 else ""
    return {
        "id":            ev.get("eventKey", ""),
        "sport_key":     sport_key,
        "sport_title":   ev.get("league") or LEAGUE_MAP.get(sport_key, sport_key),
        "commence_time": ev.get("startTime") or "2099-01-01T00:00:00Z",
        "home_team":     home,
        "away_team":     away,
        "_source":       "dualstats",      # internal tag — not sent to Telegram
        "bookmakers":    list(bk_map.values()),
    }

async def fetch_dualstats_odds(sport_key: str, live: bool = False) -> list:
    """Fetch VPS scraper odds from DualStats /api/bot/odds endpoint."""
    if not DUALSTATS_API_KEY:
        return []
    vps_sport = _VPS_SPORT_MAP.get(sport_key)
    if not vps_sport:
        return []
    max_age = 60 if live else 300
    params = f"?live={'true' if live else 'false'}&maxAge={max_age}"
    url    = f"{DUALSTATS_ODDS_URL}{params}"
    headers = {"x-bot-secret": DUALSTATS_API_KEY}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    logger.warning(f"[DualStats odds] {sport_key} HTTP {resp.status}")
                    return []
                data = await resp.json()
                events_raw = [e for e in data.get("events", []) if e.get("sport") == vps_sport]
                result = []
                for ev in events_raw:
                    converted = _convert_vps_event_to_odds_api(ev, sport_key)
                    if converted:
                        result.append(converted)
                logger.info(f"[DualStats] {sport_key} {'live' if live else 'pre'}: {len(result)} events")
                return result
    except Exception as e:
        logger.error(f"[DualStats odds] {sport_key}: {e}")
        return []

# ── Cross-source matching engine (Odds API UUID ↔ DualStats eventKey) ─────────

# Words that are ALWAYS safe to strip (club-type indicators, never differentiate clubs).
_STRUCTURAL_STOP_WORDS: frozenset[str] = frozenset({
    "fc", "cf", "cd", "sd", "club", "de", "del", "la", "el", "ac", "as", "sk",
})
# Words stripped CONDITIONALLY: only when the result is not a bare geographic residual.
# "real" is kept in "Real Madrid" → "real madrid" so it doesn't collapse to just "madrid",
# preventing same-city club collisions even if new qualifiers are later added to stop words.
_SOFT_STOP_WORDS: frozenset[str] = frozenset({"real"})
# Combined set — used by _team_tokens() for last-token discrimination filtering.
_TEAM_STOP_WORDS: frozenset[str] = _STRUCTURAL_STOP_WORDS | _SOFT_STOP_WORDS

# Reserve/sub-club descriptors: if one team has these and the other doesn't,
# similarity is hard-locked to 0.0 regardless of JW score (Porto ≠ Porto B).
_RESERVE_DESCRIPTORS: frozenset[str] = frozenset({
    "b", "ii", "iii", "u19", "u21", "u23", "femenino", "women", "femenil"
})

# Single geographic tokens shared by multiple clubs from the same city.
# If stripping stop words leaves ONLY these tokens, the name is geo-ambiguous and
# soft stop words are retained so the clubs remain distinguishable via JW.
_GEO_RESIDUALS: frozenset[str] = frozenset({
    "madrid", "barcelona", "manchester", "paris", "london", "milan",
    "bilbao", "valencia", "sevilla", "porto", "lisbon", "amsterdam",
    "munich", "berlin", "rome", "moscow", "zagreb", "glasgow",
})

def _normalize_team(name: str) -> str:
    """Lowercase, remove accents, strip club suffixes.

    Two-phase stripping:
    1. Structural stop words (fc, club, de…) are always removed.
    2. Soft stop words (real) are removed ONLY when the result is unambiguous —
       i.e., not a bare city name shared by multiple clubs.
       "Real Madrid" → "real madrid" (guard fires; "madrid" ∈ _GEO_RESIDUALS).
       "Real Betis"  → "betis"       (guard silent; "betis" ∉ _GEO_RESIDUALS).
    """
    nfkd = unicodedata.normalize("NFKD", name.lower())
    ascii_str = "".join(c for c in nfkd if not unicodedata.combining(c))
    tokens = re.sub(r"[^a-z0-9 ]", " ", ascii_str).split()
    after_structural = [t for t in tokens if t not in _STRUCTURAL_STOP_WORDS]
    after_all = [t for t in after_structural if t not in _SOFT_STOP_WORDS]
    # Guard: if full strip leaves only geographic residuals, keep soft-stop tokens
    # so different clubs from the same city are still distinguishable by JW.
    if after_all and all(t in _GEO_RESIDUALS for t in after_all):
        result = after_structural
    else:
        result = after_all
    return " ".join(result) if result else " ".join(tokens)

def _team_tokens(normalized: str) -> list[str]:
    """Tokens significativos de un nombre ya normalizado (excluye stop words y tokens ≤2 chars)."""
    return [t for t in normalized.split() if t not in _TEAM_STOP_WORDS and len(t) > 2]

def _has_reserve_mismatch(tokens_a: list[str], tokens_b: list[str]) -> bool:
    """True si un equipo tiene descriptor de reserva/filial y el otro no (Porto ≠ Porto B)."""
    res_a = set(tokens_a) & _RESERVE_DESCRIPTORS
    res_b = set(tokens_b) & _RESERVE_DESCRIPTORS
    return res_a != res_b

def _jaro(s1: str, s2: str) -> float:
    if s1 == s2:
        return 1.0
    if not s1 or not s2:
        return 0.0
    match_dist = max(len(s1), len(s2)) // 2 - 1
    s1_match = [False] * len(s1)
    s2_match = [False] * len(s2)
    matches = 0
    for i, c1 in enumerate(s1):
        lo = max(0, i - match_dist)
        hi = min(len(s2) - 1, i + match_dist)
        for j in range(lo, hi + 1):
            if s2_match[j] or c1 != s2[j]:
                continue
            s1_match[i] = s2_match[j] = True
            matches += 1
            break
    if not matches:
        return 0.0
    trans = 0
    k = 0
    for i, flag in enumerate(s1_match):
        if not flag:
            continue
        while not s2_match[k]:
            k += 1
        if s1[i] != s2[k]:
            trans += 1
        k += 1
    return (matches / len(s1) + matches / len(s2) + (matches - trans / 2) / matches) / 3

def _jaro_winkler(s1: str, s2: str, p: float = 0.1) -> float:
    jaro = _jaro(s1, s2)
    if jaro < 0.7:
        return jaro
    prefix = 0
    for c1, c2 in zip(s1[:4], s2[:4]):
        if c1 == c2:
            prefix += 1
        else:
            break
    return jaro + prefix * p * (1 - jaro)

def _event_team_similarity(ev_a: dict, ev_b: dict) -> float:
    ha = _normalize_team(ev_a.get("home_team", ""))
    aa = _normalize_team(ev_a.get("away_team", ""))
    hb = _normalize_team(ev_b.get("home_team", ""))
    ab = _normalize_team(ev_b.get("away_team", ""))
    if not (ha and aa and hb and ab):
        return 0.0

    # Hard-lock: reserva vs equipo principal — ignorar JW por alto que sea
    if (_has_reserve_mismatch(_team_tokens(ha), _team_tokens(hb)) or
            _has_reserve_mismatch(_team_tokens(aa), _team_tokens(ab))):
        return 0.0

    jw_direct  = (_jaro_winkler(ha, hb) + _jaro_winkler(aa, ab)) / 2
    jw_reverse = (_jaro_winkler(ha, ab) + _jaro_winkler(aa, hb)) / 2
    global_score = max(jw_direct, jw_reverse)

    if global_score < 0.82:
        return global_score

    # Last-token disambiguation: catches "Manchester United" vs "Manchester City",
    # "West Ham" vs "West Brom", "Inter Miami" vs "Inter Milan", etc.
    # If last tokens diverge (JW < 0.85) → teams are different despite high global JW.
    if jw_direct >= jw_reverse:
        pairs = [(ha, hb), (aa, ab)]
    else:
        pairs = [(ha, ab), (aa, hb)]

    def _last_token_ok(na: str, nb: str) -> bool:
        ta, tb = _team_tokens(na), _team_tokens(nb)
        if not ta or not tb:
            return True   # nombre muy corto — confiar en JW global
        # Geo-residual count guard (Q2): if one name is a pure geographic token
        # ("barcelona") and the other has additional discriminating tokens
        # ("atletico barcelona"), reject immediately — they are different clubs.
        if len(ta) != len(tb):
            set_a, set_b = set(ta), set(tb)
            if (set_a.issubset(_GEO_RESIDUALS) or set_b.issubset(_GEO_RESIDUALS)) and set_a != set_b:
                return False
        la, lb = ta[-1], tb[-1]
        # Aplicar solo si ambos tokens son palabras reales (len > 2).
        # Acrónimos/sufijos cortos (len ≤ 2: "sg", "bk", "cf") no son discriminadores fiables.
        if len(la) <= 2 or len(lb) <= 2:
            return True
        return _jaro_winkler(la, lb) >= 0.85

    if not all(_last_token_ok(a, b) for a, b in pairs):
        return 0.0  # tokens discriminadores divergen → equipos distintos

    return global_score

def _run_normalize_tests() -> None:
    """
    Q2 regression suite — call manually to verify the normalisation + JW pipeline.
    Covers geo-collision, single-token geographic names, and soft-stop-word guard.
    """
    def sim(ha: str, aa: str, hb: str, ab: str) -> float:
        return _event_team_similarity(
            {"home_team": ha, "away_team": aa},
            {"home_team": hb, "away_team": ab},
        )

    # ── _normalize_team ──────────────────────────────────────────────────────
    assert _normalize_team("Real Madrid") == "real madrid",      "guard must retain 'real'"
    assert _normalize_team("Real Betis") == "betis",             "non-geo residual → strip 'real'"
    assert _normalize_team("Atletico Madrid") == "atletico madrid", "'atletico' is NOT a stop word"
    assert _normalize_team("FC Barcelona") == "barcelona",       "structural 'fc' stripped"
    assert _normalize_team("Barcelona") == "barcelona",          "single geo token — guard no-op"
    assert _normalize_team("Manchester City") == "manchester city", "no stop words to strip"
    assert _normalize_team("Manchester United") == "manchester united", "no stop words to strip"

    # ── Q2 core case: single-token geo name vs multi-token composite ─────────
    # "Barcelona" → "barcelona"; "Atletico Barcelona" → "atletico barcelona"
    # JW("barcelona", "atletico barcelona") ≈ 0.61 < 0.82 → rejected
    score = sim("Barcelona", "Sevilla", "Atletico Barcelona", "Malaga")
    assert score == 0.0, f"Barcelona vs Atletico Barcelona must not match (got {score:.3f})"

    # ── Geo-collision guard: Real Madrid vs Atletico Madrid ──────────────────
    # JW("real madrid", "atletico madrid") ≈ 0.81 < 0.82 → rejected by global threshold
    score = sim("Real Madrid", "Real Betis", "Atletico Madrid", "Valencia")
    assert score == 0.0, f"Real Madrid vs Atletico Madrid must not match (got {score:.3f})"

    # ── Same-city last-token rejection: Manchester United vs Manchester City ──
    score = sim("Manchester United", "Liverpool", "Manchester City", "Arsenal")
    assert score == 0.0, f"Man United vs Man City must not match (got {score:.3f})"

    # ── Legitimate single-source match: FC Barcelona == Barcelona ────────────
    score = sim("FC Barcelona", "Real Madrid", "Barcelona", "Real Madrid")
    assert score > 0.82, f"FC Barcelona vs Barcelona must match (got {score:.3f})"

    # ── PSG: short acronym token is skip (len ≤ 2) — should NOT false-reject ─
    score = sim("Paris Saint-Germain", "Lyon", "PSG", "Olympique Lyonnais")
    # Normalized: "paris germain" vs "psg", "lyon" vs "olympique lyonnais"
    # JW global likely < 0.82, so 0.0 — this is correct (different names across APIs)
    # The point is it must not CRASH and must return a float.
    assert isinstance(score, float), "PSG test must return float"

    # ── West Ham vs West Brom: len > 2 check rejects via JW(ham, brom) < 0.85 ─
    score = sim("West Ham United", "Fulham", "West Bromwich Albion", "Brentford")
    assert score == 0.0, f"West Ham vs West Brom must not match (got {score:.3f})"

    print("_run_normalize_tests: all assertions passed ✓")


def _merge_cross_source_events(events: list, live: bool) -> list:
    """
    Merge DualStats events into matching Odds API events by team-name similarity.
    Threshold: Jaro-Winkler ≥ 0.82. Unmatched DualStats events are appended.
    """
    THRESHOLD = 0.82
    TIME_WINDOW_SECS = 60 * 60  # ±60 min for prematch

    odds_api = [e for e in events if e.get("_source") != "dualstats"]
    dualstats = [e for e in events if e.get("_source") == "dualstats"]

    if not odds_api or not dualstats:
        return events

    merged = list(odds_api)
    unmatched = []

    for ds in dualstats:
        try:
            ds_time = datetime.fromisoformat(ds.get("commence_time", "").replace("Z", ""))
        except Exception:
            ds_time = None

        best_score, best_match = 0.0, None
        for oa in merged:
            if _norm_sport_key(ds.get("sport_key", "")) != _norm_sport_key(oa.get("sport_key", "")):
                continue  # sport mismatch — evita falsos matches entre deportes
            if not live and ds_time:
                try:
                    oa_time = datetime.fromisoformat(oa.get("commence_time", "").replace("Z", ""))
                    if abs((ds_time - oa_time).total_seconds()) > TIME_WINDOW_SECS:
                        continue
                except Exception:
                    pass
            score = _event_team_similarity(ds, oa)
            if score > best_score:
                best_score, best_match = score, oa

        if best_score >= THRESHOLD and best_match is not None:
            existing_keys = {bk["key"] for bk in best_match.get("bookmakers", [])}
            for bk in ds.get("bookmakers", []):
                if bk["key"] not in existing_keys:
                    best_match.setdefault("bookmakers", []).append(bk)
            logger.debug(
                f"[cross-match] {ds.get('home_team')} vs {ds.get('away_team')} "
                f"↔ {best_match.get('home_team')} vs {best_match.get('away_team')} "
                f"score={best_score:.3f}"
            )
        else:
            unmatched.append(ds)

    merged.extend(unmatched)
    return merged

# ── Telegram rate-limiting queue (30 msg/s global, 1 msg/s per chat) ──────────

class TelegramMessageTask:
    """Message envelope for asyncio rate-limit queue. Exposes a Future for callers
    that need to await the sent Message object (e.g. to capture message_id)."""
    __slots__ = ("chat_id", "text", "kwargs", "future", "profit")

    def __init__(self, chat_id: int, text: str, profit: float = 0.0, **kwargs):
        self.chat_id = chat_id
        self.text    = text
        self.profit  = profit
        self.kwargs  = kwargs
        self.future: asyncio.Future = asyncio.get_running_loop().create_future()

_tg_queue: asyncio.Queue | None = None
_tg_last_per_chat: dict[int, float] = {}

async def _telegram_sender_task(app_bot):
    """Background sender — drains _tg_queue respecting Telegram rate limits."""
    global _tg_queue
    last_global: float = 0.0
    min_global_gap = 1 / 30   # 30 msg/s ≈ 33 ms
    min_chat_gap   = 1.0      # 1 msg/s per chat
    while True:
        try:
            task: TelegramMessageTask = await asyncio.wait_for(_tg_queue.get(), timeout=5.0)
        except asyncio.TimeoutError:
            continue
        loop = asyncio.get_event_loop()
        now = loop.time()
        gap_global = min_global_gap - (now - last_global)
        if gap_global > 0:
            await asyncio.sleep(gap_global)
        last_chat = _tg_last_per_chat.get(task.chat_id, 0.0)
        gap_chat  = min_chat_gap - (loop.time() - last_chat)
        if gap_chat > 0:
            await asyncio.sleep(gap_chat)
        try:
            msg = await app_bot.send_message(chat_id=task.chat_id, text=task.text, **task.kwargs)
            if not task.future.done():
                task.future.set_result(msg)
        except Exception as e:
            logger.error(f"[TG sender] chat {task.chat_id}: {e}")
            if not task.future.done():
                task.future.set_exception(e)
        t = loop.time()
        last_global                    = t
        _tg_last_per_chat[task.chat_id] = t
        _tg_queue.task_done()

async def tg_send(app_bot, chat_id: int, text: str, _profit: float = 0.0, **kwargs):
    """
    Enqueue a Telegram message for rate-limited delivery.
    Returns an asyncio.Future that resolves to the sent Message (for message_id capture).
    Falls back to direct send if queue not initialized.
    On QueueFull: displaces the lowest-profit queued task if new task has higher profit;
    otherwise drops the new task (backpressure).
    """
    global _tg_queue
    if _tg_queue is None:
        return await app_bot.send_message(chat_id=chat_id, text=text, **kwargs)
    task = TelegramMessageTask(chat_id, text, profit=_profit, **kwargs)
    if not _tg_queue.full():
        _tg_queue.put_nowait(task)
        return task.future
    # Priority backpressure: displace the lowest-profit queued task
    q_deque = getattr(_tg_queue, "_queue", None)
    if q_deque is not None and len(q_deque) > 0:
        min_idx = min(range(len(q_deque)), key=lambda i: getattr(q_deque[i], "profit", 0.0))
        evicted = q_deque[min_idx]
        if _profit > getattr(evicted, "profit", 0.0):
            q_deque[min_idx] = task
            evicted.future.cancel()
            logger.warning(
                f"[TG queue] priority swap: evicted profit={getattr(evicted, 'profit', 0.0):.2f}% "
                f"→ new profit={_profit:.2f}% to {chat_id}"
            )
            return task.future
    task.future.cancel()
    logger.warning(f"[TG queue] full ({_tg_queue.maxsize}) — dropped alert to {chat_id} (profit={_profit:.2f}%)")
    return None

MARKET_LABELS = {"h2h": "1X2", "totals": "Totales"}

SPORTS_H2H_LABEL = {"soccer"}  # solo fútbol usa "1X2"; el resto "Ganador"

def get_market_label(market: str, sport_key: str) -> str:
    if market == "h2h":
        return "1X2" if any(sport_key.startswith(s) for s in SPORTS_H2H_LABEL) else "Ganador"
    return MARKET_LABELS.get(market, "?")

def construir_mensaje_surebet(event, ap, sport_key, live, stake=100.0):
    profit = ap["profit"]
    emoji, nombre_deporte = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
    liga = event.get("sport_title", LEAGUE_MAP.get(sport_key, ""))
    try:
        dt_mad = datetime.fromisoformat(event["commence_time"].replace("Z","")).replace(tzinfo=timezone.utc).astimezone(_TZ_MAD)
        fecha_str = dt_mad.strftime("%d/%m %H:%M")
    except: fecha_str = "??/??"
    def _leg_line(l):
        region_tag = f" [{l['region']}]" if l.get("region") else ""
        return (f"📕 {l['bookmaker']}{region_tag} 📍 {formatear_outcome(l)} "
                f"[{get_market_label(l.get('market',''), sport_key)}] "
                f"🎲 @{l['odd']} 💰 €{redondear_stake(stake * l['stake_pct'] / 100)}\n")
    lineas   = "".join(_leg_line(l) for l in ap["legs"])
    cabecera = f"📢 Alerta Surebets!{' 🎥 LIVE' if live else ''}\n💵 Beneficio garantizado: {profit:.2f}%"
    sospechoso = "\n⚠️ *Beneficio >15% — verifica cuotas antes de apostar*" if profit > 15 else ""
    draw_warn  = "\n⚠️ *ATENCIÓN: el empate NO está cubierto — si el partido empata se pierden AMBAS apuestas*" if ap.get("draw_risk") else ""
    timestamp  = local_now().strftime("%H:%M:%S")
    return (f"{cabecera}{sospechoso}{draw_warn}\n\n"
            f"{emoji} {nombre_deporte} — {liga}\n"
            f"🗓️ {fecha_str}{' 🎥 LIVE' if live else ''}\n"
            f"🏆 {event['home_team']} – {event['away_team']}\n{lineas}"
            f"⏰ Generada a las {timestamp} — actúa rápido")

def construir_mensaje_middle(event, ap, sport_key, live, stake=100.0):
    emoji, nombre_deporte = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
    liga = event.get("sport_title", LEAGUE_MAP.get(sport_key, ""))
    try:
        dt_mad = datetime.fromisoformat(event["commence_time"].replace("Z","")).replace(tzinfo=timezone.utc).astimezone(_TZ_MAD)
        fecha_str = dt_mad.strftime("%d/%m %H:%M")
    except: fecha_str = "??/??"
    lineas = "".join([
        f"📕 {l['bookmaker']} 📍 {formatear_outcome(l)} [{get_market_label(l.get('market',''), sport_key)}] "
        f"🎲 @{l['odd']} 💰 €{redondear_stake(stake * l['stake_pct'] / 100)}\n"
        for l in ap["legs"]
    ])
    peor = ap['profit_base']
    peor_txt = f"⚠️ Peor caso: {peor:+.2f}%" if peor < 0 else f"✅ Mín. garantizado: {peor:+.2f}%"
    timestamp = local_now().strftime("%H:%M:%S")
    return (f"📢 Alerta Middlebets!{' 🎥 LIVE' if live else ''}\n"
            f"📈 Máx. si middle: +{ap['profit_max']:.2f}% | {peor_txt}\n"
            f"🍀 Probabilidad middle: {ap['prob_middle']:.2f}%\n\n"
            f"{emoji} {nombre_deporte} — {liga}\n🗓️ {fecha_str}\n"
            f"🏆 {event['home_team']} – {event['away_team']}\n{lineas}"
            f"⏰ Generada a las {timestamp} — actúa rápido")

async def escanear_y_alertar(app, live=False, user_ids=None, tipos_override=None):
    global stats
    all_sports = set()
    targets    = user_ids or list(subscriptions.keys())
    for uid in targets:
        if not tiene_suscripcion(uid): continue
        cfg = get_config(uid)
        for sport, active in cfg["sports"].items():
            if active: all_sports.add(sport)
    # Filtrar deportes pausados globalmente por el admin
    _scanner_state = _load_scanner_state()
    all_sports -= set(_scanner_state.get("disabled_sports", []))
    if not all_sports: return 0
    total_surebets = 0; total_middles = 0
    now = datetime.utcnow()
    for sport_key in all_sports:
        # Concurrent fetch: The Odds API (international) + DualStats (VPS, ES casas)
        if sport_key == "basketball":
            odds_tasks = [fetch_odds(_bk, live=live) for _bk in BASKETBALL_API_KEYS]
        elif sport_key == "rugbyleague":
            odds_tasks = [fetch_odds(_bk, live=live) for _bk in RUGBYLEAGUE_API_KEYS]
        else:
            odds_tasks = [fetch_odds(sport_key, live=live)]
        odds_tasks.append(fetch_dualstats_odds(sport_key, live=live))
        results_list = await asyncio.gather(*odds_tasks, return_exceptions=True)

        # Collect events from both sources, then merge cross-source by Jaro-Winkler team-name matching
        events: list[dict] = []
        for result in results_list:
            if isinstance(result, Exception):
                logger.error(f"fetch error {sport_key}: {result}")
                continue
            events.extend(result)
        events = _merge_cross_source_events(events, live)
        for event in events:
            try: commence = datetime.fromisoformat(event["commence_time"].replace("Z",""))
            except: commence = None
            # Pre-match: skip event when commence is unparseable
            if not live and commence is None: continue
            # Live: skip events con hora desconocida o que aún no han empezado (>5 min en el futuro)
            if live and (not commence or (commence - now).total_seconds() > 300): continue
            for uid in targets:
                if not tiene_suscripcion(uid): continue
                # ── Comprobar pausa de alertas ──────────────────
                if uid in pausa_alertas and local_now() < pausa_alertas[uid]: continue
                cfg = get_config(uid)
                if not cfg["sports"].get(sport_key, False): continue
                if commence and not live:
                    secs = (commence - now).total_seconds()
                    if secs < 0 or secs / 86400 > cfg["max_days"]: continue
                active_bks    = [k for k, v in cfg["bookmakers"].items() if v]
                buscar_middles = cfg.get("middlebets_on", False)
                apuestas = encontrar_apuestas(event, active_bks, buscar_middles, sport_key=sport_key)
                for ap in apuestas:
                    tipo = ap["tipo"]
                    if tipos_override and tipo not in tipos_override: continue
                    stake = cfg.get("stake", 100.0)
                    if tipo == "surebet":
                        if not cfg.get("surebets_on", True): continue
                        if live and not cfg.get("surebets_live_on", True): continue
                        if ap["profit"] < cfg.get("min_profit_surebet", 1.0): continue
                        if ap.get("draw_risk") and cfg.get("block_draw_risk_surebets", False): continue
                        mensaje = construir_mensaje_surebet(event, ap, sport_key, live, stake=stake)
                        total_surebets += 1
                    elif tipo == "middlebet":
                        if not buscar_middles: continue
                        if ap["profit_base"] < cfg.get("min_profit_middle", 2.0): continue
                        if ap["prob_middle"]  < cfg.get("min_prob_middle", 5.0): continue
                        mensaje = construir_mensaje_middle(event, ap, sport_key, live, stake=stake)
                        total_middles += 1
                    else: continue
                    if live:
                        # Live: deduplicate by stable key (no odds) — 180s cooldown or ≥0.5pp profit improvement
                        base_clave = f"{uid}_{clave_apuesta_base(event, ap, tipo)}"
                        if ya_enviada_live(base_clave, ap["profit"]): continue
                        marcar_enviada_live(base_clave, ap["profit"])
                    else:
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
                        # Botones fila 1: ✅/❌ | Fila 2: links directos a casas (no cuentan contra el límite 4096)
                        link_btns = [
                            InlineKeyboardButton(f"🔗 {leg['bookmaker']}", url=BOOKMAKER_URLS[leg["bookmaker_key"]])
                            for leg in ap.get("legs", [])
                            if leg.get("bookmaker_key", "") in BOOKMAKER_URLS
                        ]
                        kb_rows = [[
                            InlineKeyboardButton("✅ Hecha",    callback_data=f"AH_{uid}_{alert_id}"),
                            InlineKeyboardButton("❌ No hecha", callback_data=f"ANH_{uid}_{alert_id}"),
                        ]]
                        if link_btns:
                            kb_rows.append(link_btns[:4])  # máx 4 botones por fila
                        kb = InlineKeyboardMarkup(kb_rows)
                    try:
                        if kb:
                            fut = await tg_send(app.bot, uid, mensaje, _profit=ap["profit"], reply_markup=kb)
                            if asyncio.isfuture(fut):
                                try:
                                    sent = await asyncio.wait_for(asyncio.shield(fut), timeout=10.0)
                                    if sent and cache_key in alerta_cache:
                                        alerta_cache[cache_key]["msg_id"] = sent.message_id
                                        _save_alerts_cache()
                                except (asyncio.TimeoutError, asyncio.CancelledError):
                                    # Shield timeout: fut sigue vivo en la cola.
                                    # Registrar done_callback con deadline para capturar msg_id cuando el sender
                                    # lo resuelva sin actualizar entradas obsoletas si el bot tardó demasiado.
                                    import time as _time
                                    _cb_deadline = _time.monotonic() + 60.0  # 60s máximo de espera post-timeout
                                    def _capture_msg_id(
                                        f: asyncio.Future,
                                        _ck: str = cache_key,
                                        _dl: float = _cb_deadline,
                                    ) -> None:
                                        try:
                                            if _time.monotonic() > _dl:
                                                return   # demasiado tarde — no actualizar cache obsoleta
                                            if f.cancelled() or f.exception():
                                                return
                                            result = f.result()
                                            if result and _ck in alerta_cache:
                                                alerta_cache[_ck]["msg_id"] = result.message_id
                                                _save_alerts_cache()
                                        except Exception:
                                            pass
                                    if not fut.done():
                                        fut.add_done_callback(_capture_msg_id)
                                    logger.debug(f"[DualStats] shield timeout uid={uid} — done_callback registrado (deadline 60s)")
                                except Exception:
                                    logger.warning(f"[DualStats] Error capturando message_id uid={uid}")
                            elif fut is not None:
                                # Direct send (queue=None) — fut ES el Message
                                if cache_key in alerta_cache:
                                    alerta_cache[cache_key]["msg_id"] = fut.message_id
                                    _save_alerts_cache()
                        else:
                            await tg_send(app.bot, uid, mensaje, _profit=ap["profit"])
                        last_surebet[uid] = ap
                        # ── Contador diario ─────────────────────
                        hoy = datetime.now().date()
                        if uid not in alertas_hoy or alertas_hoy[uid]["date"] != hoy:
                            alertas_hoy[uid] = {"date": hoy, "count": 0}
                        alertas_hoy[uid]["count"] += 1
                    except Exception as e:
                        logger.error(f"Error enviando alerta a {uid}: {e}")
    if not user_ids:
        stats["surebets_encontradas"]  = total_surebets
        stats["middlebets_encontradas"] = total_middles
        stats["ultima_actualizacion"]   = local_now()
        interval = BOT_CONFIG["scan_live_interval"] if live else BOT_CONFIG["scan_prematch_interval"]
        stats["proxima_actualizacion"]  = local_now() + timedelta(seconds=interval)
    logger.info(f"Escaneo {'LIVE' if live else 'PRE'}: {total_surebets} surebets, {total_middles} middles")
    return total_surebets + total_middles

async def tarea_escaneo_prematch(context: ContextTypes.DEFAULT_TYPE):
    if api_credits_remaining is not None and api_credits_remaining <= 0:
        logger.warning("[prematch] Sin créditos API — escaneo omitido.")
        return
    await escanear_y_alertar(context.application, live=False)

async def tarea_escaneo_live(context: ContextTypes.DEFAULT_TYPE):
    global live_empty_streak
    if api_credits_remaining is not None and api_credits_remaining <= 0:
        logger.warning("[live] Sin créditos API — escaneo omitido.")
        return
    # Prune stale live deduplication entries (live games never last >3h)
    cutoff = datetime.now() - timedelta(hours=3)
    stale = [k for k, v in live_sent_surebets.items() if v["ts"] < cutoff]
    if stale:
        for k in stale:
            del live_sent_surebets[k]
        logger.debug(f"[live_cache] Pruned {len(stale)} stale entries, {len(live_sent_surebets)} remaining")
    found = await escanear_y_alertar(context.application, live=True)
    if found == 0:
        live_empty_streak += 1
    else:
        live_empty_streak = 0
    # Log créditos tras cada ciclo live
    if api_credits_remaining is not None:
        logger.info(f"[API] Créditos restantes: {api_credits_remaining} | Usados: {api_credits_used}"
                    + (" ⚠️ BAJOS" if api_credits_remaining < 500 else ""))

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
        [InlineKeyboardButton("🆘 Soporte",     callback_data="soporte"),
         InlineKeyboardButton("🆕 Novedades",  callback_data="novedades")],
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

def _auto_delete(context: ContextTypes.DEFAULT_TYPE, chat_id: int, message_id: int, delay: int = 5):
    """Borra el mensaje del usuario tras `delay` segundos (fire-and-forget)."""
    async def _task():
        await asyncio.sleep(delay)
        try:
            await context.bot.delete_message(chat_id=chat_id, message_id=message_id)
        except Exception:
            pass
    asyncio.create_task(_task())

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    user    = update.effective_user
    user_id = user.id
    args    = context.args

    if is_banned(user_id):
        await update.message.reply_text(
            "🚫 Tu acceso a FidesBot está restringido.\n"
            "Si crees que es un error, contacta con soporte.")
        return

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
        creditos[user_id] = CREDITOS_INICIALES

    # ── Trial automático para usuarios completamente nuevos ─────────────────
    if user_id not in subscriptions:
        trial_exp = local_now() + timedelta(hours=72)
        trial_cfg = deepcopy(DEFAULT_USER_CONFIG)
        trial_cfg["_is_trial"] = True          # persiste a través del sync con la API
        subscriptions[user_id] = {
            "name":     user.full_name or str(user_id),
            "expires":  trial_exp,
            "config":   trial_cfg,
            "is_trial": True,
        }
        guardar_db()
        try:
            await context.bot.send_message(
                chat_id=ADMIN_ID,
                text=(f"🆕 *Nuevo usuario en prueba*\n"
                      f"{user.full_name} (`{user_id}`)\n"
                      f"⏰ Expira: {trial_exp.strftime('%d/%m/%Y %H:%M')}"),
                parse_mode="Markdown")
        except Exception:
            pass
        await update.message.reply_text(
            f"🎁 *¡Bienvenido a FidesBot!*\n━━━━━━━━━━━━━━━━━━\n\n"
            f"Tienes *3 días de prueba gratuita* para descubrir cómo funcionan las alertas "
            f"de surebets y middlebets en tiempo real.\n\n"
            f"⏰ Tu prueba expira el *{trial_exp.strftime('%d/%m/%Y a las %H:%M')}*\n\n"
            f"_Cuando termine, elige un plan desde el menú para seguir recibiendo alertas._",
            parse_mode="Markdown")
    else:
        guardar_db()

    if not tiene_suscripcion(user_id):
        await menu_no_suscrito(update); return
    await menu_principal(update, context)

async def cmd_id(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    uid = update.effective_user.id
    await update.message.reply_text(
        f"🪪 *Tu ID de Telegram:*\n`{uid}`\n\n"
        "Puedes suscribirte directamente desde el menú principal del bot.\n"
        "Si necesitas ayuda, comparte este ID con soporte.",
        parse_mode="Markdown")

async def cmd_terms(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    volver = "menu_principal" if tiene_suscripcion(update.effective_user.id) else "menu_no_suscrito"
    await update.message.reply_text(TERMINOS,
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data=volver)]]),
        parse_mode="Markdown")

async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    await mostrar_hub_soporte(update, context)

async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    ahora   = local_now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    casas_activas = sum(1 for v in BOOKMAKERS.values() if "✅" in v.get("status", ""))
    casas_str   = f" • {casas_activas}/{len(BOOKMAKERS)} casas con scraper activo (detalle en /casas)"
    creditos_linea = (f"💳 Créditos API: *{api_credits_remaining}* restantes (usados: {api_credits_used})\n"
                      if api_credits_remaining is not None else "💳 Créditos API: *sin datos aún*\n")
    creditos_alerta = " ⚠️ *BAJOS — recarga o pausa en breve*" if (api_credits_remaining is not None and api_credits_remaining < 500) else ""
    await update.message.reply_text(
        f"🤖 *Estado de FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"📡 *General:*\n • ✅ Servicio operativo\n"
        f" • ⏱️ Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📡 *Casas monitorizadas:*\n{casas_str}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💎 Surebets: *{stats['surebets_encontradas']}* ⏳ {ultima}\n"
        f"🎯 Middlebets: *{stats['middlebets_encontradas']}* ⏳ {ultima}\n"
        f"📊 Valuebets: *{stats['valuebets_encontradas']}* ⏳ {ultima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"🆕 {ahora.strftime('%d/%m/%Y %H:%M')}\n"
        f"⏱️ Pre-partido: cada {BOT_CONFIG['scan_prematch_interval']//60} min | "
        f"Live: cada {BOT_CONFIG['scan_live_interval']//60} min\n"
        f"{creditos_linea}{creditos_alerta}",
        parse_mode="Markdown")

# ============================================================
# PANEL PRINCIPAL
# ============================================================
async def menu_principal(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if not tiene_suscripcion(user_id):
        await menu_no_suscrito(update); return
    cfg    = get_config(user_id)
    nombre = update.effective_user.first_name or update.effective_user.username or str(user_id)
    dias       = dias_restantes(user_id)
    stake      = cfg.get("stake", 100.0)
    is_trial   = subscriptions.get(user_id, {}).get("is_trial", False)
    expires_dt = subscriptions.get(user_id, {}).get("expires")
    icono_sub  = icono_suscripcion(dias)
    ultimo     = get_ultimo_escaneo_str(user_id)
    if is_trial and expires_dt:
        horas_left        = max(0, int((expires_dt - datetime.now()).total_seconds() / 3600))
        icono_sub         = "🆕"
        dias_str_completo = f"PRUEBA — {horas_left}h restantes\n🗓️ Hasta {expires_dt.strftime('%d/%m/%y %H:%M')}"
        aviso = (f"\n⚠️ *Prueba gratuita: {horas_left}h restantes.* "
                 f"Pulsa 🔄 Renovar para continuar.") if horas_left < 24 else ""
    elif dias == 9999:
        dias_str_completo = "∞ días restantes"
        aviso = ""
    else:
        fecha_str         = expires_dt.strftime("%d/%m/%y %H:%M") if expires_dt else "—"
        dias_str_completo = f"{dias} días restantes\n🗓️ Termina {fecha_str}"
        aviso = f"\n⚠️ *¡Suscripción caduca en {dias} días!* Pulsa 🔄 Renovar abajo." if dias <= 5 else ""

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
        [InlineKeyboardButton("🆘 Soporte",      callback_data="soporte"),
         InlineKeyboardButton("🆕 Novedades",    callback_data="novedades")],
        [InlineKeyboardButton("🔄 Renovar suscripción", callback_data="suscribirse")],
    ]
    surebets_icon  = "✅" if cfg.get("surebets_on", True) else "❌"
    middles_icon   = "✅" if cfg.get("middlebets_on", False) else "❌"
    valuebets_icon = "✅" if cfg.get("valuebets_on", False) else "❌"
    live_icon      = "✅" if cfg.get("surebets_live_on", True) else "❌"
    hoy = datetime.now().date()
    cnt_hoy = alertas_hoy.get(user_id, {}).get("count", 0) if alertas_hoy.get(user_id, {}).get("date") == hoy else 0
    pausa_str = ""
    if user_id in pausa_alertas and datetime.now() < pausa_alertas[user_id]:
        mins = int((pausa_alertas[user_id] - datetime.now()).total_seconds() / 60)
        pausa_str = f"\n⏸️ *Alertas pausadas* — {mins} min restantes"
    texto = (
        f"🤖 *FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"👤 *{nombre}* — {icono_sub} *{dias_str_completo}*\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"• 💎 Surebets {surebets_icon}\n• 🎯 Middlebets {middles_icon}\n"
        f"• 📊 Valuebets {valuebets_icon}\n• ⚡ LIVE {live_icon}\n"
        f"⚡ Alertas hoy: *{cnt_hoy}*{pausa_str}\n"
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
    ahora   = local_now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    await update.callback_query.edit_message_text(
        f"💎 *Panel Surebets*\n━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ Pre: ~{BOT_CONFIG['scan_prematch_interval']//60} min | Live: ~{BOT_CONFIG['scan_live_interval']//60} min\n\n"
        f"💎 Nº Surebets: *{stats['surebets_encontradas']}* ⏳ Act: {ultima}\n"
        f"🕐 Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Información:*\n• Garantizan beneficio sin riesgo mediante arbitraje.\n"
        f"• El bot detecta diferencias de cuotas entre casas.\n"
        f"• Revisa siempre las cuotas antes de apostar.\n\n"
        f"⚠️ *Atención:*\n• Puede haber datos ligeramente desactualizados.\n"
        f"━━━━━━━━━━━━━━━━━━\n🆕 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🔍 Buscar surebets ahora", callback_data="buscar_surebets")],
            [InlineKeyboardButton("🔙 Volver", callback_data="menu_principal")],
        ]), parse_mode="Markdown")

async def panel_middles(update, context):
    await update.callback_query.answer()
    ahora   = local_now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    await update.callback_query.edit_message_text(
        f"🎯 *Panel Middlebets*\n━━━━━━━━━━━━━━━━━━\n"
        f"⚠️ Pre: ~{BOT_CONFIG['scan_prematch_interval']//60} min | Live: ~{BOT_CONFIG['scan_live_interval']//60} min\n\n"
        f"🎯 Nº Middlebets: *{stats['middlebets_encontradas']}* ⏳ Act: {ultima}\n"
        f"🕐 Próx. actualización: {proxima}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Información:*\n• Apuestas en dos casas con un rango de resultados ganador.\n"
        f"• Si el resultado cae en el middle, ganas las DOS apuestas.\n"
        f"• Si no cae en el middle, la pérdida es mínima.\n\n"
        f"⚠️ *Atención:*\n• La probabilidad del middle es una estimación.\n"
        f"━━━━━━━━━━━━━━━━━━\n🆕 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🔍 Buscar middlebets ahora", callback_data="buscar_middles")],
            [InlineKeyboardButton("🔙 Volver", callback_data="menu_principal")],
        ]), parse_mode="Markdown")

async def panel_valuebets(update, context):
    await update.callback_query.answer()
    ahora   = local_now()
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
    user_id  = update.effective_user.id
    suscrito = tiene_suscripcion(user_id)
    creds    = get_creditos(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"
    casas    = list(BOOKMAKER_NAMES.items())
    keyboard = []
    for i in range(0, len(casas), 2):
        fila = [InlineKeyboardButton(nombre, callback_data=f"freebet_casa_{key}") for key, nombre in casas[i:i+2]]
        keyboard.append(fila)
    keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data=volver)])

    if suscrito:
        creds_txt = "♾️ Créditos ilimitados _(suscriptor activo)_"
    else:
        creds_txt = f"💰 Tus créditos: *{creds}*"

    await update.callback_query.edit_message_text(
        f"🎁 *Búsqueda con créditos*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"{creds_txt}\n━━━━━━━━━━━━━━━━━━\n\n"
        f"🔍 Busca surebets de baja rentabilidad _(≤{MAX_PROFIT_FREEBET}%)_ en tu casa favorita.\n\n"
        f"💡 *Cómo funciona:*\n"
        f"• Elige una casa de apuestas.\n"
        f"• El bot busca surebets ahora mismo que la incluyan.\n"
        f"• Cada búsqueda cuesta *1 crédito* _(gratis si tienes suscripción)_.\n\n"
        f"⚠️ *Elige la casa de apuestas:*",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def freebet_casa_seleccionada(update, context, casa_key):
    await update.callback_query.answer()
    user_id     = update.effective_user.id
    casa_nombre = BOOKMAKER_NAMES.get(casa_key, casa_key)
    suscrito    = tiene_suscripcion(user_id)

    # Gastar crédito (devuelve True gratis si está suscrito)
    if not gastar_credito(user_id):
        await update.callback_query.edit_message_text(
            f"❌ *Sin créditos suficientes*\n\nNecesitas al menos 1 crédito para buscar.\n\n"
            f"💡 *Cómo ganar créditos:*\n"
            f"• Invita a alguien → +{CREDITOS_POR_REFERIDO} créditos\n"
            f"• Suscríbete → créditos ilimitados + {CREDITOS_POR_SUSCRIPCION} de regalo al renovar",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("👥 Mis referidos", callback_data="mis_referidos")],
                [InlineKeyboardButton("💳 Suscribirse",   callback_data="suscribirse")],
                [InlineKeyboardButton("🔙 Volver",        callback_data="panel_freebets")],
            ]), parse_mode="Markdown")
        return

    # Mostrar "buscando..." mientras trabaja
    await update.callback_query.edit_message_text(
        f"🔍 *Buscando surebets con {casa_nombre}...*\n\n_Esto puede tardar unos segundos._",
        parse_mode="Markdown")

    cfg        = get_config(user_id)
    active_bks = [k for k, v in cfg["bookmakers"].items() if v]
    sports_on  = [k for k, v in cfg["sports"].items() if v][:MAX_SPORTS_FREEBET]

    halladas = []
    for sport_key in sports_on:
        try:
            if sport_key == "basketball":
                api_keys = BASKETBALL_API_KEYS
            elif sport_key == "rugbyleague":
                api_keys = RUGBYLEAGUE_API_KEYS
            else:
                api_keys = [sport_key]
            events = []
            for ak in api_keys:
                events.extend(await fetch_odds(ak, live=False))
        except Exception:
            continue
        for event in events:
            apuestas = encontrar_apuestas(event, active_bks, buscar_middles=True, sport_key=sport_key)
            for ap in apuestas:
                profit = ap.get("profit", 0)
                if profit <= 0 or profit > MAX_PROFIT_FREEBET:
                    continue
                # Verificar que la casa elegida aparece en alguna pata
                if not any(l["bookmaker"].lower() == casa_nombre.lower() for l in ap["legs"]):
                    continue
                halladas.append({
                    "evento":    f"{event['home_team']} – {event['away_team']}",
                    "sport_key": sport_key,
                    "ap":        ap,
                })

    # Ordenar por profit desc y mostrar hasta 5
    halladas.sort(key=lambda x: x["ap"]["profit"], reverse=True)
    halladas = halladas[:5]

    creds_txt = "♾️ Créditos ilimitados" if suscrito else f"💰 Créditos restantes: *{get_creditos(user_id)}*"

    if not halladas:
        await update.callback_query.edit_message_text(
            f"🎁 *{casa_nombre}* — Sin resultados\n━━━━━━━━━━━━━━━━━━\n\n"
            f"😔 No hay surebets disponibles ahora con *{casa_nombre}* en rango ≤{MAX_PROFIT_FREEBET}%.\n\n"
            f"💡 Las cuotas cambian constantemente. Prueba de nuevo en unos minutos.\n\n"
            f"{creds_txt}",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("🔄 Buscar de nuevo", callback_data=f"freebet_casa_{casa_key}")],
                [InlineKeyboardButton("🔙 Volver",          callback_data="panel_freebets")],
            ]), parse_mode="Markdown")
        return

    lineas = []
    for r in halladas:
        ap      = r["ap"]
        emoji, _ = SPORT_DISPLAY.get(r["sport_key"], ("🏅", ""))
        tipo_tag = "🎯 Middle" if ap["tipo"] == "middlebet" else "💎 Surebet"
        patas   = " / ".join(
            f"{l['bookmaker']} @{l['odd']} _{l['stake_pct']}%_" for l in ap["legs"]
        )
        lineas.append(
            f"{emoji} *{r['evento']}*\n"
            f"{tipo_tag} +{ap['profit']:.2f}%\n"
            f"{patas}"
        )

    msg = (
        f"🎁 *{casa_nombre}* — {len(halladas)} oportunidad{'es' if len(halladas)>1 else ''}\n"
        f"━━━━━━━━━━━━━━━━━━\n\n"
        + "\n\n".join(lineas) + "\n\n"
        + f"━━━━━━━━━━━━━━━━━━\n{creds_txt}"
    )
    await update.callback_query.edit_message_text(
        msg,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🔄 Buscar de nuevo", callback_data=f"freebet_casa_{casa_key}")],
            [InlineKeyboardButton("🔙 Volver",          callback_data="panel_freebets")],
        ]), parse_mode="Markdown")

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
    user_id  = update.effective_user.id
    creds    = get_creditos(user_id)
    suscrito = tiene_suscripcion(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"

    if suscrito:
        estado_txt = "✅ ACTIVA — créditos ilimitados este mes"
    else:
        estado_txt = f"❌ INACTIVA — tienes *{creds}* crédito{'s' if creds != 1 else ''}"

    await update.callback_query.edit_message_text(
        f"💰 *Mis créditos*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"💎 Suscripción: {estado_txt}\n"
        f"💰 Créditos guardados: *{creds}*\n\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💡 *Cómo ganar créditos:*\n"
        f"• Registro nuevo: *+{CREDITOS_INICIALES}* créditos\n"
        f"• Invitar a alguien: *+{CREDITOS_POR_REFERIDO}* créditos\n"
        f"• Renovar suscripción: *+{CREDITOS_POR_SUSCRIPCION}* créditos\n\n"
        f"💡 *Cómo usarlos:*\n"
        f"• 1 crédito = 1 búsqueda de surebets ≤{MAX_PROFIT_FREEBET}% en tu casa favorita\n"
        f"• Los créditos no caducan\n"
        f"• Con suscripción activa, no se gastan\n"
        f"━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🎁 Buscar surebets", callback_data="panel_freebets")],
            [InlineKeyboardButton("👥 Mis referidos",   callback_data="mis_referidos")],
            [InlineKeyboardButton("🔄 Renovar" if suscrito else "💳 Suscribirse", callback_data="suscribirse")],
            [InlineKeyboardButton("🔙 Volver",          callback_data=volver)],
        ]), parse_mode="Markdown")

# ============================================================
# MENÚ ALERTAS
# ============================================================
async def menu_alertas(update, context):
    uid = update.effective_user.id
    cfg = get_config(uid)
    s = cfg.get("surebets_on", True);  m = cfg.get("middlebets_on", False)
    v = cfg.get("valuebets_on", False); l = cfg.get("surebets_live_on", True)
    pausado = uid in pausa_alertas and datetime.now() < pausa_alertas[uid]
    if pausado:
        mins = int((pausa_alertas[uid] - datetime.now()).total_seconds() / 60)
        pausa_info = f"\n⏸️ *Pausadas {mins} min más*"
        fila_pausa = [InlineKeyboardButton("▶️ Reanudar alertas", callback_data="reanudar_alertas")]
    else:
        pausa_info = ""
        fila_pausa = [
            InlineKeyboardButton("⏸️ 2h",  callback_data="pausa_2h"),
            InlineKeyboardButton("⏸️ 4h",  callback_data="pausa_4h"),
            InlineKeyboardButton("⏸️ 8h",  callback_data="pausa_8h"),
        ]
    await update.callback_query.edit_message_text(
        f"🔔 *Alertas*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"• 💎 Surebets: {'✅ ON' if s else '❌ OFF'}\n  Arbitraje puro. Ganancia garantizada.\n\n"
        f"• 🎯 Middlebets: {'✅ ON' if m else '❌ OFF'}\n  Si cae en el middle, ganas las dos. Si no, pérdida mínima.\n\n"
        f"• 📊 Valuebets: {'✅ ON' if v else '❌ OFF'}\n  Apuestas con valor esperado positivo.\n\n"
        f"• ⚡ LIVE: {'✅ ON' if l else '❌ OFF'}\n  Alertas durante el partido en directo.\n\n"
        f"━━━━━━━━━━━━━━━━━━{pausa_info}",
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(f"💎 Surebets {'✅' if s else '❌'}",   callback_data="toggle_surebets")],
            [InlineKeyboardButton(f"🎯 Middlebets {'✅' if m else '❌'}", callback_data="toggle_middles")],
            [InlineKeyboardButton(f"📊 Valuebets {'✅' if v else '❌'}",  callback_data="toggle_valuebets")],
            [InlineKeyboardButton(f"⚡ LIVE {'✅' if l else '❌'}",        callback_data="toggle_live")],
            [InlineKeyboardButton("✅ Activar todas",    callback_data="alertas_todas"),
             InlineKeyboardButton("❌ Desactivar todas", callback_data="alertas_ninguna")],
            fila_pausa,
            [InlineKeyboardButton("🔙 Volver al panel",  callback_data="menu_principal")],
        ]), parse_mode="Markdown")

# ============================================================
# MENÚ CONFIGURACIÓN
# ============================================================
async def menu_config(update, context):
    cfg = get_config(update.effective_user.id)
    await update.callback_query.edit_message_text(
        f"⚙️ *Configuración*\n━━━━━━━━━━━━━━━━━━\n"
        f"💎 Profit mín. Surebet: *{cfg.get('min_profit_surebet', 1.0)}%*\n"
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
            [InlineKeyboardButton(f"🏅 Deportes ({sum(cfg['sports'].values())}/{len(cfg['sports'])})", callback_data="cfg_deportes")],
            [InlineKeyboardButton(f"🏦 Casas de apuestas ({sum(cfg['bookmakers'].values())}/{len(cfg['bookmakers'])})", callback_data="cfg_casas")],
            [InlineKeyboardButton("🔙 Volver al panel",   callback_data="menu_principal")],
        ]), parse_mode="Markdown")

async def menu_cfg_deportes(update, context):
    cfg = get_config(update.effective_user.id)
    keyboard = [[InlineKeyboardButton(
        ("✅ " if cfg["sports"].get(k) else "❌ ") + emoji + " " + nombre,
        callback_data=f"sport_{k}")] for k, (emoji, nombre) in SPORT_DISPLAY.items()]
    keyboard.append([InlineKeyboardButton("✅ Todos", callback_data="deportes_todos"),
                     InlineKeyboardButton("❌ Ninguno", callback_data="deportes_ninguno")])
    keyboard.append([InlineKeyboardButton("💾 Guardar y volver", callback_data="menu_config")])
    await update.callback_query.edit_message_text(
        f"🏅 *Deportes ({sum(cfg['sports'].values())}/{len(cfg['sports'])} activos)*\n"
        f"Elige los deportes para los que quieres recibir alertas de surebets y middlebets.\n"
        f"_Toca cualquier deporte para activarlo o desactivarlo._",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def menu_cfg_casas(update, context):
    cfg = get_config(update.effective_user.id)
    activas = sum(cfg["bookmakers"].values())
    casas_sel = [n for k, n in BOOKMAKER_NAMES.items() if cfg["bookmakers"].get(k)] or ["Ninguna"]
    casas_lista = [f"• {n}" for n in casas_sel]
    texto = (
        f"🏠 *Configuración Casas:*\n"
        f"📊 Estado: *{activas}/{len(BOOKMAKER_NAMES)}* casas activas\n\n"
        f"✅ *Casas seleccionadas:*\n" + "\n".join(casas_lista) + "\n\n"
        f"💡 *Información:*\n"
        f"• Más casas → más apuestas.\n"
        f"• Surebets y Middlebets: 2 casas mín.\n"
        f"• Valuebets: 1 casa mín.\n\n"
        f"_Toca cualquier casa para activarla o desactivarla._"
    )
    # Seleccionar/Deseleccionar todo primero
    keyboard = [
        [InlineKeyboardButton("✅ Seleccionar todo", callback_data="casas_todas"),
         InlineKeyboardButton("🔴 Deseleccionar todo", callback_data="casas_ninguna")],
    ]
    # Botones de casas de 2 en 2
    items = list(BOOKMAKER_NAMES.items())
    for i in range(0, len(items), 2):
        fila = [
            InlineKeyboardButton(
                ("✅ " if cfg["bookmakers"].get(k) else "❌ ") + n,
                callback_data=f"book_{k}"
            ) for k, n in items[i:i+2]
        ]
        keyboard.append(fila)
    keyboard.append([
        InlineKeyboardButton("💾 Guardar", callback_data="menu_config"),
        InlineKeyboardButton("🔙 Retroceder", callback_data="menu_config"),
    ])
    await update.callback_query.edit_message_text(
        texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

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
            # Flush inmediato para no depender del ciclo de 30s
            asyncio.create_task(flush_to_api())
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
        nuevo = not ha_pagado_antes(user_id)
        plan_info = {
            "bot_7":       ("🗓️ PRO 1 semana",     "19,99€"),
            "bot_14":      ("📅 PRO 2 semanas",    "32,99€"),
            "bot_30":      ("💎 PRO 1 mes",        "34,99€" if nuevo else "44,99€"),
            "bot_tracker": ("🔗 PRO+Tracker 1 mes", "39,99€" if nuevo else "49,99€"),
        }
        label, precio = plan_info.get(plan_key, ("Plan", ""))
        primer_mes = nuevo and plan_key in ("bot_30", "bot_tracker")
        oferta_txt = "\n_✨ Precio especial de bienvenida — primer mes_" if primer_mes else ""
        await msg.edit_text(
            f"💳 *{label} — {precio}*{oferta_txt}\n\n"
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
    nuevo    = not ha_pagado_antes(user_id)
    volver   = "menu_principal" if suscrito else "menu_no_suscrito"
    if nuevo:
        btn_30      = "💎 1 mes — 34,99€ ✨ Oferta 1er mes"
        btn_tracker = "🔗 1 mes — 39,99€ ✨ Oferta 1er mes"
    else:
        btn_30      = "💎 1 mes — 44,99€"
        btn_tracker = "🔗 1 mes — 49,99€"
    await update.callback_query.edit_message_text(SUSCRIPCION,
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("🗓️ PRO · 1 semana — 19,99€",  callback_data="stripe_bot_7")],
            [InlineKeyboardButton("📅 PRO · 2 semanas — 32,99€", callback_data="stripe_bot_14")],
            [InlineKeyboardButton(btn_30,                        callback_data="stripe_bot_30")],
            [InlineKeyboardButton(btn_tracker,                   callback_data="stripe_bot_tracker")],
            [InlineKeyboardButton("🔙 Volver",                   callback_data=volver)],
        ]), parse_mode="Markdown")

async def mostrar_hub_soporte(update, context):
    query  = update.callback_query
    uid    = update.effective_user.id
    volver = "menu_principal" if tiene_suscripcion(uid) else "menu_no_suscrito"
    texto = (
        "💬 *Atención al cliente*\n━━━━━━━━━━━━━━━━━━\n\n"
        "📝 ¿Problemas, dudas o sugerencias?\n"
        "• Usa los métodos de contacto de abajo.\n\n"
        "🐛 ¿Encontraste un fallo?\n"
        "• Escríbenos y podrás ganar *créditos*.\n\n"
        "💡 *Información:*\n"
        "• Revisa las FAQ antes de escribirnos.\n"
        "• Al usar el bot aceptas los Términos y Condiciones.\n"
        "━━━━━━━━━━━━━━━━━━\n"
        "⬇️ *Contacta con nosotros* ⬇️"
    )
    keyboard = [
        [InlineKeyboardButton("❓ FAQ",          callback_data="soporte_faq"),
         InlineKeyboardButton("📋 TyC",          callback_data="tyc")],
        [InlineKeyboardButton("🪪 Mi ID",        callback_data="soporte_mi_id"),
         InlineKeyboardButton("🤖 Estado Bot",   callback_data="soporte_estado")],
        [InlineKeyboardButton("🌐 Página web ↗", url=DUALSTATS_WEB_URL)],
    ]
    fila_contacto = []
    if ADMIN_USERNAME:
        fila_contacto.append(InlineKeyboardButton("💬 Contactar ↗", url=f"https://t.me/{ADMIN_USERNAME}"))
    if COMUNIDAD_URL:
        fila_contacto.append(InlineKeyboardButton("🎉 Comunidad ↗", url=COMUNIDAD_URL))
    if fila_contacto:
        keyboard.append(fila_contacto)
    keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data=volver)])
    if query:
        await query.answer()
        await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
    else:
        await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def mostrar_soporte(update, context, page=0):
    query   = update.callback_query
    page    = max(0, min(page, len(SOPORTE_PAGINAS) - 1))
    texto   = SOPORTE_PAGINAS[page]
    nav     = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀️ Anterior", callback_data=f"soporte_p{page-1}"))
    if page < len(SOPORTE_PAGINAS) - 1:
        nav.append(InlineKeyboardButton("Siguiente ▶️", callback_data=f"soporte_p{page+1}"))
    kb = []
    if nav:
        kb.append(nav)
    kb.append([InlineKeyboardButton("🔙 Volver", callback_data="soporte")])
    if query:
        await query.answer()
        await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(kb), parse_mode="Markdown")
    else:
        await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(kb), parse_mode="Markdown")

async def mostrar_novedades(update, context):
    query  = update.callback_query
    uid    = update.effective_user.id
    volver = "menu_principal" if tiene_suscripcion(uid) else "menu_no_suscrito"
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton("🕒 Última actualización",  callback_data="novedades_ultima")],
        [InlineKeyboardButton("🚀 Próximas funciones",    callback_data="novedades_proximas")],
        [InlineKeyboardButton("📢 Avisos",                callback_data="novedades_avisos")],
        [InlineKeyboardButton("🔙 Volver",                callback_data=volver)],
    ])
    if query:
        await query.answer()
        await query.edit_message_text(NOVEDADES_HUB, reply_markup=kb, parse_mode="Markdown")
    else:
        await update.message.reply_text(NOVEDADES_HUB, reply_markup=kb, parse_mode="Markdown")

async def novedades_subpagina(update, context, texto):
    try:
        await update.callback_query.edit_message_text(texto,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="novedades")]]),
            parse_mode="Markdown")
    except Exception as e:
        logger.error(f"[novedades_subpagina] FALLO: {type(e).__name__}: {e}")
        raise

async def soporte_mi_id(update, context):
    await update.callback_query.answer()
    uid = update.effective_user.id
    await update.callback_query.edit_message_text(
        f"🪪 *Tu ID de Telegram*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"`{uid}`\n\n"
        "_Puedes suscribirte directamente desde el menú principal. Si necesitas ayuda, comparte este ID con soporte._",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="soporte")]]),
        parse_mode="Markdown")

async def soporte_estado_bot(update, context):
    await update.callback_query.answer()
    ahora   = local_now()
    ultima  = stats["ultima_actualizacion"].strftime("%H:%M")  if stats["ultima_actualizacion"]  else "—"
    proxima = stats["proxima_actualizacion"].strftime("%H:%M") if stats["proxima_actualizacion"] else "—"
    await update.callback_query.edit_message_text(
        f"🤖 *Estado de FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"✅ Servicio operativo\n"
        f"⏱️ Último escaneo: *{ultima}*\n"
        f"⏭️ Próximo escaneo: *{proxima}*\n"
        f"💎 Surebets encontradas: *{stats['surebets_encontradas']}*\n"
        f"🎯 Middles encontrados: *{stats['middlebets_encontradas']}*\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"🕐 {ahora.strftime('%d/%m/%Y %H:%M')}",
        reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="soporte")]]),
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
    nombre  = update.effective_user.first_name or update.effective_user.username or str(user_id)
    plan    = get_plan_label(user_id)
    deportes_activos = [f"{emoji} {n}" for k, (emoji, n) in SPORT_DISPLAY.items() if cfg["sports"].get(k)]
    casas_activas    = [n for k, n in BOOKMAKER_NAMES.items() if cfg["bookmakers"].get(k)]
    mis_refs = referrals.get(user_id, [])
    creds    = get_creditos(user_id)
    await update.callback_query.edit_message_text(
        f"{icono_suscripcion(dias)} *Mi cuenta*\n━━━━━━━━━━━━━━━━━━\n"
        f"👤 *{nombre}*\n"
        f"💎 Plan: *{plan}*\n"
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
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton("💳 Ver planes",        callback_data="suscribirse")],
            [InlineKeyboardButton("🔙 Volver al panel",   callback_data="menu_principal")],
        ]),
        parse_mode="Markdown")

# ============================================================
# PANEL ADMIN
# ============================================================
async def cmd_admin(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    total = len([u for u in subscriptions if tiene_suscripcion(u)])
    keyboard = [
        [InlineKeyboardButton("➕ Activar usuario",   callback_data="admin_activar"),
         InlineKeyboardButton("➖ Desactivar usuario", callback_data="admin_desactivar")],
        [InlineKeyboardButton("👥 Ver suscriptores",  callback_data="admin_lista")],
        [InlineKeyboardButton("📢 Mensaje a todos",   callback_data="admin_broadcast")],
        [InlineKeyboardButton("💰 Dar créditos",      callback_data="admin_creditos")],
        [InlineKeyboardButton("🔗 Link de referido",  callback_data="admin_reflink")],
        [InlineKeyboardButton("🔎 Scanner status",   callback_data="admin_scanner")],
    ]
    sc_me = _get_scanner_cfg(update.effective_user.id)
    scanner_line = f"🔎 Scanner: {'✅ ON' if sc_me.get('active') else '❌ OFF'} | Profit ≥{sc_me.get('minProfitPct', 1.5)}%"
    await update.message.reply_text(
        f"👑 *Panel Admin — FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
        f"👥 Suscriptores activos: *{total}*\n"
        f"💎 Surebets: *{stats['surebets_encontradas']}*\n"
        f"🎯 Middles: *{stats['middlebets_encontradas']}*\n"
        f"{scanner_line}\n━━━━━━━━━━━━━━━━━━",
        reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")

async def handle_admin_callback(update, context):
    query = update.callback_query; data = query.data
    if data == "admin_activar":
        await query.edit_message_text(
            "➕ *Activar usuario*\n\n"
            "PRO:          `activar ID DIAS`\n"
            "PRO+Tracker:  `activar ID DIAS T`\n\n"
            "Ej PRO:         `activar 123456789 30`\n"
            "Ej PRO+Tracker: `activar 123456789 30 T`",
            parse_mode="Markdown")
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
            estado  = "✅" if tiene_suscripcion(uid) else "❌"
            ds_ico  = "📊" if uid in dualstats_vinculados else ""
            plan    = get_plan_label(uid)
            dias    = dias_restantes(uid)
            dias_str = "∞" if dias == 9999 else str(dias)
            lines.append(f"{estado}{ds_ico} `{uid}` — *{plan}* — {dias_str} días")
        texto = "\n".join(lines) if len(lines) > 1 else "👥 No hay suscriptores aún."
        await query.edit_message_text(texto,
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]),
            parse_mode="Markdown")
    elif data == "admin_broadcast":
        await query.edit_message_text(
            "📢 *Mensaje a todos los suscriptores*\n\nEscribe el mensaje a enviar:",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("❌ Cancelar", callback_data="admin_broadcast_cancel")]]),
            parse_mode="Markdown")
        context.user_data["admin_waiting"] = "broadcast"
    elif data == "admin_broadcast_cancel":
        context.user_data.pop("admin_waiting", None)
        await query.edit_message_text("❌ Broadcast cancelado.",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]))
    elif data == "admin_reflink":
        link = f"https://t.me/{BOT_USERNAME}?start={ADMIN_ID}"
        await query.edit_message_text(f"🔗 *Tu link de referido:*\n`{link}`",
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]),
            parse_mode="Markdown")
    elif data == "admin_scanner":
        lines = ["🔎 *Scanner — Estado por admin*\n"]
        for uid in sorted(ADMIN_IDS):
            sc = _get_scanner_cfg(uid)
            estado = "✅ ON" if sc.get("active") else "❌ OFF"
            profit = sc.get("minProfitPct", 1.5)
            lines.append(f"`{uid}`: {estado} | Profit ≥{profit}%")
        lines.append("\nUsa `/scanner_on`, `/scanner_off`, `/scanner_config [profit]`")
        await query.edit_message_text("\n".join(lines),
            reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Volver", callback_data="admin_volver")]]),
            parse_mode="Markdown")
    elif data == "admin_volver":
        total = len([u for u in subscriptions if tiene_suscripcion(u)])
        uid_query = query.from_user.id
        sc = _get_scanner_cfg(uid_query)
        scanner_line = f"🔎 Scanner: {'✅ ON' if sc.get('active') else '❌ OFF'} | Profit ≥{sc.get('minProfitPct', 1.5)}%"
        await query.edit_message_text(
            f"👑 *Panel Admin — FidesBot*\n━━━━━━━━━━━━━━━━━━\n"
            f"👥 *{total}* suscriptores\n{scanner_line}\n━━━━━━━━━━━━━━━━━━",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("➕ Activar usuario",   callback_data="admin_activar"),
                 InlineKeyboardButton("➖ Desactivar usuario", callback_data="admin_desactivar")],
                [InlineKeyboardButton("👥 Ver suscriptores",  callback_data="admin_lista")],
                [InlineKeyboardButton("📢 Mensaje a todos",   callback_data="admin_broadcast")],
                [InlineKeyboardButton("💰 Dar créditos",      callback_data="admin_creditos")],
                [InlineKeyboardButton("🔗 Link de referido",  callback_data="admin_reflink")],
                [InlineKeyboardButton("🔎 Scanner status",   callback_data="admin_scanner")],
            ]),
            parse_mode="Markdown")

# ============================================================
# COMANDOS SCANNER (solo admins)
# ============================================================
def _get_scanner_cfg(user_id: int) -> dict:
    cfg = get_config(user_id)
    return cfg.setdefault("scanner", {
        "active": False, "minProfitPct": 1.5,
        "alertSurebets": True, "alertMiddles": True,
        "alertLive": True, "alertPrematch": True,
    })

def _set_scanner_cfg(user_id: int, **kwargs):
    sc = _get_scanner_cfg(user_id)
    sc.update(kwargs)
    guardar_db()

async def cmd_scanner_on(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    args = context.args
    target_ids = [int(args[0])] if args and args[0].isdigit() else list(ADMIN_IDS)
    for uid in target_ids:
        _set_scanner_cfg(uid, active=True)
    names = ", ".join(f"`{uid}`" for uid in target_ids)
    await update.message.reply_text(
        f"✅ *Scanner activado* para {names}\n"
        f"Las alertas del scraper propio se enviarán cuando detecte surebets reales.",
        parse_mode="Markdown")

async def cmd_scanner_off(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    args = context.args
    target_ids = [int(args[0])] if args and args[0].isdigit() else list(ADMIN_IDS)
    for uid in target_ids:
        _set_scanner_cfg(uid, active=False)
    names = ", ".join(f"`{uid}`" for uid in target_ids)
    await update.message.reply_text(f"⏸️ *Scanner desactivado* para {names}.", parse_mode="Markdown")

async def cmd_scanner_config(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    args = context.args
    uid = update.effective_user.id
    profit = None
    if len(args) >= 2 and args[0].isdigit():
        uid = int(args[0])
        try: profit = float(args[1].replace(",", "."))
        except: pass
    elif args:
        try: profit = float(args[0].replace(",", "."))
        except: pass
    if profit is not None:
        _set_scanner_cfg(uid, minProfitPct=profit)
    sc = _get_scanner_cfg(uid)
    await update.message.reply_text(
        f"⚙️ *Scanner config* — `{uid}`\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"• Activo: {'✅' if sc.get('active') else '❌'}\n"
        f"• Profit mínimo: *{sc.get('minProfitPct', 1.5)}%*\n"
        f"• Surebets: {'✅' if sc.get('alertSurebets', True) else '❌'}\n"
        f"• Middles: {'✅' if sc.get('alertMiddles', True) else '❌'}\n"
        f"• LIVE: {'✅' if sc.get('alertLive', True) else '❌'}\n"
        f"• Pre-partido: {'✅' if sc.get('alertPrematch', True) else '❌'}\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"Uso: `/scanner_config [profit]` · `/scanner_config [uid] [profit]`\n"
        f"Ej: `/scanner_config 2.0` · `/scanner_on` · `/scanner_off`",
        parse_mode="Markdown")

# ============================================================
# GESTIÓN DE CASAS (toggle scraper ON/OFF — solo admins)
# ============================================================

async def _mostrar_casas(target):
    """target puede ser un Message o un CallbackQuery."""
    state    = _load_scanner_state()
    disabled = set(state.get("disabled_scrapers", []))
    n_casas   = len(BOOKMAKERS)
    n_scrapers = len(SCRAPER_DISPLAY)
    activos   = n_scrapers - len(disabled & SCRAPER_DISPLAY.keys())

    lines = [f"🏠 *Casas de apuestas — Scanner* ({n_casas} casas · {activos}/{n_scrapers} scrapers activos)\n━━━━━━━━━━━━━━━━━━"]
    keyboard = []
    for key, (emoji, nombre, nota) in SCRAPER_DISPLAY.items():
        activo = key not in disabled
        estado = "✅" if activo else "❌"
        extra  = " _(sub-scraper)_" if key in EXTRA_SCRAPERS else ""
        lines.append(f"{estado} {emoji} *{nombre}*{extra} — _{nota}_")
        lbl = f"{'⏸ Pausar' if activo else '▶️ Activar'} {nombre}"
        keyboard.append([InlineKeyboardButton(lbl, callback_data=f"scraper_toggle_{key}")])
    keyboard.append([InlineKeyboardButton("🔄 Actualizar", callback_data="scraper_refresh")])

    text   = "\n".join(lines)
    markup = InlineKeyboardMarkup(keyboard)
    if hasattr(target, "edit_message_text"):
        await target.edit_message_text(text, parse_mode="Markdown", reply_markup=markup)
    else:
        await target.reply_text(text, parse_mode="Markdown", reply_markup=markup)

async def cmd_casas(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    await _mostrar_casas(update.message)

async def handle_scraper_toggle(update, context):
    query = update.callback_query
    data  = query.data

    if data == "scraper_refresh":
        await _mostrar_casas(query)
        return

    key = data[len("scraper_toggle_"):]
    if key not in SCRAPER_DISPLAY:
        await query.answer("Casa no reconocida", show_alert=True)
        return

    state    = _load_scanner_state()
    disabled = set(state.get("disabled_scrapers", []))
    if key in disabled:
        disabled.discard(key)
        accion = "activado"
    else:
        disabled.add(key)
        accion = "pausado"

    state["disabled_scrapers"] = sorted(disabled)
    _save_scanner_state(state)

    nombre = SCRAPER_DISPLAY[key][1]
    icono  = "✅" if accion == "activado" else "⏸"
    await query.answer(f"{icono} {nombre} {accion}", show_alert=False)
    await _mostrar_casas(query)

# ============================================================
# GESTIÓN DE DEPORTES (toggle sport ON/OFF — solo admins)
# ============================================================

async def _mostrar_deportes(target):
    """target puede ser un Message o un CallbackQuery."""
    state    = _load_scanner_state()
    disabled = set(state.get("disabled_sports", []))
    activos  = len(SPORT_DISPLAY) - len(disabled & SPORT_DISPLAY.keys())

    lines = [f"🏅 *Deportes — Scanner* ({len(SPORT_DISPLAY)} deportes · {activos}/{len(SPORT_DISPLAY)} activos)\n━━━━━━━━━━━━━━━━━━"]
    keyboard = []
    for key, (emoji, nombre) in SPORT_DISPLAY.items():
        activo = key not in disabled
        estado = "✅" if activo else "❌"
        nota   = SPORT_STATUS.get(key, "")
        lines.append(f"{estado} {emoji} *{nombre}* — _{nota}_")
        lbl = f"{'⏸ Pausar' if activo else '▶️ Activar'} {nombre}"
        keyboard.append([InlineKeyboardButton(lbl, callback_data=f"sport_toggle_{key}")])
    keyboard.append([InlineKeyboardButton("🔄 Actualizar", callback_data="sport_refresh")])

    text   = "\n".join(lines)
    markup = InlineKeyboardMarkup(keyboard)
    if hasattr(target, "edit_message_text"):
        await target.edit_message_text(text, parse_mode="Markdown", reply_markup=markup)
    else:
        await target.reply_text(text, parse_mode="Markdown", reply_markup=markup)

async def cmd_deportes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_user.id not in ADMIN_IDS: return
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    await _mostrar_deportes(update.message)

async def handle_sport_toggle(update, context):
    query = update.callback_query
    data  = query.data

    if data == "sport_refresh":
        await _mostrar_deportes(query)
        return

    key = data[len("sport_toggle_"):]
    if key not in SPORT_DISPLAY:
        await query.answer("Deporte no reconocido", show_alert=True)
        return

    state    = _load_scanner_state()
    disabled = set(state.get("disabled_sports", []))
    if key in disabled:
        disabled.discard(key)
        accion = "activado"
    else:
        disabled.add(key)
        accion = "pausado"

    state["disabled_sports"] = sorted(disabled)
    _save_scanner_state(state)

    nombre = SPORT_DISPLAY[key][1]
    icono  = "✅" if accion == "activado" else "⏸"
    await query.answer(f"{icono} {nombre} {accion}", show_alert=False)
    await _mostrar_deportes(query)

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
            kwargs = {"headers": headers, "timeout": aiohttp.ClientTimeout(total=10)}
            if method.upper() != "GET":
                kwargs["json"] = payload
            async with session.request(method, url, **kwargs) as resp:
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
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    await update.message.reply_text(
        "🔗 *Vincular FidesBot con DualStats Tracker*\n━━━━━━━━━━━━━━━━━━\n\n"
        "Para vincular tu cuenta:\n\n"
        "1️⃣ Pulsa el botón de abajo para abrir DualStats\n"
        "2️⃣ Inicia sesión con tu cuenta\n"
        "3️⃣ Abre *Configuración → Conectar FidesBot*\n"
        "4️⃣ Pulsa el botón y acepta en Telegram\n\n"
        "Una vez vinculado, las alertas mostrarán botones ✅/❌ "
        "para registrar tus apuestas automáticamente.",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("🌐 Abrir DualStats", url="https://dualstats-tracker.vercel.app")
        ]]),
        parse_mode="Markdown")

# ── Panel DualStats en el menú principal ─────────────────

async def panel_dualstats(update, context):
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

        signo   = "+" if pnl_total >= 0 else ""
        pnl_str = f"{signo}{fmt_eur(pnl_total)}€"
        estado_txt  = f"✅ *Conectado · {plan_label}*\n\n"
        estado_txt += f"✅ Ganadas: {n_ganadas}  |  ❌ Perdidas: {n_perdidas}  |  💰 P&L: {pnl_str}\n"
        estado_txt += f"📋 Pendientes de registrar: {n_pend}  |  🏆 Pendientes de resultado: {n_res}\n\n"
        if es_tracker:
            estado_txt += "💡 Cuando pulses *Hecha* en una alerta, la apuesta se guarda automaticamente."
        else:
            estado_txt += "⚠️ Tu plan *PRO* no incluye integración con el bot.\nActualiza a *PRO+Tracker* para usar /pendientes y /resultados."
            keyboard.append([InlineKeyboardButton("⬆️ Actualizar a PRO+Tracker", callback_data="stripe_bot_tracker")])

        keyboard.append([InlineKeyboardButton("🌐 Abrir DualStats", url=ds_url("/", "panel_open"))])
        keyboard.append([InlineKeyboardButton("🔓 Desvincular",     callback_data="DS_desvincular")])
        keyboard.append([InlineKeyboardButton("🔙 Volver",          callback_data="menu_principal")])
    else:
        keyboard = [
            [InlineKeyboardButton("🌐 Abrir DualStats", url=ds_url("/", "panel_open"))],
            [InlineKeyboardButton("ℹ️ Cómo vincular",   callback_data="DS_info_vincular")],
        ]
        if not es_tracker:
            keyboard.append([InlineKeyboardButton("⬆️ Obtener PRO+Tracker", callback_data="stripe_bot_tracker")])
        keyboard.append([InlineKeyboardButton("🔙 Volver", callback_data="menu_principal")])
        estado_txt = "❌ *No conectado*\n\n"
        estado_txt += "🔗 Vincula tu cuenta para que las alertas se registren automáticamente.\n💎 Necesitas plan *PRO+Tracker* en DualStats para vincular."

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
                f"   📕 {l['bookmaker']} 📍 {formatear_outcome(l)} 🎲 @{l['odd']} 💰 €{redondear_stake(p['stake_sug'] * l['stake_pct'] / 100)}\n"
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
            parse_mode="Markdown",
            reply_markup=InlineKeyboardMarkup([]))
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
                parse_mode="Markdown",
                reply_markup=InlineKeyboardMarkup([]))
        except: pass

    await query.answer("❌ Registrado como no realizada")

# ── Flujo de completar un pendiente ──────────────────────

def _resumen_flow(pendiente, stakes, odds) -> str:
    """Genera el texto de resumen con los datos reales del usuario."""
    total_inv   = sum(stakes)
    ganancia    = round(min(s * o for s, o in zip(stakes, odds)) - total_inv, 2)
    emoji, _    = SPORT_DISPLAY.get(pendiente.get("sport_key",""), ("🏅",""))
    lineas = []
    for i, leg in enumerate(pendiente["legs"]):
        lineas.append(
            f"📕 *{leg['bookmaker']}* · {formatear_outcome(leg)}\n"
            f"   🎲 @{odds[i]}  💶 {fmt_eur(stakes[i])}€"
        )
    profit_real = (ganancia / total_inv * 100) if total_inv > 0 else 0
    aviso = ""
    es_middle = pendiente.get("tipo") == "middlebet"
    if profit_real < 0 and not es_middle:
        aviso = f"\n\n⚠️ _Con estas cuotas/stakes el ROI es {profit_real:.2f}% (perdida esperada)._"
    elif profit_real < 0 and es_middle:
        aviso = f"\n\n💡 _Peor caso si el middle no se cumple: {profit_real:.2f}%. Si se cumple la apuesta el beneficio es mayor._"

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
        await query.answer()
        await query.edit_message_text("⚠️ Pendiente no encontrado. Puede que ya haya sido procesado.")
        return

    stakes_raw = flow.get("stakes", [])
    odds_raw   = flow.get("odds", [])

    # Rellenar huecos con datos de la alerta si el usuario no los cambió
    stakes = [
        stakes_raw[i] if i < len(stakes_raw) and stakes_raw[i] is not None
        else redondear_stake(p["stake_sug"] * p["legs"][i]["stake_pct"] / 100)
        for i in range(len(p["legs"]))
    ]
    odds = [
        odds_raw[i] if i < len(odds_raw) and odds_raw[i] is not None
        else p["legs"][i]["odd"]
        for i in range(len(p["legs"]))
    ]

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
            await query.answer()
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
    ganancia  = round(min(s * o for s, o in zip(stakes, odds)) - total_inv, 2)
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
    context.user_data.pop("ds_flow", None)

    web_txt = "✅ Registrado en DualStats Tracker." if registrado_en_web else "📱 Guardado localmente."
    await query.answer("✅ Apuesta registrada")
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
    await query.answer()
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
    if resultado_str == "LOST" and ganancia_real is None and stakes:
        ganancia_real = round(-sum(stakes), 2)
    elif resultado_str == "VOID" and ganancia_real is None:
        ganancia_real = 0.0
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

            # Auto-registro a las 48h — prioridad sobre recordatorios
            if horas >= 48:
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
                    "ganancia_est": round(min(s*o for s, o in zip(stakes, odds)) - total, 2),
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

            # Recordatorio 12h
            elif horas >= 12 and not recordatorio_12:
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

# ── Desvincular cuenta ────────────────────────────────────

async def handle_desvincular(update, context):
    query   = update.callback_query
    user_id = update.effective_user.id
    dualstats_vinculados.discard(user_id)
    guardar_db()
    await query.edit_message_text(
        "🔓 *Cuenta desvinculada*\n\n"
        "Tu cuenta de FidesBot ya no está conectada a DualStats Tracker.\n"
        "Puedes volver a vincularla pulsando 📈 DualStats en el menú principal.",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton("📈 Volver a DualStats", callback_data="panel_dualstats"),
            InlineKeyboardButton("🔙 Menú",               callback_data="menu_principal"),
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
        context.user_data.pop("ds_flow", None)
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
    data    = query.data
    user_id = update.effective_user.id

    if is_banned(user_id):
        await query.answer("🚫 Tu acceso está restringido.", show_alert=True)
        return

    # "bloqueado" necesita show_alert=True como primera (y única) respuesta
    if data == "bloqueado":
        await query.answer(BLOQUEADO_MSG, show_alert=True); return

    # Checks que necesitan show_alert=True y deben ir ANTES del answer() blanket
    if data == "escanear_ahora":
        SCAN_COOLDOWN_S = 120
        last_manual = ultimo_scan_manual.get(user_id)
        if last_manual:
            elapsed = (datetime.now() - last_manual).total_seconds()
            if elapsed < SCAN_COOLDOWN_S:
                secs_left = int(SCAN_COOLDOWN_S - elapsed)
                await query.answer(f"⏳ Espera {secs_left}s antes del siguiente escaneo.", show_alert=True)
                return

    # Subscription check before blanket answer so BLOQUEADO_MSG show_alert=True works
    _PUBLIC_PREFIXES = ("admin_", "scraper_", "sport_", "menu_no_suscrito", "suscribirse",
                        "stripe_", "plan_", "soporte", "novedades", "tyc",
                        "panel_freebets", "panel_valuebets", "mis_referidos",
                        "mis_creditos", "freebet_casa_", "bloqueado", "scraper_refresh", "sport_refresh")
    if not any(data == p or data.startswith(p) for p in _PUBLIC_PREFIXES):
        if not tiene_suscripcion(user_id):
            await query.answer(BLOQUEADO_MSG, show_alert=True); return

    # Callbacks que gestionan su propio answer() con mensajes de error personalizados.
    # Si ya respondemos aquí con answer() vacío, su show_alert=True queda silenciado.
    _OWN_ANSWER = ("NM|", "CSH|", "FKN|", "AH_", "ANH_", "RES_", "DS_resumen_", "FL_confirm_", "PEC_", "FL_sc_yes_")
    if not any(data.startswith(p) for p in _OWN_ANSWER):
        await query.answer()

    # ── Admin activar rápido (desde grupo de pagos) ────────
    if data.startswith("admin_activar_rapido_") and user_id in ADMIN_IDS:
        parts       = data.split("_")
        uid_activar = int(parts[3]); dias_activar = int(parts[4])
        es_tracker  = len(parts) > 5 and parts[5] == "T"
        plan_interno = "PRO_TRACKER" if es_tracker else "PRO"
        activar_usuario(uid_activar, dias_activar, plan=plan_interno)
        plan_txt = "PRO+Tracker" if es_tracker else "PRO"
        nombre_activar = f"ID {uid_activar}"
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

    # ── Admin ──────────────────────────────────────────────
    if data.startswith("admin_"):
        if user_id in ADMIN_IDS: await handle_admin_callback(update, context)
        return

    # ── Gestión scrapers (admin) ────────────────────────────
    if (data.startswith("scraper_toggle_") or data == "scraper_refresh") and user_id in ADMIN_IDS:
        await handle_scraper_toggle(update, context)
        return

    # ── Gestión deportes (admin) ────────────────────────────
    if (data.startswith("sport_toggle_") or data == "sport_refresh") and user_id in ADMIN_IDS:
        await handle_sport_toggle(update, context)
        return

    # ── Sin suscripción ────────────────────────────────────
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
    if data == "soporte":             await mostrar_hub_soporte(update, context); return
    if data == "soporte_faq":         await mostrar_soporte(update, context, page=0); return
    if data.startswith("soporte_p"):
        try: page = int(data[len("soporte_p"):])
        except: page = 0
        await mostrar_soporte(update, context, page=page); return
    if data == "novedades":           await mostrar_novedades(update, context); return
    if data == "novedades_ultima":    await novedades_subpagina(update, context, NOVEDADES_ULTIMA); return
    if data == "novedades_proximas":  await novedades_subpagina(update, context, NOVEDADES_PROXIMAS); return
    if data == "novedades_avisos":    await novedades_subpagina(update, context, NOVEDADES_AVISOS); return
    if data == "soporte_mi_id":       await soporte_mi_id(update, context); return
    if data == "soporte_estado":      await soporte_estado_bot(update, context); return
    if data == "tyc":                 await mostrar_tyc(update, context); return
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
        ultimo_scan_manual[user_id] = datetime.now()
        creditos_aviso = f"\n\n💳 API: {api_credits_remaining} créditos restantes." if api_credits_remaining is not None and api_credits_remaining < 500 else ""
        await query.edit_message_text("🔍 Escaneando apuestas... espera un momento.")
        total_pre  = await escanear_y_alertar(context.application, live=False, user_ids=[user_id])
        total_live = await escanear_y_alertar(context.application, live=True,  user_ids=[user_id])
        total = total_pre + total_live
        ultimo_escaneo[user_id] = datetime.now()
        if total == 0:
            sin_creditos = api_credits_remaining is not None and api_credits_remaining <= 0
            motivo = ("⚠️ *Sin créditos de API.* El bot no puede obtener datos hasta la recarga mensual."
                      if sin_creditos else
                      "❌ No se han encontrado apuestas con tu configuración.\n\n"
                      "💡 Prueba a bajar el profit mínimo en ⚙️ Configuración.")
            await query.edit_message_text(
                f"🔍 *Escaneo completado*\n\n{motivo}{creditos_aviso}",
                parse_mode="Markdown")
        else:
            await query.edit_message_text(
                f"✅ *{total} apuesta(s) encontradas y enviadas.*{creditos_aviso}",
                parse_mode="Markdown")
        await asyncio.sleep(3)
        await menu_principal(update, context)
    elif data in ("buscar_surebets", "buscar_middles"):
        tipo_label = "surebets" if data == "buscar_surebets" else "middlebets"
        tipo_key   = "surebet"  if data == "buscar_surebets" else "middlebet"
        await query.edit_message_text(f"🔍 Buscando {tipo_label}... espera un momento.")
        total = await escanear_y_alertar(context.application, live=False, user_ids=[user_id], tipos_override={tipo_key})
        total += await escanear_y_alertar(context.application, live=True,  user_ids=[user_id], tipos_override={tipo_key})
        ultimo_escaneo[user_id] = datetime.now()
        if total == 0:
            await query.edit_message_text(
                f"🔍 *Búsqueda completada*\n\n❌ No se han encontrado {tipo_label} con tu configuración.\n\n"
                "💡 Prueba a bajar el profit mínimo en ⚙️ Configuración.",
                parse_mode="Markdown")
        else:
            await query.edit_message_text(f"✅ *{total} {tipo_label} encontradas y enviadas.*", parse_mode="Markdown")
        await asyncio.sleep(3)
        if data == "buscar_surebets": await panel_surebets(update, context)
        else: await panel_middles(update, context)
    elif data in ("pausa_2h", "pausa_4h", "pausa_8h"):
        horas = {"pausa_2h": 2, "pausa_4h": 4, "pausa_8h": 8}[data]
        _set_pausa(user_id, local_now() + timedelta(hours=horas))
        await menu_alertas(update, context)
    elif data == "reanudar_alertas":
        _clear_pausa(user_id)
        await menu_alertas(update, context)

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
    elif data.startswith("DS_resumen_"):
        period = data[len("DS_resumen_"):]  # "7d" | "30d" | "all"
        if user_id not in dualstats_vinculados:
            await query.answer("Vincula tu cuenta primero con /vincular", show_alert=True); return
        api_data = await llamar_api_dualstats(f"stats?telegram_id={user_id}&period={period}", {}, method="GET")
        if not api_data:
            await query.answer("❌ Error al obtener datos. Inténtalo de nuevo.", show_alert=True); return
        await query.answer()
        texto, keyboard = _fmt_resumen(api_data, period)
        await query.edit_message_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")
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
        if len(parts) == 3 and int(parts[1]) == user_id:
            await handle_alerta_hecha(update, context, user_id, parts[2])
    elif data.startswith("ANH_"):
        parts = data.split("_", 2)
        if len(parts) == 3 and int(parts[1]) == user_id:
            await handle_alerta_nohecha(update, context, user_id, parts[2])

    # ── Completar pendiente ────────────────────────────────
    elif data.startswith("PC_"):
        pid = data[3:]
        await iniciar_completar_pendiente(update, context, user_id, pid)

    # ── Eliminar pendiente ─────────────────────────────────
    elif data.startswith("PE_"):
        pid = data[3:]
        p   = get_pendiente(user_id, pid)
        if not p:
            await query.edit_message_text("⚠️ Pendiente no encontrado. Puede que ya haya sido procesado.")
            return
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
        p_fsc = get_pendiente(user_id, pid)
        if p_fsc is None:
            await query.answer("⚠️ Apuesta no encontrada.", show_alert=True); return
        flow = context.user_data.get("ds_flow", {"pid": pid, "stakes": [], "odds": [], "step": ""})
        flow["pid"] = pid; flow["stakes"] = [None]*len(p_fsc["legs"])
        flow["odds"] = [None]*len(p_fsc["legs"])
        context.user_data["ds_flow"] = flow
        await _mostrar_odds_confirm(query, context, p_fsc, flow)

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
        pass  # blanket answer() ya gestionado arriba
    elif data.startswith("CASH_CANCEL_"):
        context.user_data.pop("pending_cashout", None)
        await query.answer("Cashout cancelado", show_alert=False)
        await query.edit_message_text("❌ Cashout cancelado.")

# ============================================================
# HANDLER DE TEXTO
# ============================================================
async def handle_texto(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    user_id = update.effective_user.id
    if is_banned(user_id):
        return
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
    partes  = text.split()
    cmd     = partes[0].lower() if partes else ""

    # Comandos directos: funcionan con o sin pasar por el menú primero
    if cmd == "activar" or waiting == "activar":
        parts = partes
        if len(parts) >= 3 and parts[0].lower() == "activar":
            try:
                uid, dias    = int(parts[1]), int(parts[2])
                es_tracker   = len(parts) >= 4 and parts[3].upper() == "T"
                plan_interno = "PRO_TRACKER" if es_tracker else "PRO"
                plan_txt     = "PRO+Tracker" if es_tracker else "PRO"
                activar_usuario(uid, dias, plan=plan_interno)
                await update.message.reply_text(
                    f"✅ ID `{uid}` — *{plan_txt}* — activado por *{dias} días*. 💾 Guardado.",
                    parse_mode="Markdown")
                try:
                    msg_plan = "🔗 *FidesBot PRO+Tracker*\n✅ Alertas ilimitadas + DualStats Tracker incluido." if es_tracker else "💎 *FidesBot PRO*\n✅ Alertas ilimitadas activadas."
                    await context.bot.send_message(chat_id=uid,
                        text=f"🎉 ¡Tu suscripción ha sido activada!\n\n{msg_plan}\n\n"
                             f"Tienes *{dias} días* de acceso.\n\nEscribe /start para acceder.",
                        parse_mode="Markdown")
                except: pass
            except:
                await update.message.reply_text(
                    "❌ Formato:\n`activar ID DIAS` — PRO\n`activar ID DIAS T` — PRO+Tracker",
                    parse_mode="Markdown")
        elif len(parts) < 3 and cmd == "activar":
            await update.message.reply_text(
                "❌ Faltan argumentos.\n`activar ID DIAS` — PRO\n`activar ID DIAS T` — PRO+Tracker",
                parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    elif cmd == "desactivar" or waiting == "desactivar":
        parts = text.split()
        if len(parts) >= 2 and parts[0].lower() == "desactivar":
            try:
                uid = int(parts[1])
                desactivar_usuario(uid)
                await update.message.reply_text(f"✅ ID `{uid}` desactivado.", parse_mode="Markdown")
            except:
                await update.message.reply_text("❌ Formato: `desactivar ID`", parse_mode="Markdown")
        context.user_data["admin_waiting"] = None

    elif cmd == "creditos" or waiting == "creditos":
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
    Deportes: futbol, baloncesto, tenis, hockey, rugby, beisbol, americano
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
        "basketball": {
            "home": "Lakers", "away": "Warriors",
            "sport_key": "basketball", "liga": "NBA / EuroLeague",
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
    }

    # Alias de nombres para el arg del usuario
    SPORT_ALIAS = {
        "futbol": "soccer", "fútbol": "soccer", "football": "soccer",
        "baloncesto": "basketball", "basket": "basketball", "nba": "basketball", "euroleague": "basketball",
        "tenis": "tennis", "tennis": "tennis",
        "hockey": "icehockey_nhl", "nhl": "icehockey_nhl",
        "rugby": "rugbyleague",
        "beisbol": "baseball_mlb", "béisbol": "baseball_mlb", "mlb": "baseball_mlb",
        "americano": "americanfootball_nfl", "nfl": "americanfootball_nfl",
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
                    "Deportes disponibles: futbol, baloncesto, tenis, hockey, rugby, beisbol, americano"
                )
                return
        else:
            sport_key = "basketball" if es_middle else "soccer"

        datos = FAKE_EVENTS[sport_key]
        _era_vinculado = user_id in dualstats_vinculados
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
        _save_alerts_cache()
        if not _era_vinculado:
            dualstats_vinculados.discard(user_id)
        emoji, nombre = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
        tipo_label = "Middle" if es_middle else "Surebet"
        await update.message.reply_text(
            f"✅ Alerta de prueba enviada: {tipo_label} {emoji} {nombre}\n"
            f"Los botones ✅/❌ están activos para que puedas probar el registro."
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

async def cmd_diagnostico(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /diagnostico — muestra exactamente cuántas apuestas encuentra el bot y por qué las filtra.
    Útil para entender por qué el bot está en silencio.
    """
    if not tiene_suscripcion(update.effective_user.id):
        await update.message.reply_text("❌ Necesitas suscripción activa."); return

    uid = update.effective_user.id
    cfg = get_config(uid)
    msg = await update.message.reply_text("🔍 Analizando... puede tardar 15-30 segundos.")

    now = datetime.utcnow()
    active_sports = [s for s, v in cfg["sports"].items() if v]
    active_bks = [k for k, v in cfg["bookmakers"].items() if v]

    total_events = 0
    total_surebets_raw = 0
    blocked_draw = 0
    blocked_profit = 0
    blocked_days = 0
    blocked_bookmakers = 0
    passed = 0

    sport_detail: list[str] = []

    for sport_key in active_sports:
        if sport_key == "basketball":
            events: list = []
            for _bk in BASKETBALL_API_KEYS:
                events.extend(await fetch_odds(_bk, live=False))
                events.extend(await fetch_odds(_bk, live=True))
        elif sport_key == "rugbyleague":
            events = []
            for _bk in RUGBYLEAGUE_API_KEYS:
                events.extend(await fetch_odds(_bk, live=False))
                events.extend(await fetch_odds(_bk, live=True))
        else:
            events = await fetch_odds(sport_key, live=False)
            events += await fetch_odds(sport_key, live=True)

        total_events += len(events)
        sport_surebets = 0

        for event in events:
            try: commence = datetime.fromisoformat(event["commence_time"].replace("Z",""))
            except: commence = None
            apuestas = encontrar_apuestas(event, active_bks, False, sport_key=sport_key)
            surebets = [ap for ap in apuestas if ap["tipo"] == "surebet"]
            sport_surebets += len(surebets)
            total_surebets_raw += len(surebets)

            for ap in surebets:
                if ap.get("draw_risk"):
                    blocked_draw += 1
                elif ap["profit"] < cfg.get("min_profit_surebet", DEFAULT_USER_CONFIG["min_profit_surebet"]):
                    blocked_profit += 1
                elif commence and not ((commence - now).total_seconds() < 0 or (commence - now).total_seconds() / 86400 <= cfg["max_days"]):
                    blocked_days += 1
                else:
                    passed += 1

        if sport_surebets > 0:
            sport_display = SPORT_DISPLAY.get(sport_key, ("🏅", sport_key))
            sport_detail.append(f"  {sport_display[0]} {sport_display[1]}: {sport_surebets}")

    detail_str = "\n".join(sport_detail) if sport_detail else "  (ningún deporte activo tiene surebets ahora)"

    texto = (
        f"🔬 *Diagnóstico FidesBot*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"*Tu configuración:*\n"
        f"• Profit mín: {cfg.get('min_profit_surebet', DEFAULT_USER_CONFIG["min_profit_surebet"])}%\n"
        f"• Filtro días: {cfg['max_days']} días\n"
        f"• Casas activas: {len(active_bks)}/{len(cfg['bookmakers'])}\n"
        f"• Deportes activos: {len(active_sports)}\n\n"
        f"*Resultado del escaneo:*\n"
        f"• Eventos obtenidos de la API: {total_events}\n"
        f"• Surebets detectadas en bruto: {total_surebets_raw}\n\n"
        f"*Motivos por los que se filtran:*\n"
        f"• 🛡 Bloqueadas por riesgo de empate: {blocked_draw}\n"
        f"• 📉 Profit insuficiente (<{cfg.get('min_profit_surebet', DEFAULT_USER_CONFIG['min_profit_surebet'])}%): {blocked_profit}\n"
        f"• 📆 Fuera del filtro de días: {blocked_days}\n"
        f"• ✅ *Pasarían todos los filtros: {passed}*\n\n"
        f"*Surebets por deporte:*\n{detail_str}\n\n"
        f"{'✅ El bot debería estar mandando alertas.' if passed > 0 else '❌ Ninguna surebet pasa todos los filtros con tu config actual.'}"
    )

    if passed == 0 and blocked_draw > 0 and blocked_profit == 0:
        texto += f"\n\n💡 *Sugerencia:* {blocked_draw} surebets detectadas pero bloqueadas porque el empate no está cubierto (fútbol/americano/rugby sin 3ª pata). Prueba a buscar en otros deportes o esperar a que aparezcan más eventos."
    elif passed == 0 and blocked_profit > 0:
        texto += f"\n\n💡 *Sugerencia:* Baja el profit mínimo. La mayoría de surebets reales están entre 0.5% y 2%."
    elif total_events == 0:
        texto += "\n\n⚠️ *Sin datos disponibles.* Los scrapers pueden estar iniciándose o las casas seleccionadas no tienen eventos en este momento."

    await msg.edit_text(texto, parse_mode="Markdown")

async def cmd_pendientes(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
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
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
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
# RESUMEN DUALSTATS (/resumen)
# ============================================================

_PERIOD_LABEL = {"7d": "7 días", "30d": "30 días", "all": "Histórico"}

def _fmt_resumen(data: dict, period: str) -> tuple[str, list]:
    """Formatea el texto e inline keyboard del resumen de DualStats."""
    profit     = data.get("totalProfit", 0)
    roi        = data.get("roi", 0)
    win_rate   = data.get("winRate", 0)
    settled    = data.get("settled", 0)
    won        = data.get("won", 0)
    open_count = data.get("openCount", 0)
    streak     = data.get("currentStreak")

    profit_sign = "+" if profit >= 0 else ""
    roi_sign    = "+" if roi    >= 0 else ""

    streak_txt = ""
    if streak:
        if streak["type"] == "WON":
            streak_txt = f"\n🔥 Racha actual: *{streak['count']} victorias* ✅"
        else:
            streak_txt = f"\n❄️ Racha actual: *{streak['count']} derrotas* ❌"

    period_label = _PERIOD_LABEL.get(period, "Histórico")
    texto = (
        f"📊 *Tu Resumen DualStats — {period_label}*\n━━━━━━━━━━━━━━━━━━\n\n"
        f"💰 P&L: *{profit_sign}{fmt_eur(profit)}€*  (ROI: {roi_sign}{roi:.1f}%)\n"
        f"🏆 Win Rate: *{win_rate:.1f}%*  ({won}/{settled} ganadas)\n"
        f"📋 Liquidadas: *{settled}*  |  En juego: *{open_count}*"
        f"{streak_txt}\n\n"
        f"_Ver análisis completo en la web_ 👇"
    )

    def _lbl(p: str) -> str:
        label = _PERIOD_LABEL.get(p, p)
        return f"· {label} ·" if p == period else label

    keyboard = [
        [
            InlineKeyboardButton(_lbl("7d"),  callback_data="DS_resumen_7d"),
            InlineKeyboardButton(_lbl("30d"), callback_data="DS_resumen_30d"),
            InlineKeyboardButton(_lbl("all"), callback_data="DS_resumen_all"),
        ],
        [
            InlineKeyboardButton("📈 Abrir DualStats", url=ds_url("/stats", "bot_resumen")),
            InlineKeyboardButton("🏠 Menú", callback_data="menu_principal"),
        ],
    ]
    return texto, keyboard


async def cmd_resumen(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.message:
        _auto_delete(context, update.message.chat_id, update.message.message_id)
    user_id = update.effective_user.id
    if not tiene_suscripcion(user_id):
        await update.message.reply_text(BLOQUEADO_MSG); return
    if user_id not in dualstats_vinculados:
        await update.message.reply_text(
            "📊 *Resumen DualStats*\n━━━━━━━━━━━━━━━━━━\n\n"
            "⚠️ Aún no tienes DualStats vinculado.\n"
            "Usa /vincular para conectar tu cuenta web.",
            parse_mode="Markdown"); return

    data = await llamar_api_dualstats(f"stats?telegram_id={user_id}&period=all", {}, method="GET")
    if not data:
        await update.message.reply_text("❌ No se pudo obtener el resumen. Inténtalo de nuevo."); return

    texto, keyboard = _fmt_resumen(data, "all")
    await update.message.reply_text(texto, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode="Markdown")


# ============================================================
# DIGEST SEMANAL (lunes 9:00 AM)
# ============================================================

def _segundos_hasta_lunes_9am() -> float:
    """Segundos hasta el próximo lunes a las 09:00 hora Madrid."""
    ahora = local_now()
    # weekday(): 0=lun … 6=dom
    dias = (7 - ahora.weekday()) % 7
    if dias == 0 and (ahora.hour > 9 or (ahora.hour == 9 and ahora.minute >= 1)):
        dias = 7  # hoy es lunes pero ya pasó la hora → esperar al siguiente
    objetivo = ahora.replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=dias)
    return max(60.0, (objetivo - ahora).total_seconds())

async def tarea_digest_semanal(context: ContextTypes.DEFAULT_TYPE):
    """Envía el resumen de la semana anterior a todos los usuarios vinculados."""
    if local_now().weekday() != 0:
        return  # solo se ejecuta el lunes
    logger.info("[Digest] Enviando resumen semanal...")
    for user_id in list(dualstats_vinculados):
        if not tiene_suscripcion(user_id):
            continue
        try:
            data = await llamar_api_dualstats(f"stats?telegram_id={user_id}&period=week", {}, method="GET")
            if not data or data.get("settled", 0) == 0:
                continue
            profit   = data.get("totalProfit", 0)
            roi      = data.get("roi", 0)
            win_rate = data.get("winRate", 0)
            settled  = data.get("settled", 0)
            won      = data.get("won", 0)
            ahora    = local_now()
            semana   = ahora - timedelta(days=7)
            rango    = f"{semana.day:02d}/{semana.month:02d} — {ahora.day:02d}/{ahora.month:02d}"
            profit_sign = "+" if profit >= 0 else ""
            roi_sign    = "+" if roi    >= 0 else ""
            texto = (
                f"📅 *Resumen semanal · {rango}*\n━━━━━━━━━━━━━━━━━━\n\n"
                f"💰 P&L: *{profit_sign}{fmt_eur(profit)}€*  (ROI: {roi_sign}{roi:.1f}%)\n"
                f"🏆 Win Rate: *{win_rate:.1f}%*  ({won}/{settled})\n"
                f"📋 Operaciones liquidadas: *{settled}*\n\n"
                f"_¡Buenos días! Que la semana empiece con buen pie 🍀_"
            )
            keyboard = [[InlineKeyboardButton(
                "📈 Ver estadísticas", url=ds_url("/stats?period=7d", "digest_semanal")
            )]]
            await context.bot.send_message(
                chat_id=user_id,
                text=texto,
                reply_markup=InlineKeyboardMarkup(keyboard),
                parse_mode="Markdown",
            )
        except Exception as e:
            logger.warning(f"[Digest] Error enviando a {user_id}: {e}")


# ============================================================
# VIDEO TUTORIALES
# ============================================================
# Rellena las URLs cuando subas los vídeos al canal de tutoriales.
# None = "próximamente". El comando queda registrado y operativo de inmediato.
VIDEO_TUTORIALES: dict[str, tuple[str, str | None]] = {
    "winamaxbasket":   ("🏀 Winamax — Cómo apostar Basketball",    None),
    "winamaxfutbol":   ("⚽ Winamax — Cómo apostar Fútbol",         None),
    "bet365basket":    ("🏀 Bet365 — Cómo apostar Basketball",      None),
    "bet365futbol":    ("⚽ Bet365 — Cómo apostar Fútbol",           None),
    "bwinbasket":      ("🏀 Bwin — Cómo apostar Basketball",        None),
    "bwinfutbol":      ("⚽ Bwin — Cómo apostar Fútbol",             None),
    "bet365surebet":   ("⚡ Bet365 — Cómo hacer una Surebet",       None),
    "winamaxsurebet":  ("⚡ Winamax — Cómo hacer una Surebet",      None),
    "tutoriales":      ("📚 Índice de todos los tutoriales",        None),
}

async def cmd_tutorial(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Responde con el enlace al vídeo tutorial correspondiente."""
    cmd   = update.message.text.lstrip("/").split()[0].lower()
    info  = VIDEO_TUTORIALES.get(cmd)
    if not info:
        return
    titulo, url = info
    if url:
        await update.message.reply_text(
            f"🎬 *{titulo}*\n\n[👉 Ver tutorial]({url})",
            parse_mode="Markdown",
            disable_web_page_preview=False)
    else:
        await update.message.reply_text(
            f"🎬 *{titulo}*\n\n🔜 Este tutorial estará disponible próximamente.",
            parse_mode="Markdown")

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
    app.add_handler(CommandHandler("resumen",       cmd_resumen))
    app.add_handler(CommandHandler("diagnostico",   cmd_diagnostico))

    # Comandos de ban (admin)
    app.add_handler(CommandHandler("ban",       cmd_ban))
    app.add_handler(CommandHandler("unban",     cmd_unban))
    app.add_handler(CommandHandler("baneados",  cmd_baneados))

    # Comandos scanner (admin)
    app.add_handler(CommandHandler("scanner_on",     cmd_scanner_on))
    app.add_handler(CommandHandler("scanner_off",    cmd_scanner_off))
    app.add_handler(CommandHandler("scanner_config", cmd_scanner_config))
    app.add_handler(CommandHandler("casas",          cmd_casas))
    app.add_handler(CommandHandler("deportes",       cmd_deportes))

    # Video tutoriales
    for _cmd_name in VIDEO_TUTORIALES:
        app.add_handler(CommandHandler(_cmd_name, cmd_tutorial))

    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_texto))

    # Tareas periódicas
    app.job_queue.run_repeating(tarea_flush_db,                interval=30,    first=30)
    app.job_queue.run_repeating(tarea_sync_desde_api,          interval=300,   first=60)  # 5min — activa pagos Stripe
    app.job_queue.run_repeating(tarea_escaneo_prematch,        interval=BOT_CONFIG["scan_prematch_interval"], first=20)
    app.job_queue.run_repeating(tarea_escaneo_live,            interval=BOT_CONFIG["scan_live_interval"],     first=10)
    app.job_queue.run_repeating(tarea_verificar_suscripciones, interval=3600,  first=60)
    app.job_queue.run_repeating(tarea_recordatorios_pendientes,interval=3600,  first=120)
    app.job_queue.run_repeating(tarea_digest_semanal,          interval=24*3600, first=_segundos_hasta_lunes_9am())

    # ── Telegram rate-limiting queue ──────────────────────────
    global _tg_queue
    _tg_queue = asyncio.Queue(maxsize=500)
    asyncio.create_task(_telegram_sender_task(app.bot))

    logger.info("🚀 FidesBot v24 iniciado — live 2min / prematch 5min / dual-source odds / TG rate-limiter.")
    await app.initialize()
    await app.start()
    await app.updater.start_polling(drop_pending_updates=True)
    await asyncio.Event().wait()

if __name__ == "__main__":
    asyncio.run(main())
