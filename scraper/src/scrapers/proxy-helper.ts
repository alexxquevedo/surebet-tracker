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

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function createProxiedAxios(
  proxyUrl: string,
  timeout = 25_000,
  headers: Record<string, string> = {},
): AxiosInstance {
  const base: AxiosRequestConfig = {
    timeout,
    headers: {
      "User-Agent": DEFAULT_UA,
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      Accept: "application/json, */*",
      ...headers,
    },
  };

  try {
    const u = new URL(proxyUrl);

    if (u.protocol === "socks5:" || u.protocol === "socks4:" || u.protocol === "socks5h:") {
      const agent = new SocksProxyAgent(proxyUrl);
      return axios.create({ ...base, httpAgent: agent, httpsAgent: agent });
    }

    // HTTP / HTTPS proxy — axios native support
    const port = parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10);
    return axios.create({
      ...base,
      proxy: {
        host: u.hostname,
        port,
        ...(u.username
          ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } }
          : {}),
      },
    });
  } catch {
    // Malformed URL — fall back to direct connection with a warning already emitted by caller
    return axios.create(base);
  }
}
