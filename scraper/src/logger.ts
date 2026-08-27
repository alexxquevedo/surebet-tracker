export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogFields {
  bookmaker?: string;
  httpStatus?: number;
  rotationN?: number;
  wgStatus?: "up" | "down" | "degraded";
  wgLatencyMs?: number | null;
  rotatedAt?: string;
  pauseUntil?: string;
  jitterMs?: number;
  [key: string]: unknown;
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n");
}

export const logger = {
  info:  (event: string, fields?: LogFields) => log("info",  event, fields),
  warn:  (event: string, fields?: LogFields) => log("warn",  event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
};
