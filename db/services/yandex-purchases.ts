import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  browserRuns,
  db,
  spendEntries,
  yandexPurchases,
  type YandexPurchase,
} from "@db";
import { ensureScope } from "./scope";
import { lockWorkspaceSpending } from "./spending";

const sensitiveKey =
  /^(?:cookies?|setcookie|csrf(?:token)?|xsrf(?:token)?|password|passwd|cardnumber|pan|cvv|cvc|authorization|accesstoken|refreshtoken)$/iu;
const safePayload = z.record(z.string(), z.json()).refine((payload) => {
  const pending: z.infer<ReturnType<typeof z.json>>[] = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    const object = z.record(z.string(), z.json()).safeParse(value);
    if (object.success) {
      for (const [key, child] of Object.entries(object.data)) {
        if (sensitiveKey.test(key.replaceAll(/[^a-z]/giu, ""))) return false;
        pending.push(child);
      }
    } else {
      const array = z.array(z.json()).safeParse(value);
      if (array.success) pending.push(...array.data);
    }
  }
  return true;
}, "Purchase payload contains a credential or card secret.");

const preparedPurchase = z.object({
  rootSessionId: z.string().trim().min(1),
  service: z.literal("lavka"),
  checkoutKey: z.string().trim().min(1),
  fingerprint: z.string().trim().min(1),
  amountMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  currency: z.literal("RUB"),
  expiresAt: z.date(),
  confirmationQuestion: z.string().min(1),
  publicQuote: safePayload,
  providerSnapshot: safePayload,
});

function ownedPurchase(
  scope: AccessScope,
  input: Pick<YandexPurchase, "id" | "rootSessionId">
) {
  return and(
    eq(yandexPurchases.id, input.id),
    eq(yandexPurchases.workspaceId, scope.workspaceId),
    eq(yandexPurchases.userId, scope.userId),
    eq(yandexPurchases.rootSessionId, input.rootSessionId)
  );
}

export async function createYandexPurchase(
  scope: AccessScope,
  input: Pick<
    YandexPurchase,
    | "rootSessionId"
    | "service"
    | "checkoutKey"
    | "fingerprint"
    | "amountMinor"
    | "currency"
    | "expiresAt"
    | "confirmationQuestion"
    | "publicQuote"
    | "providerSnapshot"
  >
) {
  const prepared = preparedPurchase.parse(input);
  if (env.DATABASE_DRIVER === "neon-http") {
    throw new Error(
      "Yandex purchases require a transactional database driver."
    );
  }
  await ensureScope(scope);
  return db.transaction(async (transaction) => {
    await lockWorkspaceSpending(transaction, scope);
    const [existing] = await transaction
      .select()
      .from(yandexPurchases)
      .where(
        and(
          eq(yandexPurchases.workspaceId, scope.workspaceId),
          eq(yandexPurchases.service, prepared.service),
          eq(yandexPurchases.fingerprint, prepared.fingerprint)
        )
      )
      .limit(1);
    if (existing) {
      if (
        existing.userId !== scope.userId ||
        existing.rootSessionId !== prepared.rootSessionId
      )
        return { kind: "blocked" as const };
      const now = new Date();
      if (
        ((existing.state === "quoted" && existing.expiresAt <= now) ||
          (existing.state === "rejected" &&
            existing.outcome?.kind === "rejected" &&
            existing.merchantOrderId === null)) &&
        prepared.expiresAt > now &&
        existing.confirmationQuestion !== prepared.confirmationQuestion
      ) {
        const [renewed] = await transaction
          .update(yandexPurchases)
          .set({
            state: "quoted",
            callId: null,
            submittedAt: null,
            settledAt: null,
            outcome: null,
            expiresAt: prepared.expiresAt,
            confirmationQuestion: prepared.confirmationQuestion,
            publicQuote: prepared.publicQuote,
            providerSnapshot: prepared.providerSnapshot,
            updatedAt: now,
          })
          .where(
            and(
              ownedPurchase(scope, existing),
              eq(yandexPurchases.state, existing.state)
            )
          )
          .returning();
        if (!renewed) throw new Error("Purchase quote could not be renewed.");
        return { kind: "existing" as const, purchase: renewed };
      }
      return { kind: "existing" as const, purchase: existing };
    }
    const [active] = await transaction
      .select({ id: yandexPurchases.id })
      .from(yandexPurchases)
      .where(
        and(
          eq(yandexPurchases.workspaceId, scope.workspaceId),
          eq(yandexPurchases.service, prepared.service),
          inArray(yandexPurchases.state, ["submitting", "unknown"])
        )
      )
      .limit(1);
    if (active) return { kind: "blocked" as const };
    const [purchase] = await transaction
      .insert(yandexPurchases)
      .values({
        ...prepared,
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      })
      .returning();
    if (!purchase) throw new Error("Purchase intent could not be created.");
    return { kind: "created" as const, purchase };
  });
}

