/**
 * Dead Letter Queue — saves unexpected/unparseable payloads to disk for post-mortem.
 *
 * Files saved to: logs/failed_payloads/YYYY-MM-DD_bookmaker_sport_reason_HH-MM-SS.json
 *
 * Usage:
 *   saveDLQ("codere", "FOOTBALL", "no_altenar_response", rawData)
 *   saveDLQ("williamhill", "TENNIS", "zero_captures", { url, title })
 */

import * as fs from "fs";
import * as path from "path";

const DLQ_DIR = path.join(__dirname, "../../logs/failed_payloads");
let dirReady = false;

function ensureDir(): boolean {
  if (dirReady) return true;
  try {
    fs.mkdirSync(DLQ_DIR, { recursive: true });
    dirReady = true;
    return true;
  } catch {
    return false;
  }
}

export function saveDLQ(
  bookmaker: string,
  sport: string,
  reason: string,
  payload: unknown,
): void {
  if (!ensureDir()) return;
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const safeReason = reason.slice(0, 30).replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `${date}_${bookmaker}_${sport.toLowerCase()}_${safeReason}_${time}.json`;
    fs.writeFileSync(
      path.join(DLQ_DIR, filename),
      JSON.stringify({ bookmaker, sport, reason, timestamp: now.toISOString(), payload }, null, 2),
      "utf-8",
    );
    console.warn(`[dlq] Payload saved: ${filename}`);
  } catch (err) {
    console.warn("[dlq] Write failed:", err);
  }
}

/** Save a raw HTML page for scraper debugging */
export function saveDLQHtml(bookmaker: string, sport: string, reason: string, html: string): void {
  if (!ensureDir()) return;
  try {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 19).replace(/:/g, "-");
    const safeReason = reason.slice(0, 30).replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `${date}_${bookmaker}_${sport.toLowerCase()}_${safeReason}_${time}.html`;
    fs.writeFileSync(path.join(DLQ_DIR, filename), html, "utf-8");
    console.warn(`[dlq] HTML saved: ${filename}`);
  } catch (err) {
    console.warn("[dlq] HTML write failed:", err);
  }
}
