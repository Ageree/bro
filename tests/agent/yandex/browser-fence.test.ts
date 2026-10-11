import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type { ModelMessage } from "ai";
import type * as ai from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserClient from "@agent/lib/browser-use/client";
import type * as browserFacts from "@agent/lib/browser-use/facts";
import type * as browserSecrets from "@agent/lib/browser-use/secrets";
import type * as browserCdp from "@agent/lib/browser-use/cdp";
import type { ConfirmedSubmission } from "@shared/browser/submission";
import type { AccessScope } from "@shared/identity/access-scope";
import * as schema from "@db/schema";

const external = vi.hoisted(() => ({
  cancel: vi.fn<typeof browserClient.cancelBrowserUseRun>(
    async (id: string) => ({
      id,
      sessionId: "synthetic-session",
      status: "cancelled",
      task: "",
    })
  ),
  create: vi.fn<typeof browserClient.createBrowserUseRun>(() =>
    Promise.reject(new Error("Unexpected external work"))
  ),
  queue: vi.fn<typeof browserClient.queueBrowserUseSessionMessage>(() =>
    Promise.reject(new Error("Unexpected external work"))
  ),
  find: vi.fn<typeof browserClient.findBrowserUseSessionCdpUrl>(
    async () => undefined
  ),
  type: vi.fn<typeof browserCdp.typeOneTimeCodeOverCdp>(() =>
    Promise.reject(new Error("Unexpected OTP typing"))
  ),
  lookup: vi.fn<typeof browserClient.findRecentBrowserUseRunByTaskLine>(
    async () => undefined
  ),
}));

vi.mock("@agent/lib/browser-use/client", async (original) => ({
  ...(await original<typeof browserClient>()),
  browserUseConfigured: () => true,
  browserUseCloudConfigured: () => true,
  createBrowserUseRun: external.create,
  queueBrowserUseSessionMessage: external.queue,
  readBrowserUseRunStatus: async () => "running",
  findBrowserUseSessionCdpUrl: external.find,
  findRecentBrowserUseRunByTaskLine: external.lookup,
  readBrowserUseRun: async (id: string) => ({
    id,
    sessionId: "synthetic-session",
    status: "done",
    task: "Закажи воду",
  }),
  cancelBrowserUseRun: external.cancel,
  listBrowserUseRunEvents: async () => {
    throw new Error("Synthetic events unavailable");
  },
}));
vi.mock("@agent/lib/browser-use/cdp", async (original) => ({
  ...(await original<typeof browserCdp>()),
  typeOneTimeCodeOverCdp: external.type,
}));
vi.mock("@agent/lib/browser-use/facts", async (original) => ({
  ...(await original<typeof browserFacts>()),
  readOwnContacts: async () => ({ emails: [], phones: [] }),
  browserRunFacts: async () => ({
    addresses: [],
    details: undefined,
    home: "",
  }),
}));
vi.mock("ai", async (original) => ({
  ...(await original<typeof ai>()),
  generateText: vi.fn<() => Promise<{ output: { matches: boolean } }>>(
    async () => ({ output: { matches: true } })
  ),
}));
vi.mock("@agent/lib/browser-use/secrets", async (original) => ({
  ...(await original<typeof browserSecrets>()),
  resolveBrowserSecretBindings: async () => ({ aliases: [], bindings: [] }),
}));

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };
const runId = "queued:synthetic-order";
const submission = {
  amount: "354 ₽",
  chargeRub: 354,
  forWhom: "Алиса",
  items: ["Вода × 1"],
  kind: "order",
  paymentCapRub: 354,
  personalData: [],
  what: "заказ воды",
  where: "Яндекс Лавка",
} satisfies ConfirmedSubmission;

beforeEach(() => {
  vi.stubEnv("YANDEX_API_WORKSPACES", "workspace:alice");
  vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "workspace:alice");
  external.lookup.mockReset();
  external.lookup.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@db");
  vi.doUnmock("@db/services/scope");
  vi.clearAllMocks();
  vi.stubEnv("YANDEX_API_WORKSPACES", "");
  vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
  await Promise.all(databases.splice(0).map((client) => client.close()));
});

async function database() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  const migrations = await Promise.all(
    names.map((name) => readFile(new URL(name, directory), "utf8"))
  );
  await migrations.reduce(async (previous, migration) => {
    await previous;
    await client.exec(migration);
  }, Promise.resolve());
  const db = drizzle(client, { schema });
  vi.doMock("@db", () => ({ ...schema, db }));
  vi.doMock("@db/services/scope", () => ({
    ensureScope: async (scope: AccessScope) => {
      await db
        .insert(schema.workspaces)
        .values({ id: scope.workspaceId })
        .onConflictDoNothing();
      await db
        .insert(schema.workspaceMemberships)
        .values({ ...scope, role: "owner" })
        .onConflictDoNothing();
    },
  }));
  const spending = await import("@db/services/spending");
  const purchases = await import("@db/services/yandex-purchases");
  return { db, spending, purchases };
}

async function quote(test: Awaited<ReturnType<typeof database>>) {
  const created = await test.purchases.createYandexPurchase(alice, {
    amountMinor: 35_400,
    checkoutKey: "synthetic-cart",
    confirmationQuestion: "Заказ воды за 354 ₽. Оплачиваю?",
    currency: "RUB",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    fingerprint: "synthetic-cart-version",
    providerSnapshot: { cartId: "synthetic-cart" },
    publicQuote: { amountMinor: 35_400 },
    rootSessionId: "session-1",
    service: "lavka",
  });
  if (created.kind === "blocked") throw new Error("Expected quote");
  return {
    callId: "purchase-call",
    confirmationQuestion: created.purchase.confirmationQuestion,
    id: created.purchase.id,
    rootSessionId: "session-1",
  };
}

