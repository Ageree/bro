import { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  defaultNamespace,
  type MemoryNamespaceContext,
  type MemoryNamespaceDefinition,
  type MemoryScopeContext,
  type MemoryTurnStartedContext,
} from "eve/memory";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
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
// eve does not export the scope key's derivation: its own dist is the reference.
import { createMemoryLock } from "../../node_modules/eve/dist/src/shared/memory-state.js";
import * as Database from "@db";
import * as schema from "@db/schema";
import {
  adoptMemoryRecords,
  forgetMemory,
  listCurrentMemories,
  readMemorySource,
  saveMemory,
} from "@db/services/memory/records";
import {
  adoptWorkstreams,
  forgetWorkstream,
  readWorkstream,
  saveWorkstream,
} from "@db/services/workstreams";
import profileMemory from "@agent/memory/profile";
import workstreamMemory from "@agent/memory/workstreams";
import type * as Environment from "@shared/environment";
import type { WorkstreamContent } from "@shared/workstreams/schema";

// The deployment's VERCEL_ENV as `env` reads it: `env` parses once, at import.
const deployment = vi.hoisted(
  () => new Map<"VERCEL_ENV", "preview" | "production">()
);

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof Environment>();
  return {
    ...original,
    env: {
      ...original.env,
      get VERCEL_ENV() {
        return deployment.get("VERCEL_ENV");
      },
    },
  };
});

const client = new PGlite();
const database = drizzle(client, { schema });
const alice = { userId: "alice", workspaceId: "workspace-alice" };
const lockTurn = { id: "turn", input: [], sequence: 1 };
const vercelSettings = [
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
  "VERCEL_TARGET_ENV",
  "VERCEL_ENV",
  "VERCEL_GIT_COMMIT_REF",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_URL",
  "EVE_INTERNAL_AGENT_WORKSPACE_MEMBER",
];
/** The checkouts the VM's releases were built from before the pin. */
const vmBuildRoots = [
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-server",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-stand",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-ops",
  "/tmp/claude-0/-home-user-bro/099d1748-6700-5603-bdce-48a80a3e9def/scratchpad/wt-rel",
  "/home/user/bro",
];

/** The scope key eve's own lock gives a namespace. */
function eveScopeKey(namespace: string, slot: string) {
  return createMemoryLock({
    namespace,
    scope: alice.workspaceId,
    slot,
    turn: lockTurn,
    visibility: "scope",
  }).scope.key;
}

/** The scope key a VM release built in `appRoot` gave the slot. */
function vmScopeKey(slot: "profile" | "workstreams", appRoot: string) {
  return eveScopeKey(
    defaultNamespace({ appRoot, node: "__root__", slot }),
    slot
  );
}

/** The namespace each slot resolves to off a Vercel preview. */
const pinnedMemoryNamespaces = {
  profile: z.string().parse(
    namespaceOf(profileMemory.namespace, {
      appRoot: "/home/user/bro",
      node: "__root__",
      slot: "profile",
    })
  ),
  workstreams: z.string().parse(
    namespaceOf(workstreamMemory.namespace, {
      appRoot: "/home/user/bro",
      node: "__root__",
      slot: "workstreams",
    })
  ),
};
const pinnedProfileKey = eveScopeKey(pinnedMemoryNamespaces.profile, "profile");
const pinnedWorkstreamsKey = eveScopeKey(
  pinnedMemoryNamespaces.workstreams,
  "workstreams"
);
const vmProfileKeys = vmBuildRoots.map((root) => vmScopeKey("profile", root));
const vmWorkstreamsKeys = vmBuildRoots.map((root) =>
  vmScopeKey("workstreams", root)
);
const [firstVmProfileKey = "", , , releaseProfileKey = ""] = vmProfileKeys;
const lastVmProfileKey = vmProfileKeys.at(-1) ?? "";
const releaseWorkstreamsKey = vmWorkstreamsKeys[3] ?? "";
const lastVmWorkstreamsKey = vmWorkstreamsKeys.at(-1) ?? "";

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the transport changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real schema and services against an isolated PostgreSQL-compatible database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

