import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as schema from "../schema";

const databases: PGlite[] = [];
const alice = { userId: "alice", workspaceId: "workspace:alice" };
const bob = { userId: "bob", workspaceId: "workspace:bob" };

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock("@db");
  vi.doUnmock("@db/services/scope");
  vi.doUnmock("@shared/environment");
  await Promise.all(databases.splice(0).map((client) => client.close()));
});

async function purchasesDatabase() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  const directory = new URL("../migrations/", import.meta.url);
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
  const database = drizzle(client, { schema });
  vi.doMock("@db", () => ({ ...schema, db: database }));
  vi.doMock("@db/services/scope", () => ({
    ensureScope: async (scope: typeof alice) => {
      await database
        .insert(schema.workspaces)
        .values({ id: scope.workspaceId })
        .onConflictDoNothing();
    },
  }));
  const purchases = await import("@db/services/yandex-purchases");
  return { ...purchases, database };
}

function quote(fingerprint = "cart:1:version:1") {
  return {
    rootSessionId: "session:alice",
    service: "lavka" as const,
    checkoutKey: "cart:1",
    fingerprint,
    amountMinor: 25_000,
    currency: "RUB" as const,
    expiresAt: new Date(Date.now() + 60_000),
    confirmationQuestion: "Оформить этот заказ за 250 ₽?",
    publicQuote: {
      items: [{ title: "Хлеб", quantity: 1 }],
      amountMinor: 25_000,
    },
    providerSnapshot: { cartId: "cart:1", version: 1, paymentId: "saved:1" },
  };
}

