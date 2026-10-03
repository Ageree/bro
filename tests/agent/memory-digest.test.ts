import { PGlite } from "@electric-sql/pglite";
import type * as ai from "ai";
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
  forgetMemory,
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
import type * as provider from "@shared/model/provider";

/** The workspaces MEMORY_DIGEST_WORKSPACES names in a case. */
const pilot = vi.hoisted(() => {
  const list: string[] = [];
  return { list };
});

/** The digest's model, at the AI SDK's boundary. */
const model = vi.hoisted(() => ({
  active: { value: false },
  generate:
    vi.fn<
      (options: {
        readonly maxOutputTokens?: number;
        readonly onStepEnd?: (step: ModelStep) => Promise<void>;
        readonly prompt?: string;
      }) => Promise<{ readonly output: ModelProposal }>
    >(),
}));

/** A model step as the digest reads its cost. */
interface ModelStep {
  readonly providerMetadata: {
    readonly openrouter: { readonly usage: { readonly cost: number } };
  };
  readonly usage: {
    readonly inputTokenDetails: { readonly cacheReadTokens: number };
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

/** What the model may answer: indexes only. */
interface ModelProposal {
  readonly duplicateOf: readonly { index: number; of: number }[] | null;
  readonly oneOff: readonly number[] | null;
  readonly supersededBy: readonly { newer: number; older: number }[] | null;
}

const paidStep: ModelStep = {
  providerMetadata: { openrouter: { usage: { cost: 0.42 } } },
  usage: {
    inputTokenDetails: { cacheReadTokens: 0 },
    inputTokens: 900,
    outputTokens: 20,
  },
};

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof ai>()),
  generateText: model.generate,
}));
vi.mock("@shared/model/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof provider>()),
  defaultModelId: () => "deepseek/deepseek-v4.1-flash",
  directModelActive: () => model.active.value,
}));
vi.mock("@agent/lib/model/direct", () => ({
  directModelSelection: () => ({
    model: "digest-test-model",
    modelOptions: {
      providerOptions: { openrouter: { reasoning: { effort: "low" } } },
    },
  }),
}));
vi.mock("@agent/lib/model/endpoint", () => ({
  modelEndpoint: () => ({ costCurrency: "rub" }),
}));

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
  model.active.value = false;
  model.generate.mockReset();
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

  it("folds nothing into a memory changed after the digest read it", async () => {
    await saveMemory(alice, "scope-a", { text: "Любит суши." }, "s0", source);
    await saveMemory(
      alice,
      "scope-a",
      { text: "Любит суши и роллы." },
      "s1",
      source
    );
    await updateMemory(
      alice,
      "scope-a",
      {
        content: memoryContentSchema.parse({ text: "Не любит рыбу." }),
        expectedRevision: 1,
        index: 1,
      },
      "u1"
    );
    await expect(
      forgetMemory(
        alice,
        "scope-a",
        { expectedRevision: 1, index: 0, keeper: { index: 1, revision: 1 } },
        "digest:merge",
        { action: "merge", actor: "digest" }
      )
    ).rejects.toThrow("Memory changed");
    expect(
      (await listCurrentMemories(alice, "scope-a")).map(
        ({ content }) => content?.text
      )
    ).toEqual(["Любит суши.", "Не любит рыбу."]);
  });

  it("never folds a memory into one with no words", () => {
    const wordless = ["!!!", "???"].map((text, index) => ({
      content: memoryContentSchema.parse({ text }),
      index,
      revision: 1,
    }));
    expect(planDedupe(wordless).drop).toEqual([]);
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
    ).toEqual(Array(12).fill(0));
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

/**
 * The pilot's model step: it may only name records, and code decides what
 * of that holds.
 */
describe("the digest's model, for the pilot", () => {
  /** Saves a memory, dated as of `day`. */
  async function remember(
    index: number,
    content: Parameters<typeof saveMemory>[2],
    day: string
  ) {
    await saveMemory(alice, "scope-a", content, `m${String(index)}`, source);
    await database
      .update(schema.memoryRecords)
      .set({ updatedAt: new Date(`${day}T10:00:00Z`) })
      .where(eq(schema.memoryRecords.index, index));
  }

  function proposes(output: Partial<ModelProposal>) {
    model.generate.mockImplementation(async (options) => {
      await options.onStepEnd?.(paidStep);
      return {
        output: {
          duplicateOf: null,
          oneOff: null,
          supersededBy: null,
          ...output,
        },
      };
    });
  }

  beforeEach(async () => {
    pilot.list.push("*");
    model.active.value = true;
    await remember(0, { text: "Живёт в Казани." }, "2026-09-01");
    await remember(
      1,
      { category: "preference", text: "Не ест свинину." },
      "2026-09-02"
    );
    await remember(2, { category: "rule", text: "Не платить." }, "2026-09-03");
    await remember(
      3,
      { text: "Столик в «Пушкине» на 19:00 в пятницу." },
      "2026-09-04"
    );
    await remember(
      4,
      { text: "Едет в Казань.", validUntil: "2099-10-10T00:00:00Z" },
      "2026-09-05"
    );
    await remember(5, { text: "Живёт в Самаре." }, "2026-10-01");
  });

  it("forgets only a one-off fact, never a preference, a rule or a dated trip", async () => {
    proposes({ oneOff: [1, 2, 3, 4] });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ classifierCalls: 1, oneOff: 1 });
    expect(await texts()).toEqual([
      "Живёт в Казани.",
      "Не ест свинину.",
      "Не платить.",
      "Едет в Казань.",
      "Живёт в Самаре.",
    ]);
    const [oneOff] = await database
      .select()
      .from(schema.memoryRevisions)
      .where(eq(schema.memoryRevisions.action, "one_off"));
    expect(oneOff).toMatchObject({ actor: "digest", recordIndex: 3 });
  });

  it("writes the dated correction itself and keeps the older text restorable", async () => {
    proposes({ supersededBy: [{ newer: 5, older: 0 }] });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ corrected: 1 });
    const left = await texts();
    expect(left).not.toContain("Живёт в Казани.");
    expect(left).toContain(
      "Живёт в Самаре. (с 01.10; раньше: Живёт в Казани.)"
    );
    expect(await historyTexts()).toContain("Живёт в Казани.");
  });

  it("refuses a correction backwards in time and a duplicate that loses words", async () => {
    proposes({
      duplicateOf: [{ index: 3, of: 0 }],
      supersededBy: [{ newer: 0, older: 5 }],
    });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ corrected: 0, deduped: 0 });
    expect(await texts()).toHaveLength(6);
  });

  it("asks the cheap model without reasoning, and records what it cost", async () => {
    proposes({});

    await digestWorkspace(alice.workspaceId, "2026-10-03");

    expect(model.generate).toHaveBeenCalledTimes(1);
    const [options] = model.generate.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      maxOutputTokens: 400,
      providerOptions: { openrouter: { reasoning: { enabled: false } } },
    });
    expect(options?.prompt).not.toContain("Не платить");
    const [cost] = await database.select().from(schema.usageCosts);
    expect(cost).toMatchObject({
      costRub: 0.42,
      sessionId: null,
      source: "memory",
      units: { model: "deepseek/deepseek-v4.1-flash", steps: 1 },
    });
  });

  it("changes nothing on the model's word when the call fails, and keeps the day", async () => {
    model.generate.mockRejectedValue(new Error("upstream"));
    await writeUnfiltered(6, { text: "Код из смс для входа 4821" });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ classifierCalls: 1, oneOff: 0, purged: 1 });
  });

  it("does not ask again when nothing changed since the last digest", async () => {
    proposes({});
    await database.insert(schema.memoryDigestRuns).values({
      finishedAt: new Date("2026-10-02T05:00:00Z"),
      leaseUntil: new Date("2026-10-02T05:15:00Z"),
      localDate: "2026-10-02",
      startedAt: new Date("2026-10-02T04:59:00Z"),
      status: "done",
      workspaceId: alice.workspaceId,
    });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ classifierCalls: 0 });
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("never sends a preference, and keeps a local-only text out of the index", async () => {
    await remember(6, { localOnly: true, text: "Живёт в Уфе." }, "2026-09-20");
    proposes({ supersededBy: [{ newer: 5, older: 6 }] });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ corrected: 0 });
    const [options] = model.generate.mock.calls[0] ?? [];
    expect(options?.prompt).not.toContain("свинину");
    expect(await texts()).toContain("Живёт в Уфе.");
  });

  it("asks about a lone memory, which may be a one-off detail", async () => {
    await database.delete(schema.memoryRecords);
    await remember(
      6,
      { text: "Столик в «Пушкине» на 19:00 в субботу." },
      "2026-10-02"
    );
    proposes({ oneOff: [6] });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ classifierCalls: 1, oneOff: 1 });
    expect(await texts()).toEqual([]);
  });

  it("refuses to merge two things that share no word, or a negation into its opposite", async () => {
    await remember(
      6,
      { category: "person", text: "Маша — сестра." },
      "2026-09-20"
    );
    await remember(
      7,
      { category: "person", text: "Петя — брат." },
      "2026-09-21"
    );
    await remember(8, { text: "Не ест острое." }, "2026-09-22");
    await remember(9, { text: "Ест острое." }, "2026-09-23");
    proposes({
      // Either way round: the keeper may be the negated one.
      duplicateOf: [
        { index: 8, of: 9 },
        { index: 9, of: 8 },
      ],
      supersededBy: [{ newer: 7, older: 6 }],
    });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ corrected: 0, deduped: 0 });
    expect(await texts()).toHaveLength(10);
  });

  it("keeps the aliases of a record it folds", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { aliases: ["дом"], text: "Живёт на улице Ленина, дом 5." },
      "m6",
      source
    );
    await saveMemory(
      alice,
      "scope-a",
      { aliases: ["адрес"], text: "Ленина, дом 5." },
      "m7",
      source
    );
    proposes({ duplicateOf: [{ index: 7, of: 6 }] });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ deduped: 1 });
    const [kept] = await database
      .select()
      .from(schema.memoryRecords)
      .where(eq(schema.memoryRecords.index, 6));
    expect(kept?.content?.aliases).toEqual(["дом", "адрес"]);
  });

  it("records the call's cost even when its answer cannot be read, and asks again next day", async () => {
    model.generate.mockImplementation(async (options) => {
      await options.onStepEnd?.(paidStep);
      throw new Error("No object generated");
    });

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-03")
    ).toMatchObject({ classifierCalls: 1, classifierFailed: 1 });
    expect(await database.select().from(schema.usageCosts)).toHaveLength(1);
    await database.insert(schema.memoryDigestRuns).values({
      finishedAt: new Date("2026-10-03T05:00:00Z"),
      leaseUntil: new Date("2026-10-03T05:15:00Z"),
      localDate: "2026-10-03",
      outcome: { classifierFailed: 1 },
      startedAt: new Date("2026-10-03T04:59:00Z"),
      status: "done",
      workspaceId: alice.workspaceId,
    });
    proposes({});

    expect(
      await digestWorkspace(alice.workspaceId, "2026-10-04")
    ).toMatchObject({ classifierCalls: 1 });
  });

  it("never asks the model outside the pilot", async () => {
    pilot.list.length = 0;
    proposes({ oneOff: [3] });

    await digestWorkspace(alice.workspaceId, "2026-10-03");

    expect(model.generate).not.toHaveBeenCalled();
    expect(await texts()).toHaveLength(6);
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
    expect(saysInFull("Любит суши, когда голоден.", "Любит суши")).toBe(false);
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
