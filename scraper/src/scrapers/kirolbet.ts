/**
 * Kirolbet España — Kirolsoft platform SSR scraper.
 *
 * Flow:
 *   1. Fetch /esp/Sport/Deporte/{sportId} for each sport (today's events)
 *   2. Parse div[sport-type="Eve"] — event containers with des/sct/dt attrs
 *   3. Find ul[sport-type="Mkt"] with des="1X2" (visible, not houdini_apuesta)
 *   4. Extract outcome names (1/X/2) and coef odds from span.coef
 *
 * Platform: Kirolsoft (own platform, apuestas.kirolbet.es)
 * Note: Live data uses WebSocket push — scrapeLive() returns [].
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome } from "../types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios").default ?? require("axios");

const BASE_URL = "https://apuestas.kirolbet.es";

const SPORT_IDS: Partial<Record<Sport, number>> = {
  FOOTBALL:   40,
  TENNIS:     285,
  BASKETBALL: 50,
  BASEBALL:   429,
  ICEHOCKEY:  418,
};

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL ?? "";
}

async function fetchHtml(url: string, proxy: string): Promise<string> {
  const agent = new SocksProxyAgent(proxy);
  const resp = await axios.get(url, {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 20_000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Referer: BASE_URL,
    },
  });
  return String(resp.data);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&ntilde;/g, "ñ")
    .replace(/&Ntilde;/g, "Ñ");
}

function getAttr(tag: string, attr: string): string {
  const m = tag.match(new RegExp(`\\b${attr}="([^"]*)"`));
  return m ? decodeHtmlEntities(m[1]) : "";
}

function parseHtml(html: string, sport: Sport): ScrapedEvent[] {
  const results: ScrapedEvent[] = [];

  // Match event opening div tags: <div ... sport-type="Eve" ...>
  const eventTagRe = /<div\b([^>]*\bsport-type="Eve"\b[^>]*)>/gi;
  let evM: RegExpExecArray | null;

  while ((evM = eventTagRe.exec(html)) !== null) {
    const tagStr = evM[1];
    const des    = getAttr(tagStr, "des");    // "TeamA vs. TeamB"
    const sct    = getAttr(tagStr, "sct");    // competition name
    const ideve  = getAttr(tagStr, "data-ideve"); // numeric event ID

    if (!des || !ideve) continue;

    // Parse team names — format is "Home vs. Away"
    const vsSplit = des.split(" vs. ");
    if (vsSplit.length < 2) continue;
    const home = vsSplit[0].trim();
    const away = vsSplit.slice(1).join(" vs. ").trim();
    if (!home || !away) continue;

    const eventName = `${home} v ${away}`;
    const eventKey  = buildEventKey(sport, eventName, undefined);

    // Find the 1X2 market for this event.
    // Market ULs have data-ideve="EVENTID_MARKETID".
    // Exclude hidden markets (houdini_apuesta class).
    // Match: ul[sport-type="Mkt"][des="1X2"] (no houdini_apuesta) for this event.
    const escapedId = ideve.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mktRe = new RegExp(
      `<ul\\b((?!houdini_apuesta)[^>])*\\bdata-ideve="${escapedId}_\\d+"[^>]*\\bdes="1X2"[^>]*>([\\s\\S]*?)<\\/ul>`,
      "i",
    );
    const mktM = mktRe.exec(html);
    if (!mktM) continue;

    const mktHtml = mktM[2];

    // Extract each selection: title attribute (name) + span.coef (odds)
    const selRe = /\btitle="([^"]+)"[\s\S]*?<span\b[^>]*class="coef"[^>]*>([^<]+)<\/span>/gi;
    const outcomes: H2HOutcome[] = [];
    let selM: RegExpExecArray | null;
    while ((selM = selRe.exec(mktHtml)) !== null) {
      const name = selM[1].trim();           // "1", "X", "2"
      const oddsStr = selM[2].replace(",", ".").trim();
      const odds = parseFloat(oddsStr);
      if (isNaN(odds) || odds <= 1) continue;
      outcomes.push({ name, odds });
    }

    if (outcomes.length < 2) continue;

    results.push({
      bookmaker: "kirolbet",
      sport,
      eventKey,
      eventName,
      league: sct || undefined,
      isLive: false,
      market: "h2h",
      outcomes,
    });
  }

  return results;
}

export class KirolbetScraper extends BaseScraper {
  readonly name    = "kirolbet";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "ICEHOCKEY"];

  private async scrapeSport(sport: Sport): Promise<ScrapedEvent[]> {
    const sportId = SPORT_IDS[sport];
    if (!sportId) return [];

    const proxy = getProxy();
    if (!proxy) {
      this.log("Sin ROUTER_PROXY_URL — necesita proxy ES");
      return [];
    }

    try {
      const url = `${BASE_URL}/esp/Sport/Deporte/${sportId}`;
      this.log(`Kirolbet ${sport}: fetching…`);
      const html   = await fetchHtml(url, proxy);
      const events = parseHtml(html, sport);

      if (events.length > 0) {
        const bySport: Record<string, number> = {};
        for (const e of events) bySport[e.sport] = (bySport[e.sport] ?? 0) + 1;
        this.log(`Kirolbet ${sport}: ${events.length} eventos`);
      } else {
        this.warn(`Kirolbet ${sport}: 0 eventos`);
      }
      return events;
    } catch (err) {
      this.warn(`Kirolbet ${sport} failed`, err);
      return [];
    }
  }

  // Live data uses WebSocket push (GetPushToken) — not implemented
  async scrapeLive(): Promise<ScrapedEvent[]> {
    return [];
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const chunks = await Promise.all(
      this.sports.map(sport => this.scrapeSport(sport)),
    );
    return chunks.flat();
  }
}
