import type {
  H2HOutcome,
  TotalsLine,
  MarketOutcomes,
  GroupedMarket,
  DetectedSurebet,
  DetectedMiddle,
  DetectedArb,
  ArbLeg,
} from "../types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isH2H(outcomes: MarketOutcomes): outcomes is H2HOutcome[] {
  return outcomes.length > 0 && "odds" in outcomes[0];
}

function isTotals(outcomes: MarketOutcomes): outcomes is TotalsLine[] {
  return outcomes.length > 0 && "line" in outcomes[0];
}

/**
 * Kelly-style equal-profit stake distribution.
 * Returns stake % for each leg such that profit is equal regardless of which wins.
 */
function distributeStakes(odds: number[]): number[] {
  // For equal return: stake_i = (1/odds_i) / sum(1/odds_j)
  const impliedProbs = odds.map((o) => 1 / o);
  const total = impliedProbs.reduce((a, b) => a + b, 0);
  return impliedProbs.map((p) => parseFloat(((p / total) * 100).toFixed(2)));
}

// ─── Outcome name normalization ───────────────────────────────────────────────

/**
 * Bookmakers use different names for the same outcome:
 * - Draw: "X" (Winamax/FR), "Draw" (Betsson/EN), "Empate" (ES), "Nul" (FR), "Nula" (PT)
 * - Home/Away: "1"/"2" or team names — team names are kept as-is for readability.
 *
 * Normalizing to a canonical name lets the calculator merge the draw selection
 * even when bookmakers encode it differently, enabling cross-bookmaker arb detection.
 */
function normalizeOutcomeName(name: string): string {
  const t = name.trim();
  if (/^x$/i.test(t) || /^empate$/i.test(t) || /^nul[ae]?$/i.test(t) || /^draw$/i.test(t)) {
    return "Draw";
  }
  return t;
}

// ─── Surebet detection (h2h) ─────────────────────────────────────────────────

/**
 * For each outcome name (Home, Draw, Away), finds the best odds across all bookmakers.
 * If sum of implied probs < 1 → surebet exists.
 */
export function detectSurebet(market: GroupedMarket): DetectedSurebet | null {
  if (market.market !== "h2h") return null;

  // Collect all unique selection names across all bookmakers (normalized)
  const allNames = new Set<string>();
  for (const outcomes of market.byBook.values()) {
    if (isH2H(outcomes)) outcomes.forEach((o) => allNames.add(normalizeOutcomeName(o.name)));
  }

  // For each selection, find best odds + which bookmaker offers them
  const bestPerSelection: Array<{
    name: string;
    odds: number;
    bookmaker: string;
  }> = [];

  for (const name of allNames) {
    let bestOdds = 0;
    let bestBook = "";
    for (const [book, outcomes] of market.byBook) {
      if (!isH2H(outcomes)) continue;
      const match = outcomes.find((o) => normalizeOutcomeName(o.name) === name);
      if (match && match.odds > bestOdds) {
        bestOdds = match.odds;
        bestBook = book;
      }
    }
    if (bestOdds > 0) bestPerSelection.push({ name, odds: bestOdds, bookmaker: bestBook });
  }

  if (bestPerSelection.length < 2) return null;

  const impliedSum = bestPerSelection.reduce((sum, s) => sum + 1 / s.odds, 0);
  if (impliedSum >= 1) return null; // No arb

  const profitPct = parseFloat(((1 / impliedSum - 1) * 100).toFixed(2));
  const stakes = distributeStakes(bestPerSelection.map((s) => s.odds));

  const legs: ArbLeg[] = bestPerSelection.map((s, i) => ({
    bookmaker: s.bookmaker,
    selection: s.name,
    odds: s.odds,
    stake: stakes[i],
  }));

  return {
    type: "SUREBET",
    sport: market.sport,
    isLive: market.isLive,
    eventName: market.eventName,
    market: "Match Result",
    profitPct,
    legs,
  };
}

// ─── Middle detection (totals) ────────────────────────────────────────────────

