import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
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

async function spendingDatabase() {
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
    env: { DATABASE_DRIVER: "postgres", YANDEX_PURCHASE_WORKSPACES: "*" },
  }));
  vi.doMock("@db/services/scope", () => ({
    ensureScope: async (scope: typeof alice) => {
      await database
        .insert(schema.workspaces)
        .values({ id: scope.workspaceId })
        .onConflictDoNothing();
    },
  }));
  await database
    .insert(schema.workspaces)
    .values([{ id: alice.workspaceId }, { id: bob.workspaceId }]);
  const [spending, purchases] = await Promise.all([
    import("@db/services/spending"),
    import("@db/services/yandex-purchases"),
  ]);
  return { spending, purchases, database };
}

function quote() {
  return {
    rootSessionId: "session:alice",
    service: "go" as const,
    checkoutKey: "ride:1",
    fingerprint: "ride:1:quote:1",
    amountMinor: 25_000,
    currency: "RUB" as const,
    expiresAt: new Date(Date.now() + 60_000),
    confirmationQuestion: "Заказать эту поездку за 250 ₽?",
    publicQuote: { amountMinor: 25_000 },
    providerSnapshot: { offerId: "offer:1" },
  };
}

function consent(browserRunId: string) {
  return {
    amountRub: 250,
    browserRunId,
    category: "транспорт",
    merchant: "rides.example",
    periodKey: "2026-10",
    source: "card" as const,
  };
}

function automatic(browserRunId: string) {
  return {
    browserRunId,
    periodKey: "2026-10",
    request: {
      amount: 250,
      category: "транспорт",
      currency: "RUB" as const,
      fee: 0,
      merchant: "rides.example",
      recurring: false,
    },
  };
}

function unresolved(
  service: schema.YandexPurchase["service"],
  state: "submitting" | "unknown" | "active",
  workspaceId = alice.workspaceId
) {
  return {
    ...quote(),
    id: randomUUID(),
    workspaceId,
    userId: alice.userId,
    service,
    state,
    phase:
      service === "go"
        ? state === "active"
          ? ("accepted" as const)
          : ("draft_claimed" as const)
        : null,
    merchantOrderId: state === "active" ? "order:1" : null,
    callId: "call:1",
    submittedAt: new Date(),
  };
}

