/**
 * IP Rotator — SSH-based 4G IP rotation via Teltonika RUT200 + flapping control.
 *
 * Flow:
 *   1. Proxy scrapers call reportBlock() on every 403/429 response.
 *   2. When block count hits BLOCK_THRESHOLD, SSH to the router and bounce mob1s1a1.
 *   3. Wait WG_RECONNECT_WAIT_MS for the WireGuard tunnel to re-establish, then verify.
 *   4. After MAX_ROTATIONS consecutive rotations with no recovery, enter 45-min flapping pause.
 *
 * Env vars (all optional — defaults work for the current setup):
 *   ROUTER_SSH_HOST      WireGuard IP of the router  (default: 10.9.0.2)
 *   ROUTER_SSH_USER      SSH user on the router       (default: root)
 *   ROUTER_SSH_KEY       Path to private key          (default: /home/ubuntu/.ssh/id_ed25519_router)
 *   BLOCK_THRESHOLD      Consecutive blocks → rotate  (default: 5)
 *   WG_RECONNECT_WAIT_MS ms to wait after bounce      (default: 20000)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { logger } from "../logger";
import { sendAlert } from "../health/checker";

const execAsync = promisify(exec);

const ROUTER_SSH_HOST      = process.env.ROUTER_SSH_HOST      ?? "10.9.0.2";
const ROUTER_SSH_USER      = process.env.ROUTER_SSH_USER      ?? "root";
const ROUTER_SSH_KEY       = process.env.ROUTER_SSH_KEY       ?? "/home/ubuntu/.ssh/id_ed25519_router";
const BLOCK_THRESHOLD      = parseInt(process.env.BLOCK_THRESHOLD      ?? "5",     10);
const WG_RECONNECT_WAIT_MS = parseInt(process.env.WG_RECONNECT_WAIT_MS ?? "20000", 10);

const MAX_ROTATIONS = 3;
const FLAPPING_PAUSE_MS = 45 * 60 * 1000; // 45 min

let _blockCount   = 0;  // consecutive blocks (resets on success or after rotation)
let _rotationN    = 0;  // consecutive rotations without sustained success
let _pauseUntil   = 0;  // epoch ms; > Date.now() → scraper pause active
let _rotating     = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/** True during the 45-min flapping pause; proxy scrapers should skip requests. */
export function isProxyPaused(): boolean {
  return Date.now() < _pauseUntil;
}

/** Returns pause info when active, null otherwise. */
export function getPauseInfo(): { until: Date; remainingMs: number } | null {
  if (!isProxyPaused()) return null;
  return { until: new Date(_pauseUntil), remainingMs: _pauseUntil - Date.now() };
}

/** Snapshot for health file. */
export function getRotatorStats() {
  return {
    blockCount: _blockCount,
    rotationN: _rotationN,
    proxyPaused: isProxyPaused(),
    pauseUntil: _pauseUntil > 0 ? new Date(_pauseUntil).toISOString() : null,
    rotating: _rotating,
  };
}

/**
 * Pre-flight check before proxy-routed scraping cycles.
 * Returns ok=true if WireGuard tunnel is up or no router is configured.
 * Call this before each poll cycle; skip proxy scrapers if ok=false.
 */
export async function preflightCheck(): Promise<{ ok: boolean; wgStatus: "up" | "down" | "degraded" | "unconfigured"; wgLatencyMs: number | null }> {
  // No router configured → direct connection scrapers only, no tunnel to check
  if (!process.env.ROUTER_SSH_HOST && !process.env.ROUTER_PROXY_URL) {
    return { ok: true, wgStatus: "unconfigured", wgLatencyMs: null };
  }
  const result = await _checkWireguard();
  if (result.wgStatus === "down") {
    logger.warn("preflight.wg_down", { ...result });
    void sendAlert(
      "CRITICAL",
      "WireGuard <b>DOWN</b> — túnel caído antes de ciclo de scraping.\nScrapers proxy saltados hasta que el túnel se recupere.",
      "preflight_wg_down",
    );
  } else {
    logger.info("preflight.wg_ok", { ...result });
  }
  return { ok: result.wgStatus !== "down", ...result };
}

/**
 * Called by proxy-routed scrapers on every 403 / 429 response.
 * Accumulates block count; triggers SSH rotation at threshold.
 */
export async function reportBlock(bookmaker: string, httpStatus: number): Promise<void> {
  if (isProxyPaused()) return; // flapping pause — don't count, don't rotate

  _blockCount++;
  logger.warn("ip_rotator.block", {
    bookmaker,
    httpStatus,
    blockCount: _blockCount,
    threshold: BLOCK_THRESHOLD,
  });

  if (_blockCount >= BLOCK_THRESHOLD && !_rotating) {
    void _triggerRotation(bookmaker); // fire-and-forget so caller isn't blocked
  }
}

