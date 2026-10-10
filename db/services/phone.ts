import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  agentSessions,
  phoneCalls,
  phoneEvents,
  phoneNumbers,
  phoneNumberRequests,
  proactiveWatches,
  workspaceMemberships,
} from "@db";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { PhonePreflightError } from "@shared/phone/errors";

export function requirePhoneTransactions() {
  if (env.DATABASE_DRIVER === "neon-http")
    throw new Error(
      "Telephony requires transactional Postgres; neon-http is disabled."
    );
}

export function phonePilot(scope: AccessScope) {
  return Boolean(
    env.MTS_EXOLVE_API_KEY &&
    env.ELEVENLABS_API_KEY &&
    env.PHONE_AGENT_ID &&
    env.PHONE_INIT_SECRET &&
    env.PHONE_WEBHOOK_SECRET &&
    env.EVE_SCHEDULES === "on" &&
    env.DATABASE_DRIVER !== "neon-http" &&
    (env.PHONE_WORKSPACES ?? []).some(
      (entry) => entry === "*" || entry === scope.workspaceId
    )
  );
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type NumberRow = typeof phoneNumbers.$inferSelect;
type CallRow = typeof phoneCalls.$inferSelect;

export async function enqueueNewWorkspacePhone(
  transaction: Transaction,
  scope: AccessScope
) {
  if (
    env.PHONE_AUTO_PROVISION !== "on" ||
    !(
      env.PHONE_WORKSPACES?.includes("*") ||
      env.PHONE_WORKSPACES?.includes(scope.workspaceId)
    )
  )
    return;
  requirePhoneTransactions();
  await requireOwner(transaction, scope);
  await transaction
    .insert(phoneNumberRequests)
    .values({ workspaceId: scope.workspaceId, ownerUserId: scope.userId })
    .onConflictDoNothing();
}

export async function readPhoneNumberRequest(scope: AccessScope) {
  const [row] = await db
    .select({
      state: phoneNumberRequests.state,
      attempts: phoneNumberRequests.attempts,
      nextAttemptAt: phoneNumberRequests.nextAttemptAt,
      lastFailure: phoneNumberRequests.lastFailure,
    })
    .from(phoneNumberRequests)
    .where(
      and(
        eq(phoneNumberRequests.workspaceId, scope.workspaceId),
        eq(phoneNumberRequests.ownerUserId, scope.userId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function claimPhoneNumberRequests() {
  requirePhoneTransactions();
  if (env.PHONE_AUTO_PROVISION !== "on" || !env.PHONE_WORKSPACES?.length)
    return [];
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('phone:allocation', 0))`
    );
    const [active] = await transaction
      .select({ total: sql<number>`count(*)::int` })
      .from(phoneNumbers)
      .where(
        inArray(phoneNumbers.state, [
          "provisioning",
          "uncertain",
          "active",
          "disabled",
          "releasing",
          "operator-required",
        ])
      );
    const capacity =
      env.PHONE_MAX_ACTIVE_NUMBERS === undefined ||
      (active?.total ?? 0) < env.PHONE_MAX_ACTIVE_NUMBERS;
    const rows = await transaction
      .select()
      .from(phoneNumberRequests)
      .where(
        and(
          inArray(phoneNumberRequests.state, ["pending", "retry", "working"]),
          lt(phoneNumberRequests.nextAttemptAt, new Date(Date.now() + 1)),
          or(
            isNull(phoneNumberRequests.leaseUntil),
            lt(phoneNumberRequests.leaseUntil, new Date())
          ),
          env.PHONE_WORKSPACES?.includes("*")
            ? undefined
            : inArray(
                phoneNumberRequests.workspaceId,
                env.PHONE_WORKSPACES ?? []
              ),
          capacity
            ? undefined
            : sql`exists(select 1 from ${phoneNumbers} where ${phoneNumbers.workspaceId}=${phoneNumberRequests.workspaceId} and ${phoneNumbers.state} not in ('quoted','released'))`
        )
      )
      .orderBy(asc(phoneNumberRequests.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    return Promise.all(
      rows.map(async (row) => {
        const [claimed] = await transaction
          .update(phoneNumberRequests)
          .set({
            state: "working",
            attempts: row.attempts + 1,
            leaseToken: randomUUID(),
            leaseUntil: new Date(Date.now() + 10 * 60_000),
            updatedAt: new Date(),
          })
          .where(eq(phoneNumberRequests.workspaceId, row.workspaceId))
          .returning();
        if (!claimed) throw new Error("Phone allocation request lease lost.");
        return claimed;
      })
    );
  });
}

export async function finishPhoneNumberRequest(
  workspaceId: string,
  token: string,
  state: "retry" | "complete" | "operator-required",
  failure: "preflight" | "uncertain" | "configuration" | "capacity" | null
) {
  await db
    .update(phoneNumberRequests)
    .set({
      state,
      lastFailure: failure,
      leaseToken: null,
      leaseUntil: null,
      updatedAt: new Date(),
      nextAttemptAt: sql`now() + make_interval(secs => least(60 * power(2, least(greatest(${phoneNumberRequests.attempts} - 1, 0), 12)), 21600)::int)`,
    })
    .where(
      and(
        eq(phoneNumberRequests.workspaceId, workspaceId),
        eq(phoneNumberRequests.leaseToken, token)
      )
    );
}

export async function bindPhoneReportRoute(
  scope: AccessScope,
  route: PhoneReportRoute
) {
  requirePhoneTransactions();
  if (
    !route.sessionId ||
    !route.conversationId ||
    !["eve", "photon", "telegram"].includes(route.conversationChannel ?? "")
  )
    throw new Error("A trusted complete phone report route is required.");
  await db.transaction(async (transaction) => {
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    const [session] = await transaction
      .select({ id: agentSessions.sessionId })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.sessionId, route.sessionId ?? ""),
          eq(agentSessions.workspaceId, scope.workspaceId),
          eq(agentSessions.createdByUserId, scope.userId)
        )
      )
      .limit(1);
    if (!session)
      throw new Error("The report session is not owned by this workspace.");
    await transaction
      .update(phoneNumberRequests)
      .set({ ...route, updatedAt: new Date() })
      .where(
        and(
          eq(phoneNumberRequests.workspaceId, scope.workspaceId),
          eq(phoneNumberRequests.ownerUserId, scope.userId),
          isNull(phoneNumberRequests.sessionId)
        )
      );
    await transaction
      .update(phoneNumbers)
      .set({ ...route, updatedAt: new Date() })
      .where(
        and(
          eq(phoneNumbers.workspaceId, scope.workspaceId),
          eq(phoneNumbers.ownerUserId, scope.userId),
          isNull(phoneNumbers.sessionId)
        )
      );
    await transaction
      .update(phoneCalls)
      .set(route)
      .where(
        and(
          eq(phoneCalls.workspaceId, scope.workspaceId),
          eq(phoneCalls.ownerUserId, scope.userId),
          isNull(phoneCalls.sessionId)
        )
      );
  });
}

export type PhoneReportRoute = Pick<
  NumberRow,
  "sessionId" | "conversationId" | "conversationChannel"
>;

async function lockWorkspace(transaction: Transaction, workspaceId: string) {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`phone:${workspaceId}`}, 0))`
  );
}

async function requireOwner(transaction: Transaction, scope: AccessScope) {
  const [owner] = await transaction
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, scope.workspaceId),
        eq(workspaceMemberships.userId, scope.userId),
        eq(workspaceMemberships.role, "owner")
      )
    )
    .limit(1);
  if (!owner)
    throw new Error("This phone belongs to a different workspace owner.");
}

