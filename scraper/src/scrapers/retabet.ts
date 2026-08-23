/**
 * Retabet España — SignalR + REST scraper.
 *
 * Plataforma: propia (NO Kambi). Verificado el 31/07/2026.
 * - SignalR hub: wss://rtds.retabet.es/realTimeDataHub
 * - REST API:    https://apuestas.retabet.es/api/render/LoadWidget
 */

import * as https from "https";
import {
  HubConnectionBuilder, LogLevel, HubConnection, HttpTransportType,
} from "@microsoft/signalr";
import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine, PlayerPropLine } from "../types";

const HUB_URL   = "https://rtds.retabet.es/realTimeDataHub";
const REST_HOST  = "apuestas.retabet.es";

function jsonGet(path: string): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: REST_HOST, path, timeout: 15_000,
        headers: {
          "Accept": "application/json",
          "Accept-Language": "es-ES,es;q=0.9",
          "Referer": "https://www.retabet.es/",
          "Origin": "https://www.retabet.es",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// ─── Player prop helpers ──────────────────────────────────────────────────────

const RETABET_PROP_STATS: Array<[RegExp, string]> = [
  [/\bpuntos?\b/i,                            "PTS"],
  [/\brebotes?\b/i,                           "REB"],
  [/\basistencias?\b/i,                       "AST"],
  [/\btriples?\b/i,                           "3PT"],
  [/tapones?(?:\s*y\s*robos?)?/i,             "BLK"],
  [/\brobos?\b/i,                             "STL"],
  [/\bpra\b/i,                                "PRA"],
  [/disparos?\s*(?:a\s*puerta)?/i,            "shots"],
  [/goles?\s*(?:en\s*cualquier\s*momento)?/i, "goals"],
  [/\baces?\b/i,                              "aces"],
  [/dobles?\s*faltas?|double\s*faults?/i,     "double_faults"],
  [/\bpoints?\b/i,                            "PTS"],
  [/\brebound[s]?\b/i,                        "REB"],
  [/\bassist[s]?\b/i,                         "AST"],
  [/3-?pointer[s]?|three[s]?/i,              "3PT"],
];

function detectRetabetPlayerProp(mName: string): { player: string; stat: string } | null {
  const parts = mName.split(/\s*[-–—]\s*/);
  if (parts.length < 2) return null;

  const lastPart = parts[parts.length - 1];
  for (const [re, stat] of RETABET_PROP_STATS) {
    if (re.test(lastPart)) {
      const player = parts.slice(0, -1).join(" ").trim();
      if (player.length >= 2) return { player, stat };
    }
  }

  const firstPart = parts[0];
  for (const [re, stat] of RETABET_PROP_STATS) {
    if (re.test(firstPart)) {
      const player = parts.slice(1).join(" ").trim();
      if (player.length >= 2) return { player, stat };
    }
  }

  return null;
}

function parseRetabetPlayerProp(sels: any[], player: string, stat: string): PlayerPropLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const s of sels) {
    const price = parseFloat(String(s?.price ?? s?.Price ?? s?.odds ?? s?.Odds ?? s?.odd ?? 0));
    if (price < 1.01) continue;
    const name: string = (s?.name ?? s?.Name ?? s?.label ?? s?.selectionName ?? "").toLowerCase();
    const lineMatch = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /m[aá]s\s*de|over|\+/.test(name);
    const isUnder = /menos\s*de|under/.test(name);
    if (!isOver && !isUnder) continue;
    const cur = byLine.get(line) ?? { over: 0, under: 0 };
    if (isOver  && price > cur.over)  cur.over  = price;
    if (isUnder && price > cur.under) cur.under = price;
    byLine.set(line, cur);
  }
  return [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ player, stat, line, over, under }));
}

// ─── Market classification ────────────────────────────────────────────────────

