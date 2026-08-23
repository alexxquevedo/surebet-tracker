// ─── Raw odds structures ─────────────────────────────────────────────────────

export type Sport = "FOOTBALL" | "TENNIS" | "BASKETBALL" | "AMERICANFOOTBALL" | "ICEHOCKEY" | "BASEBALL" | "RUGBYLEAGUE" | "VOLLEYBALL"
  // Legacy aliases used by some scrapers (backwards compat)
  | "HOCKEY" | "RUGBY";

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
  stat:   string; // "PRA" | "PTS" | "REB" | "AST" | "3PT"
  line:   number; // 19.5
  over:   number; // odds for Over
  under:  number; // odds for Under
}

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
  market: string;  // "h2h" | "handicap" | "totals" | "player_props" | "corners" | "goals" | ...
  byBook: Map<string, MarketOutcomes>;
}
