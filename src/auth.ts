// HMAC-SHA256 relay tokens. Same wire format as the original Node and Cloudflare relays,
// so tokens minted for either one still verify here.
import { parseTarget } from "./protocol.ts";

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    keyCache.set(secret, k);
  }
  return k;
}

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const nowS = () => Math.floor(Date.now() / 1000);

type Payload = { v: 1; exp: number; target?: string; scope?: string };

async function sign(secret: string, payload: Payload): Promise<string> {
  if (!secret || secret.length < 16) throw new Error("RELAY_SECRET must be at least 16 characters");
  const encoded = b64u(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(encoded)));
  return `${encoded}.${b64u(sig)}`;
}

async function verify(secret: string | undefined, token: string | null | undefined, now: number): Promise<Payload> {
  if (!secret || secret.length < 16 || !token) throw new Error("missing relay authentication");
  const pieces = token.split(".");
  if (pieces.length !== 2) throw new Error("malformed relay token");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(pieces[1]!), enc.encode(pieces[0]!));
  if (!ok) throw new Error("invalid relay token");
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(pieces[0]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("malformed relay token payload");
  }
  if (payload.v !== 1 || !Number.isInteger(payload.exp) || payload.exp < now) throw new Error("expired relay token");
  return payload;
}

export const createToken = (secret: string, target: string, ttl = 3600, now = nowS()) =>
  sign(secret, { v: 1, target: parseTarget(target).canonical, exp: now + ttl });

export const createScopedToken = (secret: string, scope: string, ttl = 21600, now = nowS()) =>
  sign(secret, { v: 1, scope, exp: now + ttl });

export async function verifyToken(secret: string | undefined, token: string | null | undefined, target: string, now = nowS()) {
  const p = await verify(secret, token, now);
  if (p.target !== parseTarget(target).canonical) throw new Error("expired or wrong-target relay token");
  return p;
}

export async function verifyScopedToken(secret: string | undefined, token: string | null | undefined, scope: string, now = nowS()) {
  const p = await verify(secret, token, now);
  if (p.scope !== scope) throw new Error("expired or wrong-scope relay token");
  return p;
}
