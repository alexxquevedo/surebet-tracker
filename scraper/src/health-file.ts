/**
 * Health status file — writes /tmp/scanner-health.json after every poll cycle.
 *
 * Usage on VPS:
 *   cat /tmp/scanner-health.json | jq .
 *   watch -n5 'cat /tmp/scanner-health.json | jq "{uptime,cycles,proxy}"'
 *
 * Override path with: HEALTH_FILE=/var/log/scanner-health.json
 */

import * as fs from "fs";
import { healthReport } from "./health/checker";
import { getPauseInfo, getRotatorStats } from "./scrapers/ip-rotator";
import { getScraperCooldownStates } from "./scrapers/playwright-base";
import { getSpikeFilterStats } from "./spike-filter";

const HEALTH_FILE = process.env.HEALTH_FILE ?? "/tmp/scanner-health.json";
const startedAt   = Date.now();

const cycles = {
  live:     { count: 0, lastAt: null as string | null, lastEventCount: 0 },
  prematch: { count: 0, lastAt: null as string | null, lastEventCount: 0 },
};

export function recordCycle(isLive: boolean, eventCount: number): void {
  const key = isLive ? "live" : "prematch";
  cycles[key].count++;
  cycles[key].lastAt         = new Date().toISOString();
  cycles[key].lastEventCount = eventCount;
}

export function writeHealthFile(): void {
  try {
    const uptimeMs  = Date.now() - startedAt;
    const pauseInfo = getPauseInfo();

    const snapshot = {
      updatedAt:  new Date().toISOString(),
      uptime:     formatUptime(uptimeMs),
      dryRun:     process.env.DRY_RUN === "true",
      cycles,
      scrapers:   healthReport(),
      cooldowns:  getScraperCooldownStates(),
      spikeFilter: getSpikeFilterStats(),
      proxy: {
        ...getRotatorStats(),
        ...(pauseInfo ? { pauseUntil: pauseInfo.until.toISOString(), remainingMin: Math.ceil(pauseInfo.remainingMs / 60_000) } : {}),
      },
    };

    fs.writeFileSync(HEALTH_FILE, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch { /* non-fatal — never crash the scanner over a health file write */ }
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
}
