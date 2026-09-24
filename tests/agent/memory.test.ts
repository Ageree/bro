import { PGlite } from "@electric-sql/pglite";
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
  findMemories,
  forgetMemory,
  importLegacyMemories,
  listCurrentMemories,
  readMemory,
  saveMemory,
  updateMemory,
} from "@db/services/memory/records";
import {
  memoryRemovalApproval,
  parseLegacyRecall,
} from "@agent/lib/memory/profile";
import { withApprovalCard } from "@shared/chat/approval-card";
import {
  claimMemorySyncJobs,
  completeMemorySyncJob,
} from "@db/services/memory/sync";

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace-alice" };
const bob = { userId: "bob", workspaceId: "workspace-bob" };

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the transport changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services against an isolated PostgreSQL-compatible database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

beforeEach(async () => {
  await database.delete(schema.workspaces);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("durable profile memory", () => {
  it("persists, searches, corrects, and forgets a typed fact", async () => {
    const saved = await saveMemory(
      alice,
      "scope-a",
      {
        aliases: ["кофе", "morning drink"],
        category: "preference",
        text: "Предпочитает фильтр-кофе без сахара.",
      },
      "session:save",
      { sessionId: "session", turnId: "turn" }
    );
    expect(saved).toMatchObject({ index: 0, revision: 1 });
    expect(
      (await findMemories(alice, "scope-a", { query: "кофе" })).items
    ).toHaveLength(1);

    const correctedContent = {
      aliases: ["кофе"],
      category: "preference" as const,
      localOnly: false,
      relatedIndexes: [],
      text: "Предпочитает эспрессо без сахара.",
      validUntil: null,
    };
    const corrected = await updateMemory(
      alice,
      "scope-a",
      {
        content: correctedContent,
        expectedRevision: 1,
        index: 0,
      },
      "session:update"
    );
    expect(corrected).toMatchObject({ index: 0, revision: 2 });
    await expect(
      updateMemory(
        alice,
        "scope-a",
        {
          content: correctedContent,
          expectedRevision: 1,
          index: 0,
        },
        "session:stale"
      )
    ).rejects.toThrow("changed");

    await forgetMemory(
      alice,
      "scope-a",
      { expectedRevision: 2, index: 0 },
      "session:forget"
    );
    expect(await readMemory(alice, "scope-a", 0)).toBeNull();
    expect(await listCurrentMemories(alice, "scope-a")).toEqual([]);
  });

  it("isolates both the workspace and Eve scope key", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Alice prefers concise answers." },
      "save",
      { sessionId: "session", turnId: "turn" }
    );
    expect(await readMemory(bob, "scope-a", 0)).toBeNull();
    expect(await readMemory(alice, "scope-b", 0)).toBeNull();
  });

  it("rejects obvious credentials before they reach either store", async () => {
    await expect(
      saveMemory(
        alice,
        "scope-a",
        { text: "api_key = sk-super-secret-credential-123456" },
        "unsafe",
        { sessionId: "session", turnId: "turn" }
      )
    ).rejects.toThrow("cannot be saved");
    expect(await listCurrentMemories(alice, "scope-a")).toEqual([]);
  });

  it("replays operations without duplicating records", async () => {
    const input = { text: "Alice lives in Lisbon." };
    const first = await saveMemory(alice, "scope-a", input, "same-call", {
      sessionId: "session",
      turnId: "turn",
    });
    const replay = await saveMemory(alice, "scope-a", input, "same-call", {
      sessionId: "session",
      turnId: "turn",
    });
    expect(replay).toEqual({ index: first.index, revision: first.revision });
    expect(await listCurrentMemories(alice, "scope-a")).toHaveLength(1);
  });

  it("imports legacy indexes once and continues after their largest index", async () => {
    const recalled = [
      "# Persistent memories for profile",
      "",
      "2: Likes trains",
      "7: Speaks Russian",
    ].join("\n");
    const entries = parseLegacyRecall(recalled);
    expect(entries).toEqual([
      { index: 2, text: "Likes trains" },
      { index: 7, text: "Speaks Russian" },
    ]);
    expect(await importLegacyMemories(alice, "scope-a", entries, 7)).toBe(true);
    expect(
      await importLegacyMemories(
        alice,
        "scope-a",
        [{ index: 8, text: "Must not reimport" }],
        8
      )
    ).toBe(false);
    const saved = await saveMemory(
      alice,
      "scope-a",
      { text: "New record" },
      "new",
      { sessionId: "session", turnId: "turn" }
    );
    expect(saved.index).toBe(8);
  });

  it("reclaims expired leases and fences completion after forget", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Alice likes night trains." },
      "save",
      { sessionId: "session", turnId: "turn" }
    );
    const startedAt = new Date("2030-09-21T00:00:00.000Z");
    const [first] = await claimMemorySyncJobs(1, startedAt);
    expect(first).toBeDefined();
    const [reclaimed] = await claimMemorySyncJobs(
      1,
      new Date(startedAt.getTime() + 61_000)
    );
    expect(reclaimed).toBeDefined();
    if (!reclaimed) return;
    await forgetMemory(
      alice,
      "scope-a",
      { expectedRevision: 1, index: 0 },
      "forget"
    );
    expect(await completeMemorySyncJob(reclaimed, "remote-document")).toBe(
      false
    );
    const [sync] = await database.select().from(schema.memorySync);
    expect(sync).toMatchObject({
      desiredPresent: false,
      leaseUntil: null,
      status: "pending",
    });
  });
});

