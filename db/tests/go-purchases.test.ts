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
  vi.doMock("@shared/environment", () => ({
    env: { DATABASE_DRIVER: "postgres" },
  }));
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

function quote(fingerprint = "ride:1:quote:1") {
  return {
    rootSessionId: "session:alice",
    service: "go" as const,
    checkoutKey: "ride:1",
    fingerprint,
    amountMinor: 25_000,
    currency: "RUB" as const,
    expiresAt: new Date(Date.now() + 60_000),
    confirmationQuestion: "Заказать эту поездку за 250 ₽?",
    publicQuote: { amountMinor: 25_000, tariff: "econom" },
    providerSnapshot: { offerId: "offer:1", paymentId: "saved:1" },
  };
}

async function createPurchase(
  purchases: Awaited<ReturnType<typeof purchasesDatabase>>,
  input: Parameters<typeof purchases.createYandexPurchase>[1] = quote(),
  scope = alice
) {
  const created = await purchases.createYandexPurchase(scope, input);
  if (created.kind !== "created") throw new Error("Expected a new purchase.");
  return {
    id: created.purchase.id,
    rootSessionId: input.rootSessionId,
    confirmationQuestion: input.confirmationQuestion,
    callId: "call:1",
    orderId: "order:1",
  };
}

describe("Go durable purchase phases", () => {
  it("records exact cash liability once without claiming payment or reopening the intent", async () => {
    const purchases = await purchasesDatabase();
    const prepared = { ...quote(), providerSnapshot: { payment: "CASH" } };
    const input = await createPurchase(purchases, prepared);
    await purchases.claimYandexPurchase(alice, input);
    await purchases.recordGoPurchaseDraft(alice, input);
    await purchases.claimGoPurchaseCommit(alice, input);
    await purchases.settleYandexPurchase(alice, {
      ...input,
      state: "active",
      merchantOrderId: input.orderId,
      outcome: { kind: "active" },
    });
    const terminal = {
      id: input.id,
      orderId: input.orderId,
      finalFareMinor: 26_000,
    };
    expect(
      await purchases.settleGoCashLiability(bob, terminal)
    ).toBeUndefined();
    expect(
      await purchases.settleGoCashLiability(alice, {
        ...terminal,
        orderId: "unrelated-order",
      })
    ).toBeUndefined();
    expect(
      await purchases.settleGoCashLiability(alice, terminal)
    ).toMatchObject({
      state: "placed",
      merchantOrderId: input.orderId,
      outcome: {
        kind: "cash_liability_known",
        finalFareMinor: 26_000,
        paymentStatus: "unknown",
      },
    });
    expect(
      await purchases.settleGoCashLiability(alice, terminal)
    ).toBeUndefined();
    expect(await purchases.readActiveGoPurchase(alice)).toBeUndefined();
    expect(await purchases.createYandexPurchase(alice, prepared)).toMatchObject(
      { kind: "existing", purchase: { state: "placed" } }
    );
    expect(
      await purchases.claimYandexPurchase(alice, {
        ...input,
        callId: "another-call",
      })
    ).toMatchObject({ kind: "existing", purchase: { state: "placed" } });
  }, 30_000);

  it("keeps an originally-card ride protected when it later reports cash", async () => {
    const purchases = await purchasesDatabase();
    const input = await createPurchase(purchases, {
      ...quote(),
      providerSnapshot: { payment: "SAVED_CARD" },
    });
    await purchases.claimYandexPurchase(alice, input);
    await purchases.recordGoPurchaseDraft(alice, input);
    await purchases.claimGoPurchaseCommit(alice, input);
    await purchases.settleYandexPurchase(alice, {
      ...input,
      state: "active",
      merchantOrderId: input.orderId,
      outcome: { kind: "active" },
    });
    expect(
      await purchases.settleGoCashLiability(alice, {
        id: input.id,
        orderId: input.orderId,
        finalFareMinor: 25_000,
      })
    ).toBeUndefined();
    expect(await purchases.readActiveGoPurchase(alice)).toMatchObject({
      state: "active",
    });
  }, 30_000);

  it("deduplicates preparation and gives exactly one call the draft claim", async () => {
    const purchases = await purchasesDatabase();
    const prepared = quote();
    const created = await Promise.all([
      purchases.createYandexPurchase(alice, prepared),
      purchases.createYandexPurchase(alice, prepared),
    ]);
    expect(created.map((result) => result.kind).toSorted()).toEqual([
      "created",
      "existing",
    ]);
    const first = created[0];
    if (first.kind === "blocked") throw new Error("Expected a purchase.");
    expect(first.purchase).toMatchObject({
      ...prepared,
      ...alice,
      state: "quoted",
      phase: null,
      merchantOrderId: null,
      callId: null,
    });
    const input = {
      id: first.purchase.id,
      rootSessionId: prepared.rootSessionId,
      confirmationQuestion: prepared.confirmationQuestion,
    };
    const claims = await Promise.all(
      ["call:1", "call:2"].map((callId) =>
        purchases.claimYandexPurchase(alice, { ...input, callId })
      )
    );
    expect(claims.map((result) => result.kind).toSorted()).toEqual([
      "claimed",
      "existing",
    ]);
    const winner = claims.find((result) => result.kind === "claimed");
    if (winner?.kind !== "claimed") throw new Error("Expected a winner.");
    expect(winner.purchase).toMatchObject({
      state: "submitting",
      phase: "draft_claimed",
      merchantOrderId: null,
    });
    expect(winner.purchase.submittedAt).toBeInstanceOf(Date);
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(
      winner.purchase
    );
    expect(
      await purchases.database.select().from(schema.yandexPurchases)
    ).toHaveLength(1);
  }, 30_000);

  it("requires the original workspace, user, session and call for both phase transitions", async () => {
    const purchases = await purchasesDatabase();
    const input = await createPurchase(purchases);
    expect(await purchases.recordGoPurchaseDraft(alice, input)).toBeUndefined();
    expect(await purchases.claimGoPurchaseCommit(alice, input)).toBeUndefined();
    await purchases.claimYandexPurchase(alice, input);
    const before = await purchases.readYandexPurchase(alice, input);
    const attempts = [
      { scope: bob, input },
      { scope: { ...alice, userId: "bob" }, input },
      { scope: { ...alice, workspaceId: "workspace:bob" }, input },
      { scope: alice, input: { ...input, rootSessionId: "session:wrong" } },
      { scope: alice, input: { ...input, callId: "call:wrong" } },
    ];
    const foreignDrafts = await Promise.all(
      attempts.map((attempt) =>
        purchases.recordGoPurchaseDraft(attempt.scope, attempt.input)
      )
    );
    expect(foreignDrafts).toEqual(attempts.map(() => undefined));
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(before);
    const drafted = await purchases.recordGoPurchaseDraft(alice, input);
    expect(drafted).toMatchObject({
      state: "submitting",
      phase: "drafted",
      merchantOrderId: input.orderId,
      callId: input.callId,
    });
    const foreignCommits = await Promise.all(
      attempts.map((attempt) =>
        purchases.claimGoPurchaseCommit(attempt.scope, attempt.input)
      )
    );
    expect(foreignCommits).toEqual(attempts.map(() => undefined));
    expect(
      await purchases.claimGoPurchaseCommit(alice, {
        ...input,
        orderId: "order:wrong",
      })
    ).toBeUndefined();
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(drafted);
    expect(await purchases.claimGoPurchaseCommit(alice, input)).toMatchObject({
      phase: "commit_claimed",
      merchantOrderId: input.orderId,
      callId: input.callId,
    });
  }, 30_000);

  it("records one draft and grants one commit when the original call races itself", async () => {
    const purchases = await purchasesDatabase();
    const input = await createPurchase(purchases);
    await purchases.claimYandexPurchase(alice, input);
    const drafts = await Promise.all(
      ["order:1", "order:2"].map((orderId) =>
        purchases.recordGoPurchaseDraft(alice, { ...input, orderId })
      )
    );
    const winners = drafts.filter((result) => result !== undefined);
    expect(winners).toHaveLength(1);
    const draft = winners[0];
    if (!draft?.merchantOrderId)
      throw new Error("Expected the recorded order.");
    const commit = { ...input, orderId: draft.merchantOrderId };
    const commits = await Promise.all([
      purchases.claimGoPurchaseCommit(alice, commit),
      purchases.claimGoPurchaseCommit(alice, commit),
    ]);
    expect(commits.filter((result) => result !== undefined)).toHaveLength(1);
    expect(await purchases.readYandexPurchase(alice, input)).toMatchObject({
      state: "submitting",
      phase: "commit_claimed",
      merchantOrderId: draft.merchantOrderId,
    });
    expect(await purchases.recordGoPurchaseDraft(alice, input)).toBeUndefined();
    expect(
      await purchases.claimGoPurchaseCommit(alice, commit)
    ).toBeUndefined();
  }, 30_000);

  it.each(["draft_claimed", "drafted", "commit_claimed", "accepted"] as const)(
    "preserves %s after a process restart, quote expiry and preparation replay",
    async (phase) => {
      const purchases = await purchasesDatabase();
      const input = await createPurchase(purchases);
      await purchases.claimYandexPurchase(alice, input);
      if (phase !== "draft_claimed") {
        await purchases.recordGoPurchaseDraft(alice, input);
      }
      if (phase === "commit_claimed" || phase === "accepted") {
        await purchases.claimGoPurchaseCommit(alice, input);
      }
      if (phase === "accepted") {
        await purchases.settleYandexPurchase(alice, {
          ...input,
          state: "active",
          merchantOrderId: input.orderId,
          outcome: { kind: "accepted" },
        });
      }
      await purchases.database
        .update(schema.yandexPurchases)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.yandexPurchases.id, input.id));
      const before = await purchases.readYandexPurchase(alice, input);
      expect(before?.phase).toBe(phase);
      vi.resetModules();
      const restarted = await import("@db/services/yandex-purchases");
      expect(
        await restarted.createYandexPurchase(alice, {
          ...quote(),
          confirmationQuestion: "Новая котировка — заказать?",
        })
      ).toEqual({ kind: "existing", purchase: before });
      expect(
        await restarted.claimYandexPurchase(alice, {
          ...input,
          callId: "call:retry",
        })
      ).toEqual({ kind: "existing", purchase: before });
      const replacement =
        phase === "draft_claimed"
          ? undefined
          : await restarted.recordGoPurchaseDraft(alice, {
              ...input,
              orderId: "order:replacement",
            });
      expect(replacement).toBeUndefined();
      const repeatedCommit =
        phase === "drafted"
          ? undefined
          : await restarted.claimGoPurchaseCommit(alice, input);
      expect(repeatedCommit).toBeUndefined();
      expect(await restarted.readYandexPurchase(alice, input)).toEqual(before);
    },
    30_000
  );

  it.each(["draft_claimed", "drafted", "commit_claimed"] as const)(
    "permanently freezes an unknown outcome from %s",
    async (phase) => {
      const purchases = await purchasesDatabase();
      const input = await createPurchase(purchases);
      await purchases.claimYandexPurchase(alice, input);
      if (phase !== "draft_claimed") {
        await purchases.recordGoPurchaseDraft(alice, input);
      }
      if (phase === "commit_claimed") {
        await purchases.claimGoPurchaseCommit(alice, input);
      }
      const unknown = await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "unknown",
        outcome: { reason: "timeout" },
      });
      expect(unknown).toMatchObject({ state: "unknown", phase });
      expect(
        await purchases.recordGoPurchaseDraft(alice, input)
      ).toBeUndefined();
      expect(
        await purchases.claimGoPurchaseCommit(alice, input)
      ).toBeUndefined();
      const settlements = await Promise.all(
        (["active", "placed", "rejected", "unknown"] as const).map((state) =>
          purchases.settleYandexPurchase(alice, {
            ...input,
            state,
            merchantOrderId: input.orderId,
            outcome: { kind: "late_result" },
          })
        )
      );
      expect(settlements).toEqual([undefined, undefined, undefined, undefined]);
      expect(
        await purchases.createYandexPurchase(alice, {
          ...quote(),
          confirmationQuestion: "Попробовать ещё раз?",
        })
      ).toEqual({ kind: "existing", purchase: unknown });
      expect(await purchases.readYandexPurchase(alice, input)).toEqual(unknown);
    },
    30_000
  );

  it("accepts an active ride only after the matching known order has been claimed for commit", async () => {
    const purchases = await purchasesDatabase();
    const input = await createPurchase(purchases);
    const active = {
      ...input,
      state: "active" as const,
      merchantOrderId: input.orderId,
      outcome: { kind: "accepted" },
    };
    expect(await purchases.settleYandexPurchase(alice, active)).toBeUndefined();
    await purchases.claimYandexPurchase(alice, input);
    expect(await purchases.settleYandexPurchase(alice, active)).toBeUndefined();
    await purchases.recordGoPurchaseDraft(alice, input);
    expect(await purchases.settleYandexPurchase(alice, active)).toBeUndefined();
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "rejected",
        outcome: { kind: "rejected" },
      })
    ).toBeUndefined();
    await purchases.claimGoPurchaseCommit(alice, input);
    const before = await purchases.readYandexPurchase(alice, input);
    const invalid = await Promise.all([
      purchases.settleYandexPurchase(alice, {
        ...active,
        callId: "call:wrong",
      }),
      purchases.settleYandexPurchase(bob, active),
      purchases.settleYandexPurchase({ ...alice, userId: "bob" }, active),
      purchases.settleYandexPurchase(alice, {
        ...active,
        rootSessionId: "session:wrong",
      }),
      purchases.settleYandexPurchase(alice, {
        ...active,
        merchantOrderId: "order:wrong",
      }),
      purchases.settleYandexPurchase(alice, {
        ...active,
        merchantOrderId: undefined,
      }),
      purchases.settleYandexPurchase(alice, { ...active, state: "placed" }),
      purchases.settleYandexPurchase(alice, { ...active, state: "rejected" }),
    ]);
    expect(invalid).toEqual(invalid.map(() => undefined));
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(before);
    const accepted = await purchases.settleYandexPurchase(alice, active);
    expect(accepted).toMatchObject({
      state: "active",
      phase: "accepted",
      merchantOrderId: input.orderId,
      settledAt: null,
    });
    expect(await purchases.settleYandexPurchase(alice, active)).toBeUndefined();
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...active,
        state: "unknown",
        outcome: { reason: "late_timeout" },
      })
    ).toBeUndefined();
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(accepted);
  }, 30_000);

  it("does not let Go phase operations or active settlement mutate another service", async () => {
    const purchases = await purchasesDatabase();
    const input = await createPurchase(purchases, {
      ...quote(),
      service: "lavka",
    });
    await purchases.claimYandexPurchase(alice, input);
    const before = await purchases.readYandexPurchase(alice, input);
    expect(before).toMatchObject({ state: "submitting", phase: null });
    expect(await purchases.recordGoPurchaseDraft(alice, input)).toBeUndefined();
    expect(await purchases.claimGoPurchaseCommit(alice, input)).toBeUndefined();
    expect(
      await purchases.settleYandexPurchase(alice, {
        ...input,
        state: "active",
        merchantOrderId: input.orderId,
        outcome: { kind: "accepted" },
      })
    ).toBeUndefined();
    expect(await purchases.readYandexPurchase(alice, input)).toEqual(before);
  }, 30_000);

  it.each([
    { service: "go", state: "unknown", other: "lavka" },
    { service: "go", state: "active", other: "lavka" },
    { service: "lavka", state: "unknown", other: "go" },
  ] as const)(
    "blocks $other creation and existing quote claims workspace-wide while $service is $state",
    async ({ service, state, other }) => {
      const purchases = await purchasesDatabase();
      const input = await createPurchase(purchases, { ...quote(), service });
      const teammate = { ...alice, userId: "teammate" };
      const existing = await createPurchase(
        purchases,
        {
          ...quote("other:quoted"),
          service: other,
          rootSessionId: "session:teammate",
        },
        teammate
      );
      await purchases.claimYandexPurchase(alice, input);
      if (state === "active") {
        await purchases.recordGoPurchaseDraft(alice, input);
        await purchases.claimGoPurchaseCommit(alice, input);
      }
      expect(
        await purchases.settleYandexPurchase(alice, {
          ...input,
          state,
          merchantOrderId: state === "active" ? input.orderId : undefined,
          outcome: { kind: state },
        })
      ).toMatchObject({ state });
      await purchases.database
        .update(schema.yandexPurchases)
        .set({ expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.yandexPurchases.id, input.id));
      expect(
        await purchases.createYandexPurchase(teammate, {
          ...quote("other:new"),
          service: other,
          rootSessionId: "session:teammate",
        })
      ).toEqual({ kind: "blocked" });
      expect(await purchases.claimYandexPurchase(teammate, existing)).toEqual({
        kind: "unavailable",
      });
      expect(
        await purchases.readYandexPurchase(teammate, existing)
      ).toMatchObject({
        state: "quoted",
        phase: null,
        callId: null,
      });
      const independent = await createPurchase(
        purchases,
        {
          ...quote("other:independent"),
          service: other,
          rootSessionId: "session:bob",
        },
        bob
      );
      expect(
        await purchases.claimYandexPurchase(bob, independent)
      ).toMatchObject({
        kind: "claimed",
      });
    },
    30_000
  );

  it("allows only one cross-service draft claim when two prepared purchases race", async () => {
    const purchases = await purchasesDatabase();
    const go = await createPurchase(purchases);
    const other = await createPurchase(purchases, {
      ...quote(),
      service: "lavka",
    });
    const claims = await Promise.all([
      purchases.claimYandexPurchase(alice, go),
      purchases.claimYandexPurchase(alice, other),
    ]);
    expect(claims.map((result) => result.kind).toSorted()).toEqual([
      "claimed",
      "unavailable",
    ]);
    const rows = await purchases.database.select().from(schema.yandexPurchases);
    expect(rows.filter((row) => row.state === "submitting")).toHaveLength(1);
    expect(rows.filter((row) => row.state === "quoted")).toHaveLength(1);
  }, 30_000);
});
