// Eaglercraft 26.3 relay: Hono for HTTP routing, native Bun WebSockets for the hot path.
//
//   GET /            WebSocket → classic LAN signaling relay; plain browser visit → /play
//   GET /minecraft   WebSocket → Java Edition TCP tunnel (?target=host:port[&token=])
//   GET /lan/host    WebSocket → relayed LAN room host (?token= when private)
//   GET /lan/join    WebSocket → relayed LAN room guest (?code=XXXXXX)
//   GET /health      JSON status
//   GET /admin       Password-protected live status page (who's on, LAN join codes)
import dns from "node:dns/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import adminPageText from "./admin.html" with { type: "text" };
const ADMIN_PAGE = adminPageText as unknown as string; // text import (Bun types assume an HTML bundle)
import { Hono, type Context } from "hono";
import type { Server, WebSocketHandler } from "bun";
import { createBus, randomId, type Bus } from "./bus.ts";
import { loadConfig, type RelayConfig } from "./config.ts";
import { verifyScopedToken, verifyToken } from "./auth.ts";
import { isPrivateTarget, parseTarget } from "./protocol.ts";
import { MinecraftSession } from "./minecraft.ts";
import { LegacyLanSession } from "./legacy-lan.ts";
import { LanGuestSession, LanHostSession } from "./lan-rooms.ts";
import type { Deps, Session, SessionInfo, SocketData } from "./session.ts";

// vercel.json rewrites everything into /api/server?__route=<name>. Depending on how the
// platform hands us the URL we may see the original path or the rewritten one, so
// normalise both forms back to the public path before Hono routes it.
const ROUTES: Record<string, string> = {
  root: "/", minecraft: "/minecraft", "lan-host": "/lan/host", "lan-join": "/lan/join", health: "/health", play: "/play",
  admin: "/admin", "admin-status": "/admin/status",
};

function logicalPath(req: Request): string {
  const url = new URL(req.url);
  const route = url.searchParams.get("__route");
  if (route) return ROUTES[route] ?? "/__unknown";
  const p = url.pathname;
  if (p === "/api/server" || p.startsWith("/api/server/")) return p.slice("/api/server".length) || "/";
  return p;
}

async function assertPublicDestination(host: string, allowPrivate: boolean): Promise<string> {
  if (allowPrivate) return host;
  if (isPrivateTarget(host)) throw new Error("private destinations are disabled");
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0 || addrs.some(({ address }) => isPrivateTarget(address))) {
    throw new Error("target resolves to a private destination");
  }
  // Connect to the address we just vetted so DNS can't be rebound between check and connect.
  return addrs[0]!.address;
}

type Env = { Bindings: Server<SocketData> };

/** Rough location from Vercel's geo headers. Never the IP itself. */
type Meta = { since: number; country: string | null; region: string | null; city: string | null };