describe("forgetting a memory without the person's word", () => {
  it("forgets what this conversation saved at once and older memories only on a card", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Любит суши." },
      "earlier:save",
      { sessionId: "earlier-session", turnId: "turn" }
    );
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "this:save",
      { sessionId: "this-session", turnId: "turn" }
    );

    // A correction of what this conversation just saved needs no card.
    expect(
      await memoryRemovalApproval(alice, "scope-a", "this-session", {
        index: 1,
      })
    ).toBe("not-applicable");
    // «Удали всё, что ты запомнил в этом разговоре»: a memory from another
    // conversation is not forgotten on the model's reading of that.
    const unnamed = await memoryRemovalApproval(
      alice,
      "scope-a",
      "this-session",
      { index: 0 }
    );
    expect(unnamed).toMatchObject({ type: "denied" });
    // The model is told the text the card will show.
    expect(JSON.stringify(unnamed)).toContain("«Любит суши.»");
    expect(
      await memoryRemovalApproval(alice, "scope-a", "this-session", {
        index: 0,
        text: "Любит роллы.",
      })
    ).toMatchObject({ type: "denied" });
    // Named exactly as it reads, it goes to the person on a card.
    expect(
      await memoryRemovalApproval(alice, "scope-a", "this-session", {
        index: 0,
        text: "  любит  суши. ",
      })
    ).toBe("user-approval");
    // Another workspace's memory is none of this call's business.
    expect(
      await memoryRemovalApproval(bob, "scope-a", "this-session", { index: 0 })
    ).toBe("not-applicable");
  });

  it("keeps an older memory's origin when this conversation corrects it", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Любит суши." },
      "earlier:save",
      { sessionId: "earlier-session", turnId: "turn" }
    );
    // An update here does not make the memory this conversation's own, so
    // update-then-remove cannot forget it without the card.
    await updateMemory(
      alice,
      "scope-a",
      {
        content: {
          aliases: [],
          category: "preference",
          localOnly: false,
          relatedIndexes: [],
          text: "Не любит суши.",
          validUntil: null,
        },
        expectedRevision: 1,
        index: 0,
      },
      "this:update"
    );

    expect(
      await memoryRemovalApproval(alice, "scope-a", "this-session", {
        index: 0,
      })
    ).toMatchObject({ type: "denied" });
    expect(
      await memoryRemovalApproval(alice, "scope-a", "this-session", {
        index: 0,
        text: "Не любит суши.",
      })
    ).toBe("user-approval");
    // The conversation that saved it still corrects its own memory at once.
    expect(
      await memoryRemovalApproval(alice, "scope-a", "earlier-session", {
        index: 0,
      })
    ).toBe("not-applicable");
  });

  it("shows the person the memory's own text on the card", () => {
    const card = withApprovalCard(
      {
        action: {
          input: { index: 0, text: "Любит суши." },
          toolName: "profile__remove_memory",
        },
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: profile__remove_memory",
      },
      "ru"
    );

    expect(card.prompt).toBe("Забыть из памяти:\n«Любит суши.»");
    expect(card.options.map((option) => option.label)).toEqual([
      "Подтвердить",
      "Отмена",
    ]);
  });
});
