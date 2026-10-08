import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import type * as PhoneService from "@db/services/phone";
import type * as Database from "@db";
import type { SessionAuthContext } from "eve/context";
import type { ToolContext } from "eve/tools";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { phoneTestEnv } from "@db/tests/env/phone";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

function resource() {
  return {
    number: "+74950000001",
    numberId: `phone-test:${randomUUID()}`,
    sipId: `phone-test:${randomUUID()}`,
    phoneNumberId: `phone-test:${randomUUID()}`,
    outboundPhoneNumberId: `phone-test:${randomUUID()}`,
    agentId: "phone-test-agent",
    setupRub: 600,
    monthlyRub: 155,
    sipMonthlyRub: 0,
  };
}

async function registrationServices(flag: "on" | "off") {
  vi.stubEnv("PHONE_AUTO_PROVISION", flag);
  vi.stubEnv("PHONE_WORKSPACES", "*");
  vi.resetModules();
  const [phone, scope, databaseModule] = await Promise.all([
    import("@db/services/phone"),
    import("@db/services/scope"),
    import("@db"),
  ]);
  return { phone, scope, database: databaseModule };
}

async function closeRegistrationServices(
  current: Awaited<ReturnType<typeof registrationServices>>
) {
  if ("end" in current.database.db.$client)
    await current.database.db.$client.end();
  vi.stubEnv("PHONE_AUTO_PROVISION", "off");
  vi.stubEnv("PHONE_WORKSPACES", "");
  vi.resetModules();
}