beforeEach(async () => {
  await database.delete(schema.workspaces);
  for (const name of vercelSettings) vi.stubEnv(name, undefined);
  deployment.clear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await client.exec(
    "DROP TRIGGER IF EXISTS refuse_adoption ON memory_records; DROP FUNCTION IF EXISTS refuse_adoption();"
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

describe("the memory namespaces", () => {
  it("are the ones eve gave the slots on Vercel production", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_EBJG5tSUNetiNjkAB00iwwMjALYT");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    for (const slot of ["profile", "workstreams"] as const) {
      for (const appRoot of ["/vercel/path0", "/home/user/bro"]) {
        expect(defaultNamespace({ appRoot, node: "__root__", slot })).toBe(
          pinnedMemoryNamespaces[slot]
        );
      }
    }
  });

  it("are pinned off Vercel, whatever the build path", () => {
    for (const appRoot of ["/home/user/bro", "/srv/bro/releases/next"]) {
      expect(
        namespaceOf(profileMemory.namespace, {
          appRoot,
          node: "__root__",
          slot: "profile",
        })
      ).toBe(pinnedMemoryNamespaces.profile);
      expect(
        namespaceOf(workstreamMemory.namespace, {
          appRoot,
          node: "__root__",
          slot: "workstreams",
        })
      ).toBe(pinnedMemoryNamespaces.workstreams);
    }
  });

  it("stay eve's own on a Vercel preview, apart from people's memory", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_EBJG5tSUNetiNjkAB00iwwMjALYT");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "claude/some-branch");
    deployment.set("VERCEL_ENV", "preview");
    const context = {
      appRoot: "/vercel/path0",
      node: "__root__",
      slot: "profile",
    };
    const preview = namespaceOf(profileMemory.namespace, context);
    expect(preview).toBe(defaultNamespace(context));
    expect(preview).toContain("claude/some-branch");
    expect(preview).not.toBe(pinnedMemoryNamespaces.profile);
  });
});

