// /minecraft?target=host:port — WebSocket <-> raw TCP to a Java Edition server.
// The first bytes from the browser must be a valid Minecraft handshake whose port matches
// the target; after that the relay is a dumb, zero-parse byte pipe (any protocol version).
import type { Socket } from "bun";
import { ByteBudget, copyBytes, safeClose, sendBytes, type Deps, type Session, type SessionInfo, type WS } from "./session.ts";
import { concatBytes, parseLoginStartName, validateMinecraftHandshake, type Target } from "./protocol.ts";

const MAX_HANDSHAKE_BYTES = 65536;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export class MinecraftSession implements Session {
  private ws: WS | null = null;
  private tcp: Socket<undefined> | null = null;
  private accepted = false;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private queue: Uint8Array[] = []; // bytes waiting for TCP (not yet connected or backpressured)
  private queuedBytes = 0;
  private ended = false;
  private lifetime: ReturnType<typeof setTimeout> | null = null;
  private budget: ByteBudget;
  private clientBytes = 0;
  private targetBytes = 0;
  private traceId = Math.random().toString(36).slice(2, 8);
  // status page
  private player: string | null = null;
  private protocol: number | null = null;
  private nextState = 0;
  private sniff: Uint8Array | null = null; // bytes after the handshake, until Login Start is read

  constructor(private deps: Deps, private target: Target, private connectHost: string, private checkPort = true) {
    this.budget = new ByteBudget(deps.cfg.maxBytesPerMinute);
  }

  private trace(msg: string) {
    if (this.deps.cfg.trace) console.log(`[mc:${this.traceId}] ${this.target.canonical} ${msg}`);
  }

  open(ws: WS) {
    this.ws = ws;
    this.lifetime = setTimeout(() => this.end(1000, "relay session limit reached, reconnect"), this.deps.cfg.maxLifetimeMs);
    this.trace(`opening via ${this.connectHost}`);
    Bun.connect({
      hostname: this.connectHost,
      port: this.target.port,
      socket: {
        open: (s) => {
          if (this.ended) return void s.end();
          this.tcp = s;
          try { s.setNoDelay(true); } catch {}
          try { s.setKeepAlive(true, 30_000); } catch {}
          this.trace("connected");
          this.flush();
        },
        data: (_s, chunk) => {
          this.targetBytes += chunk.byteLength;
          if (!sendBytes(this.ws, chunk) && !this.ended) this.end(1011, "client send failed");
        },
        drain: () => this.flush(),
        close: () => this.end(1000, "target closed"),
        error: (_s, err) => {
          this.trace(`target error ${err?.message}`);
          this.end(1011, "target connection failed");
        },
        connectError: (_s, err) => {
          this.trace(`connect error ${err?.message}`);
          this.end(1011, "target connection failed");
        },
      },
    }).catch(() => this.end(1011, "target connection failed"));
  }

  message(_ws: WS, data: string | Buffer) {
    if (this.ended) return;
    if (typeof data === "string") return this.end(1003, "binary frames required");
    const bytes = data as Uint8Array;
    if (!this.budget.charge(bytes.byteLength)) return this.end(1008, "rate limit exceeded");
    this.clientBytes += bytes.byteLength;

    if (!this.accepted) {
      this.pending.push(copyBytes(bytes));
      this.pendingBytes += bytes.byteLength;
      if (this.pendingBytes > MAX_HANDSHAKE_BYTES) return this.end(1008, "handshake too large");
      const buffered = concatBytes(this.pending, this.pendingBytes);
      const result = validateMinecraftHandshake(buffered);
      if (result.status === "invalid") return this.end(1008, result.reason);
      if (result.status === "more") return;
      if (this.checkPort && result.port !== this.target.port) return this.end(1008, "handshake target port mismatch");
      this.trace(`handshake protocol=${result.protocol} state=${result.nextState} host=${result.host}`);
      this.accepted = true;
      this.protocol = result.protocol;
      this.nextState = result.nextState;
      this.pending = [];
      this.pendingBytes = 0;
      if (result.nextState !== 1) this.sniffName(buffered.subarray(result.packetEnd));
      return this.write(buffered);
    }
    if (this.sniff) this.sniffName(bytes);
    this.write(bytes);
  }

  private sniffName(more: Uint8Array) {
    const buf = this.sniff ? concatBytes([this.sniff, more]) : copyBytes(more);
    const name = parseLoginStartName(buf);
    if (name === undefined && buf.length < 2048) {
      this.sniff = buf;
      return;
    }
    this.sniff = null;
    if (name) this.player = name;
  }

  describe(): SessionInfo | null {
    if (this.ended || this.nextState === 1 || !this.accepted) return null; // hide server-list pings
    return { kind: "player", name: this.player, server: this.target.canonical, protocol: this.protocol, up: this.clientBytes, down: this.targetBytes };
  }

  private write(bytes: Uint8Array) {
    if (!this.tcp || this.queue.length) {
      this.queue.push(copyBytes(bytes));
      this.queuedBytes += bytes.byteLength;
      if (this.queuedBytes > MAX_QUEUED_BYTES) this.end(1008, "target is too slow");
      return;
    }
    const n = this.tcp.write(bytes);
    if (n < bytes.byteLength) {
      const rest = copyBytes(bytes.subarray(Math.max(0, n)));
      this.queue.push(rest);
      this.queuedBytes += rest.byteLength;
    }
  }

  private flush() {
    const tcp = this.tcp;
    if (!tcp) return;
    while (this.queue.length) {
      const head = this.queue[0]!;
      const n = tcp.write(head);
      if (n < head.byteLength) {
        this.queue[0] = head.subarray(Math.max(0, n));
        this.queuedBytes -= Math.max(0, n);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= head.byteLength;
    }
    tcp.flush();
  }

  private end(code: number, reason: string) {
    if (this.ended) return;
    this.ended = true;
    this.trace(`closing ${code} ${reason} client=${this.clientBytes} target=${this.targetBytes}`);
    if (this.lifetime) clearTimeout(this.lifetime);
    try { this.tcp?.end(); } catch {}
    safeClose(this.ws, code, reason);
  }

  close() {
    this.end(1000, "client closed");
  }
}
