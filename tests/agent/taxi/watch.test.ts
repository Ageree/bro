import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "@db/schema";
import type * as notice from "@agent/lib/delivery/code-notice";
import type * as transport from "@agent/lib/yandex/transport";

const sendCodeNotice = vi.hoisted(() => vi.fn<typeof notice.sendCodeNotice>());
const runYandexOperation = vi.hoisted(() =>
  vi.fn<typeof transport.runYandexOperation>()
);

vi.mock("@agent/lib/delivery/code-notice", () => ({ sendCodeNotice }));
vi.mock("@agent/lib/yandex/transport", () => ({ runYandexOperation }));

const databases: PGlite[] = [];
const alice = { userId: "better-auth:alice", workspaceId: "personal:alice" };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

async function watching(forPassenger = false) {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  const pgliteDatabase = drizzle(client, { schema });
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = pgliteDatabase as never;
  const Database = await import("@db");
  const scope = await import("@db/services/scope");
  const store = await import("@db/services/taxi-watches");
  const watch = await import("@agent/lib/taxi/watch");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  await scope.ensureScope(alice);
  await store.startTaxiWatch(
    {
      conversationChannel: "telegram",
      conversationId: "telegram:1",
      forPassenger,
      orderId: "order-1",
      ...alice,
    },
    new Date()
  );
  return { database: pgliteDatabase, watch };
}

const ride = (status: string, etaSeconds: number | null) => ({
  data: {
    car: "белый Kia Rio А001АА77",
    etaSeconds,
    fields: [],
    kind: "ride",
    status,
  },
  kind: "ok" as const,
});

const told = () => sendCodeNotice.mock.calls.map((call) => call[2]);

describe("watching a booked taxi", () => {
  it("tells that the car is found, then to step out, then that it is there", async () => {
    const { database, watch } = await watching();
    const tick = async (answer: ReturnType<typeof ride>) => {
      runYandexOperation.mockResolvedValue(answer);
      // The claim holds a read for a while: let the next tick take it.
      await database
        .update(schema.taxiWatches)
        .set({ nextCheckAt: new Date(0) });
      await watch.watchTaxiRides({}, new Date());
    };
    await tick(ride("search", null));
    expect(told()).toEqual([]);
    await tick(ride("driving", 480));
    await tick(ride("driving", 450));
    expect(told()).toEqual([
      "Нашёл машину: белый Kia Rio А001АА77, будет через ~8 мин. Напишу, когда пора выходить.",
    ]);
    await tick(ride("driving", 110));
    await tick(ride("driving", 80));
    expect(told().slice(1)).toEqual([
      "Пора выходить: Машина (белый Kia Rio А001АА77) будет на месте через ~2 мин.",
    ]);
    await tick(ride("waiting", null));
    expect(told().slice(2)).toEqual([
      "Машина (белый Kia Rio А001АА77) на месте. Выходи.",
    ]);
    const [row] = await database.select().from(schema.taxiWatches);
    expect(row?.state).toBe("done");
  });

  it("does not repeat a notice the chat did not take", async () => {
    const { database, watch } = await watching();
    runYandexOperation.mockResolvedValue(ride("driving", 60));
    sendCodeNotice.mockRejectedValueOnce(new Error("down"));
    await watch.watchTaxiRides({}, new Date());
    await database.update(schema.taxiWatches).set({ nextCheckAt: new Date(0) });
    await watch.watchTaxiRides({}, new Date());
    expect(told()).toHaveLength(2);
    expect(told()[1]).toContain("Пора выходить");
  });

  it("ends when Yandex no longer lists the order, without a word", async () => {
    const { database, watch } = await watching();
    runYandexOperation.mockResolvedValue({
      data: { kind: "gone" },
      kind: "ok",
    });
    await watch.watchTaxiRides({}, new Date());
    expect(told()).toEqual([]);
    const [row] = await database.select().from(schema.taxiWatches);
    expect(row?.state).toBe("done");
  });

  it("tells a ride for someone else only that a car is found", async () => {
    const { database, watch } = await watching(true);
    runYandexOperation.mockResolvedValue(ride("driving", 60));
    await watch.watchTaxiRides({}, new Date());
    expect(told()).toHaveLength(1);
    expect(told()[0]).toContain("Нашёл машину");
    const [row] = await database.select().from(schema.taxiWatches);
    expect(row?.state).toBe("done");
  });
});
