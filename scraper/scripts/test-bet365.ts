/**
 * Test de conectividad para bet365.
 *
 * Uso:
 *   npx ts-node scripts/test-bet365.ts
 *
 * Verifica:
 *   1. Si Cloudflare bloquea la conexión (sin proxy → esperado desde datacenter)
 *   2. Si hay proxy configurado y funciona
 *   3. Cuántos eventos son visibles en el DOM
 *
 * Exit codes:
 *   0 → Éxito (página cargada, eventos detectados)
 *   1 → Bloqueado por CF o error de red
 *   2 → Página cargada pero 0 eventos (selector incorrecto o mercado vacío)
 */

import { chromium } from "playwright";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../.env") });

const PROXY_URL  = process.env.BET365_PROXY_URL  ?? "";
const PROXY_USER = process.env.BET365_PROXY_USER ?? "";
const PROXY_PASS = process.env.BET365_PROXY_PASS ?? "";

const TEST_URL = "https://www.bet365.es/#/AS/B1"; // Football prematch

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  try { delete navigator.__proto__.webdriver; } catch (_) {}
  if (!window.chrome) {
    window.chrome = { runtime: { connect: () => {}, sendMessage: () => {} }, loadTimes: () => ({}), csi: () => ({}) };
  }
  Object.defineProperty(navigator, 'plugins', { get: () => [{ name: 'Chrome PDF Plugin' }, { name: 'Native Client' }] });
  Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en'] });
`;

async function test() {
  console.log("─".repeat(60));
  console.log("bet365 Connectivity Test");
  console.log("─".repeat(60));
  console.log(`URL:   ${TEST_URL}`);
  console.log(`Proxy: ${PROXY_URL || "(none — esperado bloqueo desde datacenter)"}`);
  console.log("─".repeat(60));

  const proxyOptions = PROXY_URL
    ? {
        proxy: {
          server: PROXY_URL,
          ...(PROXY_USER ? { username: PROXY_USER, password: PROXY_PASS } : {}),
        },
      }
    : {};

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
    ...proxyOptions,
  });

  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9,en;q=0.8" },
  });

  await ctx.addInitScript(STEALTH_SCRIPT);
  const page = await ctx.newPage();

  // Capturar XHR para diagnóstico
  const xhr: string[] = [];
  page.on("response", (res: any) => {
    if (res.status() === 200 && res.headers()?.["content-type"]?.includes("json")) {
      xhr.push(res.url());
    }
  });

  let exitCode = 0;
  try {
    console.log("\n[1/4] Navegando a bet365...");
    const t0 = Date.now();
    await page.goto(TEST_URL, { waitUntil: "networkidle", timeout: 60_000 }).catch(() => {});
    console.log(`      → ${Math.round((Date.now() - t0) / 1000)}s`);

    const title = await page.title().catch(() => "");
    const finalUrl = page.url();
    console.log(`\n[2/4] Respuesta:`);
    console.log(`      Title: "${title}"`);
    console.log(`      URL:   ${finalUrl}`);

    const isBlocked =
      title.toLowerCase().includes("just a moment") ||
      title.toLowerCase().includes("cloudflare") ||
      title.toLowerCase().includes("attention required") ||
      title.toLowerCase().includes("access denied");

    if (isBlocked) {
      console.log("\n❌  BLOQUEADO — Cloudflare challenge detectado");
      if (!PROXY_URL) {
        console.log("\nCausa: IP de datacenter bloqueada por Cloudflare Enterprise.");
        console.log("Solución: Añade BET365_PROXY_URL en .env con un proxy residencial.");
        console.log("  Proveedores: Webshare.io, Brightdata, Oxylabs, Smartproxy");
      } else {
        console.log(`\nCausa: El proxy ${PROXY_URL} no está pasando el challenge.`);
        console.log("Solución: Prueba otro proveedor (Brightdata o Webshare residencial suelen funcionar).");
      }
      exitCode = 1;
      return;
    }

    console.log("\n[3/4] Esperando contenido de apuestas (5s)...");
    await page.waitForTimeout(5_000);

    // Intentar varios selectores de bet365
    const selectors = [
      "[class*='ip-EventInfoLine']",
      "[class*='src-EventItem']",
      "[class*='el-EventLayout']",
      "[class*='ip-EventContainer']",
      "[class*='gl-Market']",
    ];

    let eventCount = 0;
    let foundSelector = "";
    for (const sel of selectors) {
      const count = await page.$$eval(sel, (els) => els.length).catch(() => 0);
      if (count > 0) { eventCount = count; foundSelector = sel; break; }
    }

    console.log(`\n[4/4] Eventos detectados: ${eventCount}`);
    if (foundSelector) console.log(`      Selector: ${foundSelector}`);

    if (xhr.length > 0) {
      const b365xhr = xhr.filter(u => u.includes("bet365")).slice(0, 5);
      if (b365xhr.length > 0) {
        console.log(`\n      XHR de bet365:`);
        b365xhr.forEach(u => console.log(`        ${u.replace(/https?:\/\/[^/]+/, "").slice(0, 80)}`));
      }
    }

    if (eventCount === 0) {
      console.log("\n⚠️  Página cargada pero sin eventos visibles.");
      console.log("   Puede que: (a) el mercado esté cerrado, (b) los selectores hayan cambiado.");
      exitCode = 2;
    } else {
      console.log("\n✅  ÉXITO — bet365 accesible y con eventos");
      exitCode = 0;
    }
  } catch (err) {
    console.log(`\n❌  Error: ${err}`);
    exitCode = 1;
  } finally {
    await browser.close();
    console.log("\n" + "─".repeat(60));
    process.exit(exitCode);
  }
}

test().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
