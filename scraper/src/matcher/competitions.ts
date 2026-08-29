/**
 * Competition tier classification.
 * Tier 1 = major leagues/tournaments worth flagging.
 * Tier 2 = everything else (still processed, not starred).
 */

export type CompetitionTier = 1 | 2;

function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// Keyword lists per sport — matched against stripped+lowercased league name.
// Multiple languages: EN / FR (Winamax) / ES (Codere).
const TIER1: Record<string, string[]> = {
  FOOTBALL: [
    "champions league", "ligue des champions", "liga de campeones", "ucl",
    "la liga", "laliga", "primera division",
    "bundesliga",
    "premier league",
    "serie a",
    "ligue 1", "ligue1",
    "primeira liga", "liga nos", "liga portugal",
    "europa league", "ligue europa", "liga europa",
    "league one",                             // EN third division (user-specified)
    "copa libertadores", "libertadores",
    "copa sudamericana", "sudamericana",
    "eredivisie",
    "jupiler", "pro league",
  ],
  BASKETBALL: [
    "nba",
    "wnba",
    "euroleague", "euroligue", "euroliga", "turkish airlines euroleague",
    "liga acb", "acb", "liga endesa",
    "bsl super", "turkiye sigorta", "turkish basketball",  // Superliga Turca
    "lega basket", "serie a basket",                       // Lega Basket Serie A
    "basketball champions league", "bcl",
    "fiba",
  ],
  TENNIS: [
    "australian open", "open d'australie", "open australie",
    "roland garros", "french open", "open de france",
    "wimbledon",
    "us open", "open americain", "abierto americano",
    "masters 1000", "atp masters", "wta masters",
    "davis cup", "copa davis", "coupe davis",
    "billie jean king", "fed cup",
    "atp 500", "wta 500",
    "atp 250", "wta 250",
  ],
  BASEBALL: [
    "mlb", "major league baseball", "ligue majeure",
    "nippon professional", "npb", "pacific league", "central league",
    "kbo",
    "liga mexicana", "lmb", "lmp",
    "caribbean series", "serie del caribe",
    "world baseball classic", "wbc",
  ],
  VOLLEYBALL: [
    "superlega",
    "plusliga", "plus liga",
    "sultanlar", "efeler ligi",
    "v.league", "sv.league", "v league", "v-league",
    "cev champions", "champions league",             // CEV CL volleyball
    "superliga brasileira", "superliga brasil",
    "vnl", "nations league",                         // Volleyball Nations League
  ],
  AMERICANFOOTBALL: [
    "nfl", "national football league",
    "super bowl",
    "ncaa", "college football",
    "cfl", "canadian football league",
  ],
  RUGBY: [
    "rugby world cup", "coupe du monde de rugby", "copa del mundo de rugby", "rwc",
    "six nations", "six nations", "cinq nations",
    "the rugby championship", "rugby championship",
    "top 14", "top14",
    "gallagher", "premiership rugby",
    "urc", "united rugby championship", "pro14", "pro12",
    "champions cup", "heineken champions",
    "super rugby",
  ],
  RUGBYLEAGUE: [
    "rugby league world cup",
    "super league",
    "nrl", "national rugby league",
    "state of origin",
  ],
  ICEHOCKEY: [
    "nhl", "national hockey league",
    "khl", "kontinental hockey",
    "shl", "swedish hockey",
    "liiga", "sm-liiga",
    "national league",                               // NL Switzerland
    "del", "deutsche eishockey",
    "iihf", "world championship",
  ],
  HANDBALL: [
    "ehf champions", "champions league handball",
    "bundesliga handball",
    "starligue", "lnh",
    "asobal", "liga asobal",
    "seha",
  ],
};

/** Returns 1 for Tier-1 (major) competitions, 2 for all others. */
export function classifyCompetition(league: string, sport: string): CompetitionTier {
  if (!league) return 2;
  const n = stripDiacritics(league);
  const keywords = TIER1[sport] ?? [];
  for (const kw of keywords) {
    if (n.includes(kw)) return 1;
  }
  return 2;
}