describe("adopting the profile saved after the move", () => {
  it("moves every current record once, skipping what the profile already holds", async () => {
    const before = { sessionId: "vercel-session", turnId: "turn" };
    const after = { sessionId: "vm-session", turnId: "turn" };
    await saveMemory(
      alice,
      pinnedProfileKey,
      { category: "preference", text: "Любит «тёплое» молоко." },
      "vercel:1",
      before
    );
    await saveMemory(
      alice,
      pinnedProfileKey,
      { category: "rule", text: "Никогда не пиши маме." },
      "vercel:2",
      before
    );
    // Saved again on the VM, which could not see it: the same memory.
    await saveMemory(
      alice,
      lastVmProfileKey,
      { category: "preference", text: "любит тёплое   молоко." },
      "vm:1",
      after
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "Сестра — Маша.", relatedIndexes: [2] },
      "vm:2",
      after
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { category: "person", text: "Маша живёт в Казани." },
      "vm:3",
      after
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { category: "rule", text: "Без моего ок ничего не оплачивай." },
      "vm:4",
      after
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "Забытое." },
      "vm:5",
      after
    );
    await forgetMemory(alice, lastVmProfileKey, { index: 4 }, "vm:forget");

    expect(
      await adoptMemoryRecords(alice, [lastVmProfileKey], pinnedProfileKey)
    ).toBe(3);

    const adopted = await listCurrentMemories(alice, pinnedProfileKey);
    expect(adopted.map(({ content, index }) => [index, content?.text])).toEqual(
      [
        [0, "Любит «тёплое» молоко."],
        [1, "Никогда не пиши маме."],
        [2, "Без моего ок ничего не оплачивай."],
        [3, "Сестра — Маша."],
        [4, "Маша живёт в Казани."],
      ]
    );
    // The related record follows its new index.
    expect(adopted[3]?.content?.relatedIndexes).toEqual([4]);
    // Nothing of the copy to merge: the record stays as it was.
    expect(adopted[0]?.revision).toBe(1);
    expect(await readMemorySource(alice, pinnedProfileKey, 3)).toMatchObject({
      sourceSessionId: "vm-session",
    });
    expect(await listCurrentMemories(alice, lastVmProfileKey)).toEqual([]);

    // A new memory continues after the adopted ones.
    expect(
      await saveMemory(
        alice,
        pinnedProfileKey,
        { text: "Новое." },
        "new",
        before
      )
    ).toMatchObject({ index: 5 });

    const sync = await database
      .select()
      .from(schema.memorySync)
      .where(eq(schema.memorySync.workspaceId, alice.workspaceId));
    const queued = (key: string) =>
      sync
        .filter((row) => row.scopeKey === key)
        .map((row) => [row.recordIndex, row.desiredPresent])
        .toSorted(([left], [right]) => Number(left) - Number(right));
    expect(queued(pinnedProfileKey)).toEqual([
      [0, true],
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
    ]);
    // The VM's copies leave the semantic index.
    expect(queued(lastVmProfileKey)).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);

    expect(
      await adoptMemoryRecords(alice, [lastVmProfileKey], pinnedProfileKey)
    ).toBe(0);
    expect(await listCurrentMemories(alice, pinnedProfileKey)).toHaveLength(6);
  });

  it("gathers every VM release's key once, merging what a copy adds", async () => {
    const vm = { sessionId: "vm", turnId: "turn" };
    await saveMemory(
      alice,
      pinnedProfileKey,
      {
        aliases: ["веган"],
        text: "Не ест мясо.",
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      "vercel:0",
      { sessionId: "vercel", turnId: "turn" }
    );
    // The person asked on the VM to keep it out of the semantic index.
    await saveMemory(
      alice,
      firstVmProfileKey,
      {
        aliases: ["вегетарианец"],
        localOnly: true,
        text: "Не ест  мясо.",
      },
      "vm:0",
      vm
    );
    await saveMemory(
      alice,
      releaseProfileKey,
      { text: "Работает в Яндексе." },
      "vm:1",
      vm
    );
    // Saved again by a later release, which could not see the earlier one.
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "работает в яндексе." },
      "vm:2",
      vm
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "Есть собака Буся.", relatedIndexes: [0] },
      "vm:3",
      vm
    );

    expect(
      await adoptMemoryRecords(alice, vmProfileKeys, pinnedProfileKey)
    ).toBe(2);
    const adopted = await listCurrentMemories(alice, pinnedProfileKey);
    expect(adopted.map(({ content, index }) => [index, content?.text])).toEqual(
      [
        [0, "Не ест мясо."],
        [1, "Работает в Яндексе."],
        [2, "Есть собака Буся."],
      ]
    );
    expect(adopted[0]).toMatchObject({
      content: {
        aliases: ["веган", "вегетарианец"],
        localOnly: true,
        validUntil: null,
      },
      revision: 2,
    });
    // Index 0 of the last release was its copy of «Работает в Яндексе.».
    expect(adopted[2]?.content?.relatedIndexes).toEqual([1]);
    const pinnedSync = await database
      .select()
      .from(schema.memorySync)
      .where(
        and(
          eq(schema.memorySync.scopeKey, pinnedProfileKey),
          eq(schema.memorySync.recordIndex, 0)
        )
      );
    // The merged record leaves the semantic index, and nothing re-adds it.
    expect(
      pinnedSync.map(({ desiredPresent, revision }) => [
        revision,
        desiredPresent,
      ])
    ).toEqual([
      [1, false],
      [2, false],
    ]);
    for (const key of vmProfileKeys) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A handful of scopes, read in order.
      expect(await listCurrentMemories(alice, key)).toEqual([]);
    }
    expect(
      await adoptMemoryRecords(alice, vmProfileKeys, pinnedProfileKey)
    ).toBe(0);
  });

  it("moves rules first and leaves what does not fit for later", async () => {
    await saveMemory(
      alice,
      pinnedProfileKey,
      { text: "Первая запись." },
      "vercel:0",
      { sessionId: "vercel", turnId: "turn" }
    );
    await database.insert(schema.memoryRecords).values(
      Array.from({ length: 248 }, (_, offset) => ({
        content: {
          aliases: [],
          category: "fact" as const,
          localOnly: false,
          relatedIndexes: [],
          text: `Факт ${String(offset)}.`,
          validUntil: null,
        },
        generation: 1,
        index: offset + 1,
        lastOperationId: `fill:${String(offset)}`,
        revision: 1,
        scopeKey: pinnedProfileKey,
        workspaceId: alice.workspaceId,
      }))
    );
    await database
      .update(schema.memoryScopes)
      .set({ lastAllocatedIndex: 248 })
      .where(
        and(
          eq(schema.memoryScopes.workspaceId, alice.workspaceId),
          eq(schema.memoryScopes.scopeKey, pinnedProfileKey)
        )
      );
    const vm = { sessionId: "vm", turnId: "turn" };
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "Живёт в Москве." },
      "vm:0",
      vm
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { category: "rule", text: "Не трогай рабочую почту." },
      "vm:1",
      vm
    );

    expect(
      await adoptMemoryRecords(alice, vmProfileKeys, pinnedProfileKey)
    ).toBe(1);
    expect(
      (await listCurrentMemories(alice, pinnedProfileKey)).at(-1)?.content
    ).toMatchObject({ category: "rule", text: "Не трогай рабочую почту." });
    expect(
      (await listCurrentMemories(alice, lastVmProfileKey)).map(
        ({ content }) => content?.text
      )
    ).toEqual(["Живёт в Москве."]);
    expect(
      await adoptMemoryRecords(alice, vmProfileKeys, pinnedProfileKey)
    ).toBe(0);

    await forgetMemory(alice, pinnedProfileKey, { index: 0 }, "forget");
    expect(
      await adoptMemoryRecords(alice, vmProfileKeys, pinnedProfileKey)
    ).toBe(1);
    expect(await listCurrentMemories(alice, lastVmProfileKey)).toEqual([]);
  });

  it("adopts every VM release's records in the turn's recall, only for the pinned namespace", async () => {
    for (const [position, key] of vmProfileKeys.entries()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Saved in order.
      await saveMemory(
        alice,
        key,
        { text: `Запись релиза ${String(position)}.` },
        `vm:${String(position)}`,
        { sessionId: "vm", turnId: "turn" }
      );
    }
    const elsewhere = await profileMemory.provider.recall["turn.started"](
      recallContext({
        key: "preview-key",
        namespace: "preview-namespace",
        slot: "profile",
      })
    );
    expect(elsewhere?.messages[0]?.content).not.toContain("Запись релиза");
    expect(await listCurrentMemories(alice, lastVmProfileKey)).toHaveLength(1);

    const recalled = await profileMemory.provider.recall["turn.started"](
      recallContext({
        key: pinnedProfileKey,
        namespace: pinnedMemoryNamespaces.profile,
        slot: "profile",
      })
    );
    for (const position of vmBuildRoots.keys()) {
      expect(recalled?.messages[0]?.content).toContain(
        `Запись релиза ${String(position)}.`
      );
    }
    for (const key of vmProfileKeys) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- A handful of scopes, read in order.
      expect(await listCurrentMemories(alice, key)).toEqual([]);
    }
  });

  it("recalls the profile when adoption fails, and adopts on a later turn", async () => {
    await saveMemory(
      alice,
      pinnedProfileKey,
      { text: "Любит суши." },
      "vercel:0",
      { sessionId: "vercel", turnId: "turn" }
    );
    await saveMemory(
      alice,
      lastVmProfileKey,
      { text: "Живёт в Казани." },
      "vm:0",
      { sessionId: "vm", turnId: "turn" }
    );
    await client.exec(`
      CREATE FUNCTION refuse_adoption() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'adoption refused';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER refuse_adoption BEFORE INSERT ON memory_records
        FOR EACH ROW WHEN (NEW.last_operation_id LIKE 'adopt:%')
        EXECUTE FUNCTION refuse_adoption();
    `);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const context = recallContext({
      key: pinnedProfileKey,
      namespace: pinnedMemoryNamespaces.profile,
      slot: "profile",
    });

    const recalled =
      await profileMemory.provider.recall["turn.started"](context);
    expect(recalled?.messages[0]?.content).toContain("Любит суши.");
    expect(recalled?.messages[0]?.content).not.toContain("Казани");
    expect(warn).toHaveBeenCalledWith(
      "[memory] adopting the VM's memory failed",
      expect.objectContaining({
        slot: "profile",
        workspaceId: alice.workspaceId,
      })
    );
    // The log carries no memory text.
    expect(JSON.stringify(warn.mock.calls)).not.toContain("Казани");
    expect(await listCurrentMemories(alice, lastVmProfileKey)).toHaveLength(1);

    await client.exec(
      "DROP TRIGGER refuse_adoption ON memory_records; DROP FUNCTION refuse_adoption();"
    );
    const later = await profileMemory.provider.recall["turn.started"](context);
    expect(later?.messages[0]?.content).toContain("Живёт в Казани.");
    warn.mockRestore();
  });
});

