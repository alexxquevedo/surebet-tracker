/**
 * Spike filter — debounce for anomalous odds before arb detection.
 *
 * When a bookmaker's H2H odds jump by more than SPIKE_THRESHOLD_PCT in a single
 * poll cycle (e.g. 1.80 → 11.00), the event is held back and not saved to DB.
 * If the same odds are still present SPIKE_CONFIRM_CYCLES later, they're treated
 * as a real market move and passed through. If they've corrected, they're dropped
 * and logged as "spike.ignored".
 *
 * Config (via .env):
 *   SPIKE_THRESHOLD_PCT    % jump in any leg to flag as spike  (default: 50)
 *   SPIKE_CONFIRM_CYCLES   poll cycles before a spike is real  (default: 1)
 *
 * Non-H2H markets (totals, player props) are passed through unchanged — their
 * structure doesn't suit simple percentage comparison.
 */

import type { ScrapedEvent, H2HOutcome, MarketOutcomes } from "./types";
import { logger } from "./logger";

const SPIKE_THRESHOLD_PCT  = parseFloat(process.env.SPIKE_THRESHOLD_PCT  ?? "50");
const SPIKE_CONFIRM_CYCLES = parseInt  (process.env.SPIKE_CONFIRM_CYCLES ?? "1", 10);

interface Pending {
  event: ScrapedEvent;
  baseline: Record<string, number>;
  confirmedCycles: number;
}

// Key: `${bookmaker}:${eventKey}:${market}`
const lastAccepted = new Map<string, Record<string, number>>();
const pending      = new Map<string, Pending>();

function marketKey(e: ScrapedEvent): string {
  return `${e.bookmaker}:${e.eventKey}:${e.market}`;
}

function toH2HMap(outcomes: MarketOutcomes): Record<string, number> | null {
  if (!Array.isArray(outcomes) || outcomes.length === 0) return null;
  const first = (outcomes as unknown[])[0] as Record<string, unknown>;
  if (typeof first["name"] !== "string" || typeof first["odds"] !== "number") return null;
  const map: Record<string, number> = {};
  for (const o of outcomes as H2HOutcome[]) map[o.name] = o.odds;
  return map;
}

/** Returns the max % increase of any leg compared to baseline. */
function maxUpChangePct(current: Record<string, number>, baseline: Record<string, number>): number {
  let max = 0;
  for (const [name, cur] of Object.entries(current)) {
    const base = baseline[name];
    if (base == null || base === 0) continue;
    const pct = ((cur - base) / base) * 100;
    if (pct > max) max = pct;
  }
  return max;
}

/**
 * Filter scraped events before saving to DB and running arb detection.
 * Returns only events whose odds are clean or confirmed after spike detection.
 * Side-effects: updates lastAccepted and pending maps in-place.
 */
export function filterSpikes(events: ScrapedEvent[]): ScrapedEvent[] {
  const accepted: ScrapedEvent[] = [];
  const seenKeys = new Set<string>();

  for (const e of events) {
    const k = marketKey(e);
    seenKeys.add(k);

    const h2h = toH2HMap(e.outcomes);

    if (h2h === null) {
      // Non-H2H (totals, player props) — pass through, no spike logic
      accepted.push(e);
      continue;
    }

    const baseline = lastAccepted.get(k);

    if (!baseline) {
      // First sighting of this market — accept immediately (no baseline to compare)
      lastAccepted.set(k, h2h);
      accepted.push(e);
      continue;
    }

    const changePct = maxUpChangePct(h2h, baseline);

    if (changePct <= SPIKE_THRESHOLD_PCT) {
      // Normal movement — accept and update baseline
      if (pending.has(k)) {
        // Spike resolved on its own before confirmation
        const p = pending.get(k)!;
        logger.info("spike.ignored", {
          bookmaker: e.bookmaker,
          eventKey: e.eventKey,
          market: e.market,
          spiked: toH2HMap(p.event.outcomes),
          resolvedTo: h2h,
          confirmedCycles: p.confirmedCycles,
        });
        pending.delete(k);
      }
      lastAccepted.set(k, h2h);
      accepted.push(e);
      continue;
    }

    // ── Spike detected ───────────────────────────────────────────────────────
    const prev = pending.get(k);
    const confirmedCycles = (prev?.confirmedCycles ?? 0) + 1;

    if (confirmedCycles >= SPIKE_CONFIRM_CYCLES) {
      // Persisted long enough — treat as a real market move
      logger.info("spike.confirmed", {
        bookmaker: e.bookmaker,
        eventKey: e.eventKey,
        market: e.market,
        changePct: Math.round(changePct),
        confirmedCycles,
        baseline,
        accepted: h2h,
      });
      lastAccepted.set(k, h2h);
      pending.delete(k);
      accepted.push(e);
    } else {
      // Hold back — wait for next cycle to confirm
      logger.warn("spike.pending", {
        bookmaker: e.bookmaker,
        eventKey: e.eventKey,
        market: e.market,
        changePct: Math.round(changePct),
        threshold: SPIKE_THRESHOLD_PCT,
        confirmAfter: SPIKE_CONFIRM_CYCLES,
        confirmedCycles,
        baseline,
        spiked: h2h,
      });
      pending.set(k, { event: e, baseline, confirmedCycles });
      // NOT pushed to accepted — skipped this cycle
    }
  }

  // Clean up pending entries for markets the scraper no longer returns
  // (event ended or disappeared — spike is moot)
  for (const [k, p] of pending) {
    if (!seenKeys.has(k)) {
      logger.info("spike.market_gone", {
        bookmaker: p.event.bookmaker,
        eventKey: p.event.eventKey,
        market: p.event.market,
        confirmedCycles: p.confirmedCycles,
      });
      pending.delete(k);
    }
  }

  return accepted;
}

/** Stats snapshot for health file or logging. */
export function getSpikeFilterStats(): { pendingCount: number; trackedMarkets: number } {
  return { pendingCount: pending.size, trackedMarkets: lastAccepted.size };
}