export async function readPhoneNumber(scope: AccessScope) {
  const [row] = await db
    .select()
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.workspaceId, scope.workspaceId),
        eq(phoneNumbers.ownerUserId, scope.userId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function readInboundPhoneScope(
  calledNumber: string,
  agentId: string
) {
  const [row] = await db
    .select({
      workspaceId: phoneNumbers.workspaceId,
      userId: phoneNumbers.ownerUserId,
    })
    .from(phoneNumbers)
    .where(
      and(
        eq(phoneNumbers.number, calledNumber),
        eq(phoneNumbers.agentId, agentId),
        eq(phoneNumbers.state, "active")
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * A quote nobody activated for a day holds a number but no money: no purchase
 * started (stage `quoted`), no provider resource, no lease. Another workspace
 * may take the number over; any row past the quote stage never.
 */
const staleQuoteMs = 24 * 60 * 60_000;

function staleQuote(now: Date) {
  return and(
    eq(phoneNumbers.state, "quoted"),
    eq(phoneNumbers.stage, "quoted"),
    isNull(phoneNumbers.numberId),
    isNull(phoneNumbers.leaseToken),
    lt(phoneNumbers.quotedAt, new Date(now.getTime() - staleQuoteMs))
  );
}

/**
 * Numbers another workspace's row holds, so a new quote skips them: the
 * number is unique in our table, and the provider still lists a number as free
 * while a quote, a failed activation or a released row of ours holds it.
 */
export async function readHeldPhoneNumbers(scope: AccessScope) {
  const rows = await db
    .select({ number: phoneNumbers.number })
    .from(phoneNumbers)
    .where(
      and(
        ne(phoneNumbers.workspaceId, scope.workspaceId),
        sql`not (${staleQuote(new Date())})`
      )
    );
  return new Set(rows.map((row) => row.number));
}

export async function savePhoneQuote(
  scope: AccessScope,
  quote: Pick<
    NumberRow,
    "number" | "setupRub" | "monthlyRub" | "sipMonthlyRub" | "quotedAt"
  >,
  route: PhoneReportRoute
) {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('phone:allocation', 0))`
    );
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    let currentRoute = route;
    if (!route.sessionId) {
      const [request] = await transaction
        .select({
          sessionId: phoneNumberRequests.sessionId,
          conversationId: phoneNumberRequests.conversationId,
          conversationChannel: phoneNumberRequests.conversationChannel,
        })
        .from(phoneNumberRequests)
        .where(
          and(
            eq(phoneNumberRequests.workspaceId, scope.workspaceId),
            eq(phoneNumberRequests.ownerUserId, scope.userId)
          )
        )
        .limit(1);
      if (request?.sessionId) currentRoute = request;
    }
    const [known] = await transaction
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.workspaceId, scope.workspaceId));
    if (known && known.state !== "quoted") return known;
    const [holder] = await transaction
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.number, quote.number),
          ne(phoneNumbers.workspaceId, scope.workspaceId)
        )
      );
    if (holder) {
      // The allocation lock is held, so the holder is not being activated.
      const [taken] = await transaction
        .delete(phoneNumbers)
        .where(and(eq(phoneNumbers.id, holder.id), staleQuote(new Date())))
        .returning({ id: phoneNumbers.id });
      if (!taken) throw new PhonePreflightError("CANDIDATE_UNAVAILABLE");
    }
    const [row] = await transaction
      .insert(phoneNumbers)
      .values({
        ...quote,
        ...currentRoute,
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        ownerUserId: scope.userId,
        state: "quoted",
      })
      .onConflictDoUpdate({
        target: phoneNumbers.workspaceId,
        set: {
          ...quote,
          ...currentRoute,
          id: randomUUID(),
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("Could not persist phone quote.");
    return row;
  });
}

/** Numbers that wait for the operator: a purchase or a release nobody can verify. */
export async function listPhoneOperatorRequired() {
  return db
    .select({
      id: phoneNumbers.id,
      number: phoneNumbers.number,
      stage: phoneNumbers.stage,
      updatedAt: phoneNumbers.updatedAt,
    })
    .from(phoneNumbers)
    .where(eq(phoneNumbers.state, "operator-required"));
}

export async function claimPhoneActivation(
  scope: AccessScope,
  quoteId: string
) {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('phone:allocation', 0))`
    );
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    const [row] = await transaction
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.id, quoteId),
          eq(phoneNumbers.workspaceId, scope.workspaceId),
          eq(phoneNumbers.ownerUserId, scope.userId)
        )
      );
    if (!row) throw new Error("Get a phone quote first.");
    if (row.state === "active" || row.state === "disabled")
      return { row, claimed: false };
    if (
      row.state !== "quoted" &&
      row.state !== "uncertain" &&
      row.state !== "provisioning"
    )
      throw new Error("Number cannot be activated in this state.");
    if (row.leaseUntil && row.leaseUntil.getTime() > Date.now())
      return { row, claimed: false };
    const [accountOperation] = await transaction
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(
        and(
          ne(phoneNumbers.id, row.id),
          inArray(phoneNumbers.state, ["provisioning", "releasing"]),
          gt(phoneNumbers.leaseUntil, new Date())
        )
      )
      .limit(1);
    if (accountOperation)
      throw new Error(
        "Another phone provisioning operation holds the account lease; retry later without creating resources."
      );
    if (row.state === "quoted") {
      if (
        Date.now() - row.quotedAt.getTime() > 5 * 60_000 ||
        row.setupRub > env.PHONE_MAX_SETUP_RUB ||
        row.monthlyRub > env.PHONE_MAX_MONTHLY_RUB ||
        row.sipMonthlyRub > env.PHONE_MAX_SIP_MONTHLY_RUB
      )
        throw new Error(
          "Phone quote expired or exceeds operator caps; request a new quote."
        );
      const [count] = await transaction
        .select({ total: sql<number>`count(*)::int` })
        .from(phoneNumbers)
        .where(
          and(
            ne(phoneNumbers.id, row.id),
            inArray(phoneNumbers.state, [
              "provisioning",
              "uncertain",
              "active",
              "disabled",
              "releasing",
              "operator-required",
            ])
          )
        );
      if (
        env.PHONE_MAX_ACTIVE_NUMBERS !== undefined &&
        (count?.total ?? 0) >= env.PHONE_MAX_ACTIVE_NUMBERS
      )
        throw new Error("Global dedicated-number pilot cap reached.");
    }
    const [claimed] = await transaction
      .update(phoneNumbers)
      .set({
        state: "provisioning",
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 5 * 60_000),
        updatedAt: new Date(),
      })
      .where(eq(phoneNumbers.id, row.id))
      .returning();
    if (!claimed) throw new Error("Activation claim lost.");
    return { row: claimed, claimed: true };
  });
}

