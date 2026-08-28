// Event name normalization for cross-bookmaker matching.
// Goal: "Real Madrid vs FC Barcelona" and "R.Madrid - Barça" → same key.

const TEAM_SUFFIXES = /\b(fc|cf|sd|ud|cd|rc|rcd|ca|at|ac|as|sc|bk|fk|sk|nk|if|gd|ok|afc|cfc|utd|united|city|town|rovers|wanderers|athletic|atletico|real|hb|hbc|hf|sv|vfl|vfb|bsc|tsg|rb|rsc|rsca|osc|bayer|borussia|tsv|vfr|spvgg|ssv|ksv|dsv|fsv|hsv|msv|wsv|rsv)\b\.?/gi;
// City qualifiers that some books append but others omit (e.g. "Juventus Turin" vs "Juventus")
const CITY_QUALIFIERS = /\b(bergame|genes|turin|leeuwarden|goteborg|göteborg|lubeck|dusseldorf|frankfurt)\b/gi;
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

// Language variants for city names used by different books
// "bruges" (French) = "brugge" (Dutch/Spanish); "liege" = "luik"; etc.
const CITY_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bbruges\b/gi, "brugge"],
  [/\bliege\b/gi, "luik"],
  [/\bgeneve\b/gi, "geneva"],
  [/\bgenf\b/gi, "geneva"],
  [/\bmunich\b/gi, "munchen"],
  [/\bmarseille\b/gi, "marseille"],
  [/\bseville\b/gi, "sevilla"],
  [/\bvalencia\b/gi, "valencia"],
  [/\bchi\b/gi, "chicago"],
  [/\bcin\b/gi, "cincinnati"],
  [/\bdet\b/gi, "detroit"],
  [/\bwsh\b/gi, "washington"],
  [/\bmia\b/gi, "miami"],
  [/\bhou\b/gi, "houston"],
  [/\bstl\b/gi, "st louis"],
  [/\batl\b/gi, "atlanta"],
  [/\bphi\b/gi, "philadelphia"],
  [/\bari\b/gi, "arizona"],
  [/\bcol\b/gi, "colorado"],
  [/\bmil\b/gi, "milwaukee"],
  [/\bmin\b/gi, "minnesota"],
  [/\bcle\b/gi, "cleveland"],
  [/\bkc\b/gi, "kansas city"],
  [/\bsea\b/gi, "seattle"],
  [/\btex\b/gi, "texas"],
  [/\btor\b/gi, "toronto"],
  [/\bbal\b/gi, "baltimore"],
  [/\bpit\b/gi, "pittsburgh"],
  [/\boak\b/gi, "oakland"],
  [/\btbr\b/gi, "tampa bay"],
  [/\bsf\b/gi, "san francisco"],
  [/\bsd\b/gi, "san diego"],
  [/\bny\b/gi, "new york"],
  [/\bla\b/gi, "los angeles"],
  [/\bsoudan du sud\b/gi, "south sudan"],
  [/\bsudan del sur\b/gi, "south sudan"],
  [/\bafrique du sud\b/gi, "south africa"],
  [/\bcoree du sud\b/gi, "south korea"],
  [/\bcorea del sur\b/gi, "south korea"],
  [/\bcoree du nord\b/gi, "north korea"],
  [/\bcorea del norte\b/gi, "north korea"],
  [/\bpays bas\b/gi, "netherlands"],
  [/\bpaises bajos\b/gi, "netherlands"],
  [/\barabie saoudite\b/gi, "saudi arabia"],
  [/\barabia saudi\b/gi, "saudi arabia"],
  [/\betats unis\b/gi, "united states"],
  [/\bestados unidos\b/gi, "united states"],
  [/\bnouvelle zelande\b/gi, "new zealand"],
  [/\bnueva zelanda\b/gi, "new zealand"],
  [/\brepublique dominicaine\b/gi, "dominican republic"],
  [/\brepublica dominicana\b/gi, "dominican republic"],
  [/\bjordanie\b/gi, "jordan"],
  [/\bjordania\b/gi, "jordan"],
  [/\bfilipinas\b/gi, "philippines"],
  [/\baustralie\b/gi, "australia"],
  [/\bitalie\b/gi, "italy"],
  [/\bitalia\b/gi, "italy"],
  [/\bespagne\b/gi, "spain"],
  [/\bespana\b/gi, "spain"],
  [/\ballemagne\b/gi, "germany"],
  [/\balemania\b/gi, "germany"],
  [/\bbelgique\b/gi, "belgium"],
  [/\bbelgica\b/gi, "belgium"],
  [/\bsuisse\b/gi, "switzerland"],
  [/\bsuiza\b/gi, "switzerland"],
  [/\bautriche\b/gi, "austria"],
  [/\brussie\b/gi, "russia"],
  [/\brusia\b/gi, "russia"],
  [/\bturquie\b/gi, "turkey"],
  [/\bturquia\b/gi, "turkey"],
  [/\bgrece\b/gi, "greece"],
  [/\bgrecia\b/gi, "greece"],
  [/\bsuede\b/gi, "sweden"],
  [/\bsuecia\b/gi, "sweden"],
  [/\bdanemark\b/gi, "denmark"],
  [/\bdinamarca\b/gi, "denmark"],
  [/\bfinlande\b/gi, "finland"],
  [/\bfinlandia\b/gi, "finland"],
  [/\bnorvege\b/gi, "norway"],
  [/\bnoruega\b/gi, "norway"],
  [/\bislande\b/gi, "iceland"],
  [/\bislandia\b/gi, "iceland"],
  [/\birlande\b/gi, "ireland"],
  [/\birlanda\b/gi, "ireland"],
  [/\bpologne\b/gi, "poland"],
  [/\bpolonia\b/gi, "poland"],
  [/\bserbie\b/gi, "serbia"],
  [/\bcroatie\b/gi, "croatia"],
  [/\bcroacia\b/gi, "croatia"],
  [/\btcheque\b/gi, "czech"],
  [/\bchequia\b/gi, "czech"],
  [/\bslovaquie\b/gi, "slovakia"],
  [/\beslovaquia\b/gi, "slovakia"],
  [/\bslovenie\b/gi, "slovenia"],
  [/\beslovenia\b/gi, "slovenia"],
  [/\bbosnie\b/gi, "bosnia"],
  [/\blettonie\b/gi, "latvia"],
  [/\bletonia\b/gi, "latvia"],
  [/\blituanie\b/gi, "lithuania"],
  [/\blituania\b/gi, "lithuania"],
  [/\bestonie\b/gi, "estonia"],
  [/\bhongrie\b/gi, "hungary"],
  [/\bhungria\b/gi, "hungary"],
  [/\bucrania\b/gi, "ukraine"],
  [/\bbielorussie\b/gi, "belarus"],
  [/\bbielorrusia\b/gi, "belarus"],
  [/\bgeorgie\b/gi, "georgia"],
  [/\barmenie\b/gi, "armenia"],
  [/\bazerbaidjan\b/gi, "azerbaijan"],
  [/\bazerbaiyan\b/gi, "azerbaijan"],
  [/\bchine\b/gi, "china"],
  [/\bjapon\b/gi, "japan"],
  [/\bbresil\b/gi, "brazil"],
  [/\bbrasil\b/gi, "brazil"],
  [/\bmexique\b/gi, "mexico"],
  [/\bcolombie\b/gi, "colombia"],
  [/\bargentine\b/gi, "argentina"],
  [/\bchili\b/gi, "chile"],
  [/\bperou\b/gi, "peru"],
  [/\bequateur\b/gi, "ecuador"],
  [/\bcameroun\b/gi, "cameroon"],
  [/\bcamerun\b/gi, "cameroon"],
  [/\bmaroc\b/gi, "morocco"],
  [/\bmarruecos\b/gi, "morocco"],
  [/\btunisie\b/gi, "tunisia"],
  [/\btunez\b/gi, "tunisia"],
  [/\balgerie\b/gi, "algeria"],
  [/\bargelia\b/gi, "algeria"],
  [/\begypte\b/gi, "egypt"],
  [/\begipto\b/gi, "egypt"],
  [/\birak\b/gi, "iraq"],
  [/\bliban\b/gi, "lebanon"],
  [/\blibano\b/gi, "lebanon"],
  [/\binde\b/gi, "india"],
  [/\bmongolie\b/gi, "mongolia"],
  [/\bindonesie\b/gi, "indonesia"],
  [/\bindonesia\b/gi, "indonesia"],
  [/\bchypre\b/gi, "cyprus"],
  [/\bchipre\b/gi, "cyprus"],
  // National team name translations: FR -> EN (Winamax uses French)
  [/\bpays de galles\b/gi, "wales"],          // FR: Pays de Galles -> wales
  [/\bgales\b/gi, "wales"],                   // ES: Gales -> wales
  [/\birlandie du nord\b/gi, "northern ireland"], // FR variant
  [/\birland(e|a) du nord\b/gi, "northern ireland"], // FR: Irlande du Nord -> northern ireland
  // Post-transform (after irlanda/irlande->ireland generic rule runs first):
  [/\bireland del norte\b/gi, "northern ireland"],  // ES post-transform
  [/\bireland du nord\b/gi, "northern ireland"],    // FR post-transform
  [/\brepublica de ireland\b/gi, "ireland"],        // ES post-transform
  [/\birlanda del norte\b/gi, "northern ireland"], // ES: Irlanda del Norte -> northern ireland
  [/\brepublica de irlanda\b/gi, "ireland"],  // ES: Republica de Irlanda -> ireland
  [/\brepublic of ireland\b/gi, "ireland"],   // EN long form -> ireland
  [/\bpays[ -]bas\b/gi, "netherlands"],        // FR: Pays-Bas -> netherlands
  [/\bpaises bajos\b/gi, "netherlands"],       // ES: Paises Bajos -> netherlands
  [/\bhamburgo\b/gi, "hamburg"],              // ES: Hamburgo -> hamburg
  // German club name fixes: Koln (stripped Koeln) -> cologne
  [/\bkoln\b/gi, "cologne"],                  // DE stripped: koln -> cologne
  // Bundesliga numbered club names -> canonical short name
  [/\b1899\s*hoffenheim\b/gi, "hoffenheim"], // TSG 1899 Hoffenheim -> hoffenheim
  [/\bpaderborn\s*07\b/gi, "paderborn"],     // SC Paderborn 07 -> paderborn
  [/\bschalke\s*04\b/gi, "schalke"],         // FC Schalke 04 -> schalke
  [/\b1[\s.]+(fsv[\s.]+)?mainz\s*05\b/gi, "mainz"], // 1. FSV Mainz 05 / 1. Mainz 05 -> mainz
  [/\b1[\s.]+(fc[\s.]+)?(koln|cologne|köln)\b/gi, "cologne"], // 1. FC Koln/Cologne -> cologne
  [/\bsv\s+elversberg\b/gi, "elversberg"],   // SV Elversberg (SV prefix already stripped by TEAM_SUFFIXES)
  // German/French city name variants for Bundesliga clubs
  [/\bbreme\b/gi, "bremen"],           // FR: Werder Brême → bremen
  [/\bhambourg\b/gi, "hamburg"],       // FR: Hambourg → hamburg
  [/\bhamburguer\b/gi, "hamburger"],   // ES: Hamburguer → hamburger
  [/\bmayence\b/gi, "mainz"],          // FR: Mayence (Mainz) → mainz
  [/\bbremen\b/gi, "bremen"],          // canonical (no-op but ensures)
  [/\bmonchengladbach\b/gi, "gladbach"], // DE: Mönchengladbach → gladbach
  [/\bm gladbach\b/gi, "gladbach"],    // short form → gladbach
  [/\bm'gladbach\b/gi, "gladbach"],    // abbreviated → gladbach
  [/\bleverkusen\b/gi, "leverkusen"],  // canonical (no-op)
  [/\bfribourg\b/gi, "freiburg"],      // FR: Fribourg → freiburg (SC Freiburg)
  [/\baugsbourg\b/gi, "augsburg"],     // FR: Augsbourg → augsburg
  [/\bcolognia\b/gi, "cologne"],       // ES variant
  [/\bcolonia\b/gi, "cologne"],        // ES: Colonia → cologne (1. FC Köln)
  // French Ligue 1 naming
  [/\bparis saint germain\b/gi, "psg"],  // long form → psg
  [/\bparis saint-germain\b/gi, "psg"], // hyphenated → psg
  [/\bparis sg\b/gi, "psg"],            // short form → psg
  [/\bpsg\b/gi, "psg"],                 // already psg (no-op)
  // Italian Serie A: Côme (FR) → Como
  [/\bcome\b/gi, "como"],              // FR: Côme → como
  // Italian/French club names: Spanish (Codere) vs French (Winamax) variants
  [/\bnapoles\b/gi, "naples"],
  [/\bbolonia\b/gi, "bologna"],
  [/\bbologne\b/gi, "bologna"],
  [/\bmarsella\b/gi, "marseille"],
  [/\bvenise\b/gi, "venezia"],
  [/\blazio rome\b/gi, "lazio"],
  [/\brome\b/gi, "roma"],
  [/\bgenes\b/gi, "genoa"],
];

function normalizeTeam(name: string): string {
  let s = stripDiacritics(name).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' '); // strip annotations in parentheses (e.g. pitcher names)
  // Normalize language city variants
  for (const [re, replacement] of CITY_NORMALIZATIONS) {
    s = s.replace(re, replacement);
  }
  return s
    .replace(CITY_QUALIFIERS, " ")
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