describe("Go workspace spending fence", () => {
  it.each(["unknown", "active"] as const)(
    "blocks consent and automatic reservations for a %s ride after flags are disabled",
    async (state) => {
      const test = await spendingDatabase();
      const policy = {
        currency: "RUB" as const,
        excludedCategories: [],
        excludedMerchants: [],
        rules: [{ category: null, limitRub: 5_000, merchant: null }],
        version: 1 as const,
      };
      await test.spending.updateSpendLimit(alice, () => policy);
      await test.spending.updateSpendLimit(bob, () => policy);
      const created = await test.purchases.createYandexPurchase(alice, quote());
      if (created.kind !== "created") throw new Error("Expected a purchase.");
      const input = {
        id: created.purchase.id,
        rootSessionId: created.purchase.rootSessionId,
        confirmationQuestion: created.purchase.confirmationQuestion,
        callId: "call:1",
        orderId: "order:1",
      };
      await test.purchases.claimYandexPurchase(alice, input);
      if (state === "active") {
        await test.purchases.recordGoPurchaseDraft(alice, input);
        await test.purchases.claimGoPurchaseCommit(alice, input);
      }
      const settled = await test.purchases.settleYandexPurchase(alice, {
        ...input,
        state,
        merchantOrderId: state === "active" ? input.orderId : undefined,
        outcome: { kind: state },
      });
      expect(settled).toMatchObject({ state });
      await test.database.insert(schema.spendEntries).values({
        ...consent("pending:replacement"),
        id: "original-reservation",
        workspaceId: alice.workspaceId,
      });
      const before = await test.database.select().from(schema.spendEntries);
      vi.doMock("@shared/environment", () => ({
        env: {
          DATABASE_DRIVER: "postgres",
          YANDEX_PURCHASE_WORKSPACES: undefined,
        },
      }));
      vi.resetModules();
      const spending = await import("@db/services/spending");
      const teammate = { ...alice, userId: "teammate" };
      const refused =
        /Nothing was started: a Yandex purchase may already have been placed/u;
      await expect(
        spending.reserveConsentPayment(teammate, {
          ...consent("pending:consent"),
          replacingRunId: "pending:replacement",
        })
      ).rejects.toThrow(refused);
      await expect(
        spending.reserveAutoPayment(teammate, {
          ...automatic("pending:auto"),
          replacingRunId: "pending:replacement",
        })
      ).rejects.toThrow(refused);
      await expect(
        spending.reserveConsentPayment(teammate, {
          ...consent("pending:free-consent"),
          amountRub: 0,
        })
      ).rejects.toThrow(refused);
      const free = automatic("pending:free-auto");
      await expect(
        spending.reserveAutoPayment(teammate, {
          ...free,
          request: { ...free.request, amount: 0 },
        })
      ).rejects.toThrow(refused);
      expect(await test.database.select().from(schema.spendEntries)).toEqual(
        before
      );
      expect(await test.purchases.readYandexPurchase(alice, input)).toEqual(
        settled
      );
      expect(
        await spending.reserveConsentPayment(bob, consent("bob:consent"))
      ).toEqual({
        allowed: true,
      });
      expect(
        await spending.reserveAutoPayment(bob, automatic("bob:auto"))
      ).toMatchObject({
        allowed: true,
      });
    },
    30_000
  );

  it.each(["submitting", "unknown", "active"] as const)(
    "enforces the workspace-wide unique index directly for a %s Go purchase",
    async (state) => {
      const test = await spendingDatabase();
      const go = unresolved("go", state);
      await test.database.insert(schema.yandexPurchases).values(go);
      const other = unresolved("lavka", "unknown");
      await expect(
        test.database.insert(schema.yandexPurchases).values(other)
      ).rejects.toMatchObject({
        cause: { code: "23505", constraint: "yandex_purchases_active_uidx" },
      });
      await test.database.insert(schema.yandexPurchases).values({
        ...other,
        id: randomUUID(),
        state: "quoted",
        callId: null,
        submittedAt: null,
        fingerprint: "other:quoted",
      });
      await test.database.insert(schema.yandexPurchases).values({
        ...other,
        id: randomUUID(),
        workspaceId: bob.workspaceId,
      });
      const rows = await test.database.select().from(schema.yandexPurchases);
      expect(rows).toHaveLength(3);
      expect(
        rows.filter(
          (row) =>
            row.workspaceId === alice.workspaceId && row.state !== "quoted"
        )
      ).toEqual([expect.objectContaining({ id: go.id, service: "go", state })]);
    },
    30_000
  );

  it("enforces the workspace-wide unique index in the reverse service direction", async () => {
    const test = await spendingDatabase();
    await test.database
      .insert(schema.yandexPurchases)
      .values(unresolved("lavka", "unknown"));
    await expect(
      test.database
        .insert(schema.yandexPurchases)
        .values(unresolved("go", "submitting"))
    ).rejects.toMatchObject({
      cause: { code: "23505", constraint: "yandex_purchases_active_uidx" },
    });
    expect(
      await test.database.select().from(schema.yandexPurchases)
    ).toHaveLength(1);
  }, 30_000);

  it.each([
    { phase: "accepted", merchantOrderId: null },
    { phase: "commit_claimed", merchantOrderId: "order:1" },
    { phase: null, merchantOrderId: "order:1" },
  ] as const)(
    "rejects active Go rows without the accepted phase and known order: $phase / $merchantOrderId",
    async ({ phase, merchantOrderId }) => {
      const test = await spendingDatabase();
      await expect(
        test.database.insert(schema.yandexPurchases).values({
          ...unresolved("go", "active"),
          phase,
          merchantOrderId,
        })
      ).rejects.toMatchObject({
        cause: { code: "23514", constraint: "yandex_purchases_phase_check" },
      });
      expect(
        await test.database.select().from(schema.yandexPurchases)
      ).toHaveLength(0);
    },
    30_000
  );
});
