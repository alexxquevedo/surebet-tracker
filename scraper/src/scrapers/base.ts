import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import type { ScrapedEvent, Sport } from "../types";

export abstract class BaseScraper {
  abstract readonly name: string;
  abstract readonly sports: Sport[];

  protected http: AxiosInstance;

  constructor() {
    const proxyConfig = config.proxy.enabled
      ? {
          proxy: {
            host: config.proxy.host,
            port: config.proxy.port,
            auth:
              config.proxy.username
                ? { username: config.proxy.username, password: config.proxy.password }
                : undefined,
          },
        }
      : {};

    this.http = axios.create({
      timeout: 20_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        Accept: "application/json, text/html, */*",
      },
      ...proxyConfig,
    });
  }

  /** Scrape live events for all configured sports. */
  abstract scrapeLive(): Promise<ScrapedEvent[]>;

  /** Scrape pre-match events for all configured sports. */
  abstract scrapePrematch(): Promise<ScrapedEvent[]>;

  protected log(msg: string): void {
    console.log(`[${this.name}] ${new Date().toISOString()} ${msg}`);
  }

  protected warn(msg: string, err?: unknown): void {
    const detail = err instanceof Error
      ? err.message.split("\n")[0]
      : err ? String(err).split("\n")[0] : "";
    console.warn(`[${this.name}] ⚠️  ${msg}${detail ? " " + detail : ""}`);
  }
}