const connectionString = phoneTestEnv.PHONE_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration("phone persistence against isolated real Postgres", () => {
  const alice = {
    userId: `phone-test:${randomUUID()}`,
    workspaceId: `phone-test:${randomUUID()}`,
  };
  const bob = {
    userId: `phone-test:${randomUUID()}`,
    workspaceId: `phone-test:${randomUUID()}`,
  };
  let pool: Pool | undefined;
  let services: typeof PhoneService;
  let database: typeof Database | undefined;
  const extraWorkspaces: string[] = [];
  const route = {
    sessionId: `phone-test:${randomUUID()}`,
    conversationChannel: "eve",
    conversationId: "",
  };
  route.conversationId = route.sessionId;

  function testPool() {
    if (!pool) throw new Error("Isolated test database is not initialized.");
    return pool;
  }

  beforeAll(async () => {
    const url = new URL(connectionString ?? "");
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/phone_integration"
    )
      throw new Error(
        "Phone integration tests require a localhost database named phone_integration; production databases are refused."
      );
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", url.href);
    vi.stubEnv("DATABASE_DRIVER", "node-postgres");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
    vi.stubEnv("PHONE_AGENT_ID", "phone-test-agent");
    vi.stubEnv("PHONE_MAX_ACTIVE_NUMBERS", "1");
    database = await import("@db");
    services = await import("@db/services/phone");
    pool = new Pool({ connectionString: url.href });
    await testPool().query("insert into workspaces (id) values ($1), ($2)", [
      alice.workspaceId,
      bob.workspaceId,
    ]);
    await testPool().query(
      "insert into workspace_memberships (workspace_id,user_id,role) values ($1,$2,'owner'),($3,$4,'owner')",
      [alice.workspaceId, alice.userId, bob.workspaceId, bob.userId]
    );
    await testPool().query(
      "insert into agent_sessions (session_id,workspace_id,created_by_user_id) values ($1,$2,$3)",
      [route.sessionId, alice.workspaceId, alice.userId]
    );
  });

  afterEach(async () => {
    if (!pool) return;
    await testPool().query(
      "delete from phone_events where provider_conversation_id like 'phone-test:%'"
    );
    await testPool().query(
      "delete from phone_calls where workspace_id = any($1::text[])",
      [[alice.workspaceId, bob.workspaceId, ...extraWorkspaces]]
    );
    await testPool().query(
      "delete from phone_numbers where workspace_id = any($1::text[])",
      [[alice.workspaceId, bob.workspaceId, ...extraWorkspaces]]
    );
    await testPool().query(
      "delete from phone_number_requests where workspace_id=any($1::text[])",
      [[alice.workspaceId, bob.workspaceId, ...extraWorkspaces]]
    );
    await testPool().query("delete from workspaces where id=any($1::text[])", [
      extraWorkspaces.splice(0),
    ]);
  });

  afterAll(async () => {
    if (pool) {
      await testPool().query(
        "delete from workspaces where id = any($1::text[])",
        [[alice.workspaceId, bob.workspaceId]]
      );
      await pool.end();
    }
    if (database && "end" in database.db.$client)
      await database.db.$client.end();
    vi.unstubAllEnvs();
  });

  async function activeNumber() {
    return services.adoptPhoneNumber(alice, resource(), route);
  }

  function request(operationId = `phone-test:${randomUUID()}`) {
    return {
      operationId,
      inputHash: "persisted-input-hash",
      target: "+74950000002",
      task: "Persistence test fixture; never submitted to any provider.",
      ...route,
    };
  }

  function registrationScope() {
    const scope = {
      userId: `phone-test:${randomUUID()}`,
      workspaceId: `phone-test:${randomUUID()}`,
    };
    extraWorkspaces.push(scope.workspaceId);
    return scope;
  }

  it("queues exactly one platform-authorized allocation for concurrent new registrations, never repeat login or existing-user backfill", async () => {
    const current = await registrationServices("on");
    const newcomer = registrationScope();
    try {
      await Promise.all(
        Array.from({ length: 12 }, () => current.scope.ensureScope(newcomer))
      );
      const rows = await testPool().query(
        "select state,owner_user_id,session_id from phone_number_requests where workspace_id=$1",
        [newcomer.workspaceId]
      );
      expect(rows.rows).toHaveLength(1);
      expect(
        z
          .object({
            state: z.string(),
            owner_user_id: z.string(),
            session_id: z.string().nullable(),
          })
          .parse(rows.rows[0])
      ).toEqual({
        state: "pending",
        owner_user_id: newcomer.userId,
        session_id: null,
      });
      await current.scope.ensureScope(newcomer);
      await current.scope.ensureScope(alice);
      expect(await current.phone.readPhoneNumberRequest(alice)).toBeNull();
      expect(
        (
          await testPool().query(
            "select count(*)::int as count from phone_number_requests where workspace_id=$1",
            [newcomer.workspaceId]
          )
        ).rows
      ).toMatchObject([{ count: 1 }]);
      expect(await current.phone.readPhoneNumber(newcomer)).toBeNull();
    } finally {
      await closeRegistrationServices(current);
    }
  });

  it("leaves default-off registrations unqueued and does not backfill them when auto-provision is enabled later", async () => {
    const off = await registrationServices("off");
    const existing = registrationScope();
    try {
      await off.scope.ensureScope(existing);
      expect(await off.phone.readPhoneNumberRequest(existing)).toBeNull();
    } finally {
      await closeRegistrationServices(off);
    }
    const on = await registrationServices("on");
    try {
      await on.scope.ensureScope(existing);
      expect(await on.phone.readPhoneNumberRequest(existing)).toBeNull();
    } finally {
      await closeRegistrationServices(on);
    }
  });

  it("keeps definite preflight retries durable and fenced without marking a number ready or repeating signup", async () => {
    const current = await registrationServices("on");
    const newcomer = registrationScope();
    try {
      await current.scope.ensureScope(newcomer);
      const claims = await Promise.all([
        current.phone.claimPhoneNumberRequests(),
        current.phone.claimPhoneNumberRequests(),
      ]);
      const requests = claims.flat();
      expect(requests).toHaveLength(1);
      const claimed = requests[0];
      if (!claimed?.leaseToken)
        throw new Error("Missing automatic request lease.");
      await current.phone.finishPhoneNumberRequest(
        newcomer.workspaceId,
        randomUUID(),
        "complete",
        null
      );
      expect(
        (await current.phone.readPhoneNumberRequest(newcomer))?.state
      ).toBe("working");
      await current.phone.finishPhoneNumberRequest(
        newcomer.workspaceId,
        claimed.leaseToken,
        "retry",
        "preflight"
      );
      expect(
        (await current.phone.readPhoneNumberRequest(newcomer))?.state
      ).toBe("retry");
      expect(await current.phone.readPhoneNumber(newcomer)).toBeNull();
      expect(await current.phone.claimPhoneNumberRequests()).toEqual([]);
      await current.scope.ensureScope(newcomer);
      expect(
        (await current.phone.readPhoneNumberRequest(newcomer))?.attempts
      ).toBe(1);
      await testPool().query(
        "update phone_number_requests set next_attempt_at=now()-interval '1 second' where workspace_id=$1",
        [newcomer.workspaceId]
      );
      const [retried] = await current.phone.claimPhoneNumberRequests();
      expect(retried?.leaseToken).not.toBe(claimed.leaseToken);
      expect(retried?.attempts).toBe(2);
    } finally {
      await closeRegistrationServices(current);
    }
  });

  it("removes only an unallocated registration intent on workspace deletion and cannot route it to another owner", async () => {
    const current = await registrationServices("on");
    const newcomer = registrationScope();
    try {
      await current.scope.ensureScope(newcomer);
      expect(
        await current.phone.readPhoneNumberRequest({
          ...newcomer,
          userId: bob.userId,
        })
      ).toBeNull();
      await expect(
        current.phone.bindPhoneReportRoute(
          { ...newcomer, userId: bob.userId },
          route
        )
      ).rejects.toThrow("different workspace owner");
      await testPool().query("delete from workspaces where id=$1", [
        newcomer.workspaceId,
      ]);
      expect(await current.phone.readPhoneNumberRequest(newcomer)).toBeNull();
      expect(await current.phone.claimPhoneNumberRequests()).toEqual([]);
    } finally {
      await closeRegistrationServices(current);
    }
  });

  it("queues unbound incoming reports until an owned first-person session route exists and preserves that first route", async () => {
    const current = await registrationServices("on");
    const newcomer = registrationScope();
    try {
      await current.scope.ensureScope(newcomer);
      const quoted = await current.phone.savePhoneQuote(
        newcomer,
        {
          number: "+74950000003",
          setupRub: 600,
          monthlyRub: 155,
          sipMonthlyRub: 0,
          quotedAt: new Date(),
        },
        { sessionId: null, conversationId: null, conversationChannel: null }
      );
      const claim = await current.phone.claimPhoneActivation(
        newcomer,
        quoted.id
      );
      if (!claim.row.leaseToken)
        throw new Error("Missing local provisioning fixture lease.");
      await current.phone.updatePhoneProvisioning(
        quoted.id,
        claim.row.leaseToken,
        {
          state: "active",
          stage: "ready",
          numberId: "phone-test-number",
          sipId: "phone-test-sip",
          phoneNumberId: "phone-test-import",
          outboundPhoneNumberId: "phone-test-outbound",
          agentId: "phone-test-agent",
        },
        true
      );
      const incoming = await current.phone.acceptInboundCall({
        calledNumber: quoted.number,
        agentId: "phone-test-agent",
        conversationId: `phone-test:${randomUUID()}`,
        callerPhoneNumber: "+74950000004",
      });
      await current.phone.updatePhoneCall(incoming.row.id, {
        state: "done",
        durationSeconds: 17,
        completedAt: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      });
      expect(incoming.row.sessionId).toBeNull();
      expect(await current.phone.claimPhoneReports()).toEqual([]);
      await expect(
        current.phone.bindPhoneReportRoute(newcomer, route)
      ).rejects.toThrow("not owned");
      const first = `phone-test:${randomUUID()}`;
      const second = `phone-test:${randomUUID()}`;
      await testPool().query(
        "insert into agent_sessions(session_id,workspace_id,created_by_user_id) values ($1,$3,$4),($2,$3,$4)",
        [first, second, newcomer.workspaceId, newcomer.userId]
      );
      await current.phone.bindPhoneReportRoute(newcomer, {
        sessionId: first,
        conversationId: first,
        conversationChannel: "eve",
      });
      await current.phone.bindPhoneReportRoute(newcomer, {
        sessionId: second,
        conversationId: second,
        conversationChannel: "eve",
      });
      expect((await current.phone.readPhoneNumber(newcomer))?.sessionId).toBe(
        first
      );
      const [report] = await current.phone.claimPhoneReports();
      expect(report?.sessionId).toBe(first);
      await expect(
        testPool().query("delete from workspaces where id=$1", [
          newcomer.workspaceId,
        ])
      ).rejects.toMatchObject({ code: "23503" });
    } finally {
      await closeRegistrationServices(current);
    }
  });

  async function closeFixture(id: string) {
    await services.updatePhoneCall(id, {
      state: "done",
      completedAt: new Date(),
    });
  }

  it("serializes parallel duplicate jobs and claims exactly one provider-start transition", async () => {
    await activeNumber();
    const input = request();
    const plans = await Promise.all(
      Array.from({ length: 12 }, () => services.planOutboundCall(alice, input))
    );
    expect(new Set(plans.map((plan) => plan.row.id)).size).toBe(1);
    expect(plans.filter((plan) => plan.created)).toHaveLength(1);
    const starts = await Promise.all(
      plans.map((plan) => services.claimCallStart(alice, plan.row.id))
    );
    expect(starts.filter(Boolean)).toHaveLength(1);
    const id = plans[0]?.row.id;
    if (!id) throw new Error("Missing persistence fixture.");
    await services.recordCallUncertain(id);
    expect(await services.claimCallStart(alice, id)).toBeNull();
    expect((await services.planOutboundCall(alice, input)).row.state).toBe(
      "uncertain"
    );
  });

  it("allows separate explicit outbound intents concurrently without application quota blocks", async () => {
    await activeNumber();
    const plans = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        services.planOutboundCall(alice, request())
      )
    );
    expect(plans.filter((plan) => plan.status === "fulfilled")).toHaveLength(
      10
    );
    const rows = await testPool().query(
      "select count(*)::int as count from phone_calls where workspace_id=$1",
      [alice.workspaceId]
    );
    expect(z.object({ count: z.number() }).parse(rows.rows[0]).count).toBe(10);
  });

  it("does not let a stale planned-expiry poll refund a call already starting", async () => {
    await activeNumber();
    const planned = await services.planOutboundCall(alice, request());
    expect(await services.claimCallStart(alice, planned.row.id)).not.toBeNull();
    expect(await services.expirePlannedPhoneCall(planned.row.id)).toBeNull();
    const row = await testPool().query(
      "select state,completed_at from phone_calls where id=$1",
      [planned.row.id]
    );
    expect(
      z
        .object({
          state: z.string(),
          completed_at: z.date().nullable(),
        })
        .parse(row.rows[0])
    ).toEqual({ state: "starting", completed_at: null });
    expect((await services.planOutboundCall(alice, request())).created).toBe(
      true
    );
  });

  it("persists a rejected initiation receipt without claiming accepted or allowing redial", async () => {
    await activeNumber();
    const planned = await services.planOutboundCall(alice, request());
    await services.claimCallStart(alice, planned.row.id);
    const conversationId = `phone-test:${randomUUID()}`;
    await services.recordCallAccepted(planned.row.id, conversationId, false);
    const receipt = await testPool().query(
      "select state,outcome,provider_conversation_id from phone_calls where id=$1",
      [planned.row.id]
    );
    expect(
      z
        .object({
          state: z.string(),
          outcome: z.string(),
          provider_conversation_id: z.string(),
        })
        .parse(receipt.rows[0])
    ).toEqual({
      state: "processing",
      outcome: "initiation_rejected",
      provider_conversation_id: conversationId,
    });
    expect(await services.claimCallStart(alice, planned.row.id)).toBeNull();
  });

  it("allows explicitly confirmed cleanup retry after an operator-required result without re-enabling", async () => {
    const number = await activeNumber();
    const release = await services.changePhoneState(alice, "releasing");
    if (!release.leaseToken) throw new Error("Missing release fixture.");
    await services.updatePhoneProvisioning(
      number.id,
      release.leaseToken,
      { state: "operator-required" },
      true
    );
    await expect(services.changePhoneState(alice, "active")).rejects.toThrow(
      "cannot be re-enabled"
    );
    const retry = await services.changePhoneState(alice, "releasing");
    expect(retry.state).toBe("releasing");
    expect(retry.leaseToken).not.toBe(release.leaseToken);
  });

  it("isolates number reads, jobs, duplicate keys and start claims by trusted owner", async () => {
    await activeNumber();
    const input = request();
    const planned = await services.planOutboundCall(alice, input);
    expect(await services.readPhoneNumber(bob)).toBeNull();
    expect(await services.listPhoneCalls(bob)).toEqual([]);
    expect(await services.listPhoneCalls(bob, planned.row.id)).toEqual([]);
    expect(await services.listPhoneCalls(alice, planned.row.id)).toHaveLength(
      1
    );
    expect(await services.claimCallStart(bob, planned.row.id)).toBeNull();
    await expect(
      services.planOutboundCall({ ...alice, userId: bob.userId }, input)
    ).rejects.toThrow("different workspace owner");
    await expect(
      services.planOutboundCall(alice, {
        ...input,
        inputHash: "different-input",
      })
    ).rejects.toThrow("different input");
  });

  it("retains a caller as unverified contact metadata without using it or supplied workspace fields for tenancy", async () => {
    const number = await activeNumber();
    const attack = {
      calledNumber: number.number,
      agentId: "phone-test-agent",
      conversationId: `phone-test:${randomUUID()}`,
      callerPhoneNumber: "+12125551234",
      workspaceId: bob.workspaceId,
      userId: bob.userId,
    };
    const accepted = await services.acceptInboundCall(attack);
    expect(accepted.row.workspaceId).toBe(alice.workspaceId);
    expect(accepted.row.ownerUserId).toBe(alice.userId);
    expect(accepted.row.target).toBe("+12125551234");
    const view = (await services.listPhoneCalls(alice, accepted.row.id))[0];
    expect(view).toMatchObject({
      target: null,
      caller: "+12125551234",
      callerIdentity: "unverified",
    });
    expect(await services.listPhoneCalls(bob, accepted.row.id)).toEqual([]);
    await closeFixture(accepted.row.id);
    const withheld = await services.acceptInboundCall({
      ...attack,
      conversationId: `phone-test:${randomUUID()}`,
      callerPhoneNumber: "anonymous",
    });
    expect(withheld.row.target).toBeNull();
  });

  it("rejects unknown, foreign agent, wrong phone mapping and disabled inbound and deduplicates a trusted conversation", async () => {
    const number = await activeNumber();
    const input = {
      calledNumber: number.number,
      agentId: "phone-test-agent",
      conversationId: `phone-test:${randomUUID()}`,
    };
    const accepted = await services.acceptInboundCall(input);
    expect((await services.acceptInboundCall(input)).row.id).toBe(
      accepted.row.id
    );
    await expect(
      services.acceptInboundCall({ ...input, calledNumber: "+74950000009" })
    ).rejects.toThrow("Unrecognized");
    await expect(
      services.acceptInboundCall({ ...input, agentId: "foreign" })
    ).rejects.toThrow("Unrecognized");
    await expect(
      services.acceptInboundCall({ ...input, phoneNumberId: "foreign" })
    ).rejects.toThrow("Unrecognized");
    await closeFixture(accepted.row.id);
    await services.changePhoneState(alice, "disabled");
    await expect(services.acceptInboundCall(input)).rejects.toThrow(
      "Unrecognized"
    );
    await expect(services.planOutboundCall(alice, request())).rejects.toThrow(
      "not active"
    );
    await services.changePhoneState(alice, "active");
    expect((await services.readPhoneNumber(alice))?.monthlyRub).toBe(155);
  });

  it("serializes global activation cap and preserves exact candidates and provisioning leases", async () => {
    const quote = {
      setupRub: 600,
      monthlyRub: 155,
      sipMonthlyRub: 0,
      quotedAt: new Date(),
    };
    const a = await services.savePhoneQuote(
      alice,
      { ...quote, number: "+74950000001" },
      route
    );
    const b = await services.savePhoneQuote(
      bob,
      { ...quote, number: "+74950000002" },
      route
    );
    const activations = await Promise.allSettled([
      services.claimPhoneActivation(alice, a.id),
      services.claimPhoneActivation(bob, b.id),
    ]);
    expect(
      activations.filter((activation) => activation.status === "fulfilled")
    ).toHaveLength(1);
    const claim = activations.find(
      (activation) => activation.status === "fulfilled"
    );
    if (!claim?.value.row.leaseToken)
      throw new Error("Missing activation fixture.");
    const { row } = claim.value;
    expect([a.number, b.number]).toContain(row.number);
    await expect(
      services.updatePhoneProvisioning(row.id, randomUUID(), {
        stage: "buying",
      })
    ).rejects.toThrow("lease lost");
    await services.updatePhoneProvisioning(
      row.id,
      claim.value.row.leaseToken,
      { stage: "buying", state: "uncertain" },
      true
    );
  });

  it("deduplicates webhook receipts, leases reports separately and never restarts a settled call", async () => {
    await activeNumber();
    const call = await services.planOutboundCall(alice, request());
    await services.claimCallStart(alice, call.row.id);
    const conversationId = `phone-test:${randomUUID()}`;
    await services.recordCallAccepted(call.row.id, conversationId);
    const event = {
      id: randomUUID(),
      providerConversationId: conversationId,
      eventType: "post_call_transcription",
      timestamp: 1,
    };
    await Promise.all(
      Array.from({ length: 5 }, () => services.enqueuePhoneEvent(event))
    );
    const receipts = await testPool().query(
      "select count(*)::int as count from phone_events where id=$1",
      [event.id]
    );
    expect(z.object({ count: z.number() }).parse(receipts.rows[0]).count).toBe(
      1
    );
    await closeFixture(call.row.id);
    const claims = await Promise.all([
      services.claimPhoneReports(),
      services.claimPhoneReports(),
    ]);
    const leased = claims.flat().filter((row) => row.id === call.row.id);
    expect(leased).toHaveLength(1);
    const token = leased[0]?.reportLeaseToken;
    if (!token) throw new Error("Missing report lease.");
    await services.finishPhoneReport(call.row.id, randomUUID(), true);
    const delivery = await testPool().query(
      "select report_delivered_at from phone_calls where id=$1",
      [call.row.id]
    );
    expect(
      z
        .object({ report_delivered_at: z.date().nullable() })
        .parse(delivery.rows[0]).report_delivered_at
    ).toBeNull();
    await services.finishPhoneReport(call.row.id, token, true);
    expect(await services.claimCallStart(alice, call.row.id)).toBeNull();
    expect(
      (await services.claimPhoneReports()).some((row) => row.id === call.row.id)
    ).toBe(false);
  });

  it("keeps one token across reclaims, rejects a foreign or delivered token in the real delivery module and stops after bounded attempts", async () => {
    await activeNumber();
    const planned = await services.planOutboundCall(alice, request());
    await closeFixture(planned.row.id);
    const [first] = await services.claimPhoneReports();
    if (!first?.reportLeaseToken)
      throw new Error("Missing first report lease.");
    await services.finishPhoneReport(
      planned.row.id,
      first.reportLeaseToken,
      false
    );
    await testPool().query(
      "update phone_calls set report_lease_until=now()-interval '1 second' where id=$1",
      [planned.row.id]
    );
    const [second] = await services.claimPhoneReports();
    if (!second?.reportLeaseToken)
      throw new Error("Missing second report lease.");
    // A copy that waited past the lease still belongs to this report.
    expect(second.reportLeaseToken).toBe(first.reportLeaseToken);
    expect(second.reportAttempts).toBe(first.reportAttempts + 1);
    const foreign = randomUUID();
    expect(
      await services.renewPhoneReportLease(alice, planned.row.id, foreign)
    ).toBe(false);
    expect(
      await services.renewPhoneReportLease(
        bob,
        planned.row.id,
        second.reportLeaseToken
      )
    ).toBe(false);
    expect(
      await services.renewPhoneReportLease(
        alice,
        planned.row.id,
        second.reportLeaseToken
      )
    ).toBe(true);
    const { default: messaging } = await import("@agent/tools/messaging");
    const guardDatabase = await import("@db");
    function deliveryContext(token: string) {
      return {
        abortSignal: new AbortController().signal,
        callId: "report-send",
        toolName: "send_message",
        getSandbox: () => {
          throw new Error("No sandbox is needed.");
        },
        getSkill: () => {
          throw new Error("No skill is needed.");
        },
        getToken: () => {
          throw new Error("No token is needed.");
        },
        requireAuth: (): never => {
          throw new Error("No provider authorization is needed.");
        },
        session: {
          id: route.sessionId,
          turn: { id: "report-turn", sequence: 0 },
          auth: {
            initiator: null,
            current: {
              authenticator: "phone-result",
              principalId: alice.userId,
              principalType: "user" as const,
              attributes: {
                workspaceId: alice.workspaceId,
                phoneCallId: planned.row.id,
                phoneReportToken: token,
              },
            },
          },
        },
      } satisfies ToolContext;
    }
    try {
      await contextStorage.run(new ContextContainer(), async () => {
        const old = deliveryContext(foreign);
        const resolveMessaging = messaging.events["step.started"];
        if (!resolveMessaging) throw new Error("Missing messaging resolver.");
        const tools = await resolveMessaging(
          {},
          {
            channel: { kind: "channel:eve" },
            model: null,
            messages: [],
            session: old.session,
          }
        );
        if (
          !tools ||
          !("send_message" in tools) ||
          !("react_to_message" in tools)
        )
          throw new Error("Missing actual messaging tools.");
        const message = {
          kind: "message" as const,
          text: "Получено сообщение: прошу перезвонить.",
        };
        expect(await tools.send_message.execute(message, old)).toEqual({
          skipped: "phone-stale",
        });
        await expect(
          tools.react_to_message.execute(
            { operation: "add", type: "heart" },
            old
          )
        ).rejects.toThrow("stale");
        const current = deliveryContext(second.reportLeaseToken ?? "");
        const sent = await tools.send_message.execute(message, current);
        expect(sent).toMatchObject(message);
        await services.finishPhoneReport(
          planned.row.id,
          second.reportLeaseToken ?? "",
          true
        );
        expect(await tools.send_message.execute(message, current)).toEqual({
          skipped: "phone-stale",
        });
      });
    } finally {
      if (
        "end" in guardDatabase.db.$client &&
        guardDatabase.db !== database?.db
      )
        await guardDatabase.db.$client.end();
      vi.resetModules();
    }
    await testPool().query(
      "update phone_calls set report_delivered_at=null,report_attempts=5,report_lease_until=null where id=$1",
      [planned.row.id]
    );
    expect(await services.claimPhoneReports()).toEqual([]);
  });

  describe("settling a report by its turn, against the real hook", () => {
    type ReportEvent =
      | "action.result"
      | "step.started"
      | "turn.cancelled"
      | "turn.completed"
      | "turn.failed"
      | "turn.started";

    const sent = {
      callId: "report-send",
      isError: false,
      kind: "tool-result" as const,
      output: { kind: "message" as const, text: "Звонок завершён." },
      toolName: "send_message",
    };

    /** Runs the real report hook inside an eve context, the way eve emits. */
    async function withReportHook(
      call: { callId: string; token: string },
      run: (
        emit: (
          name: ReportEvent,
          as?: "report" | "person",
          data?: { status?: "completed"; result?: typeof sent }
        ) => Promise<void>
      ) => Promise<void>
    ) {
      const { default: hook } = await import("@agent/hooks/phone-report");
      const guardDatabase = await import("@db");
      const session = (as: "report" | "person") => {
        const current: SessionAuthContext =
          as === "report"
            ? {
                authenticator: "phone-result",
                principalId: alice.userId,
                principalType: "user",
                attributes: {
                  workspaceId: alice.workspaceId,
                  phoneCallId: call.callId,
                  phoneReportToken: call.token,
                },
              }
            : {
                authenticator: "telegram",
                principalId: alice.userId,
                principalType: "user",
                attributes: { workspaceId: alice.workspaceId },
              };
        return {
          auth: { current, initiator: null },
          id: route.sessionId,
          turn: { id: "turn_3", sequence: 3 },
        };
      };
      try {
        await contextStorage.run(new ContextContainer(), () =>
          run(async (name, as = "report", data = {}) => {
            await hook.events?.[name]?.(
              // SAFETY: the hook reads only the fields this test supplies.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A partial event stands in for the stream event.
              { data } as never,
              {
                agent: { name: "test-agent" },
                channel: { continuationToken: route.sessionId },
                getSandbox: () => {
                  throw new Error("No sandbox is needed.");
                },
                getSkill: () => {
                  throw new Error("No skill is needed.");
                },
                session: session(as),
              }
            );
          })
        );
      } finally {
        if (
          "end" in guardDatabase.db.$client &&
          guardDatabase.db !== database?.db
        )
          await guardDatabase.db.$client.end();
        vi.resetModules();
      }
    }

    async function leasedReport() {
      await activeNumber();
      const planned = await services.planOutboundCall(alice, request());
      await closeFixture(planned.row.id);
      const [claimed] = await services.claimPhoneReports();
      if (claimed?.id !== planned.row.id || !claimed.reportLeaseToken)
        throw new Error("Missing report lease.");
      return { callId: claimed.id, token: claimed.reportLeaseToken };
    }

    async function reportRow(id: string) {
      const found = await testPool().query(
        "select report_delivered_at, report_lease_token, report_lease_until, report_attempts from phone_calls where id=$1",
        [id]
      );
      return z
        .object({
          report_delivered_at: z.date().nullable(),
          report_lease_token: z.string().nullable(),
          report_lease_until: z.date().nullable(),
          report_attempts: z.number(),
        })
        .parse(found.rows[0]);
    }

    async function expireLease(id: string) {
      await testPool().query(
        "update phone_calls set report_lease_until=now()-interval '1 second' where id=$1",
        [id]
      );
    }

    it("delivers a report once when its turn ends without a send_message, and never claims it again", async () => {
      const call = await leasedReport();
      await withReportHook(call, async (emit) => {
        await emit("turn.started");
        await emit("step.started");
        await emit("turn.completed");
      });
      const row = await reportRow(call.callId);
      expect(row.report_delivered_at).toBeInstanceOf(Date);
      expect(row.report_lease_token).toBeNull();
      await expireLease(call.callId);
      expect(await services.claimPhoneReports()).toEqual([]);
      expect((await reportRow(call.callId)).report_attempts).toBe(1);
    });

    it("lets a copy that ran after the lease expired settle the report instead of being sent again", async () => {
      const call = await leasedReport();
      // The queued turn did not start within the lease: the report is
      // claimed again, under the same token.
      await expireLease(call.callId);
      const [again] = await services.claimPhoneReports();
      expect(again?.reportLeaseToken).toBe(call.token);
      expect(again?.reportAttempts).toBe(2);
      // The first copy runs late and gets its message through.
      await withReportHook(call, async (emit) => {
        await emit("turn.started");
        await emit("action.result", "report", {
          status: "completed",
          result: sent,
        });
        await emit("turn.completed");
      });
      expect((await reportRow(call.callId)).report_delivered_at).toBeInstanceOf(
        Date
      );
      // The second copy finds the report delivered: nothing is sent, and
      // nothing is claimed.
      expect(
        await services.renewPhoneReportLease(alice, call.callId, call.token)
      ).toBe(false);
      await expireLease(call.callId);
      expect(await services.claimPhoneReports()).toEqual([]);
    });

    it("holds an accepted report for its turn without touching a delivered or foreign one", async () => {
      const call = await leasedReport();
      await services.holdPhoneReportForTurn(call.callId, randomUUID());
      const before = await reportRow(call.callId);
      await services.holdPhoneReportForTurn(call.callId, call.token);
      const held = await reportRow(call.callId);
      expect(held.report_lease_until?.getTime()).toBeGreaterThan(
        (before.report_lease_until?.getTime() ?? 0) + 4 * 60_000
      );
      // Nobody sends it again while the turn waits.
      expect(await services.claimPhoneReports()).toEqual([]);
      await services.finishPhoneReport(call.callId, call.token, true);
      await services.holdPhoneReportForTurn(call.callId, call.token);
      expect((await reportRow(call.callId)).report_lease_until).toBeNull();
    });

    it("keeps renewing and settling a report after a person's message steered into its turn", async () => {
      const call = await leasedReport();
      await withReportHook(call, async (emit) => {
        await emit("turn.started");
        await expireLease(call.callId);
        // From here on `auth.current` is the person's.
        await emit("step.started", "person");
        expect(
          (await reportRow(call.callId)).report_lease_until?.getTime()
        ).toBeGreaterThan(Date.now());
        await emit("action.result", "person", {
          status: "completed",
          result: sent,
        });
      });
      expect((await reportRow(call.callId)).report_delivered_at).toBeInstanceOf(
        Date
      );
    });

    it("settles a steered report turn that ends without a message, and ignores a person's turn that never was a report", async () => {
      const call = await leasedReport();
      await withReportHook(call, async (emit) => {
        // A person's turn with the same id is not a report: it settles
        // nothing.
        await emit("turn.started", "person");
        await emit("turn.completed", "person");
        expect((await reportRow(call.callId)).report_delivered_at).toBeNull();
        await emit("turn.started");
        await emit("turn.completed", "person");
      });
      expect((await reportRow(call.callId)).report_delivered_at).toBeInstanceOf(
        Date
      );
    });

    it("counts a cancelled report turn as settled, like a browser report", async () => {
      const call = await leasedReport();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      try {
        await withReportHook(call, async (emit) => {
          await emit("turn.started");
          await emit("turn.cancelled");
        });
        expect(warn).toHaveBeenCalledWith(
          "[phone] report turn cancelled before a message",
          expect.objectContaining({ callId: call.callId })
        );
      } finally {
        warn.mockRestore();
      }
      expect((await reportRow(call.callId)).report_delivered_at).toBeInstanceOf(
        Date
      );
      await expireLease(call.callId);
      expect(await services.claimPhoneReports()).toEqual([]);
    });

    it("puts a failed report turn back in line with a backoff and the same token", async () => {
      const call = await leasedReport();
      await withReportHook(call, async (emit) => {
        await emit("turn.started");
        await emit("turn.failed");
      });
      const row = await reportRow(call.callId);
      expect(row.report_delivered_at).toBeNull();
      expect(await services.claimPhoneReports()).toEqual([]);
      await expireLease(call.callId);
      const [retry] = await services.claimPhoneReports();
      expect(retry?.reportLeaseToken).toBe(call.token);
      expect(retry?.reportAttempts).toBe(2);
    });
  });

  it("prevents workspace deletion from orphaning a paid resource or its release tombstone", async () => {
    const number = await activeNumber();
    await expect(
      testPool().query("delete from workspaces where id=$1", [
        alice.workspaceId,
      ])
    ).rejects.toMatchObject({ code: "23503" });
    const release = await services.changePhoneState(alice, "releasing");
    if (!release.leaseToken) throw new Error("Missing release fixture.");
    await services.updatePhoneProvisioning(
      number.id,
      release.leaseToken,
      { state: "released" },
      true
    );
    await expect(
      testPool().query("delete from workspaces where id=$1", [
        alice.workspaceId,
      ])
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      services.adoptPhoneNumber(alice, resource(), route)
    ).rejects.toThrow("already has a binding");
  });

  describe("number quotes held by other workspaces", () => {
    const quote = {
      setupRub: 600,
      monthlyRub: 155,
      sipMonthlyRub: 0,
    };
    const held = "+74950000071";

    it("keeps a fresh quote, a failed activation and a released row out of every other workspace's quote", async () => {
      await services.savePhoneQuote(
        bob,
        { ...quote, number: held, quotedAt: new Date() },
        route
      );
      expect([...(await services.readHeldPhoneNumbers(alice))]).toContain(held);
      await expect(
        services.savePhoneQuote(
          alice,
          { ...quote, number: held, quotedAt: new Date() },
          route
        )
      ).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });
      expect([...(await services.readHeldPhoneNumbers(bob))]).not.toContain(
        held
      );
      await testPool().query(
        "update phone_numbers set state='released', stage='ready', number_id='phone-test:released' where workspace_id=$1",
        [bob.workspaceId]
      );
      expect([...(await services.readHeldPhoneNumbers(alice))]).toContain(held);
      await expect(
        services.savePhoneQuote(
          alice,
          { ...quote, number: held, quotedAt: new Date() },
          route
        )
      ).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });
      const other = await testPool().query(
        "select state from phone_numbers where workspace_id=$1",
        [bob.workspaceId]
      );
      expect(other.rows).toEqual([{ state: "released" }]);
    });

    it("takes over a quote nobody activated for a day, but never a row past the quote stage", async () => {
      const old = new Date(Date.now() - 25 * 60 * 60_000);
      await services.savePhoneQuote(
        bob,
        { ...quote, number: held, quotedAt: old },
        route
      );
      expect([...(await services.readHeldPhoneNumbers(alice))]).not.toContain(
        held
      );
      const taken = await services.savePhoneQuote(
        alice,
        { ...quote, number: held, quotedAt: new Date() },
        route
      );
      expect(taken).toMatchObject({
        number: held,
        workspaceId: alice.workspaceId,
        state: "quoted",
      });
      const rows = await testPool().query(
        "select workspace_id from phone_numbers where number=$1",
        [held]
      );
      expect(rows.rows).toHaveLength(1);
      await testPool().query("delete from phone_numbers where number=$1", [
        held,
      ]);
      await services.savePhoneQuote(
        bob,
        { ...quote, number: held, quotedAt: old },
        route
      );
      await testPool().query(
        "update phone_numbers set state='uncertain', stage='buying' where workspace_id=$1",
        [bob.workspaceId]
      );
      expect([...(await services.readHeldPhoneNumbers(alice))]).toContain(held);
      await expect(
        services.savePhoneQuote(
          alice,
          { ...quote, number: held, quotedAt: new Date() },
          route
        )
      ).rejects.toMatchObject({ code: "CANDIDATE_UNAVAILABLE" });
      expect(
        (
          await testPool().query(
            "select state,stage from phone_numbers where workspace_id=$1",
            [bob.workspaceId]
          )
        ).rows
      ).toEqual([{ state: "uncertain", stage: "buying" }]);
    });
  });

  it("polls never-checked calls first and rotates every polled call, so a stuck few cannot starve the rest", async () => {
    await activeNumber();
    const planned = await Promise.all(
      Array.from({ length: 22 }, () =>
        services.planOutboundCall(alice, request())
      )
    );
    const ids = planned.map(({ row }) => row.id);
    await testPool().query(
      "update phone_calls set checked_at=now()-interval '1 hour' where id=any($1::text[])",
      [ids.slice(0, 20)]
    );
    const first = (await services.listPhonePolls()).map(({ call }) => call.id);
    expect(first).toHaveLength(20);
    expect(first).toEqual(expect.arrayContaining(ids.slice(20)));
    const unchecked = await testPool().query(
      "select count(*)::int as count from phone_calls where id=any($1::text[]) and checked_at is null",
      [ids]
    );
    expect(z.object({ count: z.number() }).parse(unchecked.rows[0]).count).toBe(
      0
    );
    const second = (await services.listPhonePolls()).map(({ call }) => call.id);
    expect(new Set([...first, ...second])).toEqual(new Set(ids));
  });

  it("clears call data of reports that can no longer be delivered, never one still inside its window", async () => {
    await activeNumber();
    const cases = {
      delivered: "report_delivered_at=now()",
      exhausted: "report_attempts=10",
      windowPassed:
        "report_attempts=3, report_started_at=now()-interval '25 hours'",
      withoutRoute: "session_id=null, conversation_id=null",
      withinWindow:
        "report_attempts=3, report_started_at=now()-interval '2 hours'",
      notStarted: "report_attempts=0",
    };
    const old = await Promise.all(
      Object.entries(cases).map(async ([name, patch]) => {
        const call = await services.planOutboundCall(alice, request());
        await closeFixture(call.row.id);
        await testPool().query(
          `update phone_calls set target='+74950000002', summary='private summary', created_at=now()-interval '31 days', ${patch} where id=$1`,
          [call.row.id]
        );
        return [name, call.row.id] as const;
      })
    );
    const recent = await services.planOutboundCall(alice, request());
    await closeFixture(recent.row.id);
    await testPool().query(
      "update phone_calls set target='+74950000002', summary='private summary', report_attempts=10 where id=$1",
      [recent.row.id]
    );
    await services.prunePhoneData();
    const kept = new Set<string>();
    await Promise.all(
      [...old, ["recentExhausted", recent.row.id] as const].map(
        async ([name, id]) => {
          const row = await testPool().query(
            "select summary from phone_calls where id=$1",
            [id]
          );
          const { summary } = z
            .object({ summary: z.string().nullable() })
            .parse(row.rows[0]);
          if (summary !== null) kept.add(name);
        }
      )
    );
    expect(kept).toEqual(
      new Set(["withinWindow", "notStarted", "recentExhausted"])
    );
  });
});
