// Cross-instance plumbing for LAN rooms.
//
// On Vercel, every WebSocket is pinned to whatever function instance accepted it, and a
// LAN host and its guests can easily land on different instances. When REDIS_URL (or
// KV_URL, optionally with a prefix like PLAYERS_REDIS_URL) is set, room codes live in Redis and packets between instances travel over
// Redis pub/sub using Bun's built-in client (no npm dependency). Without Redis everything
// stays in memory, which is fine for a VPS / `bun run` or a single warm Vercel instance.
import { RedisClient } from "bun";

export type Loc = { inst: string; sid: string };
export type BusMsg = { t: string; [key: string]: unknown };
type Handler = (sid: string, msg: BusMsg) => void;

export interface Bus {
  readonly inst: string;
  readonly shared: boolean;
  /** "memory", "redis", "redis (connecting)", or "memory (redis failed: …)". */
  readonly health: string;
  /** Atomically claim key → value. Returns false if it already exists. */
  claim(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  touch(key: string, ttlSeconds: number): Promise<void>;
  release(key: string): Promise<void>;
  send(to: Loc, msg: BusMsg): void;
  onMessage(handler: Handler): void;
  /** Publish this instance's status snapshot (expires if the instance dies). */
  putStatus(json: string, ttlSeconds: number): Promise<void>;
  /** Snapshots from every live instance, this one included. */
  listStatus(): Promise<string[]>;
}

const PREFIX = "eagrelay:";

export function randomId(bytes = 8): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

// Uint8Array fields survive JSON as {$b: base64}.
// (Check holder[key], not v: Buffer.toJSON runs before the replacer sees the value.)
function encode(msg: unknown): string {
  return JSON.stringify(msg, function (this: Record<string, unknown>, k, v) {
    const raw = this[k];
    return raw instanceof Uint8Array ? { $b: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("base64") } : v;
  });
}
function decode(text: string): unknown {
  return JSON.parse(text, (_k, v) =>
    v && typeof v === "object" && typeof v.$b === "string" ? new Uint8Array(Buffer.from(v.$b, "base64")) : v);
}

class LocalBus implements Bus {
  readonly inst = randomId(6);
  get shared(): boolean {
    return false;
  }
  get health(): string {
    return "memory";
  }
  protected handler: Handler = () => {};
  private kv = new Map<string, { value: string; expires: number }>();

  async claim(key: string, value: string, ttl: number) {
    const cur = this.kv.get(key);
    if (cur && cur.expires > Date.now()) return false;
    this.kv.set(key, { value, expires: Date.now() + ttl * 1000 });
    return true;
  }
  async get(key: string) {
    const cur = this.kv.get(key);
    if (!cur) return null;
    if (cur.expires <= Date.now()) {
      this.kv.delete(key);
      return null;
    }
    return cur.value;
  }
  async touch(key: string, ttl: number) {
    const cur = this.kv.get(key);
    if (cur) cur.expires = Date.now() + ttl * 1000;
  }
  async release(key: string) {
    this.kv.delete(key);
  }
  send(to: Loc, msg: BusMsg) {
    if (to.inst !== this.inst) return; // can't happen without Redis
    queueMicrotask(() => this.handler(to.sid, msg));
  }
  onMessage(handler: Handler) {
    this.handler = handler;
  }
  protected status = "";
  async putStatus(json: string, _ttl = 0) {
    this.status = json;
  }
  async listStatus() {
    return this.status ? [this.status] : [];
  }
}

// Every Redis call is time-limited. If Redis is unreachable or misconfigured, this instance
// falls back to in-memory rooms (LAN still works for people on the same instance) and
// retries Redis every 30s, instead of hanging until the game gives up with code 1006.
const CONNECT_TIMEOUT_MS = 3000;
const OP_TIMEOUT_MS = 2000;
const RETRY_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

class RedisBus extends LocalBus {
  private state: "connecting" | "ok" | "failed" = "connecting";
  private lastError = "";
  private ready!: Promise<void>;
  private pub!: RedisClient;
  private sub: RedisClient | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string) {
    super();
    this.connect();
  }

  override get shared() {
    return this.state !== "failed";
  }
  override get health() {
    return this.state === "failed" ? `memory (redis failed: ${this.lastError})` : this.state === "ok" ? "redis" : "redis (connecting)";
  }

