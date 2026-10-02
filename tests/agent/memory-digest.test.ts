import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  afterAll,
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
  listCurrentMemories,
  saveMemory,
  updateMemory,
} from "@db/services/memory/records";
import { saveWorkstream } from "@db/services/workstreams";
import { renderProfile } from "@agent/lib/memory/profile";
import { planDedupe, saysInFull } from "@agent/lib/memory/digest/dedupe";
import { redactUnsafeText } from "@agent/lib/memory/digest/redact";
import {
  digestWorkspace,
  runDueMemoryDigests,
} from "@agent/lib/memory/digest/run";
import { memoryContentSchema } from "@shared/memory/schema";

/** The workspaces MEMORY_DIGEST_WORKSPACES names in a case. */
const pilot = vi.hoisted(() => {
  const list: string[] = [];
  return { list };
});

vi.mock("@agent/lib/memory/digest/pilot", () => ({
  memoryDigestPilot: async (scope: { readonly workspaceId: string }) =>
    Promise.resolve(
      pilot.list.includes("*") || pilot.list.includes(scope.workspaceId)
    ),
}));

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace-alice" };
const source = { sessionId: "session", turnId: "turn" };

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the transport changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services against an isolated PostgreSQL-compatible database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

beforeEach(async () => {
  pilot.list.length = 0;
  await database.delete(schema.workspaces);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

/** A memory the filter of the day it was written let through. */
async function writeUnfiltered(
  index: number,
  content: { readonly category?: string; readonly text: string }
) {
  await saveMemory(
    alice,
    "scope-a",
    { text: `Запись ${String(index)}.` },
    `p${String(index)}`,
    {
      ...source,
    }
  );
  const json = JSON.stringify({
    aliases: [],
    category: "fact",
    localOnly: false,
    relatedIndexes: [],
    validUntil: null,
    ...content,
  });
  for (const table of ["memory_records", "memory_revisions"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Two tables.
    await client.query(
      `UPDATE ${table} SET content = $1::jsonb WHERE record_index = $2`,
      [json, index]
    );
  }
}

async function texts() {
  return (await listCurrentMemories(alice, "scope-a")).map(
    ({ content }) => content?.text
  );
}

async function historyTexts() {
  const rows = await database
    .select()
    .from(schema.memoryRevisions)
    .orderBy(
      asc(schema.memoryRevisions.recordIndex),
      asc(schema.memoryRevisions.revision)
    );
  return rows.map((row) => row.content?.text ?? null);
}

describe("the daily memory digest", () => {
  it("cuts one-time codes out of memory and its history, for everyone", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "a",
      source
    );
    await writeUnfiltered(1, { text: "Код из смс для Госуслуг 482193" });
    await writeUnfiltered(2, {
      category: "rule",
      text: "Никогда не вводить PIN 1234 без моего ок.",
    });

    const outcome = await digestWorkspace(alice.workspaceId, "2026-10-03");

    expect(outcome).toMatchObject({ purged: 1, redacted: 1 });
    expect(await texts()).toEqual([
      "Живёт в Казани.",
      "Никогда не вводить PIN [удалено] без моего ок.",
    ]);
    expect((await historyTexts()).join("\n")).not.toMatch(/482193|1234/u);
  });

  it("cuts codes out of a workstream's notes", async () => {
    await saveWorkstream(
      alice,
      "work-scope",
      {
        content: {
          nextStep: "Дождаться ответа.",
          notes: "Вход в Госуслуги: код подтверждения 123-456, дальше анкета.",
          objective: "Записаться к врачу.",
          sources: [],
          status: "active",
          title: "Запись к врачу",
        },
        expectedRevision: 0,
        id: "doctor",
      },
      "save-work",
      "session"
    );

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ workstreamsRedacted: 1 });
    const [workstream] = await database.select().from(schema.workstreams);
    expect(workstream?.content?.notes).toBe(
      "Вход в Госуслуги: код подтверждения [удалено], дальше анкета."
    );
    expect(workstream?.sessionId).toBe("session");
  });

  it("folds duplicates only for the pilot, and never a rule", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { aliases: ["суши"], category: "preference", text: "Любит суши." },
      "a",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "b",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      {
        aliases: ["роллы"],
        category: "preference",
        text: "Любит суши и роллы, не ест свинину.",
      },
      "c",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      { category: "rule", text: "Не платить." },
      "d",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      { category: "rule", text: "Не платить без моего ок." },
      "e",
      source
    );
    // The same words, saved apart: «живёт в казани» with other punctuation.
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани!" },
      "f",
      source
    );

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ contained: 0, deduped: 0 });
    expect(await texts()).toHaveLength(6);

    pilot.list.push(alice.workspaceId);
    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-04")
    ).toMatchObject({ contained: 1, deduped: 1 });
    const left = await listCurrentMemories(alice, "scope-a");
    expect(left.map(({ content }) => content?.text)).toEqual([
      "Живёт в Казани.",
      "Любит суши и роллы, не ест свинину.",
      "Не платить.",
      "Не платить без моего ок.",
    ]);
    expect(left[1]?.content?.aliases).toEqual(["роллы", "суши"]);

    // What it folded can be restored from history.
    const merged = await database
      .select()
      .from(schema.memoryRevisions)
      .where(eq(schema.memoryRevisions.action, "merge"));
    expect(merged.map(({ actor }) => actor)).toEqual([
      "digest",
      "digest",
      "digest",
    ]);
    expect(await historyTexts()).toContain("Любит суши.");
  });

  it("writes nothing when nothing needs doing", async () => {
    pilot.list.push("*");
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "a",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      { category: "preference", text: "Не ест свинину." },
      "b",
      source
    );
    const before = renderProfile(await listCurrentMemories(alice, "scope-a"));
    const revisions = await historyTexts();

    expect(
      Object.values(await digestWorkspace(alice.workspaceId, "2026-10-03"))
    ).toEqual(Array(8).fill(0));
    expect(renderProfile(await listCurrentMemories(alice, "scope-a"))).toBe(
      before
    );
    expect(await historyTexts()).toEqual(revisions);
  });

  it("keeps the last ten revisions of a memory", async () => {
    await saveMemory(alice, "scope-a", { text: "Версия 0." }, "a", source);
    for (let revision = 1; revision <= 12; revision += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Revisions in order.
      await updateMemory(
        alice,
        "scope-a",
        {
          content: memoryContentSchema.parse({
            text: `Версия ${String(revision)}.`,
          }),
          expectedRevision: revision,
          index: 0,
        },
        `u${String(revision)}`
      );
    }

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ historyTrimmed: 3 });
    expect(await historyTexts()).toEqual(
      Array.from({ length: 10 }, (_, at) => `Версия ${String(at + 3)}.`)
    );
  });

  it("runs once a local day, from four in the morning", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "a",
      source
    );
    await database.insert(schema.userProfiles).values({
      timezone: "Asia/Yekaterinburg",
      workspaceId: alice.workspaceId,
    });
    const runs = () => database.select().from(schema.memoryDigestRuns);

    // 03:30 in Yekaterinburg.
    await runDueMemoryDigests(new Date("2026-10-02T22:30:00Z"));
    expect(await runs()).toEqual([]);
    // 04:30 there.
    await runDueMemoryDigests(new Date("2026-10-02T23:30:00Z"));
    await runDueMemoryDigests(new Date("2026-10-03T05:30:00Z"));
    const done = await runs();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ localDate: "2026-10-03", status: "done" });
    expect(done[0]?.outcome?.purged).toBe(0);
  });

  it("takes a day back from a run that outlived its lease", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "a",
      source
    );
    await database.insert(schema.memoryDigestRuns).values({
      leaseUntil: new Date("2026-10-03T08:00:00Z"),
      localDate: "2026-10-03",
      startedAt: new Date("2026-10-03T07:45:00Z"),
      status: "running",
      workspaceId: alice.workspaceId,
    });
    const status = async () =>
      (await database.select().from(schema.memoryDigestRuns))[0]?.status;

    await runDueMemoryDigests(new Date("2026-10-03T07:50:00Z"));
    expect(await status()).toBe("running");
    await runDueMemoryDigests(new Date("2026-10-03T08:10:00Z"));
    expect(await status()).toBe("done");
  });
});

