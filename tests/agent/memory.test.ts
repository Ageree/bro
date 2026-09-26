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
import profileMemory from "@agent/memory/profile";
import {
  memoryBulkRemovalApproval,
  memoryRemovalApproval,
  parseLegacyRecall,
  renderProfile,
  ruleWriteRefusal,
} from "@agent/lib/memory/profile";
import { withApprovalCard } from "@shared/chat/approval-card";
import { memoryContentSchema } from "@shared/memory/schema";
import { fakeComposio } from "@tests/helpers/composio";
import { afterForgetting } from "@agent/lib/privacy/removal";
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
  it("forgets at the person's word an older memory they named, and only on a card in a turn Bro opened", async () => {
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
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        {
          index: 1,
        }
      )
    ).toBe("not-applicable");
    // «Удали всё, что ты запомнил в этом разговоре»: a memory from another
    // conversation is not forgotten on the model's reading of that.
    const unnamed = await memoryRemovalApproval(
      alice,
      "scope-a",
      personTurn("this-session"),
      { index: 0 }
    );
    expect(unnamed).toMatchObject({ type: "denied" });
    // The model is told the text the memory reads.
    expect(JSON.stringify(unnamed)).toContain("«Любит суши.»");
    expect(
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        {
          index: 0,
          text: "Любит роллы.",
        }
      )
    ).toMatchObject({ type: "denied" });
    // Named exactly as it reads, it goes at once in the person's turn and
    // waits for the card in a turn Bro opened.
    expect(
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        {
          index: 0,
          text: "  любит  суши. ",
        }
      )
    ).toBe("not-applicable");
    expect(
      await memoryRemovalApproval(
        alice,
        "scope-a",
        reportTurn("this-session"),
        {
          index: 0,
          text: "  любит  суши. ",
        }
      )
    ).toBe("user-approval");
    // Another workspace's memory is none of this call's business.
    expect(
      await memoryRemovalApproval(bob, "scope-a", personTurn("this-session"), {
        index: 0,
      })
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
    // update-then-remove cannot forget it without the person naming it.
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
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        {
          index: 0,
        }
      )
    ).toMatchObject({ type: "denied" });
    expect(
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        {
          index: 0,
          text: "Не любит суши.",
        }
      )
    ).toBe("not-applicable");
    // The conversation that saved it still corrects its own memory at once.
    expect(
      await memoryRemovalApproval(
        alice,
        "scope-a",
        personTurn("earlier-session"),
        {
          index: 0,
        }
      )
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

/**
 * RU 25.09 (d14): «удали всё, что ты про меня помнишь» got «одной командой
 * выполнить не могу» and a list to choose from. Every record goes in one
 * call; owner 26.09: at once in the person's own turn, and on one card with
 * each text only in a turn Bro opened.
 */
describe("forgetting everything at once", () => {
  const everything = [
    { index: 0, text: "Любит суши." },
    { index: 1, text: "Без моего ок ничего не оплачивать и никому не писать." },
    { index: 2, text: "Живёт в Казани." },
  ];

  async function saveEverything() {
    await saveMemory(
      alice,
      "scope-a",
      { text: "Любит суши." },
      "earlier:sushi",
      { sessionId: "earlier-session", turnId: "turn" }
    );
    await saveMemory(
      alice,
      "scope-a",
      {
        category: "rule",
        text: "Без моего ок ничего не оплачивать и никому не писать.",
      },
      "earlier:rule",
      { sessionId: "earlier-session", turnId: "turn" }
    );
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "this:city",
      { sessionId: "this-session", turnId: "turn" }
    );
  }

  it("forgets every record at once at the person's word", async () => {
    await saveEverything();

    expect(
      await memoryBulkRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        { records: everything }
      )
    ).toBe("not-applicable");
    // What this conversation saved goes at once, as one record would.
    expect(
      await memoryBulkRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        { records: [{ index: 2, text: "Живёт в Казани." }] }
      )
    ).toBe("not-applicable");
    // A text the record does not have forgets nothing.
    const misnamed = await memoryBulkRemovalApproval(
      alice,
      "scope-a",
      personTurn("this-session"),
      {
        records: [
          { index: 0, text: "Любит роллы." },
          { index: 2, text: "Живёт в Казани." },
        ],
      }
    );
    expect(misnamed).toMatchObject({ type: "denied" });
    expect(JSON.stringify(misnamed)).toContain("0: «Любит суши.»");
    // A report turn takes no rule away, all at once or one by one.
    const fromReport = await memoryBulkRemovalApproval(
      alice,
      "scope-a",
      reportTurn("this-session"),
      { records: everything }
    );
    expect(fromReport).toMatchObject({ type: "denied" });
    expect(JSON.stringify(fromReport)).toContain(
      "only in a turn the user's own message started"
    );

    const card = withApprovalCard(
      {
        action: {
          input: { records: everything },
          toolName: "profile__forget_all",
        },
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: profile__forget_all",
      },
      "ru"
    );
    expect(card.prompt).toBe(
      [
        "Забыть из памяти эти записи:",
        "• «Любит суши.»",
        "• «Без моего ок ничего не оплачивать и никому не писать.»",
        "• «Живёт в Казани.»",
      ].join("\n")
    );
  });

  it("sends a card too long for a messenger back to be split in a turn Bro opened", async () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      index,
      text: `Запись номер ${String(index)}: ${"поезд, нижняя полка, место у окна. ".repeat(3)}`.trim(),
    }));
    for (const { text } of records) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each save takes the next index, and the records name theirs in order.
      await saveMemory(alice, "scope-a", { text }, `earlier:${text}`, {
        sessionId: "earlier-session",
        turnId: "turn",
      });
    }

    const decision = await memoryBulkRemovalApproval(
      alice,
      "scope-a",
      reportTurn("this-session"),
      { records }
    );
    expect(decision).toMatchObject({ type: "denied" });
    expect(JSON.stringify(decision)).toContain("Split the records");
    expect(
      await memoryBulkRemovalApproval(
        alice,
        "scope-a",
        reportTurn("this-session"),
        { records: records.slice(0, 20) }
      )
    ).toBe("user-approval");
    // In the person's own turn no card is shown, so none has to fit.
    expect(
      await memoryBulkRemovalApproval(
        alice,
        "scope-a",
        personTurn("this-session"),
        { records }
      )
    ).toBe("not-applicable");
  });

  it("forgets every record that still reads as the card showed it", async () => {
    await saveEverything();
    // Corrected after the card: the person did not see its new text.
    await updateMemory(
      alice,
      "scope-a",
      {
        content: {
          aliases: [],
          category: "fact",
          localOnly: false,
          relatedIndexes: [],
          text: "Живёт в Самаре.",
          validUntil: null,
        },
        expectedRevision: 1,
        index: 2,
      },
      "this:correct"
    );
    const session = profileToolsContext("this-session");
    const tools = await profileMemory.provider.tools(session);
    if (!tools) throw new Error("Expected profile tools.");

    const result = await tools.forget_all.execute(
      { records: everything },
      { ...session, callId: "forget-all", toolName: "profile__forget_all" }
    );
    expect(result).toMatchObject({ changed: [2], forgotten: [0, 1] });
    // RU d14 (25.09): what stays outside memory, and how each part goes, is
    // told in the same message, without asking whether to remove it.
    expect(result).toMatchObject(afterForgetting());
    const outside = afterForgetting().outsideMemory.join("\n");
    expect(outside).toContain("«удали мой адрес»");
    expect(outside).toContain("«отключи Google»");
    expect(outside).toContain("«останови все расписания»");
    expect(outside).toContain("https://example.com/vault");
    expect(outside).toContain("Историю чатов");
    expect(afterForgetting().reply).toContain("Do not ask whether to remove");
    expect(
      (await listCurrentMemories(alice, "scope-a")).map(
        (record) => record.content?.text
      )
    ).toEqual(["Живёт в Самаре."]);
  });

  // Review of wave 5: «забудь, что я люблю суши и живу в Казани» is not
  // «удали всё», and its reply stays short.
  it("adds the guide to what stays outside memory only once nothing is left", async () => {
    await saveEverything();
    const session = profileToolsContext("this-session");
    const tools = await profileMemory.provider.tools(session);
    if (!tools) throw new Error("Expected profile tools.");

    const partial = await tools.forget_all.execute(
      { records: everything.filter(({ index }) => index !== 1) },
      { ...session, callId: "forget-two", toolName: "profile__forget_all" }
    );
    expect(partial).toMatchObject({ forgotten: [0, 2] });
    expect(partial).not.toHaveProperty("outsideMemory");
    expect(partial).not.toHaveProperty("reply");

    // The last one gone, the store is empty: now the guide comes.
    const rest = await tools.forget_all.execute(
      { records: everything.slice(1, 2) },
      { ...session, callId: "forget-rest", toolName: "profile__forget_all" }
    );
    expect(rest).toMatchObject({ forgotten: [1], ...afterForgetting() });
  });
});

