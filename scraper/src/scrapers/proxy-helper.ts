/**
 * createProxiedAxios — factory que crea un AxiosInstance con soporte HTTP y SOCKS5.
 *
 * Axios nativo solo soporta proxies HTTP. Para SOCKS5 (microsocks, microsocks-relay)
 * usamos SocksProxyAgent. El esquema de la URL determina el tipo:
 *   http://  | https:// → proxy HTTP nativo de axios
 *   socks5:// | socks4:// → SocksProxyAgent
 */

import axios, { AxiosInstance, AxiosRequestConfig } from "axios";
// socks-proxy-agent uses ESM exports which are not resolvable under module:commonjs without node16.
// We load it via require() at runtime and type it manually to keep the rest strict.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SocksProxyAgent } = require("socks-proxy-agent") as { SocksProxyAgent: new (uri: string) => object };
import { randomUA, jitterDelay } from "./ua-pool";
import { reportBlock, reportSuccess } from "./ip-rotator";
import { logger } from "../logger";

export function createProxiedAxios(
  proxyUrl: string,
  timeout = 25_000,
  headers: Record<string, string> = {},
  scraperName = "proxy",
): AxiosInstance {
  const base: AxiosRequestConfig = {
    timeout,
    headers: {
      "User-Agent": randomUA(),
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      Accept: "application/json, */*",
      ...headers,
    },
  };

  let instance: AxiosInstance;
  try {
    const u = new URL(proxyUrl);

    if (u.protocol === "socks5:" || u.protocol === "socks4:" || u.protocol === "socks5h:") {
      const agent = new SocksProxyAgent(proxyUrl);
      instance = axios.create({ ...base, httpAgent: agent, httpsAgent: agent });
    } else {
      // HTTP / HTTPS proxy — axios native support
      const port = parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10);
      instance = axios.create({
        ...base,
        proxy: {
          host: u.hostname,
          port,
          ...(u.username
            ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } }
            : {}),
        },
      });
    }
  } catch {
    // Malformed URL — fall back to direct connection
    instance = axios.create(base);
  }

  // Rotate UA per request + gaussian jitter (all proxy-routed requests)
  instance.interceptors.request.use(async (cfg) => {
    cfg.headers["User-Agent"] = randomUA();
    await jitterDelay();
    return cfg;
  });

  // Feed 403/429 into IP rotator; report success to reset block counter
  instance.interceptors.response.use(
    (res) => {
      reportSuccess(scraperName);
      return res;
    },
    (err) => {
      const status: number = err?.response?.status ?? 0;
      if (status === 403 || status === 429) {
        logger.warn("scraper.blocked", { bookmaker: scraperName, httpStatus: status });
        void reportBlock(scraperName, status);
      }
      throw err;
    },
  );

  return instance;
}