function metaFrom(req: Request): Meta {
  const h = req.headers;
  let city = h.get("x-vercel-ip-city");
  try { city = city ? decodeURIComponent(city) : null; } catch {}
  return { since: Date.now(), country: h.get("x-vercel-ip-country"), region: h.get("x-vercel-ip-country-region"), city };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export type StatusEntry = SessionInfo & Meta & { id: string };
export type InstanceStatus = { inst: string; at: number; sessions: StatusEntry[] };

export type Relay = {
  fetch: (req: Request, server: Server<SocketData>) => Response | Promise<Response>;
  websocket: WebSocketHandler<SocketData>;
  config: RelayConfig;
  bus: Bus;
  sessions: Map<string, Session>;
};

export function createRelay(opts: { config?: Partial<RelayConfig>; env?: Record<string, string | undefined>; bus?: Bus } = {}): Relay {
  const cfg = loadConfig(opts.env ?? process.env, opts.config);
  const bus = opts.bus ?? createBus(opts.env ? (opts.env.REDIS_URL || opts.env.KV_URL || "") : undefined);
  const deps: Deps = { cfg, bus };
  const sessions = new Map<string, Session>();
  const metas = new Map<string, Meta>();

  const localStatus = (): InstanceStatus => {
    const out: StatusEntry[] = [];
    for (const [sid, session] of sessions) {
      const info = session.describe?.();
      const meta = metas.get(sid);
      if (info && meta) out.push({ id: sid, ...meta, ...info });
    }
    return { inst: bus.inst, at: Date.now(), sessions: out };
  };

  // Each instance publishes a snapshot every few seconds so /admin sees all of them.
  if (bus.health !== "memory") {
    const timer = setInterval(() => {
      void bus.putStatus(JSON.stringify(localStatus()), 15).catch(() => {});
    }, 4000);
    (timer as { unref?: () => void }).unref?.();
  }

  bus.onMessage((sid, msg) => sessions.get(sid)?.onBus?.(msg));

  const app = new Hono<Env>({ getPath: logicalPath });

  const reject = (c: Context<Env>, status: 400 | 401 | 403 | 404 | 426, message: string) =>
    c.text(`${message}\n`, status, { "cache-control": "no-store" });

  function upgrade(c: Context<Env>, make: (sid: string) => Session): Response {
    const sid = randomId(8);
    const session = make(sid);
    if (!c.env.upgrade(c.req.raw, { data: { sid, session } })) return reject(c, 426, "websocket upgrade failed");
    metas.set(sid, metaFrom(c.req.raw));
    return new Response(null); // ignored by Bun after a successful upgrade
  }

  const isWebSocket = (c: Context<Env>) => c.req.header("upgrade")?.toLowerCase() === "websocket";

  // Origin allow-list for every WebSocket route.
  app.use("*", async (c, next) => {
    if (isWebSocket(c) && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(c.req.header("origin") ?? "")) {
      return reject(c, 403, "origin is not allowed");
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      protocol: "minecraft-java-byte-stream-v1",
      lan: "eagler-1.8-webrtc-p2p-v1",
      capabilities: ["singleplayer", "multiplayer"],
      public: cfg.publicAccess,
      defaultServer: cfg.defaultServer !== undefined, // never the address itself
      runtime: typeof Bun !== "undefined" ? `bun-${Bun.version}` : "unknown",
      vercel: Boolean(process.env.VERCEL),
      sharedRooms: bus.shared,
      rooms: bus.health,
      sessionLimitSeconds: Math.round(cfg.maxLifetimeMs / 1000),
      client: "26.3",
    }, 200, { "cache-control": "no-store" }));

  app.get("/", (c) => {
    if (!isWebSocket(c)) return c.redirect("/play", 302);
    return upgrade(c, (sid) => new LegacyLanSession(deps, sid));
  });

  app.get("/minecraft", async (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    let target;
    let connectHost;
    // No ?target= means "this site's own server" (RELAY_DEFAULT_SERVER), so players can use
    // wss://<site>/minecraft as the address. Their handshake then names this site, not the
    // server, so the handshake port check is skipped for it.
    const usesDefault = !c.req.query("target") && cfg.defaultServer !== undefined;
    try {
      target = usesDefault ? cfg.defaultServer! : parseTarget(c.req.query("target"));
      if (!cfg.publicAccess) await verifyToken(cfg.secret, c.req.query("token"), target.canonical);
      connectHost = await assertPublicDestination(target.host, cfg.allowPrivate);
    } catch (e) {
      return reject(c, 401, (e as Error).message);
    }
    return upgrade(c, () => new MinecraftSession(deps, target, connectHost, !usesDefault));
  });

  app.get("/lan/host", async (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    if (!cfg.publicAccess) {
      try {
        await verifyScopedToken(cfg.secret, c.req.query("token"), "lan-host");
      } catch (e) {
        return reject(c, 401, (e as Error).message);
      }
    }
    return upgrade(c, (sid) => new LanHostSession(deps, sid));
  });

  app.get("/lan/join", (c) => {
    if (!isWebSocket(c)) return reject(c, 426, "websocket required");
    const code = String(c.req.query("code") ?? "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{6,10}$/.test(code)) return reject(c, 401, "LAN room is unavailable");
    return upgrade(c, (sid) => new LanGuestSession(deps, sid, code));
  });

  // ---- /admin: live status page (HTTP Basic auth, any username) ----
  const adminGate = (c: Context<Env>): Response | null => {
    if (!cfg.adminPassword) {
      return c.text("The status page is off. Set RELAY_ADMIN_PASSWORD in your Vercel environment variables, then redeploy.\n", 503, { "cache-control": "no-store" });
    }
    const header = c.req.header("authorization") ?? "";
    let given = "";
    if (header.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
        given = decoded.slice(decoded.indexOf(":") + 1);
      } catch {}
    }
    if (given && timingSafeEqual(digest(given), digest(cfg.adminPassword))) return null;
    return c.text("Password required.\n", 401, {
      "www-authenticate": 'Basic realm="Relay status", charset="UTF-8"',
      "cache-control": "no-store",
    });
  };

  app.get("/admin", (c) => adminGate(c) ?? c.html(ADMIN_PAGE, 200, {
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; connect-src 'self'",
  }));

  app.get("/admin/status", async (c) => {
    const denied = adminGate(c);
    if (denied) return denied;
    const mine = localStatus();
    let snapshots: InstanceStatus[] = [mine];
    if (bus.shared) {
      try {
        const now = Date.now();
        const others = (await bus.listStatus())
          .map((raw) => JSON.parse(raw) as InstanceStatus)
          .filter((s) => s.inst !== mine.inst && now - s.at < 15_000);
        snapshots = [mine, ...others];
      } catch {}
    }
    return c.json({
      now: Date.now(),
      shared: bus.shared,
      vercel: Boolean(process.env.VERCEL),
      instances: snapshots.length,
      sessionLimitSeconds: Math.round(cfg.maxLifetimeMs / 1000),
      sessions: snapshots.flatMap((s) => s.sessions),
    }, 200, { "cache-control": "no-store" });
  });

  // Local dev / VPS convenience. On Vercel, /play is served by the CDN from public/.
  app.get("/play", async (c) => {
    const file = Bun.file(cfg.clientPath);
    if (!(await file.exists())) return c.text("client not found; run `bun run client <path-to-html>`\n", 404);
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    console.error("[relay]", err);
    return c.json({ error: "internal error" }, 500);
  });

  const websocket: WebSocketHandler<SocketData> = {
    maxPayloadLength: 2 * 1024 * 1024,
    perMessageDeflate: false,
    idleTimeout: 960, // seconds; Bun also auto-pings so idle-but-alive sockets stay up
    sendPings: true,
    open(ws) {
      sessions.set(ws.data.sid, ws.data.session);
      ws.data.session.open(ws);
    },
    message(ws, message) {
      ws.data.session.message(ws, message);
    },
    close(ws, code, reason) {
      sessions.delete(ws.data.sid);
      metas.delete(ws.data.sid);
      ws.data.session.close(code, reason);
    },
  };

  return { fetch: (req, server) => app.fetch(req, server), websocket, config: cfg, bus, sessions };
}
