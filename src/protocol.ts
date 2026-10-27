// Minecraft Java handshake validation + target parsing.
// Version-agnostic: any protocol number is accepted, so 26.3 (and later) clients pass
// straight through. The relay only checks that the first packet is a real handshake.

const MAX_HOST_BYTES = 255;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();

export type Target = { host: string; port: number; canonical: string };

export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function parseTarget(value: unknown): Target {
  if (typeof value !== "string" || value.length === 0 || value.length > 320) throw new Error("invalid target");
  const text = value.trim();
  let host: string;
  let portText: string;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 2 || (end + 1 < text.length && text[end + 1] !== ":")) {
      throw new Error("IPv6 targets must use [host] or [host]:port");
    }
    host = text.slice(1, end);
    portText = end + 1 === text.length ? "25565" : text.slice(end + 2);
  } else {
    const split = text.lastIndexOf(":");
    if (split === -1) {
      host = text;
      portText = "25565";
    } else {
      if (split <= 0 || text.indexOf(":") !== split) throw new Error("IPv6 targets must use [host] or [host]:port");
      host = text.slice(0, split);
      portText = text.slice(split + 1);
    }
  }
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || port === 25) throw new Error("invalid target port");
  return { host, port, canonical: host.includes(":") ? `[${host}]:${port}` : `${host}:${port}` };
}

export function isPrivateTarget(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return true;
  }
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true;
    const a = o[0]!;
    const b = o[1]!;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  // IPv4-mapped IPv6, e.g. ::ffff:10.0.0.1
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateTarget(mapped[1]!);
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") ||
    lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

function readVarInt(bytes: Uint8Array, offset: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= bytes.length) return null;
    const byte = bytes[offset + i]!;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset + i + 1 };
  }
  throw new Error("VarInt exceeds five bytes");
}

export type HandshakeResult =
  | { status: "more" }
  | { status: "invalid"; reason: string }
  | { status: "valid"; packetEnd: number; protocol: number; nextState: number; host: string; port: number };

export function validateMinecraftHandshake(bytes: Uint8Array): HandshakeResult {
  let length;
  try {
    length = readVarInt(bytes, 0);
  } catch (e) {
    return { status: "invalid", reason: (e as Error).message };
  }
  if (!length) return { status: "more" };
  if (length.value < 6 || length.value > 65536) return { status: "invalid", reason: "invalid handshake packet length" };
  const packetEnd = length.next + length.value;
  if (bytes.length < packetEnd) return { status: "more" };
  try {
    let cursor = length.next;
    const packetId = readVarInt(bytes, cursor);
    if (!packetId || packetId.value !== 0) throw new Error("first packet is not handshake");
    cursor = packetId.next;
    const protocol = readVarInt(bytes, cursor);
    if (!protocol || protocol.value === 0) throw new Error("invalid protocol version");
    cursor = protocol.next;
    const hostLength = readVarInt(bytes, cursor);
    if (!hostLength || hostLength.value < 1 || hostLength.value > MAX_HOST_BYTES) throw new Error("invalid handshake hostname");
    cursor = hostLength.next;
    if (cursor + hostLength.value + 2 > packetEnd) throw new Error("truncated handshake hostname");
    const host = utf8.decode(bytes.subarray(cursor, cursor + hostLength.value));
    cursor += hostLength.value;
    const port = (bytes[cursor]! << 8) | bytes[cursor + 1]!;
    cursor += 2;
    const nextState = readVarInt(bytes, cursor);
    // 1 = status, 2 = login, 3 = transfer (modern clients use 3 after a server transfer)
    if (!nextState || nextState.value < 1 || nextState.value > 3 || nextState.next !== packetEnd) {
      throw new Error("invalid handshake next state");
    }
    return { status: "valid", packetEnd, protocol: protocol.value, nextState: nextState.value, host, port };
  } catch (e) {
    return { status: "invalid", reason: (e as Error).message };
  }
}

export function concatBytes(chunks: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function encodeVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let part = value & 0x7f;
    value >>>= 7;
    if (value !== 0) part |= 0x80;
    bytes.push(part);
  } while (value !== 0);
  return Uint8Array.from(bytes);
}

export function makeHandshake(host: string, port: number, protocol = 776, nextState = 2): Uint8Array {
  const hostBytes = enc.encode(host);
  const body = concatBytes([
    encodeVarInt(0), encodeVarInt(protocol), encodeVarInt(hostBytes.length), hostBytes,
    Uint8Array.of((port >>> 8) & 255, port & 255), encodeVarInt(nextState),
  ]);
  return concatBytes([encodeVarInt(body.length), body]);
}

export function closeReason(value: unknown): string {
  let reason = String(value || "relay closed").slice(0, 120);
  while (enc.encode(reason).byteLength > 123) reason = reason.slice(0, -1);
  return reason || "relay closed";
}

export function closeCode(value: unknown, fallback = 1011): number {
  const code = Number(value);
  return code === 1000 || code === 1001 || code === 1002 || code === 1003 ||
    (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999) ? code : fallback;
}

/**
 * Reads the username from a Java "Login Start" packet (always sent uncompressed and
 * unencrypted, right after a login handshake). undefined = need more bytes, null = not parseable.
 */
export function parseLoginStartName(bytes: Uint8Array): string | null | undefined {
  try {
    const len = readVarInt(bytes, 0);
    if (!len) return undefined;
    if (len.value < 2 || len.value > 1024) return null;
    if (bytes.length < len.next + len.value) return undefined;
    const id = readVarInt(bytes, len.next);
    if (!id || id.value !== 0) return null;
    const strLen = readVarInt(bytes, id.next);
    if (!strLen || strLen.value < 1 || strLen.value > 64 || strLen.next + strLen.value > len.next + len.value) return null;
    const name = utf8.decode(bytes.subarray(strLen.next, strLen.next + strLen.value));
    return /^[\w.\-]{1,32}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export function makeLoginStart(name: string): Uint8Array {
  const n = enc.encode(name);
  const body = concatBytes([encodeVarInt(0), encodeVarInt(n.length), n, new Uint8Array(16)]);
  return concatBytes([encodeVarInt(body.length), body]);
}
