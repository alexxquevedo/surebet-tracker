/**
 * Persistent enable/disable toggle for individual scrapers.
 *
 * State stored in scanner-state.json (path overridden by SCANNER_STATE_FILE env var).
 * The Python bot reads/writes the same file via /casas admin command.
 * The scanner checks it at the start of each poll cycle (30-second cache).
 *
 * Default: all scrapers enabled when the file is absent or the scraper is not listed.
 */

import fs from "fs";
import path from "path";

const STATE_FILE =
  process.env.SCANNER_STATE_FILE ??
  path.join(process.cwd(), "scanner-state.json");

interface ScannerState {
  disabled_scrapers: string[];
  updated_at?: string;
}

let cache: { state: ScannerState; readAt: number } | null = null;
const CACHE_TTL_MS = 30_000;

function readState(): ScannerState {
  const now = Date.now();
  if (cache && now - cache.readAt < CACHE_TTL_MS) return cache.state;
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(raw) as ScannerState;
    cache = { state, readAt: now };
    return state;
  } catch {
    // File absent or corrupt → all scrapers enabled
    const state: ScannerState = { disabled_scrapers: [] };
    cache = { state, readAt: now };
    return state;
  }
}

export function isScraperEnabled(name: string): boolean {
  return !readState().disabled_scrapers.includes(name);
}

export function invalidateStateCache(): void {
  cache = null;
}