/**
 * Called by proxy-routed scrapers on any successful response.
 * Resets block count and the consecutive-rotation counter.
 */
export function reportSuccess(bookmaker: string): void {
  if (_blockCount === 0) return;
  logger.info("ip_rotator.recovered", { bookmaker, prevBlockCount: _blockCount });
  _blockCount = 0;
  _rotationN  = 0;
}

// ─── Rotation logic ───────────────────────────────────────────────────────────

async function _triggerRotation(trigger: string): Promise<void> {
  _rotating = true;
  _rotationN++;
  const rotatedAt = new Date().toISOString();

  logger.warn("ip_rotator.rotation_start", {
    trigger,
    rotationN: _rotationN,
    maxRotations: MAX_ROTATIONS,
    rotatedAt,
  });

  try {
    const sshCmd = [
      "ssh",
      "-o StrictHostKeyChecking=no",
      "-o ConnectTimeout=10",
      "-o BatchMode=yes",
      `-i ${ROUTER_SSH_KEY}`,
      `${ROUTER_SSH_USER}@${ROUTER_SSH_HOST}`,
      `"ifdown mob1s1a1; sleep 3; ifup mob1s1a1"`,
    ].join(" ");

    const { stdout, stderr } = await execAsync(sshCmd, { timeout: 40_000 });
    logger.info("ip_rotator.ssh_ok", {
      rotationN: _rotationN,
      stdout: stdout.trim().slice(0, 200) || undefined,
      stderr: stderr.trim().slice(0, 200) || undefined,
    });
  } catch (err: any) {
    const errMsg = String(err?.message ?? err).slice(0, 300);
    logger.error("ip_rotator.ssh_failed", { rotationN: _rotationN, error: errMsg });
    void sendAlert(
      "CRITICAL",
      `SSH rotation FAILED (attempt ${_rotationN}/${MAX_ROTATIONS})\n<code>${errMsg}</code>\nScrapers continúan con IP actual.`,
      `ssh_failed:${_rotationN}`,
    );
    // SSH failure — clear block count so we don't retry every poll cycle
    _blockCount = 0;
    _rotating = false;
    return;
  }

  // Wait for WireGuard to re-establish
  logger.info("ip_rotator.wg_wait", { waitMs: WG_RECONNECT_WAIT_MS });
  await new Promise<void>((r) => setTimeout(r, WG_RECONNECT_WAIT_MS));

  // Verify tunnel health
  const wg = await _checkWireguard();
  logger.info("ip_rotator.wg_status", { ...wg, rotatedAt });

  _blockCount = 0;
  _rotating   = false;

  // Flapping check: N rotations with no sustained success → 45-min pause
  if (_rotationN >= MAX_ROTATIONS) {
    _pauseUntil = Date.now() + FLAPPING_PAUSE_MS;
    _rotationN  = 0;
    logger.error("ip_rotator.flapping_pause", {
      pauseUntil: new Date(_pauseUntil).toISOString(),
      pauseMinutes: FLAPPING_PAUSE_MS / 60_000,
    });
    void sendAlert(
      "CRITICAL",
      `IP flapping: ${MAX_ROTATIONS} rotaciones consecutivas sin recuperación.\nScrapers proxy pausados 45 min hasta ${new Date(_pauseUntil).toLocaleTimeString("es-ES")}.`,
      "flapping_pause",
    );
  } else if (wg.wgStatus === "down") {
    void sendAlert(
      "WARNING",
      `WireGuard <b>DOWN</b> tras rotación SSH.\nTúnel no recuperado en ${WG_RECONNECT_WAIT_MS / 1000}s. Proxies pueden fallar.`,
      "wg_down_after_rotation",
    );
  }
}

async function _checkWireguard(): Promise<{ wgStatus: "up" | "down" | "degraded"; wgLatencyMs: number | null }> {
  try {
    const { stdout } = await execAsync("wg show wg0", { timeout: 5_000 });
    const hs = stdout.match(/latest handshake: (.+)/)?.[1]?.trim();
    if (!hs || hs === "(none)") return { wgStatus: "down", wgLatencyMs: null };
  } catch {
    return { wgStatus: "down", wgLatencyMs: null };
  }

  try {
    const t0 = Date.now();
    await execAsync(`ping -c 1 -W 3 ${ROUTER_SSH_HOST}`, { timeout: 6_000 });
    return { wgStatus: "up", wgLatencyMs: Date.now() - t0 };
  } catch {
    return { wgStatus: "degraded", wgLatencyMs: null };
  }
}
