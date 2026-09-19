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

  // Direct-connection fallback instance (no proxy) — used only when the SOCKS5 tunnel rejects.
  const directInstance = axios.create({ ...base });

  // Feed 403/429 into IP rotator; report success to reset block counter.
  // On SOCKS5 rejection (HostUnreachable/TTLExpired/timeout) retry once via direct connection.
  instance.interceptors.response.use(
    (res) => {
      reportSuccess(scraperName);
      return res;
    },
    async (err) => {
      const status: number = err?.response?.status ?? 0;
      if (status === 403 || status === 429) {
        logger.warn("scraper.blocked", { bookmaker: scraperName, httpStatus: status });
        void reportBlock(scraperName, status);
        throw err;
      }
      const msg: string = err?.message ?? "";
      const isSocksError =
        /socks.*reject|HostUnreachable|TTLExpired|Proxy connection timed out/i.test(msg) ||
        err?.code === "ECONNREFUSED" ||
        err?.code === "EHOSTUNREACH";
      if (isSocksError && err?.config && !err.config.__directFallback) {
        logger.warn("scraper.proxy_fallback", { bookmaker: scraperName, reason: msg.slice(0, 80) });
        const cfg = { ...err.config, __directFallback: true, httpAgent: undefined, httpsAgent: undefined, proxy: false };
        try {
          return await directInstance.request(cfg);
        } catch (directErr: any) {
          // Both SOCKS5 and direct failed — count as IP block only when it's a
          // connection error (CDN IP block, timeout), not a broken endpoint (ENOTFOUND)
          const directMsg = String(directErr?.message ?? "");
          if (!/ENOTFOUND|ENOENT|getaddrinfo/.test(directMsg)) {
            void reportBlock(scraperName, 0);
          }
          throw directErr;
        }
      }
      throw err;
    },
  );

  return instance;
}
