// "/" — Eaglercraft LAN signaling relay (the classic RelayPacket protocol, version 1).
// Only WebRTC signaling goes through here; world traffic is peer-to-peer.
//
// Room state lives on the instance holding the host socket. Guests on other instances
// talk to it over the bus, so this works across Vercel instances when Redis is configured.
import { locKey, parseLoc, type BusMsg, type Loc } from "./bus.ts";
import { concatBytes } from "./protocol.ts";
import { copyBytes, safeClose, sendBytes, type Deps, type Session, type SessionInfo, type WS } from "./session.ts";

const LAN_CODE_RE = /^[A-Z0-9]{6}$/;
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ROOM_TTL_S = 180;
const JOIN_TIMEOUT_MS = 6000;

const ascii = (v: string) => Uint8Array.from(v ?? "", (c) => c.charCodeAt(0) & 255);
const pkt = (parts: Uint8Array[]) => concatBytes(parts);
function ascii8(v: string) {
  const b = ascii(v);
  if (b.byteLength > 255) throw new Error("relay field is too long");
  return pkt([Uint8Array.of(b.byteLength), b]);
}
function ascii16(v: string) {
  const b = ascii(v);
  if (b.byteLength > 65535) throw new Error("relay field is too long");
  return pkt([Uint8Array.of(b.byteLength >>> 8, b.byteLength & 255), b]);
}
function randomCode(len: number) {
  let out = "";
  for (const b of crypto.getRandomValues(new Uint8Array(len))) out += ALPHABET[b % ALPHABET.length];
  return out;
}

const handshakePacket = (type: number, code: string) => pkt([Uint8Array.of(0x00, type, 1), ascii8(code)]);
const errorPacket = (code: number, reason: string) => pkt([Uint8Array.of(0xff, code & 255), ascii16(reason)]);
const disconnectPacket = (peer: string, code: number, reason: string) =>
  pkt([Uint8Array.of(0xfe), ascii8(peer), Uint8Array.of(code & 255), ascii16(reason)]);
const pongPacket = () => pkt([Uint8Array.of(0x69, 1), ascii8("Eaglercraft 26.3 relay"), ascii8("Eaglercraft 26.3 Vercel/Bun")]);
const peerPayload = (type: number, peer: string, payload: Uint8Array) =>
  pkt([Uint8Array.of(type), ascii8(peer), Uint8Array.of(payload.length >>> 8, payload.length & 255), payload]);

function iceServersPacket(servers: string[]) {
  const entries = servers.map((entry) => {
    const f = entry.split(";");
    const user = f.length > 1 ? f[1]! : "";
    const pass = f.length > 2 ? f.slice(2).join(";") : "";
    return pkt([Uint8Array.of(user ? 0x54 : 0x53), ascii16(f[0]!), ascii8(user), ascii8(pass)]);
  });
  return pkt([Uint8Array.of(0x01, entries.length >>> 8, entries.length & 255), ...entries]);
}

function readAscii8(bytes: Uint8Array, offset: number) {
  if (offset >= bytes.length) throw new Error("truncated ASCII8 field");
  const len = bytes[offset++]!;
  if (offset + len > bytes.length) throw new Error("truncated ASCII8 data");
  return { value: String.fromCharCode(...bytes.subarray(offset, offset + len)), offset: offset + len };
}

function parsePeerPayload(bytes: Uint8Array) {
  const peer = readAscii8(bytes, 1);
  if (peer.offset + 2 > bytes.length) throw new Error("truncated payload length");
  const len = (bytes[peer.offset]! << 8) | bytes[peer.offset + 1]!;
  const off = peer.offset + 2;
  if (off + len !== bytes.length) throw new Error("invalid payload length");
  return { peer: peer.value, payload: bytes.slice(off) };
}

