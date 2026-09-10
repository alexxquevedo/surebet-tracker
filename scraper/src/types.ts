// ─── Raw odds structures ─────────────────────────────────────────────────────

export type Sport = "FOOTBALL" | "TENNIS" | "BASKETBALL" | "AMERICANFOOTBALL" | "ICEHOCKEY" | "BASEBALL"
  // Legacy aliases used by some scrapers (backwards compat)
  | "HOCKEY";

export interface H2HOutcome {
  name: string; // "Home" | "Draw" | "Away" | team name
  odds: number;
}

export interface TotalsLine {
  line: number; // 2.5 | 3.5 | etc.
  over: number;
  under: number;
}

// Player prop Over/Under line (e.g. "Julian Champagnie +19.5 PRA")
export interface PlayerPropLine {
  player: string; // "Julian Champagnie"
  stat:   string; // "PRA" | "PTS" | "REB" | "AST" | "3PT" | "STL" | "BLK" | etc.
  line:   number; // 19.5
  over:   number; // odds for Over
  under:  number; // odds for Under
}

// Asian Handicap line — modelled as a TotalsLine where:
//   line  = handicap offset (e.g. -0.5 = home favored by 0.5)
//   over  = odds for Home team at that handicap
//   under = odds for Away team at that handicap
// Using TotalsLine enables both same-line surebets (detectOverUnderSurebets)
// and cross-line risk-free middles (detectMiddles) with the existing calculator.
export type AsianHandicapLine = TotalsLine;

// BTTS / Double Chance / straight H2H: all use H2HOutcome[].
//   market="btts"          → outcomes [{name:"Yes",...},{name:"No",...}]
//   market="double_chance" → outcomes [{name:"1X",...},{name:"X2",...},{name:"12",...}]
//   market="h2h"           → outcomes [{name:"1",...},{name:"X",...},{name:"2",...}]
//   market="handicap"      → outcomes [{name:"Home (+0.5)",...},{name:"Away (+0.5)",...}]
//   market="asian_handicap"→ TotalsLine[] (line=handicap, over=home, under=away)

export type MarketOutcomes = H2HOutcome[] | TotalsLine[] | PlayerPropLine[];

export interface ScrapedEvent {
  bookmaker: string;
  sport: Sport;
  eventKey: string;   // normalized key for cross-book matching
  eventName: string;  // display name
  league?: string;
  startTime?: Date;
  isLive: boolean;
  // "h2h" | "totals" | "handicap" | "player_props" | "corners" | "goals" | "yellow_cards" | ...
  market: string;
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
  startTime?: Date;
  eventKey: string;
  eventName: string;
  league?: string;
  market: string;
  profitPct: number;
  legs: ArbLeg[];
}

export interface DetectedMiddle {
  type: "MIDDLE";
  sport: Sport;
  isLive: boolean;
  startTime?: Date;
  eventKey: string;
  eventName: string;
  league?: string;
  market: string;
  /** Guaranteed minimum profit even if window misses (always ≥ 0 for risk-free middles) */
  profitPct: number;
  /** Maximum profit when window hits (both legs win) */
  maxProfitPct: number;
  /** Same as profitPct; kept for DB compat */
  worstLoss: number;
  windowLow: number;
  windowHigh: number;
  /** Estimated probability the window triggers (Poisson approximation, 0–1) */
  middleProbability: number;
  legs: ArbLeg[];
}

export type DetectedArb = DetectedSurebet | DetectedMiddle;

// ─── Grouped odds for arb calculation ────────────────────────────────────────

export interface GroupedMarket {
  eventKey: string;
  eventName: string;
  league?: string;
  sport: Sport;
  isLive: boolean;
  startTime?: Date;
  market: string;  // "h2h" | "handicap" | "totals" | "player_props" | "corners" | "goals" | ...
  byBook: Map<string, MarketOutcomes>;
}
