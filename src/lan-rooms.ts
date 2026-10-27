// /lan/host and /lan/join — relayed LAN rooms (world traffic goes through the relay).
//
// Host frames:  [version=1][idLen][peerId ascii][payload]   (host -> one guest)
// Guest frames: raw payload, wrapped into the same frame shape before reaching the host.
// Control messages to the host are JSON text: hosted / peer-open / peer-close.
import { locKey, parseLoc, randomId, type BusMsg, type Loc } from "./bus.ts";
import { ByteBudget, copyBytes, isOpen, safeClose, sendBytes, type Deps, type Session, type SessionInfo, type WS } from "./session.ts";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HOST_FRAME_VERSION = 1;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_EARLY_BYTES = 1024 * 1024;
const ROOM_TTL_S = 180;
const JOIN_TIMEOUT_MS = 6000;

function randomCode(len: number) {
  let code = "";
  for (const b of crypto.getRandomValues(new Uint8Array(len))) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function peerFrame(peerId: string, payload: Uint8Array): Uint8Array {
  const id = Buffer.from(peerId, "ascii");
  const frame = new Uint8Array(2 + id.length + payload.length);
  frame[0] = HOST_FRAME_VERSION;
  frame[1] = id.length;
  frame.set(id, 2);
  frame.set(payload, 2 + id.length);
  return frame;
}

export function parseHostFrame(frame: Uint8Array) {
  if (frame.length < 3 || frame[0] !== HOST_FRAME_VERSION) throw new Error("invalid LAN host frame");
  const idLen = frame[1]!;
  if (idLen < 8 || idLen > 32 || frame.length < 2 + idLen) throw new Error("invalid LAN peer id");
  return {
    peerId: Buffer.from(frame.subarray(2, 2 + idLen)).toString("ascii"),
    payload: frame.subarray(2 + idLen),
  };
}

const sendJson = (ws: WS | null, value: unknown) => {
  if (isOpen(ws)) ws.send(JSON.stringify(value));
};

type Peer = { loc: Loc; budget: ByteBudget };

export class LanHostSession implements Session {
  private ws: WS | null = null;
  private self: Loc;
  private code = "";
  private peers = new Map<string, Peer>();
  private closed = false;
  private joinedTotal = 0;
  private up = 0;
  private down = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private lifetime: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: Deps, sid: string) {
    this.self = { inst: deps.bus.inst, sid };
  }

  open(ws: WS) {
    this.ws = ws;
    void this.start();
  }

  private async start() {
    const { bus, cfg } = this.deps;
    try {
      for (let i = 0; i < 32 && !this.code; i++) {
        const code = randomCode(6);
        if (await bus.claim(`F:${code}`, locKey(this.self), ROOM_TTL_S)) this.code = code;
      }
    } catch {}
    if (!this.code) return this.shutdown(1013, "no LAN room codes available");
    if (this.closed) return void bus.release(`F:${this.code}`).catch(() => {});
    this.keepalive = setInterval(() => void bus.touch(`F:${this.code}`, ROOM_TTL_S).catch(() => {}), 60_000);
    this.lifetime = setTimeout(() => this.shutdown(1000, "LAN room expired"), cfg.maxLifetimeMs);
    sendJson(this.ws, { type: "hosted", code: this.code, maxPeers: cfg.maxLanPeers });
  }

  describe(): SessionInfo | null {
    if (this.closed || !this.code) return null;
    return { kind: "lan", mode: "relayed", code: this.code, guests: this.peers.size, joinedTotal: this.joinedTotal, up: this.up, down: this.down };
  }

  message(_ws: WS, data: string | Buffer) {
    if (typeof data === "string") return this.shutdown(1003, "binary host frames required");
    this.up += (data as Uint8Array).byteLength;
    try {
      const { peerId, payload } = parseHostFrame(data as Uint8Array);
      const peer = this.peers.get(peerId);
      if (!peer) return;
      if (!peer.budget.charge(payload.byteLength)) return this.dropPeer(peerId, 1008, "rate limit exceeded");
      if (payload.length) this.deps.bus.send(peer.loc, { t: "F.data", data: copyBytes(payload) });
    } catch (e) {
      this.shutdown(1008, (e as Error).message);
    }
  }

  onBus(msg: BusMsg) {
    const { bus, cfg } = this.deps;
    if (this.closed) return;
    switch (msg.t) {
      case "F.join": {
        const from = msg.from as Loc;
        if (this.peers.size >= cfg.maxLanPeers) return bus.send(from, { t: "F.close", code: 1013, reason: "LAN room is full" });
        let peerId: string;
        do peerId = randomId(8); while (this.peers.has(peerId));
        this.peers.set(peerId, { loc: from, budget: new ByteBudget(cfg.maxLanBytesPerMinute) });
        this.joinedTotal++;
        sendJson(this.ws, { type: "peer-open", peer: peerId });
        bus.send(from, { t: "F.ok", peer: peerId });
        return;
      }
      case "F.data": {
        const peerId = msg.peer as string;
        if (!this.peers.has(peerId)) return;
        if (this.ws && this.ws.getBufferedAmount() > MAX_BUFFERED_BYTES) return this.dropPeer(peerId, 1008, "host is too slow");
        const frame = peerFrame(peerId, msg.data as Uint8Array);
        if (sendBytes(this.ws, frame)) this.down += frame.byteLength;
        return;
      }
      case "F.gone": {
        const peerId = msg.peer as string;
        if (this.peers.delete(peerId)) sendJson(this.ws, { type: "peer-close", peer: peerId, reason: msg.reason ?? "guest disconnected" });
        return;
      }
    }
  }

  private dropPeer(peerId: string, code: number, reason: string) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    this.deps.bus.send(peer.loc, { t: "F.close", code, reason });
    sendJson(this.ws, { type: "peer-close", peer: peerId, reason });
  }

  private shutdown(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    const { bus } = this.deps;
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.lifetime) clearTimeout(this.lifetime);
    for (const peer of this.peers.values()) bus.send(peer.loc, { t: "F.close", code, reason });
    this.peers.clear();
    if (this.code) {
      const key = `F:${this.code}`;
      bus.get(key).then((v) => (v === locKey(this.self) ? bus.release(key) : undefined)).catch(() => {});
    }
    safeClose(this.ws, code, reason);
  }

  close() {
    this.shutdown(1000, "LAN host disconnected");
  }
}