  private connect() {
    this.retry = null;
    this.state = "connecting";
    try { this.pub?.close(); } catch {}
    try { this.sub?.close(); } catch {}
    let pub: RedisClient;
    try {
      pub = new RedisClient(this.url, { autoReconnect: true, enableOfflineQueue: false, connectionTimeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      this.ready = Promise.reject(e);
      this.ready.catch(() => {});
      this.fail(e);
      return;
    }
    this.pub = pub;
    this.ready = withTimeout((async () => {
      await pub.connect();
      const sub = await pub.duplicate();
      this.sub = sub;
      await sub.subscribe(`${PREFIX}i:${this.inst}`, (raw: string) => {
        try {
          const { sid, msg } = decode(raw) as { sid: string; msg: BusMsg };
          this.handler(sid, msg);
        } catch (e) {
          console.warn("[relay] bad bus message", e);
        }
      });
    })(), CONNECT_TIMEOUT_MS, "redis connect");
    this.ready.then(() => {
      this.state = "ok";
      this.lastError = "";
      console.log("[relay] redis connected; LAN rooms are shared across instances");
    }, (e) => this.fail(e));
  }

  private fail(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (this.state !== "failed") console.error(`[relay] redis unavailable, using in-memory rooms: ${msg}`);
    this.state = "failed";
    this.lastError = msg.slice(0, 160);
    if (!this.retry) {
      this.retry = setTimeout(() => this.connect(), RETRY_MS);
      (this.retry as { unref?: () => void }).unref?.();
    }
  }

  /** Run a Redis op with a deadline; on any failure use the in-memory fallback. */
  private async op<T>(what: string, fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.state === "failed") return fallback();
    try {
      await this.ready;
      return await withTimeout(fn(), OP_TIMEOUT_MS, `redis ${what}`);
    } catch (e) {
      this.fail(e);
      return fallback();
    }
  }

  override claim(key: string, value: string, ttl: number) {
    return this.op("claim", async () => (await this.pub.set(PREFIX + key, value, "NX", "EX", String(ttl))) === "OK",
      () => super.claim(key, value, ttl));
  }
  override get(key: string) {
    return this.op("get", async () => (await this.pub.get(PREFIX + key)) ?? null, () => super.get(key));
  }
  override touch(key: string, ttl: number) {
    return this.op("touch", async () => void (await this.pub.expire(PREFIX + key, ttl)), () => super.touch(key, ttl));
  }
  override release(key: string) {
    return this.op("release", async () => void (await this.pub.del(PREFIX + key)), () => super.release(key));
  }
  override putStatus(json: string, ttl: number) {
    this.status = json;
    return this.op("status write", async () => void (await this.pub.set(`${PREFIX}status:${this.inst}`, json, "EX", String(ttl))),
      async () => {});
  }
  override listStatus() {
    return this.op("status read", async () => {
      const keys = (await this.pub.keys(`${PREFIX}status:*`)) as string[];
      if (!keys.length) return this.status ? [this.status] : [];
      const values = (await this.pub.mget(...keys)) as (string | null)[];
      return values.filter((v): v is string => typeof v === "string");
    }, () => super.listStatus());
  }
  override send(to: Loc, msg: BusMsg) {
    if (to.inst === this.inst || this.state === "failed") return super.send(to, msg);
    void this.op("publish", async () => void (await this.pub.publish(`${PREFIX}i:${to.inst}`, encode({ sid: to.sid, msg }))),
      async () => {});
  }
}

/**
 * REDIS_URL or KV_URL, or the same with a custom prefix: Vercel's Upstash integration names
 * them e.g. PLAYERS_REDIS_URL when the store is given the prefix "PLAYERS".
 * The *_KV_REST_API_URL variables are HTTP-only and can't be used here.
 */
export function redisUrlFrom(env: Record<string, string | undefined>): string {
  if (env.REDIS_URL) return env.REDIS_URL;
  if (env.KV_URL) return env.KV_URL;
  const keys = Object.keys(env).filter((k) => env[k] && /_(REDIS|KV)_URL$/.test(k)).sort();
  const key = keys.find((k) => k.endsWith("_REDIS_URL")) ?? keys[0];
  return key ? env[key]! : "";
}

export function createBus(redisUrl = redisUrlFrom(process.env)): Bus {
  if (!redisUrl) return new LocalBus();
  return new RedisBus(redisUrl);
}

export const locKey = (loc: Loc) => `${loc.inst}/${loc.sid}`;
export const parseLoc = (value: string | null): Loc | null => {
  if (!value) return null;
  const i = value.indexOf("/");
  return i > 0 ? { inst: value.slice(0, i), sid: value.slice(i + 1) } : null;
};
