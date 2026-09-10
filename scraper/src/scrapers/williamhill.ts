/**
 * William Hill España — HTML modelBox scraper.
 *
 * Flow:
 *   1. Fetch live/prematch HTML via proxy
 *   2. Parse WH.sportsbook.modelBox["inPlayPage-0"] (or preMatchPage-0) JSON
 *      → events {sportId}, markets {hash[10]=type, parent=eventId},
 *        selections {hash[1]=status, hash[2]=priceNum, hash[3]=priceDen, hash[9]=meaning, parent=marketId}
 *   3. Extract <button id="OB_OU…" data-name="…"> from HTML for team names
 *   4. Build ScrapedEvent[] from the combined data
 */

import { BaseScraper } from "./base";
import { buildEventKey } from "../matcher/normalize";
import type { ScrapedEvent, Sport, H2HOutcome, TotalsLine } from "../types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require("socks-proxy-agent");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require("axios").default ?? require("axios");

const BASE_URL  = "https://sports.williamhill.es/betting/es-es";
const LIVE_PATH = "en-directo/all";

const SPORT_PATHS: Partial<Record<Sport, string>> = {
  FOOTBALL:        "f%C3%BAtbol",
  TENNIS:          "tenis",
  BASKETBALL:      "basketball",
  BASEBALL:        "baseball",
  AMERICANFOOTBALL:"american-football",
  ICEHOCKEY:       "hockey-hielo",
};

const WH_SPORT_MAP: Record<string, Sport> = {
  OB_SP9:  "FOOTBALL",
  OB_SP24: "TENNIS",
  OB_SP27: "BASKETBALL",
  OB_SP1:  "AMERICANFOOTBALL",
  OB_SP26: "ICEHOCKEY",
  OB_SP2:  "BASEBALL",
};

// OpenBet market type hash[10] → internal market key
const MKT_TYPE_MAP: Record<string, string> = {
  MR:   "h2h",   // 3-way (football)
  HH:   "h2h",   // 2-way head-to-head (tennis, basketball, etc.)
  DC:   "double_chance",
  AH:   "asian_handicap",
  MH:   "handicap",
  WH:   "handicap",
  TG:   "goals",
  HHTG: "h1_goals",
  H2TG: "h2_goals",
  BTS:  "btts",
  CRN:  "corners",
  ACRN: "corners",
  BK:   "cards",
  YC:   "yellow_cards",
  RC:   "red_cards",
};

function getProxy(): string {
  return process.env.ROUTER_PROXY_URL ?? "";
}

// ── HTML fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url: string, proxy: string): Promise<string> {
  const agent = new SocksProxyAgent(proxy);
  const resp = await axios.get(url, {
    httpAgent: agent,
    httpsAgent: agent,
    timeout: 20_000,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Accept: "text/html",
      "Accept-Language": "es-ES,es;q=0.9",
    },
  });
  return String(resp.data);
}

// ── modelBox extraction ────────────────────────────────────────────────────────

interface ModelBoxData {
  events:     Record<string, { hash: any[]; sportId: string }>;
  markets:    Record<string, { hash: any[]; parent: string }>;
  selections: Record<string, { hash: any[]; parent: string }>;
}