describe("Yandex purchase intents", () => {
  it("stores the server scope, UUID and exact question and deduplicates concurrent preparation", async () => {
    const purchases = await purchasesDatabase();
    const input = quote();
    const results = await Promise.all([
      purchases.createYandexPurchase(alice, input),
      purchases.createYandexPurchase(alice, input),
    ]);
    expect(results.map((result) => result.kind).toSorted()).toEqual([
      "created",
      "existing",
    ]);
    const first = results[0];
    if (first.kind === "blocked") throw new Error("Expected a purchase.");
    expect(first.purchase).toMatchObject({
      ...input,
      workspaceId: alice.workspaceId,
      userId: alice.userId,
      state: "quoted",
      callId: null,
    });
    expect(first.purchase.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(
      await purchases.database.select().from(schema.yandexPurchases)
    ).toHaveLength(1);
  }, 30_000);

  it("isolates read, claim and settle by workspace, user and root session", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, quote());
    if (created.kind !== "created") throw new Error("Expected a purchase.");
    const input = {
      id: created.purchase.id,
      confirmationQuestion: created.purchase.confirmationQuestion,
      rootSessionId: "session:alice",
      callId: "call:1",
    };
    const attempts = [
      { scope: bob, input },
      { scope: { ...alice, userId: "bob" }, input },
      { scope: alice, input: { ...input, rootSessionId: "session:bob" } },
    ];
    const foreign = await Promise.all(
      attempts.map(async (attempt) => ({
        read: await purchases.readYandexPurchase(attempt.scope, attempt.input),
        claim: await purchases.claimYandexPurchase(
          attempt.scope,
          attempt.input
        ),
        settle: await purchases.settleYandexPurchase(attempt.scope, {
          ...attempt.input,
          state: "placed",
          outcome: {},
        }),
      }))
    );
    for (const result of foreign) {
      expect(result).toEqual({
        read: undefined,
        claim: { kind: "unavailable" },
        settle: undefined,
      });
    }
    expect(
      await purchases.createYandexPurchase({ ...alice, userId: "bob" }, quote())
    ).toEqual({ kind: "blocked" });
    expect(
      await purchases.createYandexPurchase(alice, {
        ...quote(),
        rootSessionId: "session:bob",
      })
    ).toEqual({ kind: "blocked" });
    expect((await purchases.readYandexPurchase(alice, input))?.state).toBe(
      "quoted"
    );
    await purchases.claimYandexPurchase(alice, input);
    expect(
      await Promise.all(
        attempts.map((attempt) =>
          purchases.settleYandexPurchase(attempt.scope, {
            ...attempt.input,
            state: "placed",
            outcome: {},
          })
        )
      )
    ).toEqual([undefined, undefined, undefined]);
    expect((await purchases.readYandexPurchase(alice, input))?.state).toBe(
      "submitting"
    );
  }, 30_000);

  it("renews only an expired quoted intent with a different exact question, rejecting stale consent", async () => {
    const purchases = await purchasesDatabase();
    const original = {
      ...quote(),
      expiresAt: new Date(Date.now() - 1_000),
    };
    const created = await purchases.createYandexPurchase(alice, original);
    if (created.kind !== "created") throw new Error("Expected a purchase.");
    const input = {
      id: created.purchase.id,
      rootSessionId: original.rootSessionId,
      callId: "call:1",
      confirmationQuestion: original.confirmationQuestion,
    };
    const unchanged = await purchases.createYandexPurchase(alice, quote());
    expect(unchanged).toMatchObject({
      kind: "existing",
      purchase: { expiresAt: original.expiresAt },
    });
    const replacement = {
      ...quote(),
      confirmationQuestion: `${original.confirmationQuestion} Срок: ${new Date(Date.now() + 60_000).toISOString()}`,
    };
    expect(
      await purchases.createYandexPurchase(alice, {
        ...replacement,
        rootSessionId: "session:other",
      })
    ).toEqual({ kind: "blocked" });
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(
      created.purchase
    );
    const renewed = await purchases.createYandexPurchase(alice, replacement);
    expect(renewed).toMatchObject({
      kind: "existing",
      purchase: {
        id: created.purchase.id,
        state: "quoted",
        confirmationQuestion: replacement.confirmationQuestion,
        expiresAt: replacement.expiresAt,
      },
    });
    expect(await purchases.claimYandexPurchase(alice, input)).toEqual({
      kind: "unavailable",
    });
    const stillCurrent = await purchases.createYandexPurchase(alice, {
      ...replacement,
      confirmationQuestion: "Не менять действующий вопрос",
    });
    expect(stillCurrent).toMatchObject({
      kind: "existing",
      purchase: { confirmationQuestion: replacement.confirmationQuestion },
    });
    expect(
      await purchases.claimYandexPurchase(alice, {
        ...input,
        confirmationQuestion: replacement.confirmationQuestion,
      })
    ).toMatchObject({ kind: "claimed", purchase: { state: "submitting" } });
  }, 30_000);

  it("expires only a quoted intent", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, {
      ...quote(),
      expiresAt: new Date(Date.now() - 1_000),
    });
    if (created.kind !== "created") throw new Error("Expected a purchase.");
    expect(
      await purchases.claimYandexPurchase(alice, {
        id: created.purchase.id,
        confirmationQuestion: created.purchase.confirmationQuestion,
        rootSessionId: "session:alice",
        callId: "call:1",
      })
    ).toMatchObject({
      kind: "expired",
      purchase: { state: "quoted", callId: null },
    });
  }, 30_000);

  it("claims once before any network work and never reclaims even the same call", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, quote());
    if (created.kind !== "created") throw new Error("Expected a purchase.");
    const input = {
      id: created.purchase.id,
      confirmationQuestion: created.purchase.confirmationQuestion,
      rootSessionId: "session:alice",
      callId: "call:1",
    };
    const results = await Promise.all([
      purchases.claimYandexPurchase(alice, input),
      purchases.claimYandexPurchase(alice, { ...input, callId: "call:2" }),
    ]);
    expect(results.map((result) => result.kind).toSorted()).toEqual([
      "claimed",
      "existing",
    ]);
    expect(await purchases.claimYandexPurchase(alice, input)).toMatchObject({
      kind: "existing",
      purchase: { state: "submitting" },
    });
    const stored = await purchases.readYandexPurchase(alice, input);
    expect(stored?.state).toBe("submitting");
    expect(stored?.submittedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("blocks other carts and already quoted intents while an attempt is unresolved, even after TTL", async () => {
    const purchases = await purchasesDatabase();
    const first = await purchases.createYandexPurchase(alice, quote());
    const second = await purchases.createYandexPurchase(alice, {
      ...quote("cart:2:version:1"),
      rootSessionId: "session:alice:other",
    });
    if (first.kind !== "created" || second.kind !== "created")
      throw new Error("Expected purchases.");
    const input = {
      id: first.purchase.id,
      confirmationQuestion: first.purchase.confirmationQuestion,
      rootSessionId: "session:alice",
      callId: "call:1",
    };
    await purchases.claimYandexPurchase(alice, input);
    await purchases.database
      .update(schema.yandexPurchases)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.yandexPurchases.id, input.id));
    expect(
      await purchases.createYandexPurchase(alice, quote("cart:3:version:1"))
    ).toEqual({ kind: "blocked" });
    expect(
      await purchases.claimYandexPurchase(alice, {
        ...input,
        id: second.purchase.id,
        rootSessionId: "session:alice:other",
      })
    ).toEqual({ kind: "unavailable" });
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "unknown",
        outcome: { reason: "timeout" },
      })
    ).toMatchObject({ state: "unknown" });
    expect(
      await purchases.createYandexPurchase(alice, quote("cart:4:version:1"))
    ).toEqual({ kind: "blocked" });
    expect(await purchases.claimYandexPurchase(alice, input)).toMatchObject({
      kind: "existing",
      purchase: { state: "unknown" },
    });
    expect(
      (
        await purchases.createYandexPurchase(bob, {
          ...quote(),
          rootSessionId: "session:bob",
        })
      ).kind
    ).toBe("created");
  }, 30_000);

  it("requires the original call to settle and permanently freezes unknown until reconciliation is implemented", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, quote());
    if (created.kind !== "created") throw new Error("Expected a purchase.");
    const input = {
      id: created.purchase.id,
      confirmationQuestion: created.purchase.confirmationQuestion,
      rootSessionId: "session:alice",
      callId: "call:1",
    };
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "placed",
        outcome: {},
      })
    ).toBeUndefined();
    await purchases.claimYandexPurchase(alice, input);
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        callId: "call:wrong",
        state: "placed",
        outcome: {},
      })
    ).toBeUndefined();
    await purchases.settleYandexPurchase(alice, {
      ...input,
      state: "unknown",
      outcome: { reason: "timeout" },
    });
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "placed",
        outcome: {},
      })
    ).toBeUndefined();
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "rejected",
        outcome: {},
      })
    ).toBeUndefined();
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "unknown",
        outcome: {},
      })
    ).toBeUndefined();
    expect(await purchases.readYandexPurchase(alice, input)).toMatchObject({
      state: "unknown",
      outcome: { reason: "timeout" },
    });
  }, 30_000);

  it.each(["placed", "rejected"] as const)(
    "never overwrites or resends a %s intent, and allows a genuinely different version",
    async (state) => {
      const purchases = await purchasesDatabase();
      const created = await purchases.createYandexPurchase(alice, quote());
      if (created.kind !== "created") throw new Error("Expected a purchase.");
      const input = {
        id: created.purchase.id,
        confirmationQuestion: created.purchase.confirmationQuestion,
        rootSessionId: "session:alice",
        callId: "call:1",
      };
      await purchases.claimYandexPurchase(alice, input);
      const settled = await purchases.settleYandexPurchase(alice, {
        ...input,
        state,
        outcome: { status: state },
      });
      expect(settled?.state).toBe(state);
      expect(
        await purchases.settleYandexPurchase(alice, {
          ...input,
          state: "unknown",
          outcome: { reason: "late failure" },
        })
      ).toBeUndefined();
      expect(
        await purchases.claimYandexPurchase(alice, {
          ...input,
          callId: "call:2",
        })
      ).toMatchObject({ kind: "existing", purchase: { state } });
      expect(
        await purchases.createYandexPurchase(alice, quote())
      ).toMatchObject({
        kind: "existing",
        purchase: { id: created.purchase.id, state },
      });
      expect(
        (await purchases.createYandexPurchase(alice, quote("cart:1:version:2")))
          .kind
      ).toBe("created");
      expect(await purchases.readYandexPurchase(alice, input)).toEqual(settled);
    },
    30_000
  );

  it("renews a safely rejected attempt only with a different question and new consent", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, quote());
    if (created.kind === "blocked") throw new Error("Expected a purchase");
    const input = {
      id: created.purchase.id,
      rootSessionId: created.purchase.rootSessionId,
      confirmationQuestion: created.purchase.confirmationQuestion,
      callId: "call:1",
    };
    await purchases.claimYandexPurchase(alice, input);
    await purchases.settleYandexPurchase(alice, {
      ...input,
      state: "rejected",
      outcome: { kind: "rejected", reason: "quote_expired" },
    });
    const renewed = await purchases.createYandexPurchase(alice, {
      ...quote(),
      confirmationQuestion: "Новый срок, тот же заказ за 250 ₽. Оплачиваю?",
    });
    expect(renewed.kind).toBe("existing");
    if (renewed.kind === "blocked") throw new Error("Expected a renewed quote");
    expect(renewed.purchase.state).toBe("quoted");
    expect(renewed.purchase.callId).toBeNull();
    expect(await purchases.claimYandexPurchase(alice, input)).toEqual({
      kind: "unavailable",
    });
    expect(
      await purchases.claimYandexPurchase(alice, {
        ...input,
        callId: "call:2",
        confirmationQuestion: renewed.purchase.confirmationQuestion,
      })
    ).toMatchObject({ kind: "claimed" });
  }, 30_000);

  it("cannot claim an API purchase while a browser payment holds its reservation", async () => {
    const purchases = await purchasesDatabase();
    const created = await purchases.createYandexPurchase(alice, quote());
    if (created.kind === "blocked") throw new Error("Expected a purchase");
    await purchases.database.insert(schema.spendEntries).values({
      id: "browser-reservation",
      workspaceId: alice.workspaceId,
      browserRunId: "pending:browser-payment",
      periodKey: "2026-10",
      amountRub: 250,
      source: "card",
    });
    const input = {
      id: created.purchase.id,
      rootSessionId: created.purchase.rootSessionId,
      confirmationQuestion: created.purchase.confirmationQuestion,
      callId: "call:1",
    };
    expect(await purchases.claimYandexPurchase(alice, input)).toEqual({
      kind: "unavailable",
    });
    await purchases.database
      .update(schema.spendEntries)
      .set({ status: "released" })
      .where(eq(schema.spendEntries.id, "browser-reservation"));
    expect(await purchases.claimYandexPurchase(alice, input)).toMatchObject({
      kind: "claimed",
    });
  }, 30_000);

  it("rejects unsafe amounts and nested credential/card payloads", async () => {
    const purchases = await purchasesDatabase();
    await Promise.all(
      [-1, 0.1, Number.MAX_SAFE_INTEGER + 1].map(async (amountMinor) => {
        await expect(
          purchases.createYandexPurchase(alice, { ...quote(), amountMinor })
        ).rejects.toThrow(/expected (?:number|int)/iu);
      })
    );
    await Promise.all(
      ["cookies", "csrf_token", "password", "cardNumber", "CVV"].map(
        async (key) => {
          await expect(
            purchases.createYandexPurchase(alice, {
              ...quote(),
              providerSnapshot: { nested: [{ [key]: "not-a-real-secret" }] },
            })
          ).rejects.toThrow(
            "Purchase payload contains a credential or card secret."
          );
        }
      )
    );
    expect(
      (
        await purchases.createYandexPurchase(alice, {
          ...quote(),
          amountMinor: 0,
        })
      ).kind
    ).toBe("created");
    expect(
      await purchases.database.select().from(schema.yandexPurchases)
    ).toHaveLength(1);
  }, 30_000);

  it("refuses nontransactional drivers before writing", async () => {
    const purchases = await purchasesDatabase();
    vi.doMock("@shared/environment", () => ({
      env: { DATABASE_DRIVER: "neon-http" },
    }));
    vi.resetModules();
    const service = await import("@db/services/yandex-purchases");
    await expect(service.createYandexPurchase(alice, quote())).rejects.toThrow(
      "transactional"
    );
    expect(
      await purchases.database.select().from(schema.yandexPurchases)
    ).toHaveLength(0);
  }, 30_000);
});