const RETABET_MARKET_MAP: Array<[RegExp, string]> = [
  [/resultado\s*(final)?|ganador|match\s*result|full\s*time\s*result|1\s*x\s*2|ft\s*result|\bh2h\b|\bft\b/i, "h2h"],
  [/h[aá]ndicap(?:\s+asi[aá]tico)?|handicap|asian\s*handicap/i, "handicap"],
  [/(?:primer[ao]|1[aº])\s*mitad.*goles?|goles?.*(?:primer[ao]|1[aº])\s*mitad|ht\s*goals?|1st\s*half.*goals?/i, "h1_goals"],
  [/(?:segund[ao]|2[aº])\s*mitad.*goles?|goles?.*(?:segund[ao]|2[aº])\s*mitad|2nd\s*half.*goals?/i, "h2_goals"],
  [/total\s+(?:de\s+)?goles?|goles?\s+totales?|m[aá]s\s*\/?\s*menos.*goles?|\bgoles?\b|total\s+goals?|over\s*\/?\s*under\s+goals?/i, "goals"],
  [/c[oó]rners?|saques?\s+de\s+esquina|corner\s+kicks?/i, "corners"],
  [/tarjetas?\s+amarillas?|yellow\s+cards?/i, "yellow_cards"],
  [/tarjetas?\s+rojas?|red\s+cards?/i, "red_cards"],
  [/tarjetas?\s+totales?|total\s+(?:de\s+)?tarjetas?|total\s+cards?/i, "cards"],
  [/total\s+(?:de\s+)?juegos?|juegos?\s+totales?|total\s+games?/i, "games"],
  [/total\s+(?:de\s+)?sets?|sets?\s+totales?|total\s+sets?/i, "sets"],
  [/\baces?\b/i, "aces"],
  [/dobles?\s*faltas?|double\s+faults?/i, "double_faults"],
  [/total\s+(?:de\s+)?puntos?|puntos?\s+totales?|total\s+points?/i, "match_points"],
];

function classifyRetabetMarket(name: string): string | null {
  for (const [re, cat] of RETABET_MARKET_MAP) {
    if (re.test(name)) return cat;
  }
  return null;
}

function parseRetabetOverUnder(sels: any[]): TotalsLine[] {
  const byLine = new Map<number, { over: number; under: number }>();
  for (const s of sels) {
    const price = parseFloat(String(s?.price ?? s?.Price ?? s?.odds ?? s?.Odds ?? s?.odd ?? 0));
    if (price < 1.01) continue;
    const name: string = (s?.name ?? s?.Name ?? s?.label ?? s?.selectionName ?? "").toLowerCase();
    const lineMatch = name.match(/(\d+[.,]\d+|\d+)/);
    if (!lineMatch) continue;
    const line = parseFloat(lineMatch[1].replace(",", "."));
    const isOver  = /m[aá]s\s*de|over|plus|\+/.test(name);
    const isUnder = /menos\s*de|under|minus/.test(name);
    if (!isOver && !isUnder) continue;
    const cur = byLine.get(line) ?? { over: 0, under: 0 };
    if (isOver  && price > cur.over)  cur.over  = price;
    if (isUnder && price > cur.under) cur.under = price;
    byLine.set(line, cur);
  }
  return [...byLine.entries()]
    .filter(([, { over, under }]) => over >= 1.01 && under >= 1.01)
    .map(([line, { over, under }]) => ({ line, over, under }));
}

function parseRetabetData(data: any, sport: Sport, isLive: boolean): ScrapedEvent[] {
  if (!data || typeof data !== "object") return [];
  const events: ScrapedEvent[] = [];

  const evList: any[] = (
    data?.events ?? data?.Events ?? data?.data?.events ??
    data?.matches ?? data?.Matches ?? data?.items ?? data?.Items ??
    data?.competitions?.flatMap((c: any) => c?.events ?? c?.Events ?? []) ??
    data?.data?.competitions?.flatMap((c: any) => c?.events ?? []) ??
    []
  );

  for (const ev of evList) {
    const home: string = ev?.homeTeam ?? ev?.HomeTeam ?? ev?.home ?? ev?.HomeTeamName ?? "";
    const away: string = ev?.awayTeam ?? ev?.AwayTeam ?? ev?.away ?? ev?.AwayTeamName ?? "";
    const eventName: string = ev?.name ?? ev?.Name ?? ev?.eventName ?? ev?.EventName ??
      (home && away ? `${home} - ${away}` : "");
    if (!eventName) continue;

    const rawStart = ev?.startDate ?? ev?.StartDate ?? ev?.start ?? ev?.date;
    const startTime = rawStart ? new Date(rawStart) : undefined;
    const eventKey = buildEventKey(sport, eventName, startTime);

    const markets: any[] = ev?.markets ?? ev?.Markets ?? ev?.betOffers ?? ev?.offers ?? [];
    let emittedH2H = false;

    for (const m of markets) {
      const mName = m?.name ?? m?.Name ?? m?.type ?? m?.marketType ?? "";
      const sels: any[] = m?.selections ?? m?.Selections ?? m?.outcomes ?? m?.Runners ?? [];

      // 1. Player prop detection (e.g. "LeBron James - Puntos")
      const propMeta = detectRetabetPlayerProp(mName);
      if (propMeta) {
        const lines = parseRetabetPlayerProp(sels, propMeta.player, propMeta.stat);
        if (lines.length > 0) {
          events.push({ bookmaker: "retabet", sport, eventKey, eventName, startTime, isLive, market: "player_props", outcomes: lines });
        }
        continue;
      }

      // 2. Generic market classification
      const cat = classifyRetabetMarket(mName);
      if (!cat) continue;

      if (cat === "h2h" || cat === "handicap") {
        if (cat === "h2h" && emittedH2H) continue;
        const outcomes: H2HOutcome[] = sels
          .map((s: any) => {
            const price = parseFloat(String(s?.price ?? s?.Price ?? s?.odds ?? s?.Odds ?? s?.odd ?? 0));
            const name: string = s?.name ?? s?.Name ?? s?.label ?? s?.selectionName ?? "";
            return price >= 1.01 && name ? { name, odds: price } : null;
          })
          .filter(Boolean) as H2HOutcome[];
        if (outcomes.length >= 2) {
          events.push({ bookmaker: "retabet", sport, eventKey, eventName, startTime, isLive, market: cat, outcomes });
          if (cat === "h2h") emittedH2H = true;
        }
      } else {
        const lines = parseRetabetOverUnder(sels);
        if (lines.length > 0) {
          events.push({ bookmaker: "retabet", sport, eventKey, eventName, startTime, isLive, market: cat, outcomes: lines });
        }
      }
    }
  }
  return events;
}

