/**
 * William Hill España — HTTP + pure WebSocket scraper (no browser).
 *
 * Flow:
 *   1. Fetch sport page HTML → extract full PDS topic paths
 *      (embedded as PDS/OB_EV{eid}/OB_MA{mid}/OB_OU{oid} strings)
 *   2. Connect pure WS to wss://whpush.williamhill.es via SOCKS5 proxy
 *   3. Subscribe to each outcome topic with Diffusion v6 binary frames
 *   4. Parse descriptor + data frame pairs for name, H/D/A position, fractional odds
 *   5. Group outcomes by event ID → ScrapedEvent[]
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require("ws");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios").default ?? require("axios");

const BASE_URL = "https://sports.williamhill.es/betting/es-es";
const WH_PUSH_URL =
  "wss://whpush.williamhill.es/v6/pds/diffusion?ty=WB&v=18&ca=10&r=0&sp=%7B%22src%22%3A%22push-component%22%7D";

const SPORT_PATHS: Partial<Record<Sport, string>> = {
  FOOTBALL:        "f%C3%BAtbol",
  TENNIS:          "tenis",
  BASKETBALL:      "basketball",
  HANDBALL:        "balonmano",
  VOLLEYBALL:      "voleibol",
  BASEBALL:        "baseball",
  AMERICANFOOTBALL:"american-football",
  RUGBYLEAGUE:     "rugby-league",
  ICEHOCKEY:       "hockey-hielo",
};
const LIVE_PATH = "en-directo/all";

// WilliamHill sport ID → our Sport enum
const WH_SPORT_MAP: Record<string, Sport> = {
  OB_SP9:  "FOOTBALL",
  OB_SP24: "TENNIS",
  OB_SP27: "BASKETBALL",   // OB_SP23 = Snooker (not Basketball), OB_SP27 = Baloncesto
  OB_SP21: "RUGBYLEAGUE",  // OB_SP22 = Rugby Union (not in Sport type — skipped)
  OB_SP1:  "AMERICANFOOTBALL",
  OB_SP26: "ICEHOCKEY",
  OB_SP2:  "BASEBALL",
  OB_SP12: "HANDBALL",
  OB_SP30: "VOLLEYBALL",
};

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL || "";
}

// Build Diffusion v6 SUBSCRIBE frame: 00 03 {seq:u8} {len:u8} ">" + topicPath
function buildSubscribeFrame(seq: number, topicPath: string): Buffer {
  const pathWithPrefix = ">" + topicPath;
  const pathBuf = Buffer.from(pathWithPrefix, "utf8");
  const frame = Buffer.alloc(4 + pathBuf.length);
  frame.writeUInt8(0x00, 0);
  frame.writeUInt8(0x03, 1);
  frame.writeUInt8(seq & 0xff, 2);
  frame.writeUInt8(pathBuf.length, 3);
  pathBuf.copy(frame, 4);
  return frame;
}

type OutcomeInfo = { name: string; pos: "H" | "D" | "A"; odds: number };

// Parse data frame (starts with \x04) for a Diffusion outcome topic
function parseDataFrame(buf: Buffer): OutcomeInfo | null {
  if (buf.length < 10 || buf[0] !== 0x04) return null;
  const txt = buf.toString("binary");

  // Team name: between | delimiters
  const nameMatch = txt.match(/\|([^|]{2,60})\|/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();

  // H/D/A position — appears after team name as \x02-delimited single char
  const namePos = txt.indexOf(nameMatch[0]);
  const afterName = txt.slice(namePos + nameMatch[0].length);
  const posMatch = afterName.match(/\x02(H|D|A)\x02/);
  if (!posMatch) return null;
  const pos = posMatch[1] as "H" | "D" | "A";

  // First fractional odds in price string: "n/d|n/d|n/d" — take first segment
  const oddsMatch = txt.match(/(\d{1,5})\/(\d{1,5})\|/);
  if (!oddsMatch) return null;
  const n = parseInt(oddsMatch[1], 10);
  const d = parseInt(oddsMatch[2], 10);
  if (!d) return null;
  const odds = parseFloat((n / d + 1).toFixed(4));
  if (odds < 1.01 || odds > 501) return null;

  return { name, pos, odds };
}

type PageData = {
  topics: string[];                       // full PDS/OB_EV.../OB_MA.../OB_OU... paths
  topicSport: Map<string, Sport>;         // topic → sport (for live page mixed sports)
};

// Fetch HTML and extract PDS topic paths (and sport per event for live page)
async function extractPageData(sportUrl: string, proxy: string, defaultSport?: Sport): Promise<PageData> {
  const agent = new SocksProxyAgent(proxy);
  const resp = await axios.get(sportUrl, {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 20_000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html",
      "Accept-Language": "es-ES,es;q=0.9",
    },
  });
  const html: string = resp.data;

  // All unique full topic paths
  const topics = [...new Set<string>(html.match(/PDS\/OB_EV\d+\/OB_MA\d+\/OB_OU\d+/g) || [])];

  // Build event → sport map from embedded JSON: "OB_EV12345":{"topic":...,"sportId":"OB_SP9"}
  const evSportMap = new Map<string, Sport>();
  // Looser pattern: capture sportId anywhere within 400 chars after OB_EV id (handles varying JSON field order)
  const evSportPat = /"OB_EV(\d+)":\{[^}]{0,400}?"sportId":"(\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = evSportPat.exec(html)) !== null) {
    const eid = m[1];
    const sport = WH_SPORT_MAP[m[2]];
    if (sport) evSportMap.set(eid, sport); // skip events with unknown sportId (cricket, snooker, pool, etc.)
  }

  // Map topic → sport
  const topicSport = new Map<string, Sport>();
  for (const topic of topics) {
    const evMatch = topic.match(/OB_EV(\d+)/);
    if (!evMatch) continue;
    const sport = evSportMap.get(evMatch[1]) ?? defaultSport;
    if (sport) topicSport.set(topic, sport); // exclude topics with unknown sport
  }

  // If evSportMap is empty but topics were found, WH HTML format may have changed — fall back to FOOTBALL
  // (better than returning 0 events for all live events)
  if (evSportMap.size === 0 && topics.length > 0) {
    console.warn(`[williamhill] evSportMap empty despite ${topics.length} topics — HTML format may have changed; defaulting to FOOTBALL`);
    for (const topic of topics) {
      topicSport.set(topic, (defaultSport ?? "FOOTBALL") as Sport);
    }
  }

  return { topics, topicSport };
}

// Connect WS and collect outcome data for given topics
async function fetchOutcomesViaWs(
  topics: string[],
  proxy: string,
  timeoutMs = 22_000,
): Promise<Map<string, OutcomeInfo>> {
  if (topics.length === 0) return new Map();

  const agent = new SocksProxyAgent(proxy);
  const ws = new WebSocket(WH_PUSH_URL, {
    agent,
    headers: {
      Origin: "https://sports.williamhill.es",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
    handshakeTimeout: 15_000,
  });

  const results = new Map<string, OutcomeInfo>();
  // Track last 2 descriptors in case data arrives after a second descriptor
  const pendingTopics: string[] = [];

  return new Promise<Map<string, OutcomeInfo>>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (_) {}
      resolve(results);
    };

    const timer = setTimeout(finish, timeoutMs);

    ws.on("error", finish);
    ws.on("close", () => {
      clearTimeout(timer);
      finish();
    });

    ws.on("open", () => {
      // Send subscribe frames in batches of 60 with small gaps to avoid overwhelming the WS
      const BATCH = 60;
      const send = (start: number) => {
        const end = Math.min(start + BATCH, topics.length);
        let seq = (start % 254) + 1;
        for (let i = start; i < end; i++) {
          try { ws.send(buildSubscribeFrame(seq & 0xff, topics[i])); } catch (_) {}
          seq++;
        }
        if (end < topics.length) setTimeout(() => send(end), 150);
      };
      setTimeout(() => send(0), 400);
    });

    ws.on("message", (data: any) => {
      const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
      if (buf.length < 2) return;

      const t0 = buf[0];
      const t1 = buf[1];

      // Descriptor frame (0x00 0x57): contains topic path as ASCII text
      if (t0 === 0x00 && t1 === 0x57) {
        const ascii = buf.toString("ascii");
        const m = ascii.match(/PDS\/OB_EV\d+\/OB_MA\d+\/OB_OU\d+/);
        if (m) {
          pendingTopics.push(m[0]);
          if (pendingTopics.length > 3) pendingTopics.shift(); // keep last 3
        }
        return;
      }

      // Data frame (0x04): outcome data — associate with most recent pending descriptor
      if (t0 === 0x04 || (t0 === 0x05 && buf.length > 15)) {
        const outcome = parseDataFrame(buf);
        if (outcome && pendingTopics.length > 0) {
          const topic = pendingTopics.pop()!;
          results.set(topic, outcome);
          // Finish early if we've received all expected outcomes
          if (results.size >= topics.length) {
            clearTimeout(timer);
            finish();
          }
        }
        return;
      }
    });
  });
}

// Build ScrapedEvent[] from topic→outcome map and topic→sport map
function buildEvents(
  topicOutcomes: Map<string, OutcomeInfo>,
  topicSport: Map<string, Sport>,
  bookmaker: string,
  isLive: boolean,
  defaultSport: Sport | undefined,
): ScrapedEvent[] {
  type EvGroup = {
    sport: Sport;
    H?: OutcomeInfo;
    D?: OutcomeInfo;
    A?: OutcomeInfo;
  };
  const byEvent = new Map<string, EvGroup>();

  for (const [topic, outcome] of topicOutcomes) {
    const evMatch = topic.match(/OB_EV(\d+)/);
    if (!evMatch) continue;
    const eid = evMatch[1];
    if (!byEvent.has(eid)) {
      const evSport = topicSport.get(topic) ?? defaultSport;
      if (!evSport) continue; // skip if sport unknown (mixed live page, non-mapped sportIds)
      byEvent.set(eid, { sport: evSport });
    }
    byEvent.get(eid)![outcome.pos] = outcome;
  }

  const events: ScrapedEvent[] = [];
  for (const [, ev] of byEvent) {
    if (!ev.H || !ev.A) continue;
    const eventName = `${ev.H.name} - ${ev.A.name}`;
    const eventKey = buildEventKey(ev.sport, eventName, undefined);
    const outcomes: H2HOutcome[] = [
      { name: "1", odds: ev.H.odds },
      ...(ev.D ? [{ name: "X", odds: ev.D.odds }] : []),
      { name: "2", odds: ev.A.odds },
    ];
    events.push({
      bookmaker,
      sport: ev.sport,
      eventKey,
      eventName,
      isLive,
      market: "h2h",
      outcomes,
    });
  }
  return events;
}

export class WilliamHillScraper extends BaseScraper {
  readonly name = "williamhill";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "HANDBALL", "VOLLEYBALL", "BASEBALL", "AMERICANFOOTBALL", "RUGBYLEAGUE", "ICEHOCKEY"];

  private async scrapePage(
    pageUrl: string,
    defaultSport: Sport | undefined,
    isLive: boolean,
  ): Promise<ScrapedEvent[]> {
    const proxy = getProxy();
    if (!proxy) {
      this.log("Sin ROUTER_PROXY_URL — necesita proxy ES");
      return [];
    }

    try {
      this.log(`WH ${defaultSport ?? "LIVE"} (${isLive ? "live" : "prematch"}): fetching HTML...`);
      const { topics, topicSport } = await extractPageData(pageUrl, proxy, defaultSport);

      if (topics.length === 0) {
        this.warn(`WH ${defaultSport ?? "LIVE"}: 0 outcome topics found in HTML`);
        return [];
      }
      this.log(`WH ${defaultSport ?? "LIVE"}: ${topics.length} outcome topics — connecting WS...`);

      const outcomeMap = await fetchOutcomesViaWs(topics, proxy, isLive ? 25_000 : 20_000);
      this.log(`WH ${defaultSport ?? "LIVE"}: ${outcomeMap.size}/${topics.length} outcomes received`);

      const events = buildEvents(outcomeMap, topicSport, "williamhill", isLive, defaultSport);
      if (events.length > 0) {
        this.log(`WH ${defaultSport ?? "LIVE"}: ${events.length} events`);
      } else {
        this.warn(`WH ${defaultSport ?? "LIVE"}: 0 events from ${outcomeMap.size} outcomes`);
      }
      return events;
    } catch (err) {
      this.warn(`WH ${defaultSport ?? "LIVE"} failed`, err);
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return this.scrapePage(`${BASE_URL}/${LIVE_PATH}`, undefined, true); // mixed-sport page — sport detected per-event from embedded sportId
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    // Run all sport pages in parallel — sequential was taking 5+ minutes with 9 sports
    const results = await Promise.all(
      this.sports
        .filter(sport => SPORT_PATHS[sport])
        .map(sport => this.scrapePage(`${BASE_URL}/${SPORT_PATHS[sport]!}`, sport, false))
    );
    return results.flat();
  }
}
