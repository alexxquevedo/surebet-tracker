// dotenv/config is loaded in index.ts before this module is imported

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const config = {
  db: {
    url: required("DATABASE_URL"),
    directUrl: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
  },
  telegram: {
    token: required("TELEGRAM_TOKEN"),
  },
  betfair: {
    appKey: process.env.BETFAIR_APP_KEY ?? "",
    username: process.env.BETFAIR_USERNAME ?? "",
    password: process.env.BETFAIR_PASSWORD ?? "",
  },
  proxy: {
    host: process.env.PROXY_HOST ?? "",
    port: parseInt(process.env.PROXY_PORT ?? "80"),
    username: process.env.PROXY_USERNAME ?? "",
    password: process.env.PROXY_PASSWORD ?? "",
    enabled: Boolean(process.env.PROXY_HOST),
  },
  residentialProxy: {
    url: process.env.RESIDENTIAL_PROXY_URL ?? "",
    username: process.env.RESIDENTIAL_PROXY_USER ?? "",
    password: process.env.RESIDENTIAL_PROXY_PASS ?? "",
    enabled: Boolean(process.env.RESIDENTIAL_PROXY_URL),
  },
  // Per-scraper proxy routing.
  // Empty string → direct connection (no proxy).
  // Priority: scraper-specific var → ROUTER_PROXY_URL (router LTE tunnel) → ""
  // On router day: just set ROUTER_PROXY_URL=socks5://user:pass@tunnel-ip:port
  scraperProxies: {
    bwin:         process.env.BWIN_PROXY_URL         ?? process.env.ROUTER_PROXY_URL ?? "",
    sportium:     process.env.SPORTIUM_PROXY_URL     ?? process.env.ROUTER_PROXY_URL ?? "",
    codere:       process.env.CODERE_PROXY_URL       ?? "",
    williamhill:  process.env.WILLIAMHILL_PROXY_URL  ?? process.env.ROUTER_PROXY_URL ?? "",
    daznbet:      process.env.DAZNBET_PROXY_URL      ?? process.env.ROUTER_PROXY_URL ?? "",
    bet365:       process.env.BET365_PROXY_URL       ?? process.env.ROUTER_PROXY_URL ?? "",
    betfair:      process.env.BETFAIR_PROXY_URL      ?? "",
    betsson:      process.env.BETSSON_PROXY_URL      ?? process.env.ROUTER_PROXY_URL ?? "",
    winamax:      process.env.WINAMAX_PROXY_URL      ?? "",
    kambi:        process.env.KAMBI_PROXY_URL        ?? process.env.ROUTER_PROXY_URL ?? "",
    pokerstars:   process.env.POKERSTARS_PROXY_URL   ?? process.env.ROUTER_PROXY_URL ?? "",
    betway:       process.env.BETWAY_PROXY_URL       ?? process.env.ROUTER_PROXY_URL ?? "",
    interwetten:  process.env.INTERWETTEN_PROXY_URL  ?? process.env.ROUTER_PROXY_URL ?? "",
    betano:       process.env.BETANO_PROXY_URL       ?? process.env.ROUTER_PROXY_URL ?? "",
    altenar:      process.env.ALTENAR_PROXY_URL      ?? process.env.ROUTER_PROXY_URL ?? "",
    // New bookmakers — share the router proxy until dedicated proxies are configured
    marathonbet:  process.env.MARATHONBET_PROXY_URL  ?? process.env.ROUTER_PROXY_URL ?? "",
    jokerbet:     process.env.JOKERBET_PROXY_URL     ?? process.env.ROUTER_PROXY_URL ?? "",
    paston:       process.env.PASTON_PROXY_URL       ?? process.env.ROUTER_PROXY_URL ?? "",
    kirolbet:     process.env.KIROLBET_PROXY_URL     ?? process.env.ROUTER_PROXY_URL ?? "",
    sport888:     process.env.SPORT888_PROXY_URL     ?? process.env.ROUTER_PROXY_URL ?? "",
  },
  scanner: {
    minProfitPct: parseFloat(process.env.MIN_PROFIT_PCT ?? "0.5"),
    livePollMs: parseInt(process.env.LIVE_POLL_INTERVAL ?? "30") * 1000,
    prematchPollMs: parseInt(process.env.PREMATCH_POLL_INTERVAL ?? "300") * 1000,
    // Maximum age of odds used in live arb detection (3× the 30s poll cycle)
    liveOddsExpiryMs: 90 * 1000,
    // Maximum age of odds used in prematch arb detection (just past the 5-min poll)
    prematchOddsExpiryMs: 6 * 60 * 1000,
    // How long odds are kept in DB before cleanup (must be >= prematchOddsExpiryMs)
    oddsRetentionMs: 10 * 60 * 1000,
    // How far back to clean up old detected arbs
    arbRetentionMs: 24 * 60 * 60 * 1000, // 24 hours
  },
} as const;

export const BOOKMAKERS = [
  "betfair", "winamax", "bet365", "codere", "sportium",
  "bwin", "williamhill", "betsson", "daznbet", "pokerstars",
  "leovegas", "888sport", "luckia", "retabet",
  "betway", "interwetten", "betano", "unibet", "tonybet", "casino-gran-madrid", "kirolbet",
  // New bookmakers added 2026-09-10
  "marathonbet", "jokerbet", "paston",
] as const;

export type BookmakerKey = (typeof BOOKMAKERS)[number];
