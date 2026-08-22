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
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

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

function isH2HMarket(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("1x2") || n.includes("resultado") || n.includes("match result") ||
    n.includes("ganador") || n.includes("winner") || n.includes("full time") ||
    n === "h2h" || n === "ft";
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
    for (const m of markets) {
      if (!isH2HMarket(m?.name ?? m?.Name ?? m?.type ?? m?.marketType ?? "")) continue;
      const sels: any[] = m?.selections ?? m?.Selections ?? m?.outcomes ?? m?.Runners ?? [];
      const outcomes: H2HOutcome[] = sels
        .map((s: any) => {
          const price = parseFloat(String(s?.price ?? s?.Price ?? s?.odds ?? s?.Odds ?? s?.odd ?? 0));
          const name: string = s?.name ?? s?.Name ?? s?.label ?? s?.selectionName ?? "";
          return price >= 1.01 && name ? { name, odds: price } : null;
        })
        .filter(Boolean) as H2HOutcome[];
      if (outcomes.length >= 2) {
        events.push({ bookmaker: "retabet", sport, eventKey, eventName, startTime, isLive, market: "h2h", outcomes });
        break;
      }
    }
  }
  return events;
}

export class RetabetScraper extends BaseScraper {
  readonly name = "retabet";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];

  private connection: HubConnection | null = null;
  private isConnecting = false;
  private receivedMessages: Array<{ method: string; args: any[] }> = [];

  private async ensureConnection(): Promise<void> {
    if (this.connection?.state === "Connected") return;
    if (this.isConnecting) return;
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
    const sp = ({ FOOTBALL: "futbol", TENNIS: "tenis", BASKETBALL: "baloncesto", ICEHOCKEY: "hockey", BASEBALL: "beisbol", RUGBYLEAGUE: "rugby-league", AMERICANFOOTBALL: "futbol-americano" } as Partial<Record<Sport, string>>)[sport];
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
    this.ensureConnection().catch(() => {});
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...await this.scrapeOneSport(sport, true));
    return all;
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    this.ensureConnection().catch(() => {});
    const all: ScrapedEvent[] = [];
    for (const sport of this.sports) all.push(...await this.scrapeOneSport(sport, false));
    return all;
  }
}