export async function updatePhoneProvisioning(
  id: string,
  leaseToken: string,
  patch: Partial<
    Pick<
      NumberRow,
      | "stage"
      | "state"
      | "numberId"
      | "sipId"
      | "phoneNumberId"
      | "outboundPhoneNumberId"
      | "agentId"
      | "monthlyRub"
      | "sipMonthlyRub"
    >
  >,
  finish = false
) {
  const values: Partial<typeof phoneNumbers.$inferInsert> = {
    ...patch,
    updatedAt: new Date(),
    leaseUntil: new Date(Date.now() + 5 * 60_000),
  };
  if (finish) {
    values.leaseToken = null;
    values.leaseUntil = null;
  }
  const [row] = await db
    .update(phoneNumbers)
    .set(values)
    .where(
      and(
        eq(phoneNumbers.id, id),
        eq(phoneNumbers.leaseToken, leaseToken),
        gt(phoneNumbers.leaseUntil, new Date())
      )
    )
    .returning();
  if (!row)
    throw new Error(
      "Phone provisioning lease lost; no further provider mutations are allowed."
    );
  return row;
}

export async function changePhoneState(
  scope: AccessScope,
  state: "active" | "disabled" | "releasing"
) {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    const [row] = await transaction
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, scope.workspaceId),
          eq(phoneNumbers.ownerUserId, scope.userId)
        )
      );
    if (!row) throw new Error("No dedicated number.");
    if (row.state === "released") return row;
    if (row.state === "operator-required" && state !== "releasing")
      throw new Error(
        "An operator-required number cannot be re-enabled; explicitly confirm release to retry cleanup."
      );
    if (row.leaseUntil && row.leaseUntil.getTime() > Date.now())
      throw new Error("Number operation is already in progress.");
    if (
      state === "disabled" &&
      row.state !== "active" &&
      row.state !== "disabled"
    )
      throw new Error("Only an active number can be disabled.");
    if (state === "active" && row.state !== "disabled")
      throw new Error("Only a disabled number can be re-enabled.");
    const [open] = await transaction
      .select({ id: phoneCalls.id })
      .from(phoneCalls)
      .where(
        and(
          eq(phoneCalls.workspaceId, scope.workspaceId),
          isNull(phoneCalls.completedAt)
        )
      )
      .limit(1);
    if (open)
      throw new Error("Wait for unresolved calls before changing the number.");
    const [updated] = await transaction
      .update(phoneNumbers)
      .set({
        state,
        leaseToken: state === "releasing" ? randomUUID() : null,
        leaseUntil:
          state === "releasing" ? new Date(Date.now() + 5 * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(phoneNumbers.id, row.id))
      .returning();
    if (!updated) throw new Error("Number state update failed.");
    return updated;
  });
}

