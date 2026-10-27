// RELAY_SECRET=... bun run token host:port [ttlSeconds]
// RELAY_SECRET=... bun run token --lan-host [ttlSeconds]
import { createScopedToken, createToken } from "../src/auth.ts";

const [target, ttlArg] = process.argv.slice(2);
const secret = process.env.RELAY_SECRET ?? "";
if (!target) {
  console.error("Usage: RELAY_SECRET=... bun run token host:port [ttlSeconds]");
  console.error("   or: RELAY_SECRET=... bun run token --lan-host [ttlSeconds]");
  process.exit(2);
}
console.log(target === "--lan-host"
  ? await createScopedToken(secret, "lan-host", Number(ttlArg ?? 21600))
  : await createToken(secret, target, Number(ttlArg ?? 3600)));
