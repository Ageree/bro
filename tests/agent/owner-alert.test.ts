import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  claimOperationalAlert,
  clearOperationalAlert,
  releaseOperationalAlertClaim,
} from "@db/services/operational-alerts";
import type * as EnvModule from "@shared/environment";
import { alertOwner } from "@agent/lib/owner-alert";

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  return {
    ...original,
    env: {
      ...original.env,
      TELEGRAM_BOT_TOKEN: "telegram-test-token",
      TELEGRAM_OWNER_CHAT_ID: "1001",
    },
  };
});

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real alert state with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

const key = "test-alert";
const repeatAfterMs = 6 * 60 * 60_000;
const start = new Date("2026-09-24T10:00:00Z");

function minutesLater(minutes: number) {
  return new Date(start.getTime() + minutes * 60_000);
}

function stubTelegram(...replies: Response[]) {
  const network = vi.fn<typeof fetch>();
  for (const reply of replies) network.mockResolvedValueOnce(reply);
  network.mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", network);
  return network;
}

function alertAt(now: Date) {
  return alertOwner(key, "Баланс кончился", { now, repeatAfterMs });
}

describe("owner alerts", () => {
  beforeEach(async () => {
    await database.delete(schema.operationalAlerts);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says it once per window", async () => {
    const network = stubTelegram();

    await expect(alertAt(start)).resolves.toBe(true);
    await expect(alertAt(minutesLater(5))).resolves.toBe(false);
    await expect(alertAt(minutesLater(6 * 60 + 1))).resolves.toBe(true);

    expect(network).toHaveBeenCalledTimes(2);
  });

  it("tries again when Telegram answered 2xx but did not take the message", async () => {
    const network = stubTelegram(
      Response.json({ description: "chat not found", ok: false })
    );

    await expect(alertAt(start)).rejects.toThrow("Telegram owner alert");
    await expect(alertAt(minutesLater(1))).resolves.toBe(true);

    expect(network).toHaveBeenCalledTimes(2);
  });

  it("takes the alert again when its sender died before sending", async () => {
    const network = stubTelegram();
    // A sender claimed it and never came back.
    await claimOperationalAlert(key, 0, {
      minimumDrop: Number.MAX_SAFE_INTEGER,
      now: start,
      repeatAfterMs,
    });

    await expect(alertAt(minutesLater(1))).resolves.toBe(false);
    await expect(alertAt(minutesLater(3))).resolves.toBe(true);
    // Sent now, so the full window holds from here.
    await expect(alertAt(minutesLater(10))).resolves.toBe(false);

    expect(network).toHaveBeenCalledOnce();
  });

  it("does not let a stale failed send erase a newer claim", async () => {
    const network = stubTelegram();
    const stale = await claimOperationalAlert(key, 0, {
      minimumDrop: Number.MAX_SAFE_INTEGER,
      now: start,
      repeatAfterMs,
    });
    if (!stale) throw new Error("The first claim must go through.");
    // The condition cleared and came back while the first send hung.
    await clearOperationalAlert(key, minutesLater(1));
    await expect(alertAt(minutesLater(2))).resolves.toBe(true);

    await releaseOperationalAlertClaim(key, stale, minutesLater(3));

    await expect(alertAt(minutesLater(4))).resolves.toBe(false);
    expect(network).toHaveBeenCalledOnce();
  });
});