async function reserveCall(
  transaction: Transaction,
  number: NumberRow,
  input: Pick<
    CallRow,
    "operationId" | "inputHash" | "direction" | "target" | "task"
  > &
    PhoneReportRoute & { providerConversationId?: string }
) {
  const [existing] = await transaction
    .select()
    .from(phoneCalls)
    .where(eq(phoneCalls.operationId, input.operationId));
  if (existing) {
    if (
      existing.workspaceId !== number.workspaceId ||
      existing.inputHash !== input.inputHash
    )
      throw new Error("Phone operation key was reused with different input.");
    return { row: existing, created: false };
  }
  if (
    number.state !== "active" ||
    !number.phoneNumberId ||
    !number.agentId ||
    (input.direction === "outbound" && !number.outboundPhoneNumberId)
  )
    throw new Error("Dedicated phone is not active.");
  const [row] = await transaction
    .insert(phoneCalls)
    .values({
      ...input,
      id: randomUUID(),
      workspaceId: number.workspaceId,
      ownerUserId: number.ownerUserId,
      numberRecordId: number.id,
      state: input.direction === "inbound" ? "accepted" : "planned",
    })
    .returning();
  if (!row) throw new Error("Could not reserve call.");
  if (input.direction === "outbound")
    await transaction
      .update(phoneNumbers)
      .set({
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        conversationChannel: input.conversationChannel,
      })
      .where(eq(phoneNumbers.id, number.id));
  return { row, created: true };
}