export class LegacyLanSession implements Session {
  private ws: WS | null = null;
  private role: "pending" | "joining" | "host" | "guest" | "done" = "pending";
  private chain: Promise<void> = Promise.resolve();
  private self: Loc;
  // host
  private code = "";
  private guests = new Map<string, Loc>();
  private joinedTotal = 0;
  private up = 0;
  private down = 0;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  // guest
  private id = "";
  private hostLoc: Loc | null = null;
  private stage = 0;
  private completed = false;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private lifetime: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: Deps, sid: string) {
    this.self = { inst: deps.bus.inst, sid };
  }

  open(ws: WS) {
    this.ws = ws;
    this.lifetime = setTimeout(() => safeClose(this.ws, 1000, "relay session limit reached"), this.deps.cfg.maxLifetimeMs);
  }

  private send(bytes: Uint8Array) {
    if (sendBytes(this.ws, bytes)) this.down += bytes.byteLength;
  }

  describe(): SessionInfo | null {
    if (this.role !== "host" || !this.code) return null;
    return { kind: "lan", mode: "p2p", code: this.code, guests: this.guests.size, joinedTotal: this.joinedTotal, up: this.up, down: this.down };
  }

  private reject(code: number, reason: string, closeWith = 1008) {
    this.send(errorPacket(code, reason));
    safeClose(this.ws, closeWith, reason);
  }

  message(_ws: WS, data: string | Buffer) {
    const bytes = typeof data === "string" ? null : copyBytes(data as Uint8Array);
    if (bytes) this.up += bytes.byteLength;
    // Serialize: handshakes are async (room lookups), and order must be kept.
    this.chain = this.chain.then(() => this.handle(bytes)).catch((e) => {
      this.reject(2, e instanceof Error ? e.message : "Invalid relay packet");
    });
  }

  private async handle(bytes: Uint8Array | null) {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 65536) {
      return this.reject(2, "Binary relay packet required", 1003);
    }
    switch (this.role) {
      case "pending": return this.handshake(bytes);
      case "host": return this.fromHost(bytes);
      case "guest": return this.fromGuest(bytes);
      case "joining": return this.reject(3, "Packet sent before join completed");
      default: return;
    }
  }

  private async handshake(bytes: Uint8Array) {
    if (bytes[0] !== 0x00 || bytes.length < 4) throw new Error("Expected handshake packet");
    const type = bytes[1];
    const version = bytes[2];
    const field = readAscii8(bytes, 3);
    if (field.offset !== bytes.length) throw new Error("Trailing handshake data");
    if (version !== 1) return this.reject(1, "Unsupported relay protocol version; version 1 required");

    if (type === 0x03) {
      this.send(pongPacket());
      return safeClose(this.ws, 1000, "pong");
    }
    const { bus, cfg } = this.deps;
    if (type === 0x01) {
      for (let i = 0; i < 32; i++) {
        const code = randomCode(6);
        if (await bus.claim(`L:${code}`, locKey(this.self), ROOM_TTL_S)) {
          this.code = code;
          break;
        }
      }
      if (!this.code) return this.reject(0, "Relay has no available join codes", 1013);
      this.role = "host";
      this.keepalive = setInterval(() => void bus.touch(`L:${this.code}`, ROOM_TTL_S).catch(() => {}), 60_000);
      this.send(handshakePacket(0x01, this.code));
      this.send(iceServersPacket(cfg.iceServers));
      return;
    }
    if (type === 0x02) {
      const code = field.value.toUpperCase();
      if (!LAN_CODE_RE.test(code)) return this.reject(4, "Join code must be 6 letters or digits");
      const host = parseLoc(await bus.get(`L:${code}`));
      if (!host) return this.reject(5, "Invalid code, no LAN world found");
      this.code = code;
      this.hostLoc = host;
      this.role = "joining";
      this.joinTimer = setTimeout(() => this.reject(5, "LAN host did not respond"), JOIN_TIMEOUT_MS);
      bus.send(host, { t: "L.join", from: this.self });
      return;
    }
    this.reject(3, "Unsupported relay connection type");
  }

  private fromHost(bytes: Uint8Array) {
    const type = bytes[0];
    if (type === 0x03 || type === 0x04) {
      const { peer, payload } = parsePeerPayload(bytes);
      const loc = this.guests.get(peer);
      if (!loc) return this.send(errorPacket(7, `Unknown Client ID: ${peer}`));
      this.deps.bus.send(loc, { t: "L.toGuest", type, payload });
      return;
    }
    if (type === 0xfe) {
      const peer = readAscii8(bytes, 1).value;
      const loc = this.guests.get(peer);
      if (!loc) return;
      this.guests.delete(peer);
      this.deps.bus.send(loc, { t: "L.kick", bytes });
      return;
    }
    throw new Error("Host sent an unexpected relay packet");
  }

  private fromGuest(bytes: Uint8Array) {
    const host = this.hostLoc!;
    const type = bytes[0]!;
    if (type === 0x03 || type === 0x04) {
      const { peer, payload } = parsePeerPayload(bytes);
      if (peer !== "") throw new Error("Guest packet contained a client ID");
      if (type === 0x04 && this.stage !== 0) throw new Error("Unexpected guest description");
      if (type === 0x03 && this.stage !== 2) throw new Error("Unexpected guest ICE candidate");
      this.stage = type === 0x04 ? 1 : 3;
      this.deps.bus.send(host, { t: "L.fromGuest", id: this.id, type, payload });
      return;
    }
    if (type === 0x05 || type === 0x06) {
      const f = readAscii8(bytes, 1);
      if (f.offset !== bytes.length || f.value !== "") throw new Error("Invalid guest completion packet");
      if (this.stage !== 4) throw new Error("Guest completed signaling out of order");
      this.completed = true;
      this.role = "done";
      this.deps.bus.send(host, { t: "L.done", id: this.id, type });
      this.send(disconnectPacket(this.id, type === 0x05 ? 0 : 1, type === 0x05 ? "Successful connection" : "Failed connection"));
      return safeClose(this.ws, 1000, "signaling complete");
    }
    throw new Error("Guest sent an unexpected relay packet");
  }

  onBus(msg: BusMsg) {
    const { bus, cfg } = this.deps;
    switch (msg.t) {
      // ---- host side ----
      case "L.join": {
        if (this.role !== "host") return;
        const from = msg.from as Loc;
        if (this.guests.size >= cfg.maxLanPeers) {
          bus.send(from, { t: "L.reject", code: 0, reason: "LAN world is full", close: 1013 });
          return;
        }
        let id: string;
        do id = randomCode(16); while (this.guests.has(id));
        this.guests.set(id, from);
        this.joinedTotal++;
        bus.send(from, { t: "L.accept", id });
        this.send(pkt([Uint8Array.of(0x02), ascii8(id)]));
        return;
      }
      case "L.fromGuest": {
        if (this.role !== "host" || !this.guests.has(msg.id as string)) return;
        this.send(peerPayload(msg.type as number, msg.id as string, msg.payload as Uint8Array));
        return;
      }
      case "L.done": {
        if (this.role !== "host" || !this.guests.has(msg.id as string)) return;
        this.send(pkt([Uint8Array.of(msg.type as number), ascii8(msg.id as string)]));
        return;
      }
      case "L.gone": {
        this.guests.delete(msg.id as string);
        return;
      }
      // ---- guest side ----
      case "L.accept": {
        if (this.role !== "joining") return;
        if (this.joinTimer) clearTimeout(this.joinTimer);
        this.id = msg.id as string;
        this.role = "guest";
        this.send(handshakePacket(0x02, this.id));
        this.send(iceServersPacket(cfg.iceServers));
        return;
      }
      case "L.reject": {
        if (this.joinTimer) clearTimeout(this.joinTimer);
        return this.reject(msg.code as number, msg.reason as string, (msg.close as number) ?? 1008);
      }
      case "L.toGuest": {
        if (this.role !== "guest") return;
        this.stage = msg.type === 0x04 ? 2 : 4;
        this.send(peerPayload(msg.type as number, "", msg.payload as Uint8Array));
        return;
      }
      case "L.kick": {
        this.send(msg.bytes as Uint8Array);
        return safeClose(this.ws, 1000, "host ended signaling");
      }
      case "L.hostGone": {
        if ((this.role === "guest" || this.role === "joining") && !this.completed) this.reject(6, "LAN host disconnected");
        return;
      }
    }
  }

  close() {
    const { bus } = this.deps;
    if (this.lifetime) clearTimeout(this.lifetime);
    if (this.joinTimer) clearTimeout(this.joinTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.role === "host" && this.code) {
      const key = `L:${this.code}`;
      bus.get(key).then((v) => (v === locKey(this.self) ? bus.release(key) : undefined)).catch(() => {});
      for (const loc of this.guests.values()) bus.send(loc, { t: "L.hostGone" });
      this.guests.clear();
    } else if (this.hostLoc && this.id) {
      bus.send(this.hostLoc, { t: "L.gone", id: this.id });
    }
    this.role = "done";
  }
}