function extractModelBox(html: string, isLive: boolean): ModelBoxData | null {
  // Try all key variants WilliamHill has used
  const candidates = isLive
    ? ["inPlayPage-0", "inPlay"]
    : ["preMatchPage-0", "preMatch"];

  for (const key of candidates) {
    for (const q of ['"', "'"]) {
      const marker = `WH.sportsbook.modelBox[${q}${key}${q}]`;
      const idx = html.indexOf(marker);
      if (idx < 0) continue;

      const eqIdx = html.indexOf("=", idx + marker.length);
      if (eqIdx < 0 || eqIdx > idx + marker.length + 10) continue;
      const braceIdx = html.indexOf("{", eqIdx);
      if (braceIdx < 0) continue;

      // Balanced-brace walk — cap at 6 MB to avoid runaway
      let depth = 0, i = braceIdx, end = -1, inStr = false, esc = false;
      const limit = Math.min(html.length, braceIdx + 6_000_000);
      while (i < limit) {
        const ch = html[i];
        if (esc) { esc = false; }
        else if (inStr) { if (ch === "\\") esc = true; else if (ch === '"') inStr = false; }
        else if (ch === '"') { inStr = true; }
        else if (ch === "{") { depth++; }
        else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
        i++;
      }
      if (end < 0) continue;

      try {
        const raw = JSON.parse(html.slice(braceIdx, end + 1));
        // Validate shape
        if (raw && typeof raw.events === "object" && typeof raw.markets === "object" && typeof raw.selections === "object") {
          return raw as ModelBoxData;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// ── Button data-name extraction ───────────────────────────────────────────────

function extractSelectionNames(html: string): Map<string, string> {
  const map = new Map<string, string>();
  // <button id="OB_OU…" … data-name="…" … data-entityid="OB_OU…" …>
  const re = /<button\b[^>]*\bid="(OB_OU\d+)"[^>]*\bdata-name="([^"]*)"[^>]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

// ── modelBox → ScrapedEvent[] ─────────────────────────────────────────────────

function parseModelBox(
  data: ModelBoxData,
  selNames: Map<string, string>,
  isLive: boolean,
): ScrapedEvent[] {
  // Event sport map
  const evSport = new Map<string, Sport>();
  for (const [evId, ev] of Object.entries(data.events)) {
    const sport = WH_SPORT_MAP[ev.sportId];
    if (sport) evSport.set(evId, sport);
  }

  // Group selections by market
  const selsByMkt = new Map<string, string[]>();
  for (const [selId, sel] of Object.entries(data.selections)) {
    const list = selsByMkt.get(sel.parent);
    if (list) list.push(selId); else selsByMkt.set(sel.parent, [selId]);
  }

  // Build eventId → "Home v Away" using H2H markets (MR = 3-way, HH = 2-way)
  const H2H_CODES = new Set(["MR", "HH"]);
  const evNames = new Map<string, string>();
  for (const [mktId, mkt] of Object.entries(data.markets)) {
    if (!H2H_CODES.has(mkt.hash[10] as string)) continue;
    const evId = mkt.parent;
    if (evNames.has(evId)) continue;
    let home = "", away = "";
    for (const selId of selsByMkt.get(mktId) ?? []) {
      const meaning = data.selections[selId]?.hash[9] as string ?? "";
      const name = selNames.get(selId) ?? "";
      if (meaning === "H" && name) home = name;
      else if (meaning === "A" && name) away = name;
    }
    if (home && away) evNames.set(evId, `${home} v ${away}`);
  }

  const results: ScrapedEvent[] = [];

  for (const [mktId, mkt] of Object.entries(data.markets)) {
    // Skip suspended markets (hash[1] = "S")
    if ((mkt.hash[1] as string) === "S") continue;

    const mktTypeCode = (mkt.hash[10] as string) ?? "";
    const marketKey = MKT_TYPE_MAP[mktTypeCode];
    if (!marketKey) continue;

    const evId = mkt.parent;
    const sport = evSport.get(evId);
    if (!sport) continue;

    const eventName = evNames.get(evId) ?? "";
    if (!eventName) continue;

    const eventKey = buildEventKey(sport, eventName, undefined);

    // Collect active selections
    type ActiveSel = { meaning: string; priceNum: number; priceDen: number; name: string };
    const active: ActiveSel[] = [];
    for (const selId of selsByMkt.get(mktId) ?? []) {
      const sel = data.selections[selId];
      if (!sel) continue;
      if ((sel.hash[1] as string) === "S") continue; // suspended
      const priceNum = sel.hash[2] as number;
      const priceDen = sel.hash[3] as number;
      if (!priceNum || !priceDen || priceDen === 0) continue;
      const meaning = (sel.hash[9] as string) ?? "";
      const name = selNames.get(selId) ?? meaning;
      active.push({ meaning, priceNum, priceDen, name });
    }

    if (active.length < 2) continue;

    const toDecimal = (s: ActiveSel) =>
      parseFloat((s.priceNum / s.priceDen + 1).toFixed(4));

    if (marketKey === "h2h" || marketKey === "double_chance" || marketKey === "btts") {
      // Normalize outcome names
      const h2hOutcomes: H2HOutcome[] = active.map(s => {
        let name = s.name;
        if (!name || name === "D") {
          name = s.meaning === "H" ? "1" : s.meaning === "D" ? "X" : "2";
        }
        return { name, odds: toDecimal(s) };
      });
      if (h2hOutcomes.length < 2) continue;
      results.push({
        bookmaker: "williamhill",
        sport,
        eventKey,
        eventName,
        isLive,
        market: marketKey,
        outcomes: h2hOutcomes,
      });

    } else if (marketKey === "asian_handicap") {
      // H = home at line, A = away at line; line extracted from button name
      const lines = new Map<string, TotalsLine>();
      for (const s of active) {
        const odds = toDecimal(s);
        const lineMatch = s.name.match(/([+-]?\d+\.?\d*)\s*$/) ??
                          s.name.match(/(\d+\.?\d*)/);
        const rawLine = lineMatch ? parseFloat(lineMatch[1]) : 0;
        const absLine = Math.abs(rawLine);
        const key = String(absLine);
        if (!lines.has(key)) lines.set(key, { line: absLine, over: 0, under: 0 });
        const tl = lines.get(key)!;
        if (rawLine <= 0) tl.over = odds; else tl.under = odds;
      }
      for (const tl of lines.values()) {
        if (!tl.over || !tl.under) continue;
        results.push({
          bookmaker: "williamhill",
          sport,
          eventKey,
          eventName,
          isLive,
          market: "asian_handicap",
          outcomes: [tl],
        });
      }

    } else if (marketKey === "handicap") {
      // European handicap: group by line suffix
      const lines = new Map<string, H2HOutcome[]>();
      for (const s of active) {
        const odds = toDecimal(s);
        const lineMatch = s.name.match(/([+-]?\d+\.?\d*)\)?$/);
        const lineKey = lineMatch ? lineMatch[1] : "0";
        if (!lines.has(lineKey)) lines.set(lineKey, []);
        lines.get(lineKey)!.push({ name: s.name, odds });
      }
      for (const outcomes of lines.values()) {
        if (outcomes.length < 2) continue;
        results.push({
          bookmaker: "williamhill",
          sport,
          eventKey,
          eventName,
          isLive,
          market: "handicap",
          outcomes,
        });
      }

    } else {
      // O/U markets: goals, corners, cards, etc.
      // meaning H = Over, A = Under; line from button name
      const lines = new Map<string, TotalsLine>();
      for (const s of active) {
        const odds = toDecimal(s);
        const numMatch = s.name.match(/(\d+\.?\d*)/);
        if (!numMatch) continue;
        const line = parseFloat(numMatch[1]);
        const key = String(line);
        if (!lines.has(key)) lines.set(key, { line, over: 0, under: 0 });
        const tl = lines.get(key)!;
        if (s.meaning === "H" || /m[aá]s\s*de|over/i.test(s.name)) tl.over = odds;
        else if (s.meaning === "A" || /menos\s*de|under/i.test(s.name)) tl.under = odds;
      }
      for (const tl of lines.values()) {
        if (!tl.over || !tl.under) continue;
        results.push({
          bookmaker: "williamhill",
          sport,
          eventKey,
          eventName,
          isLive,
          market: marketKey,
          outcomes: [tl],
        });
      }
    }
  }

  return results;
}

// ── Scraper class ──────────────────────────────────────────────────────────────

export class WilliamHillScraper extends BaseScraper {
  readonly name = "williamhill";
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL", "BASEBALL", "AMERICANFOOTBALL", "ICEHOCKEY"];

  private async scrapePage(
    pageUrl: string,
    label: string,
    isLive: boolean,
  ): Promise<ScrapedEvent[]> {
    const proxy = getProxy();
    if (!proxy) {
      this.log("Sin ROUTER_PROXY_URL — necesita proxy ES");
      return [];
    }

    try {
      this.log(`WH ${label}: fetching HTML…`);
      const html = await fetchHtml(pageUrl, proxy);

      const modelBox = extractModelBox(html, isLive);
      if (!modelBox) {
        this.warn(`WH ${label}: no modelBox found in HTML`);
        return [];
      }

      const selNames = extractSelectionNames(html);
      const events = parseModelBox(modelBox, selNames, isLive);

      // Deduplicate by eventKey + market + first-line-value
      const seen = new Set<string>();
      const deduped = events.filter(ev => {
        const line =
          Array.isArray(ev.outcomes) && ev.outcomes.length > 0 && "line" in ev.outcomes[0]
            ? String((ev.outcomes[0] as TotalsLine).line)
            : "";
        const k = `${ev.eventKey}|${ev.market}|${line}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      if (deduped.length > 0) {
        const mktCounts = deduped.reduce(
          (acc, e) => { acc[e.market] = (acc[e.market] ?? 0) + 1; return acc; },
          {} as Record<string, number>,
        );
        this.log(
          `WH ${label}: ${deduped.length} markets (${Object.entries(mktCounts)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")})`,
        );
      } else {
        this.warn(
          `WH ${label}: 0 events parsed — modelBox has ${Object.keys(modelBox.events).length} events,` +
          ` ${Object.keys(modelBox.markets).length} markets, ${Object.keys(modelBox.selections).length} selections`,
        );
      }

      return deduped;
    } catch (err) {
      this.warn(`WH ${label} failed`, err);
      return [];
    }
  }

  async scrapeLive(): Promise<ScrapedEvent[]> {
    return this.scrapePage(`${BASE_URL}/${LIVE_PATH}`, "LIVE", true);
  }

  async scrapePrematch(): Promise<ScrapedEvent[]> {
    const results = await Promise.all(
      this.sports
        .filter(sport => SPORT_PATHS[sport])
        .map(sport => this.scrapePage(`${BASE_URL}/${SPORT_PATHS[sport]!}`, sport, false)),
    );
    return results.flat();
  }
}