export async function planOutboundCall(
  scope: AccessScope,
  input: Pick<CallRow, "operationId" | "inputHash" | "target" | "task"> &
    PhoneReportRoute
) {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    const [number] = await transaction
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.workspaceId, scope.workspaceId),
          eq(phoneNumbers.ownerUserId, scope.userId)
        )
      );
    if (!number) throw new Error("Activate a dedicated phone first.");
    return reserveCall(transaction, number, {
      ...input,
      direction: "outbound",
    });
  });
}

// Бро уже дозванивался на этот номер (разговор состоялся): знакомым людям не нужно представляться заново.
export async function hasEarlierConnectedCall(
  scope: AccessScope,
  target: string,
  exceptId: string
) {
  const [row] = await db
    .select({ id: phoneCalls.id })
    .from(phoneCalls)
    .where(
      and(
        eq(phoneCalls.workspaceId, scope.workspaceId),
        eq(phoneCalls.ownerUserId, scope.userId),
        eq(phoneCalls.direction, "outbound"),
        eq(phoneCalls.target, target),
        ne(phoneCalls.id, exceptId),
        eq(phoneCalls.state, "done"),
        gt(phoneCalls.durationSeconds, 5)
      )
    )
    .limit(1);
  return row !== undefined;
}

export async function acceptInboundCall(input: {
  calledNumber: string;
  agentId: string;
  phoneNumberId?: string;
  conversationId: string;
  callerPhoneNumber?: string | null;
}) {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    const [number] = await transaction
      .select()
      .from(phoneNumbers)
      .where(
        and(
          eq(phoneNumbers.number, input.calledNumber),
          eq(phoneNumbers.agentId, input.agentId),
          eq(phoneNumbers.state, "active")
        )
      );
    if (
      !number ||
      (input.phoneNumberId && input.phoneNumberId !== number.phoneNumberId)
    )
      throw new Error("Unrecognized dedicated phone.");
    await lockWorkspace(transaction, number.workspaceId);
    const [fresh] = await transaction
      .select()
      .from(phoneNumbers)
      .where(eq(phoneNumbers.id, number.id));
    if (!fresh) throw new Error("Unbound phone.");
    await requireOwner(transaction, {
      userId: fresh.ownerUserId,
      workspaceId: fresh.workspaceId,
    });
    return reserveCall(transaction, fresh, {
      operationId: `inbound:${input.conversationId}`,
      inputHash: `${fresh.id}:${input.conversationId}`,
      direction: "inbound",
      target:
        input.callerPhoneNumber && isE164PhoneNumber(input.callerPhoneNumber)
          ? input.callerPhoneNumber
          : null,
      task: null,
      sessionId: fresh.sessionId,
      conversationId: fresh.conversationId,
      conversationChannel: fresh.conversationChannel,
      providerConversationId: input.conversationId,
    });
  });
}

export async function claimCallStart(scope: AccessScope, id: string) {
  const [row] = await db
    .update(phoneCalls)
    .set({ state: "starting", checkedAt: new Date() })
    .where(
      and(
        eq(phoneCalls.id, id),
        eq(phoneCalls.workspaceId, scope.workspaceId),
        eq(phoneCalls.ownerUserId, scope.userId),
        eq(phoneCalls.state, "planned")
      )
    )
    .returning();
  return row ?? null;
}

export async function recordCallAccepted(
  id: string,
  conversationId: string,
  accepted = true
) {
  await db
    .update(phoneCalls)
    .set({
      state: accepted ? "accepted" : "processing",
      outcome: accepted ? null : "initiation_rejected",
      providerConversationId: conversationId,
      checkedAt: new Date(),
    })
    .where(and(eq(phoneCalls.id, id), eq(phoneCalls.state, "starting")));
}

export async function recordCallUncertain(id: string) {
  await db
    .update(phoneCalls)
    .set({ state: "uncertain", checkedAt: new Date() })
    .where(and(eq(phoneCalls.id, id), eq(phoneCalls.state, "starting")));
}

