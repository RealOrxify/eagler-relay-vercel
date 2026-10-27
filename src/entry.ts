// Vercel Function entrypoint (Bun runtime). Also runs anywhere with `bun api/server.ts`.
import { createRelay } from "./relay.ts";

const relay = createRelay();

const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787), // ignored on Vercel
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: relay.fetch,
  websocket: relay.websocket,
});

if (!process.env.VERCEL) {
  console.log(`Eaglercraft 26.3 relay on http://localhost:${server.port}  (client: /play, health: /health)`);
  console.log(`LAN rooms: ${relay.bus.shared ? "shared via Redis" : "in-memory"}; public: ${relay.config.publicAccess}`);
}
