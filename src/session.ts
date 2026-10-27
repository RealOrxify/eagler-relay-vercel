import type { ServerWebSocket } from "bun";
import type { Bus, BusMsg } from "./bus.ts";
import type { RelayConfig } from "./config.ts";
import { closeCode, closeReason } from "./protocol.ts";

export interface Session {
  open(ws: WS): void;
  message(ws: WS, data: string | Buffer): void;
  close(code: number, reason: string): void;
  onBus?(msg: BusMsg): void;
  /** What the status page shows for this socket; null = don't list it. */
  describe?(): SessionInfo | null;
}

export type SessionInfo =
  | { kind: "player"; name: string | null; server: string; protocol: number | null; up: number; down: number }
  | { kind: "lan"; mode: "p2p" | "relayed"; code: string; guests: number; joinedTotal: number; up: number; down: number };

export type SocketData = { sid: string; session: Session };
export type WS = ServerWebSocket<SocketData>;
export type Deps = { cfg: RelayConfig; bus: Bus };

const OPEN = 1;

export function isOpen(ws: WS | null | undefined): ws is WS {
  return !!ws && ws.readyState === OPEN;
}

export function safeClose(ws: WS | null | undefined, code: number, reason: string) {
  if (!ws || ws.readyState > OPEN) return;
  try {
    ws.close(closeCode(code), closeReason(reason));
  } catch {}
}

export function sendBytes(ws: WS | null | undefined, bytes: Uint8Array): boolean {
  if (!isOpen(ws)) return false;
  try {
    return ws.send(bytes) !== 0;
  } catch {
    return false;
  }
}

/** Fixed 60s window byte limiter. Returns false when over budget. */
export class ByteBudget {
  private started = Date.now();
  private used = 0;
  constructor(private readonly perMinute: number) {}
  charge(bytes: number): boolean {
    const now = Date.now();
    if (now - this.started >= 60_000) {
      this.started = now;
      this.used = 0;
    }
    this.used += bytes;
    return Number.isFinite(this.perMinute) && this.perMinute > 0 && this.used <= this.perMinute;
  }
}

/** Real copy. (Buffer#slice is a view, not a copy.) */
export const copyBytes = (data: Uint8Array): Uint8Array => new Uint8Array(data);