export async function readYandexPurchase(
  scope: AccessScope,
  input: Pick<YandexPurchase, "id" | "rootSessionId">
) {
  const [purchase] = await db
    .select()
    .from(yandexPurchases)
    .where(ownedPurchase(scope, input))
    .limit(1);
  return purchase;
}

export async function claimYandexPurchase(
  scope: AccessScope,
  input: Pick<
    YandexPurchase,
    "id" | "rootSessionId" | "confirmationQuestion"
  > & {
    callId: string;
  }
) {
  z.string().trim().min(1).parse(input.callId);
  return db.transaction(async (transaction) => {
    await lockWorkspaceSpending(transaction, scope);
    const [purchase] = await transaction
      .select()
      .from(yandexPurchases)
      .where(ownedPurchase(scope, input))
      .limit(1);
    if (
      !purchase ||
      purchase.confirmationQuestion !== input.confirmationQuestion
    )
      return { kind: "unavailable" as const };
    if (purchase.state !== "quoted") {
      return { kind: "existing" as const, purchase };
    }
    const now = new Date();
    if (purchase.expiresAt <= now) {
      return { kind: "expired" as const, purchase };
    }
    const [browserReservation] = await transaction
      .select({ id: spendEntries.id })
      .from(spendEntries)
      .where(
        and(
          eq(spendEntries.workspaceId, scope.workspaceId),
          eq(spendEntries.status, "reserved")
        )
      )
      .limit(1);
    if (browserReservation) return { kind: "unavailable" as const };
    const [browserPayment] = await transaction
      .select({ id: browserRuns.id })
      .from(browserRuns)
      .where(
        and(
          eq(browserRuns.workspaceId, scope.workspaceId),
          eq(browserRuns.paymentAllowed, true),
          inArray(browserRuns.status, [
            "created",
            "queued",
            "running",
            "waiting",
          ])
        )
      )
      .limit(1);
    if (browserPayment) return { kind: "unavailable" as const };
    const [active] = await transaction
      .select({ id: yandexPurchases.id })
      .from(yandexPurchases)
      .where(
        and(
          eq(yandexPurchases.workspaceId, scope.workspaceId),
          eq(yandexPurchases.service, purchase.service),
          inArray(yandexPurchases.state, ["submitting", "unknown"])
        )
      )
      .limit(1);
    if (active) return { kind: "unavailable" as const };
    const [claimed] = await transaction
      .update(yandexPurchases)
      .set({
        state: "submitting",
        callId: input.callId,
        submittedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          ownedPurchase(scope, input),
          eq(yandexPurchases.state, "quoted"),
          eq(yandexPurchases.confirmationQuestion, input.confirmationQuestion)
        )
      )
      .returning();
    if (!claimed) return { kind: "unavailable" as const };
    return { kind: "claimed" as const, purchase: claimed };
  });
}

export async function settleYandexPurchase(
  scope: AccessScope,
  input: Pick<YandexPurchase, "id" | "rootSessionId"> & {
    callId: string;
    state: "placed" | "rejected" | "unknown";
    outcome: NonNullable<YandexPurchase["outcome"]>;
    merchantOrderId?: string;
  }
) {
  const state = z.enum(["placed", "rejected", "unknown"]).parse(input.state);
  const outcome = safePayload.parse(input.outcome);
  return db.transaction(async (transaction) => {
    await lockWorkspaceSpending(transaction, scope);
    const [purchase] = await transaction
      .select()
      .from(yandexPurchases)
      .where(
        and(
          ownedPurchase(scope, input),
          eq(yandexPurchases.callId, input.callId)
        )
      )
      .limit(1);
    if (!purchase) return undefined;
    if (purchase.state !== "submitting") return undefined;
    const now = new Date();
    const [settled] = await transaction
      .update(yandexPurchases)
      .set({
        state,
        outcome,
        merchantOrderId: input.merchantOrderId ?? purchase.merchantOrderId,
        updatedAt: now,
        settledAt: now,
      })
      .where(
        and(
          ownedPurchase(scope, input),
          eq(yandexPurchases.callId, input.callId),
          eq(yandexPurchases.state, purchase.state)
        )
      )
      .returning();
    return settled;
  });
}