export async function listPhoneCalls(scope: AccessScope, callId?: string) {
  const rows = await db
    .select({
      id: phoneCalls.id,
      direction: phoneCalls.direction,
      target: phoneCalls.target,
      state: phoneCalls.state,
      outcome: phoneCalls.outcome,
      taskSucceeded: phoneCalls.taskSucceeded,
      summary: phoneCalls.summary,
      costUsd: phoneCalls.costUsd,
      carrierRub: phoneCalls.carrierRub,
      createdAt: phoneCalls.createdAt,
    })
    .from(phoneCalls)
    .where(
      and(
        eq(phoneCalls.workspaceId, scope.workspaceId),
        eq(phoneCalls.ownerUserId, scope.userId),
        callId === undefined ? undefined : eq(phoneCalls.id, callId)
      )
    )
    .orderBy(sql`${phoneCalls.createdAt} desc`)
    .limit(callId === undefined ? 20 : 1);
  return rows.map((row) =>
    Object.assign({}, row, {
      target: row.direction === "outbound" ? row.target : null,
      caller: row.direction === "inbound" ? row.target : null,
      callerIdentity: row.direction === "inbound" ? "unverified" : null,
    })
  );
}

/**
 * The 20 open calls checked longest ago, never-checked ones first (a new
 * inbound call has no `checked_at`). Each is marked checked here, whatever the
 * poll does with it: a call whose poll returns early or fails still rotates to
 * the back, so a few stuck calls cannot starve the rest of the queue.
 */
export async function listPhonePolls() {
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select({ call: phoneCalls, number: phoneNumbers })
      .from(phoneCalls)
      .innerJoin(phoneNumbers, eq(phoneCalls.numberRecordId, phoneNumbers.id))
      .where(isNull(phoneCalls.completedAt))
      .orderBy(sql`${phoneCalls.checkedAt} asc nulls first`)
      .limit(20)
      .for("update", { of: phoneCalls, skipLocked: true });
    if (rows.length)
      await transaction
        .update(phoneCalls)
        .set({ checkedAt: new Date() })
        .where(
          inArray(
            phoneCalls.id,
            rows.map(({ call }) => call.id)
          )
        );
    return rows;
  });
}

export async function updatePhoneCall(
  id: string,
  patch: Partial<
    Pick<
      CallRow,
      | "state"
      | "providerConversationId"
      | "durationSeconds"
      | "costUsd"
      | "carrierRub"
      | "outcome"
      | "taskSucceeded"
      | "summary"
      | "completedAt"
    >
  >
) {
  const values: Partial<typeof phoneCalls.$inferInsert> = {
    ...patch,
    checkedAt: new Date(),
  };
  if (patch.completedAt) values.task = null;
  await db
    .update(phoneCalls)
    .set(values)
    .where(and(eq(phoneCalls.id, id), isNull(phoneCalls.completedAt)));
}

export async function expirePlannedPhoneCall(id: string) {
  const [row] = await db
    .update(phoneCalls)
    .set({
      state: "failed",
      outcome: "not_submitted",
      summary: "No provider call was submitted before the request expired.",
      task: null,
      durationSeconds: 0,
      completedAt: new Date(),
      checkedAt: new Date(),
    })
    .where(
      and(
        eq(phoneCalls.id, id),
        eq(phoneCalls.state, "planned"),
        isNull(phoneCalls.completedAt)
      )
    )
    .returning();
  return row ?? null;
}

export async function enqueuePhoneEvent(input: {
  id: string;
  providerConversationId: string;
  eventType: string;
  timestamp: number;
}) {
  const [known] = await db
    .select({ id: phoneCalls.id, completedAt: phoneCalls.completedAt })
    .from(phoneCalls)
    .where(eq(phoneCalls.providerConversationId, input.providerConversationId))
    .limit(1);
  if (!known) return;
  await db
    .insert(phoneEvents)
    .values({
      id: input.id,
      providerConversationId: input.providerConversationId,
      eventType: input.eventType,
      processedAt: known.completedAt ? new Date() : null,
      metadata: { timestamp: input.timestamp },
    })
    .onConflictDoNothing();
}

export async function acknowledgePhoneEvents(conversationId: string) {
  await db
    .update(phoneEvents)
    .set({ processedAt: new Date() })
    .where(
      and(
        eq(phoneEvents.providerConversationId, conversationId),
        isNull(phoneEvents.processedAt)
      )
    );
}

/**
 * Sends of one call's report, over its first 24 hours. A hand-over is a paid
 * model turn and a chat message, so a report that keeps failing stops early;
 * its result stays available through `phone-status`.
 */
const maximumReportAttempts = 5;

