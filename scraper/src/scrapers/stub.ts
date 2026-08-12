/**
 * Stub scraper for bookmakers not yet implemented.
 * Replace the name and implement scrapeLive/scrapePrematch for each book.
 * All 10 scrapers below will be fleshed out progressively.
 */

import { BaseScraper } from "./base";
import type { ScrapedEvent, Sport } from "../types";

class StubScraper extends BaseScraper {
  readonly name: string;
  readonly sports: Sport[] = ["FOOTBALL", "TENNIS", "BASKETBALL"];
  constructor(name: string) {
    super();
    this.name = name;
  }
  async scrapeLive(): Promise<ScrapedEvent[]> {
    this.warn("Not implemented yet");
    return [];
  }
  async scrapePrematch(): Promise<ScrapedEvent[]> {
    this.warn("Not implemented yet");
    return [];
  }
}

export class WinamaxScraper     extends StubScraper { constructor() { super("winamax"); } }
export class Bet365Scraper      extends StubScraper { constructor() { super("bet365"); } }
export class CodereScraper      extends StubScraper { constructor() { super("codere"); } }
export class SportiumScraper    extends StubScraper { constructor() { super("sportium"); } }
export class BwinScraper        extends StubScraper { constructor() { super("bwin"); } }
export class WilliamHillScraper extends StubScraper { constructor() { super("williamhill"); } }
export class BetssonScraper     extends StubScraper { constructor() { super("betsson"); } }
export class DaznBetScraper     extends StubScraper { constructor() { super("daznbet"); } }
export class PokerStarsScraper  extends StubScraper { constructor() { super("pokerstars"); } }
