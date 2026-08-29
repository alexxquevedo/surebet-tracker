/**
 * Tiered competition classification for the FidesBot scraper.
 *
 * Tier 1 — high-value leagues that get ⭐ priority in notifications.
 * Tier 2 — everything else (still processed, no star tag).
 *
 * Matching is case-insensitive substring. League strings from scrapers follow
 * the pattern "<Country> - <Competition>", e.g. "Spain - La Liga".
 */

export type CompetitionTier = 1 | 2;

// SportType values match the Prisma enum in schema.prisma.
const TIER1_PATTERNS: Partial<Record<string, string[]>> = {
  FOOTBALL: [
    "champions league",
    "la liga",
    "bundesliga",
    "premier league",
    "ligue 1",
    "serie a",
    "primeira liga",
    "eredivisie",
    "jupiler",          // Belgian Pro League
    "europa league",
    "conference league",
    "copa libertadores",
    "copa sudamericana",
    "world cup",
    "euro 2024",
    "euro 2028",
    "nations league",
    "league one",       // as specified
  ],
  BASKETBALL: [
    "nba",
    "wnba",
    "euroleague",
    "euroliga",
    " acb",             // Liga ACB — leading space avoids false match "diablo/knacb"
    "superliga turca",
    "lega basket",
    "basketball champions league",
    "fiba world cup",
    "olympics",
    "olympic games",
  ],
  TENNIS: [
    "wimbledon",
    "us open",
    "french open",
    "roland garros",
    "australian open",
    "masters 1000",
    "atp 500",
    "wta 500",
    "atp 250",
    "wta 250",
    "davis cup",
    "bjk cup",
    "billie jean",
    "finals",           // ATP/WTA Finals
  ],
  BASEBALL: [
    "mlb",
    "npb",
    "kbo",
    "lmb",
    "lmp",
    "caribbean",
    "world baseball classic",
    "world series",
  ],
  VOLLEYBALL: [
    "champions league",
    "nations league",
    "world championship",
    "olympics",
    "olympic games",
    "superliga",
    "serie a1",
    "plus liga",
  ],
  AMERICANFOOTBALL: [
    "nfl",
    "super bowl",
    "playoffs",
    "ncaa",
  ],
  RUGBYLEAGUE: [
    "super league",
    "nrl",              // National Rugby League (Australia)
    "state of origin",
    "world cup",
    "challenge cup",
    "world club",
  ],
  ICEHOCKEY: [
    "nhl",
    "khl",
    "shl",
    "liiga",            // Finnish Liiga
    "ahl",
    "world championship",
    "olympics",
    "olympic games",
  ],
};

/**
 * Returns the competition tier for a given sport and league string.
 * @param sport  SportType value ("FOOTBALL", "BASKETBALL", etc.)
 * @param league League name from the scraper (e.g. "Spain - La Liga")
 */
export function getCompetitionTier(sport: string, league: string): CompetitionTier {
  const patterns = TIER1_PATTERNS[sport];
  if (!patterns || !league) return 2;
  const lower = league.toLowerCase();
  return patterns.some((p) => lower.includes(p)) ? 1 : 2;
}

/**
 * True when the sport+league combination is Tier 1.
 */
export function isTier1(sport: string, league: string): boolean {
  return getCompetitionTier(sport, league) === 1;
}