/**
 * How long a report the conversation accepted may wait for its turn. With
 * `turnPolicy: "queue"` it waits behind a turn the person started, which can
 * run for minutes; sent again after the plain lease, a second copy was a second
 * paid turn. The turn's start renews the lease and its end settles the report.
 */
const handedOverLeaseMs = 10 * 60_000;

export async function claimPhoneReports() {
  requirePhoneTransactions();
  return db.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(phoneCalls)
      .where(
        and(
          sql`${phoneCalls.completedAt} is not null`,
          isNull(phoneCalls.reportDeliveredAt),
          sql`${phoneCalls.sessionId} is not null`,
          sql`${phoneCalls.conversationId} is not null`,
          sql`${phoneCalls.conversationChannel} is not null`,
          lt(phoneCalls.reportAttempts, maximumReportAttempts),
          or(
            isNull(phoneCalls.reportStartedAt),
            gt(
              phoneCalls.reportStartedAt,
              new Date(Date.now() - 24 * 60 * 60_000)
            )
          ),
          or(
            isNull(phoneCalls.reportLeaseUntil),
            lt(phoneCalls.reportLeaseUntil, new Date())
          )
        )
      )
      .orderBy(asc(phoneCalls.completedAt))
      .limit(20)
      .for("update", { skipLocked: true });
    return Promise.all(
      rows.map(async (row) => {
        const [updated] = await transaction
          .update(phoneCalls)
          .set({
            // One token for the life of the report: a copy that waited in
            // the conversation's queue past the lease still belongs to this
            // report and settles it, instead of being refused as stale
            // while the next copy goes out again. Delivery clears it, so a
            // copy that comes after the report landed sends nothing.
            reportLeaseToken: row.reportLeaseToken ?? randomUUID(),
            reportLeaseUntil: new Date(Date.now() + 5 * 60_000),
            reportAttempts: row.reportAttempts + 1,
            reportStartedAt: row.reportStartedAt ?? new Date(),
          })
          .where(eq(phoneCalls.id, row.id))
          .returning();
        if (!updated) throw new Error("Report lease claim lost.");
        return updated;
      })
    );
  });
}

/** Settles a report turn; true when this call marked the report delivered. */
export async function finishPhoneReport(
  id: string,
  token: string,
  delivered: boolean
) {
  if (delivered) {
    const rows = await db
      .update(phoneCalls)
      .set({
        reportDeliveredAt: new Date(),
        reportLeaseToken: null,
        reportLeaseUntil: null,
      })
      .where(
        and(
          eq(phoneCalls.id, id),
          eq(phoneCalls.reportLeaseToken, token),
          isNull(phoneCalls.reportDeliveredAt)
        )
      )
      .returning({ id: phoneCalls.id });
    return rows.length > 0;
  }
  await db
    .update(phoneCalls)
    .set({
      reportLeaseUntil: sql`now() + make_interval(secs => least(60 * power(2, greatest(${phoneCalls.reportAttempts} - 1, 0)), 3600)::int)`,
    })
    .where(and(eq(phoneCalls.id, id), eq(phoneCalls.reportLeaseToken, token)));
  return false;
}

/**
 * The conversation took the report, or may have: nobody sends it again until
 * its turn had time to start. A dispatch that timed out is the same, since
 * eve may have accepted it after the caller stopped waiting.
 */
export async function holdPhoneReportForTurn(id: string, token: string) {
  await db
    .update(phoneCalls)
    .set({ reportLeaseUntil: new Date(Date.now() + handedOverLeaseMs) })
    .where(
      and(
        eq(phoneCalls.id, id),
        eq(phoneCalls.reportLeaseToken, token),
        isNull(phoneCalls.reportDeliveredAt)
      )
    );
}

export async function renewPhoneReportLease(
  scope: AccessScope,
  id: string,
  token: string
) {
  const [row] = await db
    .update(phoneCalls)
    .set({ reportLeaseUntil: new Date(Date.now() + 5 * 60_000) })
    .where(
      and(
        eq(phoneCalls.id, id),
        eq(phoneCalls.workspaceId, scope.workspaceId),
        eq(phoneCalls.ownerUserId, scope.userId),
        eq(phoneCalls.reportLeaseToken, token),
        isNull(phoneCalls.reportDeliveredAt),
        sql`${phoneCalls.completedAt} is not null`
      )
    )
    .returning({ id: phoneCalls.id });
  return row !== undefined;
}

