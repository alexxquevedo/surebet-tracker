// Event name normalization for cross-bookmaker matching.
// Goal: "Real Madrid vs FC Barcelona" and "R.Madrid - Barça" → same key.

const TEAM_SUFFIXES = /\b(fc|cf|sd|ud|cd|rc|rcd|ca|at|ac|sc|bk|fk|sk|nk|if|gd|ok|afc|cfc|utd|united|city|town|rovers|wanderers|athletic|atletico|real)\b\.?/gi;
const DIACRITICS: Record<string, string> = {
  á: "a", é: "e", í: "i", ó: "o", ú: "u",
  à: "a", è: "e", ì: "i", ò: "o", ù: "u",
  â: "a", ê: "e", î: "i", ô: "o", û: "u",
  ä: "a", ë: "e", ï: "i", ö: "o", ü: "u",
  ã: "a", õ: "o", ñ: "n", ç: "c", ý: "y",
  ß: "ss",
};

function stripDiacritics(s: string): string {
  return s.replace(/[áéíóúàèìòùâêîôûäëïöüãõñçýß]/gi, (c) => DIACRITICS[c.toLowerCase()] ?? c);
}

function normalizeTeam(name: string): string {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(TEAM_SUFFIXES, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits "Team A vs Team B" or "Team A - Team B" into [teamA, teamB]
const SEPARATORS = /\s+(?:vs\.?|v\.?|-|@)\s+/i;

function splitTeams(eventName: string): string[] {
  const parts = eventName.split(SEPARATORS);
  return parts.length >= 2 ? parts.slice(0, 2) : [eventName];
}

/**
 * Returns a stable event key for matching the same match across bookmakers.
 * Format: "{sport}:{teamA_normalized}:{teamB_normalized}:{YYYY-MM-DD}"
 */
export function buildEventKey(
  sport: string,
  eventName: string,
  startTime?: Date | null,
): string {
  const teams = splitTeams(eventName).map(normalizeTeam).sort();
  const date = startTime
    ? startTime.toISOString().slice(0, 10)
    : "nodate";
  return `${sport.toLowerCase()}:${teams.join(":")}:${date}`;
}

/**
 * Returns similarity [0,1] between two normalized team strings.
 * Used as fallback when exact keys don't match but names are close.
 */
export function teamSimilarity(a: string, b: string): number {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  // Jaccard similarity on word sets
  const wa = new Set(na.split(" "));
  const wb = new Set(nb.split(" "));
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : intersection / union;
}
