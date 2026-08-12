// ─── Raw odds structures ─────────────────────────────────────────────────────

export type Sport = "FOOTBALL" | "TENNIS" | "BASKETBALL";

export interface H2HOutcome {
  name: string; // "Home" | "Draw" | "Away" | team name
  odds: number;
}

export interface TotalsLine {
  line: number; // 2.5 | 3.5 | etc.
  over: number;
  under: number;
}

export type MarketOutcomes = H2HOutcome[] | TotalsLine[];

export interface ScrapedEvent {
  bookmaker: string;
  sport: Sport;
  eventKey: string;   // normalized key for cross-book matching
  eventName: string;  // display name
  league?: string;
  startTime?: Date;
  isLive: boolean;
  market: "h2h" | "totals" | "handicap";
  outcomes: MarketOutcomes;
}

// ─── Arb detection results ────────────────────────────────────────────────────

export interface ArbLeg {
  bookmaker: string;
  selection: string;
  odds: number;
  stake: number;  // % of total stake to put here for equal-profit distribution
  url?: string;
}

export interface DetectedSurebet {
  type: "SUREBET";
  sport: Sport;
  isLive: boolean;
  eventName: string;
  market: string;
  profitPct: number;
  legs: ArbLeg[];
}

export interface DetectedMiddle {
  type: "MIDDLE";
  sport: Sport;
  isLive: boolean;
  eventName: string;
  market: string;
  profitPct: number;    // profit if total falls in middle window
  worstLoss: number;    // loss % if middle misses
  windowLow: number;    // total goals/points lower bound
  windowHigh: number;   // total goals/points upper bound
  legs: ArbLeg[];
}

export type DetectedArb = DetectedSurebet | DetectedMiddle;

// ─── Grouped odds for arb calculation ────────────────────────────────────────

export interface GroupedMarket {
  eventKey: string;
  eventName: string;
  sport: Sport;
  isLive: boolean;
  market: "h2h" | "totals";
  // bookmaker → outcomes
  byBook: Map<string, MarketOutcomes>;
}