/**
 * In the RU benchmark (d14) «никогда ничего не оплачивай и никому не пиши
 * без моего ок» was not kept anywhere. A rule is saved as one and read back
 * first, as a boundary that only restricts.
 */
describe("the person's rules in the profile", () => {
  it("keeps a stated rule and shows it first, apart from the facts", async () => {
    await saveMemory(
      alice,
      "scope-a",
      { category: "preference", text: "Любит суши." },
      "save:sushi",
      { sessionId: "session", turnId: "turn-1" }
    );
    await saveMemory(
      alice,
      "scope-a",
      {
        category: "rule",
        text: "Никогда ничего не оплачивать и никому не писать без моего ок.",
      },
      "save:rule",
      { sessionId: "session", turnId: "turn-2" }
    );

    const profile = renderProfile(
      await listCurrentMemories(alice, "scope-a")
    ).split("\n");

    expect(profile.slice(2)).toEqual([
      "## Rules the user set",
      expect.stringContaining("a rule only holds you back"),
      "1 (revision 1, rule): Никогда ничего не оплачивать и никому не писать без моего ок.",
      "## The user's preferences",
      expect.stringContaining("name in the reply the ones you applied"),
      "0 (revision 1, preference): Любит суши.",
    ]);
  });

  // Owner 26.09: a request runs without a card now, so the rule is the one
  // thing between «напиши маме» and a sent email.
  it("puts a saved rule above a request that otherwise runs at once", () => {
    const [, , heading, note, rule] = renderProfile([
      currentRecord(0, { category: "rule", text: "Никогда не писать маме." }),
    ]).split("\n");

    expect(heading).toBe("## Rules the user set");
    expect(note).toContain("above a request in the moment");
    expect(note).toContain(
      "check every send, booking, change or payment against these first: what a rule forbids is not done — say which rule holds it back"
    );
    expect(rule).toBe("0 (revision 1, rule): Никогда не писать маме.");
  });

  // RU d14 (25.09): after «никому не пиши без моего ок» Bro never said that
  // Google itself could be narrowed to read-only.
  it("offers read-only Google on a rule against sending, not on other rules", async () => {
    const composio = fakeComposio();
    composio.connect({ toolkit: "googlesuper", userId: alice.userId });
    const session = profileToolsContext("this-session");
    const tools = await profileMemory.provider.tools(session);
    if (!tools) throw new Error("Expected profile tools.");
    const save = (text: string, callId: string) =>
      tools.save_memory.execute(
        memoryContentSchema.parse({ category: "rule", text }),
        {
          ...session,
          callId,
          toolName: "profile__save_memory",
        }
      );

    try {
      expect(
        await save(
          "Никогда ничего не оплачивать и никому не писать без моего ок.",
          "save-rule"
        )
      ).toHaveProperty("note", expect.stringContaining("«только чтение»"));
      expect(
        await save("Ничего не оплачивать без моего ок.", "save-payment-rule")
      ).not.toHaveProperty("note");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reads as it always did while the person has set no rule or preference", () => {
    const profile = renderProfile([
      currentRecord(0, { text: "Живёт в Казани." }),
    ]);

    expect(profile).not.toContain("##");
    expect(profile).toContain("0 (revision 1, fact): Живёт в Казани.");
  });

  /**
   * RU d13 (25.09): «свинину не ем» was in memory, and neither dinner pick
   * a week later filtered by it or said so.
   */
  it("shows preferences apart, as conditions of every pick they bear on", () => {
    const profile = renderProfile([
      currentRecord(0, { text: "Живёт в Казани." }),
      currentRecord(1, {
        category: "preference",
        text: "В поезде только нижняя полка, в самолёте у прохода, свинину не ест.",
      }),
    ]).split("\n");

    expect(profile.slice(2)).toEqual([
      "## The user's preferences",
      "When you recommend, search, book or buy for the user (food, places, trips, seats, gifts), each preference that bears on it is a condition like one named in the message: filter by it, put it into a browser errand, and name in the reply the ones you applied («учёл: без свинины»).",
      "1 (revision 1, preference): В поезде только нижняя полка, в самолёте у прохода, свинину не ест.",
      "## Other records",
      "0 (revision 1, fact): Живёт в Казани.",
    ]);
  });

  it("keeps the rules when the facts no longer fit", () => {
    const profile = renderProfile([
      ...Array.from({ length: 30 }, (_, index) =>
        currentRecord(index, {
          text: `Факт ${String(index)}: ${"подробности ".repeat(40)}`,
        })
      ),
      currentRecord(99, {
        category: "rule",
        text: "Не трогать рабочую почту.",
      }),
    ]);

    expect(profile).toContain(
      "99 (revision 1, rule): Не трогать рабочую почту."
    );
    expect(profile).toContain("More memories exist");
  });
});

/**
 * Review of #191: a rule binds Bro and takes permissions away without a
 * card, so a browser report — an interactive turn whose text the page
 * writes — must not be able to save one, reword it or drop it.
 */
describe("a rule only from the person's own turn", () => {
  const rule = {
    category: "rule" as const,
    text: "Никогда ничего не оплачивать без моего ок.",
  };

  it("keeps a report turn from saving a rule, and lets the person save one", async () => {
    expect(
      await ruleWriteRefusal(alice, "scope-a", reportTurn("session"), {
        category: "rule",
      })
    ).toContain("only in a turn the user's own message started");
    expect(
      await ruleWriteRefusal(alice, "scope-a", personTurn("session"), {
        category: "rule",
      })
    ).toBeUndefined();
    // Other memories are the report turn's to save as before.
    expect(
      await ruleWriteRefusal(alice, "scope-a", reportTurn("session"), {
        category: "fact",
      })
    ).toBeUndefined();
  });

  it("keeps a report turn from rewording a rule or dropping it", async () => {
    await saveMemory(alice, "scope-a", rule, "save:rule", {
      sessionId: "session",
      turnId: "turn-1",
    });
    await saveMemory(
      alice,
      "scope-a",
      { text: "Живёт в Казани." },
      "save:fact",
      { sessionId: "session", turnId: "turn-1" }
    );

    // Turning the rule into a plain fact would unmake it.
    expect(
      await ruleWriteRefusal(alice, "scope-a", reportTurn("session"), {
        category: "fact",
        index: 0,
      })
    ).toContain("Nothing changed");
    expect(
      await ruleWriteRefusal(alice, "scope-a", reportTurn("session"), {
        category: "fact",
        index: 1,
      })
    ).toBeUndefined();
    // The rule was saved in this very conversation, which forgets its own
    // records at once — but not on the page's word.
    expect(
      await memoryRemovalApproval(alice, "scope-a", reportTurn("session"), {
        index: 0,
      })
    ).toMatchObject({ type: "denied" });
    expect(
      await memoryRemovalApproval(alice, "scope-a", personTurn("session"), {
        index: 0,
      })
    ).toBe("not-applicable");
  });
});

/** A turn the person's own message started, in this conversation. */
function personTurn(id: string) {
  return {
    auth: {
      current: {
        attributes: { workspaceId: alice.workspaceId },
        authenticator: "photon-imessage",
        principalId: alice.userId,
        principalType: "user" as const,
      },
      initiator: null,
    },
    id,
  };
}

/** What the profile provider's tools run with, in a person's turn. */
function profileToolsContext(sessionId: string) {
  return {
    abortSignal: new AbortController().signal,
    channel: {},
    getSandbox() {
      throw new Error("Sandbox access is outside this test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this test.");
    },
    getToken() {
      throw new Error("Token access is outside this test.");
    },
    memory: {
      scope: { key: "scope-a", namespace: "test-profile", value: "alice" },
      slot: "profile",
    },
    messages: [],
    model: null,
    requireAuth() {
      throw new Error("Auth access is outside this test.");
    },
    session: {
      ...personTurn(sessionId),
      turn: { id: "turn", sequence: 1 },
    },
    turn: { id: "turn", input: [], sequence: 1 },
  };
}

/** The report of a browser run: interactive, but its text is the page's. */
function reportTurn(id: string) {
  const turn = personTurn(id);
  return {
    ...turn,
    auth: {
      ...turn.auth,
      current: { ...turn.auth.current, authenticator: "browser-result" },
    },
  };
}

/** A current record as recall lists it. */
function currentRecord(
  index: number,
  content: Parameters<typeof memoryContentSchema.parse>[0]
) {
  return {
    content: memoryContentSchema.parse(content),
    index,
    revision: 1,
    updatedAt: "2026-09-24T10:00:00.000Z",
  };
}