function reservation(browserRunId = runId) {
  return {
    amountRub: 354,
    browserRunId,
    category: "order",
    merchant: "lavka.yandex.ru",
    periodKey: "2026-10",
    source: "card" as const,
  };
}

async function pendingPurchase(
  test: Awaited<ReturnType<typeof database>>,
  state: "submitting" | "unknown"
) {
  const input = await quote(test);
  expect(await test.purchases.claimYandexPurchase(alice, input)).toMatchObject({
    kind: "claimed",
  });
  if (state === "unknown") {
    await test.purchases.settleYandexPurchase(alice, {
      ...input,
      outcome: { kind: "unknown" },
      state,
    });
  }
}

async function queuedBrowser(test: Awaited<ReturnType<typeof database>>) {
  await test.spending.updateSpendLimit(alice, () => ({
    currency: "RUB",
    excludedCategories: [],
    excludedMerchants: [],
    rules: [{ category: null, limitRub: 5000, merchant: null }],
    version: 1,
  }));
  await test.db.insert(schema.browserRuns).values({
    conversationChannel: "eve",
    conversationId: "session-1",
    createdByUserId: alice.userId,
    id: runId,
    paymentAllowed: true,
    rootSessionId: "session-1",
    site: "https://lavka.yandex.ru",
    status: "queued",
    submission,
    task: "Закажи воду",
    workspaceId: alice.workspaceId,
  });
}

function unused(): never {
  throw new Error("Unexpected capability");
}

async function continueBrowser(freshConsent = false, task = "Продолжай") {
  const tools = (await import("@agent/tools/browser_task")).default;
  const current = {
    attributes: { conversationChannel: "eve", workspaceId: alice.workspaceId },
    authenticator: "authjs",
    principalId: alice.userId,
    principalType: "user" as const,
  };
  const session = { auth: { current, initiator: null }, id: "session-1" };
  const messages: ModelMessage[] = freshConsent
    ? [
        { role: "user", content: "Закажи воду" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "ask",
              toolName: "send_message",
              input: { text: "Заказ воды за 354 ₽. Оплачиваю?" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "ask",
              toolName: "send_message",
              output: { type: "text", value: "submitted" },
            },
          ],
        },
        { role: "user", content: "да" },
      ]
    : [{ role: "user", content: task }];
  const context: DynamicResolveContext = {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session,
  };
  const resolved = await tools.events["step.started"]?.({}, context);
  if (!resolved || !("browser_task" in resolved)) throw new Error("No tool");
  const call: ToolContext = {
    abortSignal: new AbortController().signal,
    callId: "browser-call",
    getSandbox: unused,
    getSkill: unused,
    getToken: unused,
    requireAuth: unused,
    session: { ...session, turn: { id: "turn-1", sequence: 1 } },
    toolName: "browser_task",
  };
  return resolved.browser_task.execute(
    {
      action: "continue",
      allowSubmit: freshConsent ? true : undefined,
      personSaid: freshConsent ? "да" : task,
      personWants: "look",
      runId,
      submission: freshConsent ? submission : undefined,
      task: freshConsent ? "да" : task,
    },
    call
  );
}