export class RetabetScraper extends BaseScraper {
  readonly name = "retabet";
  readonly sports: Sport[] = [
    "FOOTBALL", "TENNIS", "BASKETBALL", "VOLLEYBALL",
    "AMERICANFOOTBALL", "ICEHOCKEY", "BASEBALL", "RUGBYLEAGUE",
  ];

  private connection: HubConnection | null = null;
  private isConnecting = false;
  private receivedMessages: Array<{ method: string; args: any[] }> = [];

  private async ensureConnection(): Promise<void> {
    if (this.connection?.state === "Connected") return;
    if (this.isConnecting) {
      // Wait for the ongoing connection attempt to finish
      const deadline = Date.now() + 20_000;
      while (this.isConnecting && Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 300));
      }
      return;
    }
    this.isConnecting = true;
    try {
      this.connection = new HubConnectionBuilder()
        .withUrl(HUB_URL, {
          transport: HttpTransportType.WebSockets,
          headers: {
            "Accept-Language": "es-ES,es;q=0.9",
            "Origin": "https://www.retabet.es",
            "Referer": "https://www.retabet.es/apuestas/",
          },
        })
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(LogLevel.Warning)
        .build();

      this.connection.onclose((err: Error | undefined) => {
        this.warn(`Retabet WS closed: ${err?.message ?? "unknown"}`);
        this.isConnecting = false;
      });

      // Register listeners for all plausible push method names from the Retabet hub
      const pushMethods = [
        "oddsUpdate", "OddsUpdate", "odds", "Odds", "eventOdds", "EventOdds",
        "liveOdds", "LiveOdds", "updateOdds", "UpdateOdds",
        "marketUpdate", "MarketUpdate", "eventUpdate", "EventUpdate",
        "offerUpdate", "OfferUpdate", "selectionUpdate", "SelectionUpdate",
        "priceUpdate", "PriceUpdate", "dataUpdate", "DataUpdate",
        "sportsUpdate", "SportsUpdate", "update", "Update",
        "message", "Message", "push", "Push", "EventsData", "eventsData",
        "feed", "Feed", "BroadcastMessage", "broadcastMessage",
      ];
      for (const method of pushMethods) {
        this.connection.on(method, (...args: any[]) => {
          this.receivedMessages.push({ method, args });
          const count = this.receivedMessages.filter(m => m.method === method).length;
          if (count <= 3) {
            this.log(`Retabet WS [${method}]: ${JSON.stringify(args).slice(0, 600)}`);
          }
        });
      }

      await this.connection.start();
      this.log(`Retabet SignalR connected: ${HUB_URL}`);

      // Fire invocations to discover active hub methods — responses logged for analysis
      const invocations: Array<{ method: string; args: any[] }> = [
        { method: "subscribe",             args: ["football"] },
        { method: "subscribe",             args: ["live"] },
        { method: "Subscribe",             args: ["football"] },
        { method: "SubscribeToSport",      args: [1] },
        { method: "SubscribeToLiveEvents", args: [] },
        { method: "GetLiveEvents",         args: [] },
        { method: "GetPreMatchEvents",     args: [] },
        { method: "GetOdds",              args: [1] },
        { method: "JoinGroup",            args: ["football"] },
        { method: "RegisterClient",       args: ["web"] },
        { method: "Ping",                 args: [] },
        // Numeric IDs per Gemini (football=1, basketball=2, tennis=3)
        { method: "Subscribe",             args: [1] },
        { method: "Subscribe",             args: [2] },
        { method: "Subscribe",             args: [3] },
        { method: "SubscribeSport",        args: [1] },
        { method: "JoinGroup",             args: ["Live_FUTBOL"] },
        { method: "JoinGroup",             args: ["live_football"] },
        { method: "JoinGroup",             args: ["FUTBOL_LIVE"] },
        { method: "JoinGroup",             args: ["live"] },
        { method: "JoinChannel",           args: ["live"] },
        { method: "GetEvents",             args: [1] },
        { method: "GetEventList",          args: [1] },
      ];
      for (const inv of invocations) {
        try {
          const result = await (this.connection as any).invoke(inv.method, ...inv.args)
            .catch(() => undefined);
          if (result !== undefined && result !== null) {
            this.log(`Retabet invoke ${inv.method}: ${JSON.stringify(result).slice(0, 400)}`);
          }
        } catch { /* method not found */ }
      }
    } catch (err: any) {
      this.warn(`Retabet WS connect error: ${err?.message ?? String(err)}`);
    } finally {
      this.isConnecting = false;
    }
  }

  private async scrapeViaRest(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    const sp = ({
      FOOTBALL: "futbol", TENNIS: "tenis", BASKETBALL: "baloncesto",
      VOLLEYBALL: "voleibol", ICEHOCKEY: "hockey-hielo", BASEBALL: "beisbol",
      RUGBYLEAGUE: "rugby-league", AMERICANFOOTBALL: "futbol-americano",
    } as Partial<Record<Sport, string>>)[sport];
    const paths = [
      `/api/render/LoadWidget?sport=${sp}&live=${isLive}&lang=es`,
      `/api/render/LoadWidget?sportId=1&live=${isLive}&locale=es-ES`,
      `/api/sports/${sp}/events?live=${isLive}&lang=es`,
      `/api/sports/${sp}?inplay=${isLive}&lang=es&locale=es-ES`,
      `/api/events?sport=${sp}&isLive=${isLive}`,
      `/sportsdata/${sp}/${isLive ? "live" : "prematch"}.json`,
    ];
    for (const path of paths) {
      const data = await jsonGet(path);
      if (!data) continue;
      const parsed = parseRetabetData(data, sport, isLive);
      if (parsed.length > 0) {
        this.log(`REST ${path.slice(0, 50)}: ${parsed.length} events`);
        return parsed;
      }
      const topKeys = typeof data === "object" && data
        ? Object.keys(data).slice(0, 6).join(",") : typeof data;
      this.log(`REST ${path.slice(0, 50)} -> 0 events, keys: ${topKeys}`);
    }
    return [];
  }

  private async scrapeOneSport(sport: Sport, isLive: boolean): Promise<ScrapedEvent[]> {
    if (this.receivedMessages.length > 0) {
      const wsEvents: ScrapedEvent[] = [];
      for (const { args } of this.receivedMessages) {
        for (const arg of args) wsEvents.push(...parseRetabetData(arg, sport, isLive));
      }
      if (wsEvents.length > 0) {
        this.log(`WS ${isLive ? "live" : "prematch"} ${sport}: ${wsEvents.length} events`);
        return wsEvents;
      }
    }
    const restEvents = await this.scrapeViaRest(sport, isLive);
    if (restEvents.length > 0) return restEvents;
    this.warn(`Retabet ${sport} ${isLive ? "live" : "prematch"}: 0 events (WS msgs: ${this.receivedMessages.length})`);
    return [];
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    await this.ensureConnection().catch(() => {});
    // Give the hub time to push data after the initial invocations
    if (this.connection?.state === "Connected" && this.receivedMessages.length === 0) {
      await new Promise<void>((r) => setTimeout(r, 4_000));
    }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...await this.scrapeOneSport(sport, true));
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    await this.ensureConnection().catch(() => {});
    if (this.connection?.state === "Connected" && this.receivedMessages.length === 0) {
      await new Promise<void>((r) => setTimeout(r, 4_000));
    }
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...await this.scrapeOneSport(sport, false));
    return all;
  }
}