describe("adopting the workstreams saved after the move", () => {
  const trip = workstream("Autumn trip");
  it("moves current work once, renaming an ID the pinned scope uses", async () => {
    await saveWorkstream(
      alice,
      pinnedWorkstreamsKey,
      { content: trip, expectedRevision: 0, id: "autumn-trip" },
      "vercel:1",
      "vercel-session"
    );
    await saveWorkstream(
      alice,
      pinnedWorkstreamsKey,
      { content: workstream("Old plan"), expectedRevision: 0, id: "old-plan" },
      "vercel:2",
      "vercel-session"
    );
    await forgetWorkstream(
      alice,
      pinnedWorkstreamsKey,
      { expectedRevision: 1, id: "old-plan" },
      "vercel:3"
    );
    const vmTrip = { ...trip, nextStep: "Pay for the 09:00 train." };
    for (const [id, content] of [
      ["autumn-trip", vmTrip],
      ["old-plan", workstream("New plan")],
      // Saved word for word again on the VM: the same work.
      ["trip-copy", trip],
      ["dentist", workstream("Dentist")],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Saved in order.
      await saveWorkstream(
        alice,
        lastVmWorkstreamsKey,
        { content, expectedRevision: 0, id },
        `vm:${id}`,
        "vm-session"
      );
    }
    await forgetWorkstream(
      alice,
      lastVmWorkstreamsKey,
      { expectedRevision: 1, id: "dentist" },
      "vm:forget"
    );

    expect(
      await adoptWorkstreams(alice, vmWorkstreamsKeys, pinnedWorkstreamsKey)
    ).toBe(2);
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "autumn-trip")
    ).toMatchObject({ content: trip, sessionId: "vercel-session" });
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "autumn-trip-2")
    ).toMatchObject({ content: vmTrip, revision: 1, sessionId: "vm-session" });
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "old-plan")
    ).toBeNull();
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "old-plan-2")
    ).toMatchObject({ content: { title: "New plan" } });
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "trip-copy")
    ).toBeNull();
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "dentist")
    ).toBeNull();
    const left = await database
      .select()
      .from(schema.workstreams)
      .where(eq(schema.workstreams.scopeKey, lastVmWorkstreamsKey));
    expect(left.filter(({ content }) => content !== null)).toEqual([]);

    expect(
      await adoptWorkstreams(alice, vmWorkstreamsKeys, pinnedWorkstreamsKey)
    ).toBe(0);
  });

  it("moves the newest work first when the cap leaves room for only some", async () => {
    await saveWorkstream(
      alice,
      pinnedWorkstreamsKey,
      { content: trip, expectedRevision: 0, id: "autumn-trip" },
      "vercel:0",
      "vercel-session"
    );
    await database.insert(schema.workstreams).values(
      Array.from({ length: 98 }, (_, offset) => ({
        content: workstream(`Vercel ${String(offset)}`),
        id: `vercel-${String(offset)}`,
        lastOperationId: `fill:${String(offset)}`,
        revision: 1,
        scopeKey: pinnedWorkstreamsKey,
        workspaceId: alice.workspaceId,
      }))
    );
    for (const [key, id, updatedAt] of [
      [releaseWorkstreamsKey, "older", "2026-10-02T10:00:00Z"],
      [lastVmWorkstreamsKey, "newest", "2026-10-02T22:10:00Z"],
    ] as const) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Saved in order.
      await database.insert(schema.workstreams).values({
        content: workstream(id),
        id,
        lastOperationId: `vm:${id}`,
        revision: 1,
        scopeKey: key,
        updatedAt: new Date(updatedAt),
        workspaceId: alice.workspaceId,
      });
    }

    expect(
      await adoptWorkstreams(alice, vmWorkstreamsKeys, pinnedWorkstreamsKey)
    ).toBe(1);
    expect(
      await readWorkstream(alice, pinnedWorkstreamsKey, "newest")
    ).toMatchObject({ content: { title: "newest" } });
    expect(
      await readWorkstream(alice, releaseWorkstreamsKey, "older")
    ).toMatchObject({ content: { title: "older" } });
    // Full: nothing more to do, and nothing is locked to find that out.
    expect(
      await adoptWorkstreams(alice, vmWorkstreamsKeys, pinnedWorkstreamsKey)
    ).toBe(0);
  });

  it("adopts in the turn's recall", async () => {
    await saveWorkstream(
      alice,
      releaseWorkstreamsKey,
      { content: trip, expectedRevision: 0, id: "autumn-trip" },
      "vm:1",
      "vm-session"
    );
    const recalled = await workstreamMemory.provider.recall["turn.started"](
      recallContext({
        key: pinnedWorkstreamsKey,
        namespace: pinnedMemoryNamespaces.workstreams,
        slot: "workstreams",
      })
    );
    expect(recalled?.messages[0]?.content).toContain("Autumn trip");
    expect(
      await readWorkstream(alice, releaseWorkstreamsKey, "autumn-trip")
    ).toBeNull();
  });
});