describe("cutting a code out of a text", () => {
  it("leaves one placeholder for one secret two patterns found", () => {
    expect(redactUnsafeText("password: 1234 5678 9012 3456, не забыть")).toBe(
      "password: [удалено], не забыть"
    );
  });
});

describe("folding memories together", () => {
  it("reads one memory as part of another only at a clause", () => {
    expect(saysInFull("Любит суши и роллы.", "Любит суши")).toBe(true);
    expect(
      saysInFull("Живёт в Казани. Работает в «Яндексе».", "Работает в Яндексе")
    ).toBe(true);
    // A clause after a comma may lean on the one before it.
    expect(saysInFull("По выходным, любит суши.", "Любит суши")).toBe(false);
    expect(saysInFull("Не любит суши.", "Любит суши")).toBe(false);
    expect(saysInFull("Любит суши.", "Любит суши и роллы")).toBe(false);
    // A clause that narrows or takes back the memory is no copy of it.
    expect(saysInFull("Любит суши по пятницам.", "Любит суши")).toBe(false);
    expect(saysInFull("Любит суши, но разлюбил.", "Любит суши")).toBe(false);
    expect(saysInFull("Работает в Сбере до декабря.", "Работает в Сбере")).toBe(
      false
    );
  });

  it("never folds across a category, a validity or a rule", () => {
    expect(
      planDedupe([
        record(0, { category: "fact", text: "Любит суши." }),
        record(1, { category: "preference", text: "Любит суши." }),
        record(2, {
          text: "Едет в Казань.",
          validUntil: "2026-10-10T00:00:00Z",
        }),
        record(3, { text: "Едет в Казань." }),
        record(4, { category: "rule", text: "Не платить." }),
        record(5, { category: "rule", text: "Не платить." }),
      ])
    ).toEqual({ drop: [], keep: [] });
  });

  it("folds a chain into the memory that says it all", () => {
    const plan = planDedupe([
      record(0, { aliases: ["a"], text: "Любит суши" }),
      record(1, { aliases: ["b"], text: "Любит суши и роллы" }),
      record(2, { text: "Любит суши и роллы, и пиццу" }),
    ]);
    expect(
      plan.drop.map(({ into, record: { index } }) => [index, into])
    ).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(plan.keep.map(({ aliases }) => aliases)).toEqual([["a", "b"]]);
  });
});

/** A current memory as the digest reads it. */
function record(
  index: number,
  content: Parameters<typeof memoryContentSchema.parse>[0]
) {
  return { content: memoryContentSchema.parse(content), index, revision: 1 };
}