/**
 * Finds middles in totals markets.
 * A middle exists when:
 *   Book A offers Over X  (e.g. Over 2.5 at 1.90)
 *   Book B offers Under Y (e.g. Under 3.5 at 1.85)
 *   where Y > X  →  the "middle window" [X, Y] means BOTH bets win if result is in that range.
 *
 * Profitability: stake both at equal amounts.
 * - If result is OUTSIDE the window: one bet wins, one loses → net = odds_winner - 1 (return on 1 unit each)
 * - If result is INSIDE window: both win → profit = (odds_over - 1) + (odds_under - 1)
 */
export function detectMiddles(market: GroupedMarket): DetectedMiddle[] {
  if (market.market !== "totals") return [];

  const middles: DetectedMiddle[] = [];

  // Gather all (line, over, under, bookmaker) from all books
  const allLines: Array<{
    bookmaker: string;
    line: number;
    over: number;
    under: number;
  }> = [];

  for (const [book, outcomes] of market.byBook) {
    if (!isTotals(outcomes)) continue;
    for (const t of outcomes) {
      allLines.push({ bookmaker: book, line: t.line, over: t.over, under: t.under });
    }
  }

  // Check every pair (overLine from bookA) vs (underLine from bookB) where underLine > overLine
  for (let i = 0; i < allLines.length; i++) {
    for (let j = 0; j < allLines.length; j++) {
      if (i === j) continue;
      const overSide = allLines[i];
      const underSide = allLines[j];

      // Middle condition: we back Over X and Under Y where Y > X
      if (underSide.line <= overSide.line) continue;
      // Different bookmakers for legs (same book is fine too but less common)

      const overOdds = overSide.over;
      const underOdds = underSide.under;

      // Worst case: middle misses → one wins one loses
      // Best case: middle hits → both win
      // Calculate stakes for equal worst-case loss
      // Stake s1 on Over at odds o1, stake s2 on Under at odds o2 (total = 1 unit)
      // s1 + s2 = 1
      // Worst case: min(s1*o1 - s2, s2*o2 - s1) (one leg loses, one wins)
      // For equal worst-case return: s1*o1 - s2 = s2*o2 - s1
      // s1*(o1+1) = s2*(o2+1)  → s1/s2 = (o2+1)/(o1+1)
      const ratio = (underOdds + 1) / (overOdds + 1);
      const s1 = ratio / (1 + ratio); // stake on Over
      const s2 = 1 - s1;              // stake on Under

      // Worst-case payout (miss scenario): back one side wins, front loses
      const missReturn = Math.min(s1 * overOdds - s2, s2 * underOdds - s1);
      // If both miss (impossible in totals with 2 lines, can't both win)
      // Middle hit return
      const hitReturn = s1 * overOdds + s2 * underOdds - 1;

      const worstLoss = parseFloat((Math.min(0, missReturn) * 100).toFixed(2));
      const profitPct = parseFloat((hitReturn * 100).toFixed(2));

      // Only report if there's meaningful upside (middle profit > 5%)
      if (profitPct < 5) continue;

      const legs: ArbLeg[] = [
        {
          bookmaker: overSide.bookmaker,
          selection: `Over ${overSide.line}`,
          odds: overOdds,
          stake: parseFloat((s1 * 100).toFixed(2)),
        },
        {
          bookmaker: underSide.bookmaker,
          selection: `Under ${underSide.line}`,
          odds: underOdds,
          stake: parseFloat((s2 * 100).toFixed(2)),
        },
      ];

      middles.push({
        type: "MIDDLE",
        sport: market.sport,
        isLive: market.isLive,
        eventName: market.eventName,
        market: `Totals ${overSide.line}/${underSide.line}`,
        profitPct,
        worstLoss,
        windowLow: overSide.line,
        windowHigh: underSide.line,
        legs,
      });
    }
  }

  return middles;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function findArbs(markets: GroupedMarket[], minProfitPct: number): DetectedArb[] {
  const arbs: DetectedArb[] = [];

  for (const market of markets) {
    if (market.market === "h2h") {
      const arb = detectSurebet(market);
      if (arb && arb.profitPct >= minProfitPct) arbs.push(arb);
    } else if (market.market === "totals") {
      const middles = detectMiddles(market);
      arbs.push(...middles.filter((m) => m.profitPct >= minProfitPct));
    }
  }

  return arbs;
}