export async function adoptPhoneNumber(
  scope: AccessScope,
  resource: Pick<
    NumberRow,
    | "number"
    | "numberId"
    | "sipId"
    | "phoneNumberId"
    | "outboundPhoneNumberId"
    | "agentId"
    | "setupRub"
    | "monthlyRub"
    | "sipMonthlyRub"
  >,
  route: PhoneReportRoute
) {
  requirePhoneTransactions();
  const sessionId = route.sessionId;
  if (!sessionId)
    throw new Error("Adoption requires an existing owned report session.");
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('phone:allocation', 0))`
    );
    await lockWorkspace(transaction, scope.workspaceId);
    await requireOwner(transaction, scope);
    const [session] = await transaction
      .select()
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.sessionId, sessionId),
          eq(agentSessions.workspaceId, scope.workspaceId),
          eq(agentSessions.createdByUserId, scope.userId)
        )
      );
    if (!session)
      throw new Error(
        "Adoption requires an existing session owned by this workspace."
      );
    if (route.conversationChannel === "eve") {
      if (route.conversationId !== route.sessionId)
        throw new Error("Web report route must be the owned session.");
    } else {
      const [target] = await transaction
        .select()
        .from(proactiveWatches)
        .where(
          and(
            eq(proactiveWatches.workspaceId, scope.workspaceId),
            eq(proactiveWatches.createdByUserId, scope.userId),
            eq(
              proactiveWatches.messengerChannel,
              route.conversationChannel === "photon" ? "photon" : "telegram"
            ),
            eq(
              proactiveWatches.messengerConversationId,
              route.conversationId ?? ""
            )
          )
        );
      if (!target)
        throw new Error(
          "Adoption requires an already recorded trusted messenger route."
        );
    }
    const [existing] = await transaction
      .select()
      .from(phoneNumbers)
      .where(
        or(
          eq(phoneNumbers.workspaceId, scope.workspaceId),
          eq(phoneNumbers.number, resource.number)
        )
      );
    if (existing)
      throw new Error(
        "Workspace or number already has a binding; adoption cannot overwrite or reassign it."
      );
    const [count] = await transaction
      .select({ total: sql<number>`count(*)::int` })
      .from(phoneNumbers)
      .where(
        inArray(phoneNumbers.state, [
          "provisioning",
          "uncertain",
          "active",
          "disabled",
          "releasing",
          "operator-required",
        ])
      );
    if (
      env.PHONE_MAX_ACTIVE_NUMBERS !== undefined &&
      (count?.total ?? 0) >= env.PHONE_MAX_ACTIVE_NUMBERS
    )
      throw new Error("Global dedicated-number pilot cap reached.");
    if (
      !resource.numberId ||
      !resource.sipId ||
      !resource.phoneNumberId ||
      !resource.outboundPhoneNumberId ||
      resource.agentId !== env.PHONE_AGENT_ID ||
      ![resource.setupRub, resource.monthlyRub, resource.sipMonthlyRub].every(
        (amount) => Number.isInteger(amount) && amount >= 0
      ) ||
      resource.monthlyRub > env.PHONE_MAX_MONTHLY_RUB ||
      resource.sipMonthlyRub > env.PHONE_MAX_SIP_MONTHLY_RUB
    )
      throw new Error(
        "Adoption resource mapping or recurring fees exceed pilot configuration."
      );
    const [row] = await transaction
      .insert(phoneNumbers)
      .values({
        ...resource,
        ...route,
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        ownerUserId: scope.userId,
        state: "active",
        stage: "ready",
        quotedAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("Adoption failed.");
    return row;
  });
}

export async function prunePhoneData(now = new Date()) {
  const before = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
  await db
    .update(phoneCalls)
    .set({ target: null, task: null, summary: null })
    .where(
      and(
        lt(phoneCalls.createdAt, before),
        or(
          sql`${phoneCalls.reportDeliveredAt} is not null`,
          // A finished call whose report can no longer be delivered: out of
          // attempts, past the 24 h window `claimPhoneReports` allows, or
          // with no report route at all. One still inside its window waits.
          and(
            sql`${phoneCalls.completedAt} is not null`,
            or(
              gt(phoneCalls.reportAttempts, 9),
              lt(
                phoneCalls.reportStartedAt,
                new Date(now.getTime() - 24 * 60 * 60_000)
              ),
              isNull(phoneCalls.sessionId),
              isNull(phoneCalls.conversationId),
              isNull(phoneCalls.conversationChannel)
            )
          )
        )
      )
    );
  await db
    .delete(phoneEvents)
    .where(
      and(
        lt(phoneEvents.receivedAt, before),
        sql`${phoneEvents.processedAt} is not null`
      )
    );
}