export class LanGuestSession implements Session {
  private ws: WS | null = null;
  private self: Loc;
  private host: Loc | null = null;
  private peerId = "";
  private early: Uint8Array[] = [];
  private earlyBytes = 0;
  private closed = false;
  private budget: ByteBudget;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private lifetime: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: Deps, sid: string, private code: string) {
    this.self = { inst: deps.bus.inst, sid };
    this.budget = new ByteBudget(deps.cfg.maxLanBytesPerMinute);
  }

  open(ws: WS) {
    this.ws = ws;
    this.lifetime = setTimeout(() => this.end(1000, "relay session limit reached"), this.deps.cfg.maxLifetimeMs);
    void this.join();
  }

  private async join() {
    let host: Loc | null = null;
    try {
      host = parseLoc(await this.deps.bus.get(`F:${this.code}`));
    } catch {}
    if (this.closed) return;
    if (!host) return this.end(1008, "LAN room is unavailable");
    this.host = host;
    this.joinTimer = setTimeout(() => this.end(1008, "LAN room is unavailable"), JOIN_TIMEOUT_MS);
    this.deps.bus.send(host, { t: "F.join", from: this.self });
  }

  message(_ws: WS, data: string | Buffer) {
    if (this.closed) return;
    if (typeof data === "string") return this.end(1003, "binary frames required");
    const bytes = copyBytes(data as Uint8Array);
    if (!this.budget.charge(bytes.byteLength)) return this.end(1008, "rate limit exceeded");
    if (!this.peerId) {
      this.early.push(bytes);
      this.earlyBytes += bytes.byteLength;
      if (this.earlyBytes > MAX_EARLY_BYTES) this.end(1008, "too much data before join completed");
      return;
    }
    this.deps.bus.send(this.host!, { t: "F.data", peer: this.peerId, data: bytes });
  }

  onBus(msg: BusMsg) {
    if (this.closed) return;
    switch (msg.t) {
      case "F.ok": {
        if (this.joinTimer) clearTimeout(this.joinTimer);
        this.peerId = msg.peer as string;
        for (const b of this.early) this.deps.bus.send(this.host!, { t: "F.data", peer: this.peerId, data: b });
        this.early = [];
        return;
      }
      case "F.data": {
        if (this.ws && this.ws.getBufferedAmount() > MAX_BUFFERED_BYTES) return this.end(1008, "peer is too slow");
        sendBytes(this.ws, msg.data as Uint8Array);
        return;
      }
      case "F.close": {
        this.peerId = ""; // host already forgot us
        return this.end((msg.code as number) ?? 1000, (msg.reason as string) ?? "LAN room closed");
      }
    }
  }

  private end(code: number, reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.lifetime) clearTimeout(this.lifetime);
    if (this.host && this.peerId) this.deps.bus.send(this.host, { t: "F.gone", peer: this.peerId, reason });
    safeClose(this.ws, code, reason);
  }

  close() {
    this.end(1000, "guest disconnected");
  }
}
