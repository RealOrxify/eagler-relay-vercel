# Eaglercraft 26.3 Relay — Vercel + Hono + Bun

The client and the relay are one Vercel project:

- The **26.3 client** is served from the CDN at `/play`.
- The **relay** runs as one Bun function with Hono routing and native Bun WebSockets.

The client defaults to this site as its relay, so players open `https://your-app.vercel.app` and play.

| Path | What it does |
|---|---|
| `/` | Browser visit: redirects to `/play`. WebSocket: classic LAN signaling relay. |
| `/minecraft?target=host:port` | Java Edition server tunnel. Works with any protocol version, including 26.3. |
| `/lan/host`, `/lan/join?code=` | Relayed LAN rooms |
| `/health` | JSON status |

## Deploy

> **`api/server.js` is a pre-built bundle** of everything in `src/` plus Hono. Vercel's Bun
> runtime crashed resolving the multi-file TypeScript imports (`ResolveMessage {}` /
> `FUNCTION_INVOCATION_FAILED`), so the function ships as one self-contained file with no
> imports to resolve. If you edit anything in `src/`, run `bun run build` and commit the new
> `api/server.js`.

```bash
bun install
bunx vercel login
bunx vercel deploy --prod
```

Or push to GitHub and import the repo in Vercel. `vercel.json` already sets the Bun runtime, the routes, and the function's max duration.

> `public/play/index.html` is about 76 MB. GitHub accepts it but warns about files over 50 MB, and the Vercel CLI accepts it.

### Strongly recommended: add Redis

Vercel can put a LAN host and a guest on different function instances. When that happens, the guest gets "no LAN world found."

To fix it, add **Redis** from the Vercel Marketplace (Storage → Redis). That sets `REDIS_URL`, which the relay picks up automatically. It uses Bun's built-in Redis client, so no extra package is needed. `/health` shows `"sharedRooms": true` when it's working.

## Your own server as the address

Set `RELAY_DEFAULT_SERVER` to your Java/Paper server's public address (for example `play.example.com:25565`
or a playit.gg address), then redeploy. Players can then connect to `wss://your-app.vercel.app/minecraft` and land on your server
without knowing its real address. `/health` shows `"defaultServer": true` but never the address.

Your server still has to be reachable from the internet (port forwarding or a tunnel such as playit.gg): Vercel
connects out to it, and home-network addresses are refused. Only Eaglercraft players can come in this way; normal
Java and Bedrock (Geyser) players use the server's real address, and voice chat's UDP port can't go through Vercel.

## Status page (`/admin`)

This page shows who's using the relay, live:
- Players on Java servers, with their username, the server, time online, and data used.
- Open LAN worlds, with their join codes (each has a copy button).

Each entry shows a rough location (city, region, country) from Vercel's geo headers. IP addresses are never shown or stored.

To turn it on:
1. Add `RELAY_ADMIN_PASSWORD` in your Vercel project's environment variables.
2. Redeploy.
3. Open `https://your-app.vercel.app/admin`. Your browser will ask you to sign in: type anything as the username, then the password.

The page is password-protected because the join codes let anyone into those worlds.

Without Redis, the page only sees whichever Vercel instance answered the request. With Redis, every instance reports in every few seconds, so you see everyone.

## Vercel limits (read this)

Every WebSocket on Vercel is closed when the function hits its max duration:

| Plan | Max connection length |
|---|---|
| Hobby | 300 s (≈5 min) |
| Pro | 800 s, or 1800 s (extended, beta) |

On Hobby, players on Java servers get disconnected about every 5 minutes. The relay closes a few seconds early with "relay session limit reached, reconnect" so the client gets a clean message.

On Pro, raise the limit in two places:

1. `"maxDuration"` in `vercel.json` (for example 800).
2. The `RELAY_VERCEL_MAX_DURATION` env var, set to the same number.

If you want unlimited sessions, run the same code on a VPS (below).

Costs: relaying game traffic is billed as Active CPU plus data transfer.

## Troubleshooting

**"Could not connect to signaling relay (code 1006)"**

1. Open `https://your-app.vercel.app/health` and look at `"rooms"`:
   - `"memory"`: no Redis is configured. LAN works, but only when the host and guests reach the same instance.
   - `"redis"`: Redis is working.
   - `"memory (redis failed: …)"`: `REDIS_URL` is set, but this relay can't reach that Redis. LAN still works through the in-memory fallback. Fix or remove `REDIS_URL` in Vercel's environment variables, then redeploy.
2. If `/health` doesn't load, the function is crashing. Open the Vercel dashboard (Logs) and check the lines above `Bun process exited`.
3. In the game's **Relays** screen, make sure the relay address is `wss://your-app.vercel.app/` with **wss**, not ws.
4. If you're using a long `…-git-…` or `…-xxxx.vercel.app` preview URL, Vercel's Deployment Protection may block it. Use your production domain, or turn protection off under Settings → Deployment Protection.

## Run anywhere else (no time limits)

```bash
bun install
bun start            # http://localhost:8787  (client at /play)
bun run dev          # same, from source with auto-reload
```

## Updating the client

```bash
bun run client path/to/eaglercraft26-3.html
```

This copies the client to `public/play/index.html` and injects this site as the default relay. Relays already saved in a player's browser still take priority.

## Private mode

1. Set `RELAY_PUBLIC=0` and `RELAY_SECRET` (16+ characters) in your Vercel env vars.
2. Mint tokens:

```bash
RELAY_SECRET=... bun run token mc.example.com:25565 3600
RELAY_SECRET=... bun run token --lan-host 21600
```

Tokens from the old Node and Cloudflare relays stay valid; the format is the same.

## Settings (env vars)

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_PUBLIC` | `1` | `0` requires tokens |
| `RELAY_SECRET` | — | Required when private |
| `RELAY_DEFAULT_SERVER` | — | `host:port` of your own Java server. `wss://your-app.vercel.app/minecraft` (no `?target=`) connects there. |
| `REDIS_URL` / `KV_URL` | — | Enables cross-instance LAN rooms |
| `RELAY_VERCEL_MAX_DURATION` | `300` | Keep equal to `maxDuration` in `vercel.json` |
| `RELAY_MAX_LIFETIME_MS` | auto | Overrides the per-connection cap |
| `RELAY_ALLOWED_ORIGINS` | — | Comma-separated browser origins |
| `RELAY_MAX_BYTES_PER_MINUTE` | 64 MiB | Per Java connection |
| `RELAY_MAX_LAN_BYTES_PER_MINUTE` | 512 MiB | Per LAN peer |
| `RELAY_MAX_LAN_PEERS` | `8` | Guests per LAN room |
| `RELAY_ICE_SERVERS` | Google + Cloudflare STUN | `stun:host:port` or `turn:host:port;user;pass` |
| `RELAY_ALLOW_PRIVATE` | `0` | Allow LAN/private targets. Never enable this on a public relay. |
| `RELAY_TRACE` | `0` | Per-connection logs |
| `RELAY_ADMIN_PASSWORD` | — | Turns on the `/admin` status page |

## Tests

```bash
bun test
```

The cross-instance tests need a Redis server on `127.0.0.1:6390` (or set `TEST_REDIS_URL`). If none is running, they're skipped.

MIT, same as the original relay.
