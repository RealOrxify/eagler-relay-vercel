import { parseTarget, type Target } from "./protocol.ts";

export type RelayConfig = {
  publicAccess: boolean;
  /** Server that /minecraft connects to when no ?target= is given (RELAY_DEFAULT_SERVER). */
  defaultServer: Target | undefined;
  secret: string | undefined;
  allowPrivate: boolean;
  allowedOrigins: string[];
  maxBytesPerMinute: number;
  maxLanBytesPerMinute: number;
  /** Hard cap on any single WebSocket. On Vercel this sits just under the function's maxDuration. */
  maxLifetimeMs: number;
  maxLanPeers: number;
  iceServers: string[];
  clientPath: string;
  trace: boolean;
  /** Password for the /admin status page. Page is disabled when unset. */
  adminPassword: string | undefined;
};

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Record<string, string | undefined> = process.env, overrides: Partial<RelayConfig> = {}): RelayConfig {
  const onVercel = Boolean(env.VERCEL);
  // Keep in sync with "maxDuration" in vercel.json. Close cleanly ~5s before Vercel kills the socket.
  const vercelMaxDuration = num(env.RELAY_VERCEL_MAX_DURATION, 300);
  const defaultLifetime = onVercel ? Math.max(10, vercelMaxDuration - 5) * 1000 : 6 * 60 * 60 * 1000;

  const cfg: RelayConfig = {
    // Public by default, like the shipped wrangler.toml. Set RELAY_PUBLIC=0 + RELAY_SECRET for private.
    publicAccess: env.RELAY_PUBLIC !== "0",
    defaultServer: env.RELAY_DEFAULT_SERVER?.trim() ? parseTarget(env.RELAY_DEFAULT_SERVER) : undefined,
    secret: env.RELAY_SECRET,
    allowPrivate: env.RELAY_ALLOW_PRIVATE === "1",
    allowedOrigins: String(env.RELAY_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxBytesPerMinute: num(env.RELAY_MAX_BYTES_PER_MINUTE, 64 * 1024 * 1024),
    maxLanBytesPerMinute: num(env.RELAY_MAX_LAN_BYTES_PER_MINUTE, 512 * 1024 * 1024),
    maxLifetimeMs: num(env.RELAY_MAX_LIFETIME_MS, 0) > 0 ? num(env.RELAY_MAX_LIFETIME_MS, 0) : defaultLifetime,
    maxLanPeers: num(env.RELAY_MAX_LAN_PEERS, 8),
    iceServers: String(env.RELAY_ICE_SERVERS ?? "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478")
      .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 16),
    clientPath: env.RELAY_CLIENT_HTML ?? "public/play/index.html",
    trace: env.RELAY_TRACE === "1",
    adminPassword: env.RELAY_ADMIN_PASSWORD || undefined,
    ...overrides,
  };
  if (!cfg.publicAccess && (!cfg.secret || cfg.secret.length < 16)) {
    throw new Error("RELAY_SECRET must be at least 16 characters when RELAY_PUBLIC=0");
  }
  return cfg;
}