/** What a slot's `namespace` gives in `context`. */
function namespaceOf(
  definition: MemoryNamespaceDefinition | undefined,
  context: MemoryNamespaceContext
) {
  return definition instanceof Function ? definition(context) : definition;
}

function workstream(title: string): WorkstreamContent {
  return {
    nextStep: "Choose a departure.",
    notes: "Nothing booked.",
    objective: `Finish: ${title}.`,
    sources: [],
    status: "active",
    title,
  };
}

/** A person's turn as recall sees it, under the given scope. */
function recallContext(memory: {
  key: string;
  namespace: string;
  slot: string;
}) {
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
      scope: {
        key: memory.key,
        namespace: memory.namespace,
        value: alice.workspaceId,
      },
      slot: memory.slot,
    },
    messages: [],
    operationId: "recall",
    requireAuth() {
      throw new Error("Auth access is outside this test.");
    },
    session: {
      auth: {
        current: {
          attributes: { workspaceId: alice.workspaceId },
          authenticator: "photon-imessage",
          principalId: alice.userId,
          principalType: "user" as const,
        },
        initiator: null,
      },
      id: "session",
      turn: { id: "turn", sequence: 1 },
    },
    turn: { id: "turn", input: [], sequence: 1 },
  } satisfies MemoryTurnStartedContext &
    MemoryScopeContext &
    Pick<ToolContext, "getToken" | "requireAuth">;
}