async function assertUnresolvedAfterReconciliation(
  test: Awaited<ReturnType<typeof database>>,
  input: Awaited<ReturnType<typeof quote>>
) {
  const { reconcileSpendReservations } =
    await import("@agent/lib/browser-use/spend");
  await reconcileSpendReservations(new Date(Date.now() + 3 * 24 * 60 * 60_000));
  await test.spending.releaseAbandonedSpendReservations(
    new Date(Date.now() + 7 * 24 * 60 * 60_000)
  );
  const [held] = await test.db.select().from(schema.spendEntries);
  expect(held?.status).toBe("reserved");
  expect(held?.browserRunId).toMatch(/^pending:dispatch:/u);
  const purchase = await test.purchases.readYandexPurchase(alice, input);
  expect(purchase?.state).toBe("quoted");
  expect(purchase?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  expect(await test.purchases.claimYandexPurchase(alice, input)).toEqual({
    kind: "unavailable",
  });
  await expect(
    test.spending.reserveConsentPayment(alice, reservation("replacement"))
  ).rejects.toThrow(/browser payment/i);
  await expect(
    test.spending.reserveAutoPayment(alice, {
      browserRunId: "replacement-limit",
      periodKey: "2026-10",
      request: {
        amount: 354,
        fee: 0,
        currency: "RUB",
        category: "order",
        merchant: "lavka.yandex.ru",
        recurring: false,
      },
    })
  ).rejects.toThrow(/browser payment/i);
  await expect(
    test.spending.moveSpendReservation(runId, "pending:dispatch:replacement", {
      scope: alice,
      amountRub: 354,
    })
  ).rejects.toThrow(/browser payment/i);
}

async function automaticBrowser(
  test: Awaited<ReturnType<typeof database>>,
  kind: "queue" | "captcha"
) {
  await queuedBrowser(test);
  await test.db
    .update(schema.browserRuns)
    .set({
      status: kind === "queue" ? "queued" : "waiting",
      sessionId: "synthetic-session",
      profileId: "synthetic-profile",
      queueRevision: 2,
      captchaAttempt: 4,
      completedAt: kind === "captcha" ? new Date() : null,
      outcome: kind === "captcha" ? "Needs: captcha" : null,
      browserReleasedAt: kind === "captcha" ? new Date() : null,
    })
    .where(eq(schema.browserRuns.id, runId));
  await test.spending.reserveConsentPayment(alice, reservation());
}

async function dispatchTick(
  test: Awaited<ReturnType<typeof database>>,
  kind: "queue" | "captcha",
  now = new Date()
) {
  const [row] = await test.db
    .select()
    .from(schema.browserRuns)
    .where(eq(schema.browserRuns.id, runId));
  if (!row) throw new Error("Missing original run");
  return kind === "queue"
    ? (await import("@agent/lib/browser-use/queue")).startQueuedBrowserRun(
        row,
        now
      )
    : (await import("@agent/lib/browser-use/captcha-retry")).startCaptchaRetry(
        row,
        now
      );
}

describe("the shared Yandex/browser payment fence", () => {
  it("returns the reservation transfer result without relaxing the strict default", async () => {
    const test = await database();
    await test.spending.reserveConsentPayment(alice, reservation());
    await expect(
      test.spending.moveSpendReservation(runId, "pending:continuation", {
        scope: alice,
        amountRub: 354,
      })
    ).resolves.toBe(true);
    await expect(
      test.spending.moveSpendReservation("missing", "pending:legacy", {
        scope: alice,
        amountRub: 0,
        requireReservation: false,
      })
    ).resolves.toBe(false);
    await expect(
      test.spending.moveSpendReservation("missing", "pending:strict", {
        scope: alice,
        amountRub: 0,
      })
    ).rejects.toThrow("Old consent cannot authorize another charge");
    expect(await test.db.select().from(schema.spendEntries)).toMatchObject([
      { browserRunId: "pending:continuation", status: "reserved" },
    ]);
  }, 60_000);

  it.each(["submitting", "unknown"] as const)(
    "blocks both reservation sources behind %s even with purchase flags off",
    async (state) => {
      const test = await database();
      await pendingPurchase(test, state);
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      await test.spending.updateSpendLimit(alice, () => ({
        currency: "RUB",
        excludedCategories: [],
        excludedMerchants: [],
        rules: [{ category: null, limitRub: 5000, merchant: null }],
        version: 1,
      }));
      await expect(
        test.spending.reserveConsentPayment(alice, reservation())
      ).rejects.toThrow("Yandex purchase may already have been placed");
      await expect(
        test.spending.reserveAutoPayment(alice, {
          browserRunId: runId,
          periodKey: "2026-10",
          request: {
            amount: 354,
            category: "order",
            currency: "RUB",
            fee: 0,
            merchant: "lavka.yandex.ru",
            recurring: false,
          },
        })
      ).rejects.toThrow("Yandex purchase may already have been placed");
      expect(await test.db.select().from(schema.spendEntries)).toHaveLength(0);
      expect(
        await test.spending.reserveConsentPayment(bob, reservation("other"))
      ).toEqual({ allowed: true });
    },
    30_000
  );

  it("preserves a nonpilot live paid continuation without a sticky unknown marker", async () => {
    vi.stubEnv("YANDEX_API_WORKSPACES", "");
    vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
    const test = await database();
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.db
      .update(schema.browserRuns)
      .set({ sessionId: "synthetic-session", status: "running" })
      .where(eq(schema.browserRuns.id, runId));
    external.queue.mockResolvedValue({
      id: 1,
      sessionId: "synthetic-session",
      status: "pending",
    });
    expect(await continueBrowser()).toMatchObject({ status: "running" });
    expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
      status: "reserved",
    });
    expect(
      (await test.db.select().from(schema.spendEntries)).some((entry) =>
        entry.browserRunId.startsWith("pending:dispatch:")
      )
    ).toBe(false);
  }, 60_000);

  it("blocks a nonpilot continuation after a pilot dispatch marker survives disabling the flags", async () => {
    const test = await database();
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.spending.moveSpendReservation(
      runId,
      "pending:dispatch:uncertain",
      { scope: alice, amountRub: 354 }
    );
    vi.stubEnv("YANDEX_API_WORKSPACES", "");
    vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
    vi.resetModules();
    await expect(continueBrowser()).rejects.toThrow(/browser payment/i);
    expect(external.queue).not.toHaveBeenCalled();
    expect(external.create).not.toHaveBeenCalled();
  }, 60_000);

  it.each(["queue", "captcha"] as const)(
    "%s holds a lost paid-create response across empty lookup, flag-off and expired retry windows",
    async (kind) => {
      const test = await database();
      const input = await quote(test);
      await automaticBrowser(test, kind);
      const original = await test.spending.readSpendEntryForRun(runId);
      external.create.mockRejectedValue(
        new Error("Accepted create response lost")
      );
      await dispatchTick(test, kind);
      expect(external.create).toHaveBeenCalledOnce();
      const firstLookup = external.lookup.mock.calls[0]?.[0];
      const own = await test.spending.readBrowserPaymentDispatch(alice, {
        kind,
        runId,
      });
      expect(own?.entry.id).toBe(original?.id);
      expect(own?.entry.browserRunId).toMatch(/^pending:dispatch:/u);
      expect(own?.sequence).toBe(kind === "queue" ? 2 : 5);
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      if (kind === "captcha") {
        await test.db
          .update(schema.browserRuns)
          .set({ captchaAttempt: 5 })
          .where(eq(schema.browserRuns.id, runId));
      }
      const after = new Date(Date.now() + 3 * 24 * 60 * 60_000);
      const result = await dispatchTick(test, kind, after);
      expect(result.status).toBe(kind === "queue" ? "waiting" : "parked");
      expect(external.create).toHaveBeenCalledOnce();
      expect(external.lookup.mock.calls.map((call) => call[0])).toEqual([
        firstLookup,
        firstLookup,
      ]);
      await assertUnresolvedAfterReconciliation(test, input);
      await dispatchTick(
        test,
        kind,
        new Date(after.getTime() + 24 * 60 * 60_000)
      );
      expect(external.create).toHaveBeenCalledOnce();
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s adopts only its exact marker after flag-off and atomically carries the same ledger entry",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      const original = await test.spending.readSpendEntryForRun(runId);
      external.create.mockRejectedValue(
        new Error("Accepted create response lost")
      );
      await dispatchTick(test, kind);
      const reference = external.lookup.mock.calls[0]?.[0];
      await test.db.insert(schema.spendEntries).values({
        ...reservation("pending:dispatch:foreign-errand"),
        id: "foreign-entry",
        workspaceId: alice.workspaceId,
      });
      external.lookup.mockImplementation(async (line) =>
        line === reference
          ? {
              id: "synthetic-adopted-run",
              sessionId: "synthetic-session",
              status: "running",
              task: line,
            }
          : undefined
      );
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      expect(
        await dispatchTick(
          test,
          kind,
          new Date(Date.now() + 3 * 24 * 60 * 60_000)
        )
      ).toMatchObject({ status: "started" });
      expect(external.create).toHaveBeenCalledOnce();
      expect(
        await test.spending.readSpendEntryForRun("synthetic-adopted-run")
      ).toMatchObject({
        id: original?.id,
        source: original?.source,
        periodKey: original?.periodKey,
        amountRub: original?.amountRub,
        status: "reserved",
      });
      const [adopted] = await test.db
        .select()
        .from(schema.browserRuns)
        .where(eq(schema.browserRuns.id, "synthetic-adopted-run"));
      expect(adopted?.paymentAllowed).toBe(true);
      const [old] = await test.db
        .select()
        .from(schema.browserRuns)
        .where(eq(schema.browserRuns.id, runId));
      expect(old?.retriedAsRunId).toBe("synthetic-adopted-run");
      expect(
        await test.spending.readBrowserPaymentDispatch(alice, { kind, runId })
      ).toBeUndefined();
      expect(
        await test.spending.readSpendEntryForRun(
          "pending:dispatch:foreign-errand"
        )
      ).toMatchObject({ id: "foreign-entry", status: "reserved" });
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s cannot dispatch or take another errand's unresolved marker",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      await test.db.insert(schema.spendEntries).values({
        ...reservation("pending:dispatch:foreign-errand"),
        id: "foreign-entry",
        workspaceId: alice.workspaceId,
      });
      expect((await dispatchTick(test, kind)).status).toBe(
        kind === "queue" ? "waiting" : "parked"
      );
      expect(external.create).not.toHaveBeenCalled();
      expect(
        await test.spending.readSpendEntryForRun(
          "pending:dispatch:foreign-errand"
        )
      ).toMatchObject({ id: "foreign-entry", status: "reserved" });
      expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
        status: "reserved",
      });
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s allows only one possible paid create from concurrent dispatch ticks",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      const before = await test.spending.readSpendEntryForRun(runId);
      external.create.mockRejectedValue(
        new Error("Accepted concurrent create response lost")
      );
      await Promise.all([dispatchTick(test, kind), dispatchTick(test, kind)]);
      expect(external.create).toHaveBeenCalledOnce();
      expect(await test.db.select().from(schema.spendEntries)).toMatchObject([
        { id: before?.id, status: "reserved" },
      ]);
      expect(
        (await test.spending.readBrowserPaymentDispatch(alice, { kind, runId }))
          ?.entry.id
      ).toBe(before?.id);
    },
    60_000
  );

  it("keeps the old queue revision fenced instead of adopting it as a changed paid errand", async () => {
    const test = await database();
    await automaticBrowser(test, "queue");
    external.create.mockRejectedValue(
      new Error("Accepted create response lost")
    );
    await dispatchTick(test, "queue");
    const before = await test.spending.readBrowserPaymentDispatch(alice, {
      kind: "queue",
      runId,
    });
    const reference = external.lookup.mock.calls[0]?.[0];
    await test.db
      .update(schema.browserRuns)
      .set({
        queueRevision: 3,
        pendingTask: "A changed errand",
        task: "A changed errand",
      })
      .where(eq(schema.browserRuns.id, runId));
    external.lookup.mockImplementation(async (line) => ({
      id: "synthetic-old-revision-run",
      sessionId: "synthetic-session",
      status: "running",
      task: line,
    }));
    expect((await dispatchTick(test, "queue")).status).toBe("waiting");
    expect(external.lookup.mock.calls.map((call) => call[0])).toEqual([
      reference,
      reference,
    ]);
    expect(external.create).toHaveBeenCalledOnce();
    expect(
      await test.spending.readBrowserPaymentDispatch(alice, {
        kind: "queue",
        runId,
      })
    ).toEqual(before);
    expect(
      await test.db
        .select()
        .from(schema.browserRuns)
        .where(eq(schema.browserRuns.id, "synthetic-old-revision-run"))
    ).toHaveLength(0);
    expect(
      (
        await test.db
          .select()
          .from(schema.browserRuns)
          .where(eq(schema.browserRuns.id, runId))
      )[0]
    ).toMatchObject({
      queueRevision: 3,
      retriedAsRunId: null,
      status: "queued",
    });
  }, 60_000);

  it.each(["queue", "captcha"] as const)(
    "%s promotes its legacy unresolved dispatch before holding it past TTL and flag-off",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      const sequence = kind === "queue" ? 2 : 5;
      const suffix = `${kind}:${encodeURIComponent(runId)}:${String(sequence)}`;
      await test.spending.moveSpendReservation(runId, `pending:${suffix}`);
      const before = await test.spending.readSpendEntryForRun(
        `pending:${suffix}`
      );
      expect((await dispatchTick(test, kind)).status).toBe(
        kind === "queue" ? "waiting" : "parked"
      );
      await test.spending.releaseAbandonedSpendReservations(
        new Date(Date.now() + 7 * 24 * 60 * 60_000)
      );
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      expect(
        (await dispatchTick(test, kind, new Date(Date.now() + 90 * 60_000)))
          .status
      ).toBe(kind === "queue" ? "waiting" : "parked");
      expect(external.create).not.toHaveBeenCalled();
      expect(
        await test.spending.readSpendEntryForRun(`pending:dispatch:${suffix}`)
      ).toMatchObject({
        id: before?.id,
        status: "reserved",
        amountRub: before?.amountRub,
        feeRub: before?.feeRub,
        periodKey: before?.periodKey,
        source: before?.source,
      });
    },
    60_000
  );

  it.each([400, 404, 409])(
    "a sticky queued payment never makes a second create after HTTP %s",
    async (status) => {
      const test = await database();
      await automaticBrowser(test, "queue");
      const { BrowserUseError } = await import("@agent/lib/browser-use/client");
      external.create.mockRejectedValue(
        new BrowserUseError(status, "/runs", "synthetic refusal")
      );
      expect((await dispatchTick(test, "queue")).status).toBe("waiting");
      expect(external.create).toHaveBeenCalledOnce();
      expect(
        (
          await test.spending.readBrowserPaymentDispatch(alice, {
            kind: "queue",
            runId,
          })
        )?.entry.status
      ).toBe("reserved");
    },
    60_000
  );

  it.each([400, 404, 409])(
    "a sticky direct payment never dispatches a fallback after HTTP %s",
    async (status) => {
      const test = await database();
      const input = await quote(test);
      await queuedBrowser(test);
      await test.db.insert(schema.browserProfiles).values({
        workspaceId: alice.workspaceId,
        profileId: "synthetic-profile",
      });
      await test.db
        .update(schema.browserRuns)
        .set({
          completedAt: new Date(),
          outcome: "Items: заказ воды\nTotal: 354 ₽\nNeeds: payment",
          paymentAllowed: false,
          sessionId: "synthetic-session",
          status: "done",
          submission: null,
        })
        .where(eq(schema.browserRuns.id, runId));
      const { BrowserUseError } = await import("@agent/lib/browser-use/client");
      external.create.mockRejectedValue(
        new BrowserUseError(status, "/runs", "synthetic refusal")
      );
      external.queue.mockRejectedValue(new Error("Unexpected queue fallback"));

      await expect(continueBrowser(true)).rejects.toThrow(
        "Its outcome is unknown"
      );
      expect(external.create).toHaveBeenCalledOnce();
      expect(external.queue).not.toHaveBeenCalled();
      await assertUnresolvedAfterReconciliation(test, input);
    },
    60_000
  );

  it("a sticky live payment never falls back to create after a generic message conflict", async () => {
    const test = await database();
    const input = await quote(test);
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.db.insert(schema.browserProfiles).values({
      workspaceId: alice.workspaceId,
      profileId: "synthetic-profile",
    });
    await test.db
      .update(schema.browserRuns)
      .set({
        profileId: "synthetic-profile",
        sessionId: "vm:workspace:alice:s:synthetic-session",
        status: "running",
      })
      .where(eq(schema.browserRuns.id, runId));
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    external.queue.mockRejectedValue(
      new BrowserUseError(409, "/messages", "synthetic conflict")
    );
    external.create.mockRejectedValue(new Error("Unexpected create fallback"));

    await expect(continueBrowser()).rejects.toThrow("Its outcome is unknown");
    expect(external.queue).toHaveBeenCalledOnce();
    expect(external.create).not.toHaveBeenCalled();
    await assertUnresolvedAfterReconciliation(test, input);
  }, 60_000);

  it("keeps the session fallback for a nonpayment queued run", async () => {
    const test = await database();
    await queuedBrowser(test);
    await test.db
      .update(schema.browserRuns)
      .set({
        paymentAllowed: false,
        submission: null,
        task: "Read the menu",
        sessionId: "missing-session",
        profileId: "synthetic-profile",
      })
      .where(eq(schema.browserRuns.id, runId));
    const { BrowserUseError } = await import("@agent/lib/browser-use/client");
    external.create.mockRejectedValueOnce(
      new BrowserUseError(404, "/runs", "synthetic missing session")
    );
    external.create.mockResolvedValueOnce({
      id: "synthetic-free-run",
      model: "test-model",
      sessionId: "new-session",
      status: "running",
    });
    expect((await dispatchTick(test, "queue")).status).toBe("started");
    expect(external.create).toHaveBeenCalledTimes(2);
    expect(external.create.mock.calls[0]?.[0].sessionId).toBe(
      "missing-session"
    );
    expect(external.create.mock.calls[1]?.[0].sessionId).toBeUndefined();
    expect(await test.db.select().from(schema.spendEntries)).toHaveLength(0);
  }, 60_000);

  it.each(["queue", "captcha"] as const)(
    "%s refuses an already unresolved Yandex intent after purchase flags are disabled",
    async (kind) => {
      const test = await database();
      await pendingPurchase(test, "unknown");
      await queuedBrowser(test);
      await test.db
        .update(schema.browserRuns)
        .set({
          status: kind === "queue" ? "queued" : "waiting",
          sessionId: "synthetic-session",
          profileId: "synthetic-profile",
          outcome: kind === "captcha" ? "Needs: captcha" : null,
          completedAt: kind === "captcha" ? new Date() : null,
        })
        .where(eq(schema.browserRuns.id, runId));
      await test.db.insert(schema.spendEntries).values({
        ...reservation(),
        id: "legacy-entry",
        workspaceId: alice.workspaceId,
      });
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      expect((await dispatchTick(test, kind)).status).toBe(
        kind === "queue" ? "waiting" : "parked"
      );
      expect(external.create).not.toHaveBeenCalled();
      expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
        id: "legacy-entry",
        status: "reserved",
      });
    },
    60_000
  );

  it.each(["api", "browser"] as const)(
    "allows only one financial path in a concurrent %s-first race",
    async (first) => {
      const test = await database();
      const input = await quote(test);
      const api = () => test.purchases.claimYandexPurchase(alice, input);
      const browser = () =>
        test.spending.reserveConsentPayment(alice, reservation());
      const attempts = first === "api" ? [api, browser] : [browser, api];
      await Promise.allSettled(attempts.map((attempt) => attempt()));
      const purchase = await test.purchases.readYandexPurchase(alice, input);
      const entries = await test.db.select().from(schema.spendEntries);
      expect(Number(purchase?.state === "submitting") + entries.length).toBe(1);
    },
    30_000
  );

  it.each(schema.spendEntrySources)(
    "moves inherited %s exposure without reclassifying or releasing it",
    async (source) => {
      const test = await database();
      const input = await quote(test);
      await test.db.insert(schema.spendEntries).values({
        ...reservation(),
        createdAt: new Date(Date.now() - 24 * 60 * 60_000),
        feeRub: 20,
        id: "original-reservation",
        periodKey: "2026-09",
        source,
        workspaceId: alice.workspaceId,
      });
      await test.spending.moveSpendReservation(runId, "pending:follow-up", {
        amountRub: 354,
        scope: alice,
      });
      await test.spending.releaseAbandonedSpendReservations(
        new Date(Date.now() - 20 * 60_000)
      );
      expect(
        await test.spending.settleSpendReservation(runId, { charged: false })
      ).toBeUndefined();
      expect(
        await test.spending.readSpendEntryForRun("pending:follow-up")
      ).toMatchObject({
        amountRub: 354,
        feeRub: 20,
        id: "original-reservation",
        periodKey: "2026-09",
        source,
        status: "reserved",
      });
      expect(await test.purchases.claimYandexPurchase(alice, input)).toEqual({
        kind: "unavailable",
      });
      await test.spending.moveSpendReservation("pending:follow-up", runId);
      expect(await test.purchases.claimYandexPurchase(alice, input)).toEqual({
        kind: "unavailable",
      });
    },
    30_000
  );

  it.each(["missing", "released", "charged", "higher-cap"] as const)(
    "does not reuse old consent after %s",
    async (condition) => {
      const test = await database();
      await quote(test);
      if (condition !== "missing") {
        await test.db.insert(schema.spendEntries).values({
          ...reservation(),
          amountRub: condition === "higher-cap" ? 300 : 354,
          id: "original-reservation",
          status: condition === "higher-cap" ? "reserved" : condition,
          workspaceId: alice.workspaceId,
        });
      }
      await expect(
        test.spending.moveSpendReservation(runId, "pending:follow-up", {
          amountRub: 354,
          scope: alice,
        })
      ).rejects.toThrow("Old consent cannot authorize another charge");
      expect(
        await test.spending.readSpendEntryForRun("pending:follow-up")
      ).toBeUndefined();
    },
    30_000
  );

  it("reserves a real queued continuation carrying old consent before updating it", async () => {
    const test = await database();
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    const original = await test.spending.readSpendEntryForRun(runId);
    expect(await continueBrowser()).toMatchObject({ status: "queued" });
    const [run] = await test.db
      .select()
      .from(schema.browserRuns)
      .where(eq(schema.browserRuns.id, runId));
    expect(run?.queueRevision).toBe(1);
    expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
      id: original?.id,
      status: "reserved",
    });
    expect(external.create).not.toHaveBeenCalled();
    expect(external.queue).not.toHaveBeenCalled();
  }, 60_000);

  it("restores the same inherited reservation when a queued update fails", async () => {
    const test = await database();
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    const original = await test.spending.readSpendEntryForRun(runId);
    const runs = await import("@db/services/browser-runs");
    vi.spyOn(runs, "updateQueuedBrowserRun").mockRejectedValue(
      new Error("Queue update failed")
    );
    await expect(continueBrowser()).rejects.toThrow("Queue update failed");
    expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
      id: original?.id,
      periodKey: original?.periodKey,
      source: original?.source,
      status: "reserved",
    });
    expect(await test.db.select().from(schema.spendEntries)).toHaveLength(1);
  }, 60_000);

  it("keeps a session-message ACK unresolved when it does not identify a new run and the old run settles", async () => {
    const test = await database();
    const input = await quote(test);
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.db
      .update(schema.browserRuns)
      .set({ sessionId: "synthetic-session", status: "running" })
      .where(eq(schema.browserRuns.id, runId));
    external.queue.mockImplementation(async (sessionId) => {
      const [held] = await test.db.select().from(schema.spendEntries);
      expect(held?.browserRunId).toMatch(/^pending:/u);
      expect(held?.status).toBe("reserved");
      await test.db
        .update(schema.browserRuns)
        .set({ completedAt: new Date(), status: "done" })
        .where(eq(schema.browserRuns.id, runId));
      expect(
        await test.spending.settleSpendReservation(runId, { charged: false })
      ).toBeUndefined();
      expect(await test.purchases.claimYandexPurchase(alice, input)).toEqual({
        kind: "unavailable",
      });
      return { id: 1, sessionId, status: "pending" };
    });
    await expect(continueBrowser()).rejects.toThrow("Its outcome is unknown");
    expect(external.queue).toHaveBeenCalledOnce();
    await assertUnresolvedAfterReconciliation(test, input);
  }, 60_000);

  it("retains inherited exposure when a live-session message loses its response", async () => {
    const test = await database();
    const input = await quote(test);
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.db
      .update(schema.browserRuns)
      .set({ sessionId: "synthetic-session", status: "running" })
      .where(eq(schema.browserRuns.id, runId));
    external.queue.mockImplementation(async () => {
      await test.db
        .update(schema.browserRuns)
        .set({
          completedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000),
          outcome: "Result: nothing bought\nNeeds: none",
          status: "done",
        })
        .where(eq(schema.browserRuns.id, runId));
      throw new Error("Response lost");
    });
    await expect(continueBrowser()).rejects.toThrow("Its outcome is unknown");
    await assertUnresolvedAfterReconciliation(test, input);
    expect(await test.db.select().from(schema.spendEntries)).toHaveLength(1);
  }, 60_000);

  it("retains a fresh authorized paid-run start when create accepted but its response was lost", async () => {
    const test = await database();
    const input = await quote(test);
    await queuedBrowser(test);
    await test.db.insert(schema.browserProfiles).values({
      workspaceId: alice.workspaceId,
      profileId: "synthetic-profile",
    });
    await test.db
      .update(schema.browserRuns)
      .set({
        completedAt: new Date(),
        outcome: "Items: заказ воды\nTotal: 354 ₽\nNeeds: payment",
        paymentAllowed: false,
        sessionId: "synthetic-session",
        status: "done",
        submission: null,
      })
      .where(eq(schema.browserRuns.id, runId));
    external.create.mockRejectedValue(new Error("Create response lost"));
    await expect(continueBrowser(true)).rejects.toThrow(
      "Its outcome is unknown"
    );
    expect(external.create).toHaveBeenCalledOnce();
    await assertUnresolvedAfterReconciliation(test, input);
  }, 60_000);

  it("keeps a possible OTP payment unresolved without dispatching another paid instruction", async () => {
    const test = await database();
    const input = await quote(test);
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    await test.db
      .update(schema.browserRuns)
      .set({
        sessionId: "synthetic-session",
        status: "running",
        outcome: "Needs: sms_code",
      })
      .where(eq(schema.browserRuns.id, runId));
    external.find.mockResolvedValue("ws://synthetic-debugger");
    external.type.mockImplementation(async () => {
      await test.db
        .update(schema.browserRuns)
        .set({
          completedAt: new Date(),
          outcome: "Result: nothing bought\nNeeds: none",
          status: "done",
        })
        .where(eq(schema.browserRuns.id, runId));
      throw new Error("OTP response lost");
    });
    await expect(continueBrowser(false, "Код 4821")).rejects.toThrow(
      "Its outcome is unknown"
    );
    expect(external.type).toHaveBeenCalledOnce();
    expect(external.queue).not.toHaveBeenCalled();
    expect(external.create).not.toHaveBeenCalled();
    await assertUnresolvedAfterReconciliation(test, input);
  }, 60_000);

  it("keeps a dispatch marker reserved after a crash and days of abandoned-placeholder cleanup", async () => {
    const test = await database();
    const input = await quote(test);
    await test.spending.reserveConsentPayment(
      alice,
      reservation("pending:dispatch:crashed")
    );
    await test.db
      .update(schema.spendEntries)
      .set({ createdAt: new Date(Date.now() - 10 * 24 * 60 * 60_000) });
    await assertUnresolvedAfterReconciliation(test, input);
    expect(await test.db.select().from(schema.spendEntries)).toHaveLength(1);
  }, 30_000);

  it("hands the reservation to a persisted newly acknowledged run, preserving its original source", async () => {
    const test = await database();
    await queuedBrowser(test);
    await test.spending.reserveConsentPayment(alice, reservation());
    const original = await test.spending.readSpendEntryForRun(runId);
    await test.db
      .update(schema.browserRuns)
      .set({ sessionId: "synthetic-session", status: "running" })
      .where(eq(schema.browserRuns.id, runId));
    external.queue.mockResolvedValue({
      id: 1,
      runId: "synthetic-acknowledged-run",
      sessionId: "synthetic-session",
      status: "pending",
    });
    expect(await continueBrowser()).toMatchObject({
      runId: "synthetic-acknowledged-run",
      status: "running",
    });
    expect(
      await test.spending.readSpendEntryForRun("synthetic-acknowledged-run")
    ).toMatchObject({
      id: original?.id,
      source: original?.source,
      periodKey: original?.periodKey,
      status: "reserved",
    });
    const [acknowledged] = await test.db
      .select()
      .from(schema.browserRuns)
      .where(eq(schema.browserRuns.id, "synthetic-acknowledged-run"));
    expect(acknowledged?.paymentAllowed).toBe(true);
    expect(
      (await test.db.select().from(schema.spendEntries)).some((entry) =>
        entry.browserRunId.startsWith("pending:dispatch:")
      )
    ).toBe(false);
    expect(
      await test.spending.reserveConsentPayment(
        alice,
        reservation("another-confirmed-order")
      )
    ).toEqual({ allowed: true });
  }, 60_000);

  it.each(["queued", "running"] as const)(
    "blocks %s old-consent continuation before queueing or external work",
    async (status) => {
      const test = await database();
      await pendingPurchase(test, "unknown");
      await queuedBrowser(test);
      await test.db
        .update(schema.browserRuns)
        .set({ status })
        .where(eq(schema.browserRuns.id, runId));
      await test.db.insert(schema.spendEntries).values({
        ...reservation(),
        id: "legacy-reservation",
        workspaceId: alice.workspaceId,
      });
      await expect(continueBrowser()).rejects.toThrow(
        "Yandex purchase may already have been placed"
      );
      const [run] = await test.db
        .select()
        .from(schema.browserRuns)
        .where(eq(schema.browserRuns.id, runId));
      expect(run?.queueRevision).toBe(0);
      expect(await test.spending.readSpendEntryForRun(runId)).toMatchObject({
        id: "legacy-reservation",
        status: "reserved",
      });
      expect(external.create).not.toHaveBeenCalled();
      expect(external.queue).not.toHaveBeenCalled();
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s preserves the committed winner when a stale competing lookup resumes",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      const original = await test.spending.readSpendEntryForRun(runId);
      const lookupStarted = Promise.withResolvers<undefined>();
      const lookup =
        Promise.withResolvers<
          Awaited<
            ReturnType<typeof browserClient.findRecentBrowserUseRunByTaskLine>
          >
        >();
      const winner = {
        id: "synthetic-competing-winner",
        sessionId: "synthetic-session",
      };
      external.lookup.mockImplementationOnce(async () => {
        lookupStarted.resolve(undefined);
        return lookup.promise;
      });
      external.create.mockResolvedValue({
        ...winner,
        model: "test-model",
        status: "running",
      });
      const stale = dispatchTick(test, kind);
      await lookupStarted.promise;
      expect((await dispatchTick(test, kind)).status).toBe("started");
      const acceptedTask = external.create.mock.calls[0]?.[0].task;
      if (acceptedTask === undefined) throw new Error("No accepted task.");
      lookup.resolve({ ...winner, status: "running", task: acceptedTask });
      const result = await stale;
      expect(external.cancel).not.toHaveBeenCalled();
      expect(result).toMatchObject(
        kind === "queue"
          ? { status: "started" }
          : { status: "started", runId: winner.id }
      );
      expect(external.create).toHaveBeenCalledOnce();
      expect(await test.spending.readSpendEntryForRun(winner.id)).toMatchObject(
        { id: original?.id, status: "reserved" }
      );
      expect(
        (
          await test.db
            .select()
            .from(schema.browserRuns)
            .where(eq(schema.browserRuns.id, runId))
        )[0]
      ).toMatchObject({
        retriedAsRunId: winner.id,
        status: "stopped",
        retryAt: null,
      });
      expect(
        (
          await test.db
            .select()
            .from(schema.browserRuns)
            .where(eq(schema.browserRuns.id, winner.id))
        )[0]
      ).toMatchObject({ status: "running" });
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s recognizes its committed handoff after the database ACK is lost",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      const original = await test.spending.readSpendEntryForRun(runId);
      const winner = {
        id: "synthetic-db-ack-winner",
        sessionId: "synthetic-session",
      };
      const transaction = test.db.transaction.bind(test.db);
      external.create.mockImplementationOnce(async () => {
        vi.spyOn(test.db, "transaction").mockImplementationOnce(
          async (...args) => {
            await transaction(...args);
            throw new Error("Committed handoff ACK lost");
          }
        );
        return { ...winner, model: "test-model", status: "running" };
      });
      expect(await dispatchTick(test, kind)).toMatchObject(
        kind === "queue"
          ? { status: "started" }
          : { status: "started", runId: winner.id }
      );
      expect(external.cancel).not.toHaveBeenCalled();
      expect(await test.spending.readSpendEntryForRun(winner.id)).toMatchObject(
        { id: original?.id, status: "reserved" }
      );
      expect(
        (
          await test.db
            .select()
            .from(schema.browserRuns)
            .where(eq(schema.browserRuns.id, runId))
        )[0]
      ).toMatchObject({
        retriedAsRunId: winner.id,
        status: "stopped",
        retryAt: null,
      });
      expect(
        (
          await test.db
            .select()
            .from(schema.browserRuns)
            .where(eq(schema.browserRuns.id, winner.id))
        )[0]
      ).toMatchObject({ status: "running" });
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s preserves an unfunded nonpilot legacy dispatcher only after the shared guard",
    async (kind) => {
      const test = await database();
      await automaticBrowser(test, kind);
      await test.db
        .delete(schema.spendEntries)
        .where(eq(schema.spendEntries.browserRunId, runId));
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      external.create.mockResolvedValue({
        id: "synthetic-unfunded-legacy-run",
        sessionId: "synthetic-session",
        model: "test-model",
        status: "running",
      });
      expect((await dispatchTick(test, kind)).status).toBe("started");
      expect(external.create).toHaveBeenCalledOnce();
      expect(await test.db.select().from(schema.spendEntries)).toHaveLength(0);
    },
    60_000
  );

  it.each(["queue", "captcha"] as const)(
    "%s blocks an unfunded nonpilot legacy dispatcher behind API unknown or a foreign marker",
    async (kind) => {
      const test = await database();
      await pendingPurchase(test, "unknown");
      await queuedBrowser(test);
      await test.db
        .update(schema.browserRuns)
        .set({
          status: kind === "queue" ? "queued" : "waiting",
          sessionId: "synthetic-session",
          profileId: "synthetic-profile",
          queueRevision: 2,
          captchaAttempt: 4,
          completedAt: kind === "captcha" ? new Date() : null,
          outcome: kind === "captcha" ? "Needs: captcha" : null,
          browserReleasedAt: kind === "captcha" ? new Date() : null,
        })
        .where(eq(schema.browserRuns.id, runId));
      vi.stubEnv("YANDEX_API_WORKSPACES", "");
      vi.stubEnv("YANDEX_PURCHASE_WORKSPACES", "");
      vi.resetModules();
      expect((await dispatchTick(test, kind)).status).toBe(
        kind === "queue" ? "waiting" : "parked"
      );
      expect(external.create).not.toHaveBeenCalled();
      await test.db.delete(schema.yandexPurchases);
      await test.db.insert(schema.spendEntries).values({
        ...reservation("pending:dispatch:foreign-unfunded-errand"),
        id: "foreign-unfunded-entry",
        workspaceId: alice.workspaceId,
      });
      const before = await test.db.select().from(schema.spendEntries);
      expect((await dispatchTick(test, kind)).status).toBe(
        kind === "queue" ? "waiting" : "parked"
      );
      expect(external.create).not.toHaveBeenCalled();
      expect(await test.db.select().from(schema.spendEntries)).toEqual(before);
    },
    60_000
  );
});
