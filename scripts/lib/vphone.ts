import { createConnection } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VPHONE_SCREEN = { width: 1290, height: 2796 } as const;

export const VPHONE_KEYS = ["home", "power", "volup", "voldown"] as const;
export type VPhoneKey = (typeof VPHONE_KEYS)[number];

export type VPhoneCommand =
  | { t: "screenshot"; path?: string; screen?: boolean; delay?: number }
  | { t: "tap"; x: number; y: number; screen?: boolean; delay?: number }
  | {
      t: "swipe";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      ms?: number;
      screen?: boolean;
      delay?: number;
    }
  | { t: "key"; name: VPhoneKey; screen?: boolean; delay?: number }
  | { t: "type"; text: string; screen?: boolean; delay?: number };

export type VPhoneResponse = {
  ok: boolean;
  path?: string;
  error?: string;
  image?: string;
};

const GRID_COLS = [180, 500, 820, 1120] as const;
const GRID_ROWS = [1050, 1310, 1570, 1830] as const;
const DOCK_Y = 2500;
const DOCK_COLS = [180, 460, 820, 1120] as const;

const HOME_SCREEN_APPS: Record<string, readonly [number, number]> = {
  facetime: [0, 0],
  calendar: [1, 0],
  photos: [2, 0],
  mail: [3, 0],
  notes: [0, 1],
  reminders: [1, 1],
  clock: [2, 1],
  tv: [3, 1],
  games: [0, 2],
  "app store": [1, 2],
  maps: [2, 2],
  health: [3, 2],
  wallet: [0, 3],
  settings: [1, 3],
};

const DOCK_APPS: Record<string, number> = {
  phone: 0,
  safari: 1,
  messages: 2,
  music: 3,
};

export function encodeCommand(cmd: VPhoneCommand): string {
  return JSON.stringify(cmd) + "\n";
}

export function decodeResponse(raw: string): VPhoneResponse {
  const parsed: unknown = JSON.parse(raw.trim());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("vphone response is not an object");
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") {
    throw new Error("vphone response missing ok");
  }
  const out: VPhoneResponse = { ok: rec.ok };
  if (typeof rec.path === "string") out.path = rec.path;
  if (typeof rec.error === "string") out.error = rec.error;
  if (typeof rec.image === "string") out.image = rec.image;
  return out;
}

export function appPosition(name: string): { x: number; y: number } | null {
  const key = name.toLowerCase().trim();
  const dock = DOCK_APPS[key];
  if (dock !== undefined) {
    const x = DOCK_COLS[dock];
    return x === undefined ? null : { x, y: DOCK_Y };
  }
  const grid = HOME_SCREEN_APPS[key];
  if (!grid) return null;
  const x = GRID_COLS[grid[0]];
  const y = GRID_ROWS[grid[1]];
  if (x === undefined || y === undefined) return null;
  return { x, y };
}

export function discoverSocket(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string | null {
  const explicit = env.VPHONE_SOCK;
  if (explicit && explicit.length > 0) return explicit;

  const vmName = env.VPHONE_VM && env.VPHONE_VM.length > 0 ? env.VPHONE_VM : "bro";
  const named = join(home, ".vphone", "VMs", vmName, "vphone.sock");
  if (existsSync(named)) return named;

  const lib = join(home, ".vphone", "VMs");
  if (!existsSync(lib)) return null;
  for (const entry of readdirSync(lib, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sock = join(lib, entry.name, "vphone.sock");
    if (existsSync(sock)) return sock;
  }
  return null;
}

export function sendCommand(
  socketPath: string,
  cmd: VPhoneCommand,
  timeoutMs = 30_000,
): Promise<VPhoneResponse> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error(`vphone timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    let settled = false;
    const finish = (err?: Error, value?: VPhoneResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.removeAllListeners();
      conn.destroy();
      if (err) reject(err);
      else if (value) resolve(value);
      else reject(new Error("empty vphone response"));
    };

    conn.on("connect", () => {
      conn.write(encodeCommand(cmd));
    });
    conn.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(undefined, decodeResponse(buf.slice(0, nl)));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    conn.on("error", (err) => {
      finish(err);
    });
    conn.on("end", () => {
      if (!buf.trim()) {
        finish(new Error("empty vphone response"));
        return;
      }
      try {
        finish(undefined, decodeResponse(buf));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
