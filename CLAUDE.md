# Eaglercraft 26.3 relay — notes for Claude Code

Bun + Hono relay for Eaglercraft 26.3, deployed on Vercel. The 26.3 client is served from `public/play/index.html`.

## The one rule that breaks deploys

`api/server.js` is a **generated bundle**. Never edit it by hand.

- After changing anything in `src/`, run `bun run build`, then commit the new `api/server.js`.
- Vercel's Bun runtime crashed resolving multi-file TS imports (`ResolveMessage {}` / `FUNCTION_INVOCATION_FAILED`), which is why the function ships as one self-contained file.
- `vercel.json` `functions` must reference `api/server.js` (not `.ts`).

## Layout

- `src/entry.ts`: `Bun.serve` entrypoint (bundled into `api/server.js`).
- `src/relay.ts`: Hono routes. Vercel rewrites send `/`, `/minecraft`, `/lan/*`, `/health`, and `/admin*` to `/api/server?__route=…`. `logicalPath()` maps them back.
- `src/minecraft.ts`: WebSocket ↔ TCP tunnel (`Bun.connect`). It validates the Java handshake and sniffs the Login Start username for `/admin`.
- `src/legacy-lan.ts`: `/` classic Eagler LAN signaling (RelayPacket v1, WebRTC).
- `src/lan-rooms.ts`: `/lan/host` and `/lan/join`, relayed LAN rooms.
- `src/bus.ts`: cross-instance rooms through Redis (Bun's built-in `RedisClient`), with a time-limited in-memory fallback. Redis problems must never hang LAN hosting.
- `src/admin.html`: the `/admin` status page, imported as text.
- `scripts/prepare-client.ts`: `bun run client <html>` patches the client to use this site as its relay.

## Commands

    bun install
    bun test            # cross-instance tests need redis on 127.0.0.1:6390 (else skipped)
    bun run typecheck
    bun run build       # regenerate api/server.js
    bun run dev         # local server on :8787, client at /play

## Vercel constraints

- WebSockets close at the function's `maxDuration` (300s on Hobby). The relay closes cleanly ~5s before (`RELAY_VERCEL_MAX_DURATION`).
- Instances don't share memory. LAN across instances needs `REDIS_URL`; `/health` → `"rooms"` shows the state.
- `/admin` needs `RELAY_ADMIN_PASSWORD`.
