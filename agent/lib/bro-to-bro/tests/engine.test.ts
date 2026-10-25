import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { JSONValue } from "ai";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import type * as Slots from "@agent/lib/bro-to-bro/slots";
import type { BroProposal } from "@shared/bro-to-bro/contract";
import * as schema from "@db/schema";
import { fakeComposio } from "@tests/helpers/composio";

// A fresh PGlite with every migration applied takes seconds.
vi.setConfig({ testTimeout: 60_000 });

/** Bro ↔ Bro's model and the owner's calendar, at their boundaries. */
const outside = vi.hoisted(() => ({
  ask: vi.fn<
    (request: {
      readonly purpose: "envoy" | "gate";
    }) => Promise<JSONValue | undefined>
  >(),
  slots: vi.fn<typeof Slots.readSlotCandidates>(),
}));
vi.mock("@agent/lib/bro-to-bro/model", () => ({
  askBroModel: outside.ask,
  broToBroModelId: () => "test-model",
}));
vi.mock("@agent/lib/bro-to-bro/slots", () => ({
  readSlotCandidates: outside.slots,
}));

const databases: PGlite[] = [];
const savely = {
  userId: "better-auth:savely",
  workspaceId: "workspace:savely",
};
const petya = { userId: "better-auth:petya", workspaceId: "workspace:petya" };
const mandate = {
  goal: "Поужинать на выходных",
  details: "После врача в субботу свободен",
  window: null,
  durationMinutes: 90,
};

beforeEach(() => {
  outside.ask.mockReset();
  outside.slots.mockReset();
  outside.slots.mockResolvedValue({ state: "unavailable" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

async function applyMigrations(database: PGlite) {
  const directory = new URL("../../../../db/migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .toSorted();
  /* oxlint-disable eslint/no-await-in-loop -- SQL migration statements must execute in file order. */
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await database.exec(statement);
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
}

/** Savely and Petya, linked (Savely calls him «брат»), with a thread Savely started. */
async function thread() {
  vi.resetModules();
  const client = new PGlite();
  databases.push(client);
  await applyMigrations(client);
  // SAFETY: PGlite implements the query-builder surface these services use despite using a different Drizzle driver.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test swaps only the driver while retaining the shared Drizzle schema and query-builder contract.
  const database = drizzle(client, { schema }) as never;
  const Database = await import("@db");
  vi.spyOn(Database, "db", "get").mockReturnValue(database);
  const scope = await import("@db/services/scope");
  await scope.ensureScope(savely);
  await scope.ensureScope(petya);
  await client.exec(`
    INSERT INTO user_profiles (workspace_id, first_name) VALUES ('workspace:savely', 'Савелий');
    INSERT INTO "user" (id, name, email) VALUES ('petya', 'Пётр', 'petya@example.com');
  `);
  const invites = await import("@db/services/bro-to-bro/invites");
  const links = await import("@db/services/bro-to-bro/links");
  const threads = await import("@db/services/bro-to-bro/threads");
  const steps = await import("@db/services/bro-to-bro/steps");
  const { buildEnvoyBrief, runBroToBroSteps, runEnvoyStep } =
    await import("@agent/lib/bro-to-bro/engine");
  const created = await invites.createBroInvite(savely, { label: "брат" });
  if (created.kind !== "created") throw new Error("The invite was refused.");
  await invites.openBroInvite(created.token, petya);
  const accepted = await invites.acceptOpenedBroInvite(petya, "telegram");
  if (accepted.kind !== "accepted") throw new Error("Not accepted.");
  await links.setBroLinkLabel(petya, accepted.linkId, "старший");
  const [own] = await links.listBroLinks(savely);
  if (!own) throw new Error("Savely has no link.");
  await links.confirmBroLink(savely, own.id, "cabinet");
  const started = await threads.startBroThread(savely, {
    linkId: own.id,
    mandate,
    reportTarget: null,
  });
  if (started.kind !== "started") throw new Error("Not started.");
  const { threadId } = started;
  const claim = async () => {
    const [claimed] = await steps.claimDueBroThreads({
      leaseMs: 120_000,
      limit: 10,
    });
    if (!claimed) throw new Error("Nothing was due.");
    return claimed.leaseToken;
  };
  const view = async (workspaceId: string) => {
    const read = await threads.readBroThreadForSide(threadId, workspaceId);
    if (!read?.link) throw new Error("The side cannot see its thread.");
    return { ...read, link: read.link };
  };
  /**
   * An owner's envoy says or holds something, as a step records it, under
   * the lease given or a new one.
   */
  const says = async (
    owner: typeof savely,
    outcome: Parameters<typeof steps.recordEnvoyStep>[2]["outcome"],
    leaseToken?: string
  ) => {
    const seen = await view(owner.workspaceId);
    return steps.recordEnvoyStep(threadId, leaseToken ?? (await claim()), {
      linkRevisions: seen.link.revisions,
      outOfScope: [],
      outcome,
      side: seen.side,
      threadVersion: seen.version,
    });
  };
  return {
    buildEnvoyBrief,
    claim,
    client,
    runBroToBroSteps,
    runEnvoyStep,
    says,
    savelySays: async (outcome: Parameters<typeof says>[1]) =>
      says(savely, outcome),
    threadId,
    threads,
    view,
  };
}

describe("an envoy's step", () => {
  it("is briefed with neither the owner's own label for the peer nor the other side's mandate and answers", async () => {
    const bro = await thread();
    await bro.savelySays({
      kind: "sent",
      message: { action: "message", body: "Привет! Поужинаем на выходных?" },
    });
    await bro.threads.appendOwnerAnswer(
      savely,
      bro.threadId,
      "Только не в пятницу"
    );

    const before = Date.now();
    const initiator = await bro.buildEnvoyBrief(
      await bro.view(savely.workspaceId),
      savely.workspaceId
    );
    expect(initiator).toMatchObject({
      mandate: { details: mandate.details },
      peer: { name: "Пётр" },
      self: { name: "Савелий" },
    });
    expect(JSON.stringify(initiator)).not.toContain("брат");
    // No time is offered sooner than two hours from now.
    const [, request] = outside.slots.mock.calls[0] ?? [];
    expect(Date.parse(request?.window.from ?? "")).toBeGreaterThanOrEqual(
      before + 2 * 60 * 60_000
    );

    const responder = await bro.buildEnvoyBrief(
      await bro.view(petya.workspaceId),
      petya.workspaceId
    );
    expect(responder).toMatchObject({
      goal: "Привет! Поужинаем на выходных?",
      mandate: null,
      ownerAnswers: [],
    });
    const seen = JSON.stringify(responder);
    for (const secret of ["врача", "Только не в пятницу", "старший"])
      expect([secret, seen.includes(secret)]).toEqual([secret, false]);
  });

  it("briefs the responder for a meeting as long as the initiator proposed", async () => {
    const bro = await thread();
    await bro.savelySays({
      kind: "sent",
      message: {
        action: "propose",
        body: "Привет! Поужинаем в субботу в 19:00?",
        proposal: {
          end: "2026-10-24T20:30:00+03:00",
          start: "2026-10-24T19:00:00+03:00",
          summary: "Ужин в сб 24.10 в 19:00",
        },
      },
    });

    const responder = await bro.buildEnvoyBrief(
      await bro.view(petya.workspaceId),
      petya.workspaceId
    );

    expect(responder.durationMinutes).toBe(90);
    // Petya's free times are read for the same ninety minutes.
    expect(outside.slots.mock.calls.at(-1)?.[1].durationMinutes).toBe(90);
  });

  it("holds a time the owner named without a calendar as just that, not as busy", async () => {
    const bro = await thread();
    await bro.threads.appendOwnerAnswer(
      savely,
      bro.threadId,
      "Давай в субботу в 19:30"
    );
    outside.ask.mockImplementation(async ({ purpose }) =>
      purpose === "gate"
        ? { facts: [] }
        : {
            action: "propose",
            message: "Привет! Поужинаем в сб 24.10 в 19:30?",
            outOfScope: [],
            proposal: {
              end: "2026-10-24T21:00:00+03:00",
              start: "2026-10-24T19:30:00+03:00",
              summary: "Ужин в сб 24.10 в 19:30",
            },
          }
    );

    await bro.runEnvoyStep({
      leaseToken: await bro.claim(),
      threadId: bro.threadId,
      workspaceId: savely.workspaceId,
    });

    expect((await bro.view(savely.workspaceId)).own.heldMessage?.reason).toBe(
      "время без твоего календаря"
    );
  });

  it("is dropped when the thread changed while the envoy thought", async () => {
    const bro = await thread();
    const leaseToken = await bro.claim();
    outside.ask.mockImplementation(async ({ purpose }) => {
      if (purpose === "gate") return { facts: [] };
      await bro.threads.appendOwnerAnswer(
        savely,
        bro.threadId,
        "Лучше в субботу"
      );
      return {
        action: "message",
        message: "Привет! Бро Савелия на связи. Поужинаем на выходных?",
        outOfScope: [],
      };
    });

    expect(
      await bro.runEnvoyStep({
        leaseToken,
        threadId: bro.threadId,
        workspaceId: savely.workspaceId,
      })
    ).toBe("stopped");
    expect((await bro.view(savely.workspaceId)).messages).toEqual([]);
    const failed = await bro.client.query<{ failed_steps: number }>(
      "SELECT failed_steps FROM bro_threads"
    );
    expect(failed.rows).toEqual([{ failed_steps: 0 }]);
  });

  it("keeps the responder's calendar to two weeks: a proposal past them goes to the owner, one within them among the times", async () => {
    const day = 24 * 60 * 60_000;
    const brief = async (inDays: number) => {
      const bro = await thread();
      const proposal = {
        end: new Date(
          Date.now() + inDays * day + 2 * 60 * 60_000
        ).toISOString(),
        start: new Date(Date.now() + inDays * day).toISOString(),
        summary: "Ужин",
      };
      await bro.savelySays({
        kind: "sent",
        message: { action: "propose", body: "Поужинаем?", proposal },
      });
      const built = await bro.buildEnvoyBrief(
        await bro.view(petya.workspaceId),
        petya.workspaceId
      );
      const [, request] = outside.slots.mock.calls.at(-1) ?? [];
      return { built, proposal, request };
    };

    // A month out: whether Petya is free then is his to say, not his calendar's.
    const far = await brief(30);
    expect(far.request?.around).toBeUndefined();
    expect(Date.parse(far.request?.window.to ?? "")).toBeLessThanOrEqual(
      Date.now() + 14 * day
    );
    expect(far.built.horizon).toBe(far.request?.window.to);

    const near = await brief(10);
    expect(near.request?.around).toEqual({
      end: near.proposal.end,
      start: near.proposal.start,
    });
  });

  it("lets the checker take a proposal its owner approved, place and all, as said", async () => {
    const bro = await thread();
    const proposal = {
      place: "у меня, Ленина 5",
      summary: "Ужин у Савелия",
    };
    await bro.savelySays({
      draft: { action: "propose", body: "Поужинаем у меня?", proposal },
      kind: "held",
      reason: "адрес",
    });
    const held = (await bro.view(savely.workspaceId)).own.heldMessage;
    if (!held) throw new Error("Nothing was held.");
    await bro.threads.approveHeldMessage(savely, bro.threadId, held.id);
    const leaseToken = await bro.claim();
    await bro.runEnvoyStep({
      leaseToken,
      threadId: bro.threadId,
      workspaceId: savely.workspaceId,
    });
    await bro.says(
      petya,
      { kind: "sent", message: { action: "message", body: "А во сколько?" } },
      leaseToken
    );
    const checked: string[] = [];
    outside.ask.mockImplementation(async (request) => {
      if (request.purpose === "envoy")
        return {
          action: "message",
          message: "Как Савелию удобнее, уточню",
          outOfScope: [],
        };
      checked.push(JSON.stringify(request));
      return { facts: [] };
    });

    await bro.runEnvoyStep({
      leaseToken,
      threadId: bro.threadId,
      workspaceId: savely.workspaceId,
    });

    expect(checked.join()).toContain("у меня, Ленина 5");
    expect(checked.join()).toContain("Ужин у Савелия");
  });

  it("sends a draft its owner approved word for word, with no model and no gate", async () => {
    const bro = await thread();
    await bro.savelySays({
      draft: { action: "message", body: "Он после врача, давай в субботу" },
      kind: "held",
      reason: "здоровье",
    });
    const held = (await bro.view(savely.workspaceId)).own.heldMessage;
    if (!held) throw new Error("Nothing was held.");
    await bro.threads.approveHeldMessage(savely, bro.threadId, held.id);

    expect(
      await bro.runEnvoyStep({
        leaseToken: await bro.claim(),
        threadId: bro.threadId,
        workspaceId: savely.workspaceId,
      })
    ).toBe("passed");
    expect(outside.ask).not.toHaveBeenCalled();
    expect((await bro.view(petya.workspaceId)).messages).toMatchObject([
      { body: "Он после врача, давай в субботу", from: "peer" },
    ]);
  });
});

type Bro = Awaited<ReturnType<typeof thread>>;

// Far ahead: a yes to a meeting that has begun is refused.
const dinner = {
  end: "2037-10-24T21:00:00+03:00",
  place: "Хачапурная на Покровке",
  start: "2037-10-24T19:00:00+03:00",
  summary: "Ужин в субботу",
};

/** Savely proposes, Petya's Bro accepts, and both owners say yes. */
async function confirm(bro: Bro, proposal: BroProposal) {
  const lease = await bro.claim();
  const proposed = await bro.says(
    savely,
    {
      kind: "sent",
      message: { action: "propose", body: "Поужинаем в субботу?", proposal },
    },
    lease
  );
  if (proposed.kind !== "recorded" || !proposed.messageId)
    throw new Error("The proposal did not go out.");
  await bro.says(
    petya,
    {
      kind: "sent",
      message: {
        acceptsMessageId: proposed.messageId,
        action: "accept",
        body: "Договорились",
      },
    },
    lease
  );
  for (const owner of [savely, petya])
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each owner says yes in turn.
    await bro.threads.confirmBroThread(owner, bro.threadId, proposed.messageId);
}

const insertedEventSchema = z.looseObject({ id: z.string() });

/** Each owner's Google Calendar behind the fake Composio, by account. */
function calendars(composio: ReturnType<typeof fakeComposio>) {
  const events = new Map<
    string,
    Map<string, z.infer<typeof insertedEventSchema>>
  >();
  composio.proxy.mockImplementation(
    ({ body, connectedAccountId, method, url }) => {
      const calendar =
        events.get(connectedAccountId) ??
        new Map<string, z.infer<typeof insertedEventSchema>>();
      events.set(connectedAccountId, calendar);
      const [, id] = url.pathname.split("/calendars/primary/events/");
      if (method === "GET" && id)
        return { data: calendar.get(decodeURIComponent(id)), status: 200 };
      if (
        method !== "POST" ||
        !url.pathname.endsWith("/calendars/primary/events")
      )
        throw new Error(`Unexpected Google call: ${method} ${url.pathname}`);
      const event = insertedEventSchema.parse(body);
      if (calendar.has(event.id))
        return {
          data: {
            error: { message: "The requested identifier already exists." },
          },
          status: 409,
        };
      calendar.set(event.id, event);
      return { data: event, status: 200 };
    }
  );
  return (owner: typeof savely) => [
    ...(events.get(`ca:${owner.userId}`)?.values() ?? []),
  ];
}

async function calendarStates(bro: Bro) {
  const rows = await bro.client.query<{
    side: string;
    calendar_state: string | null;
  }>("SELECT side, calendar_state FROM bro_thread_sides ORDER BY side");
  return rows.rows.map((row) => row.calendar_state);
}

async function confirmedReports(bro: Bro) {
  const rows = await bro.client.query<{
    workspace_id: string;
    payload: { calendar?: string };
  }>(
    "SELECT workspace_id, payload FROM bro_reports WHERE kind = 'confirmed' ORDER BY workspace_id"
  );
  return rows.rows.map((row) => [row.workspace_id, row.payload.calendar]);
}

describe("the engine", () => {
  beforeEach(() => {
    vi.stubEnv("BRO_TO_BRO_WORKSPACES", "*");
  });

  afterEach(() => {
    vi.stubEnv("BRO_TO_BRO_WORKSPACES", "");
    vi.useRealTimers();
  });

  it("renews a thread's lease before each step, so a step that ends late in the tick still counts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00+03:00"));
    const bro = await thread();
    // The first envoy thinks 40 s, the second, started within the tick, 90 s:
    // past the two minutes the thread was claimed for.
    const thinking = [40_000, 90_000];
    outside.ask.mockImplementation(async ({ purpose }) => {
      if (purpose === "gate") return { facts: [] };
      vi.setSystemTime(Date.now() + (thinking.shift() ?? 0));
      return {
        action: "message",
        message: "Привет! Поужинаем на выходных?",
        outOfScope: [],
      };
    });

    await bro.runBroToBroSteps();

    expect(
      (await bro.view(savely.workspaceId)).messages.map(({ from }) => from)
    ).toEqual(["self", "peer"]);
  });
});

describe("a meeting both owners confirmed", () => {
  beforeEach(() => {
    vi.stubEnv("BRO_TO_BRO_WORKSPACES", "*");
  });

  afterEach(() => {
    vi.stubEnv("BRO_TO_BRO_WORKSPACES", "");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("goes into each owner's own calendar once, a repeated try finding the event it made", async () => {
    const bro = await thread();
    await bro.client.exec(
      "INSERT INTO user_profiles (workspace_id, timezone) VALUES ('workspace:petya', 'Asia/Yekaterinburg')"
    );
    const composio = fakeComposio();
    for (const owner of [savely, petya])
      composio.connect({
        id: `ca:${owner.userId}`,
        toolkit: "googlesuper",
        userId: owner.userId,
      });
    const eventsOf = calendars(composio);
    await confirm(bro, dinner);

    await bro.runBroToBroSteps();
    // A restart lost the record of Savely's event after Google made it.
    await bro.client.exec(
      "UPDATE bro_thread_sides SET calendar_state = 'pending', calendar_next_at = now() - interval '1 minute', calendar_attempts = 0 WHERE side = 'initiator'"
    );
    await bro.runBroToBroSteps();

    const [event, ...more] = eventsOf(savely);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      description: "Договорились Бро ↔ Бро с Петром",
      end: { dateTime: dinner.end, timeZone: "Europe/Moscow" },
      location: dinner.place,
      start: { dateTime: dinner.start, timeZone: "Europe/Moscow" },
      status: "confirmed",
      summary: "Ужин в субботу — с Петром",
      visibility: "private",
    });
    expect(event).not.toHaveProperty("attendees");
    expect(eventsOf(petya)).toMatchObject([
      {
        description: "Договорились Бро ↔ Бро с Савелием",
        start: { dateTime: dinner.start, timeZone: "Asia/Yekaterinburg" },
        summary: "Ужин в субботу — с Савелием",
      },
    ]);
    // Nobody is invited or mailed: the event is the owner's alone.
    expect(
      composio.proxy.mock.calls.some(([request]) =>
        request.url.searchParams.has("sendUpdates")
      )
    ).toBe(false);
    expect(await calendarStates(bro)).toEqual(["created", "created"]);
    expect(await confirmedReports(bro)).toEqual([
      [petya.workspaceId, "created"],
      [savely.workspaceId, "created"],
    ]);
  });

  it("stays out of a calendar Bro may not write, and the owner hears why", async () => {
    const bro = await thread();
    const settings = await import("@db/services/settings");
    await settings.selectGoogleWorkspaceAccess(savely, "read_only");
    const composio = fakeComposio();
    composio.connect({
      authConfigId: "ac_google_read_only",
      toolkit: "googlesuper",
      userId: savely.userId,
    });
    await confirm(bro, dinner);

    await bro.runBroToBroSteps();

    expect(composio.proxy).not.toHaveBeenCalled();
    expect(await calendarStates(bro)).toEqual([
      "skipped_read_only",
      "skipped_no_calendar",
    ]);
    expect(await confirmedReports(bro)).toEqual([
      [petya.workspaceId, "skipped_no_calendar"],
      [savely.workspaceId, "skipped_read_only"],
    ]);
  });

  it("is not put in a calendar without a time", async () => {
    const bro = await thread();
    const composio = fakeComposio();
    composio.connect({ toolkit: "googlesuper", userId: savely.userId });
    await confirm(bro, { summary: "Созвониться на неделе" });

    await bro.runBroToBroSteps();

    expect(composio.fetch).not.toHaveBeenCalled();
    expect(await calendarStates(bro)).toEqual([
      "skipped_no_time",
      "skipped_no_time",
    ]);
  });

  it("is tried three times, a pause apart, before the owner hears it failed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00+03:00"));
    const bro = await thread();
    const composio = fakeComposio();
    composio.connect({ toolkit: "googlesuper", userId: savely.userId });
    composio.proxy.mockImplementation(() => ({
      data: { error: { message: "Backend Error" } },
      status: 503,
    }));
    await confirm(bro, dinner);

    const states = [];
    /* oxlint-disable eslint/no-await-in-loop -- Each try waits for the pause after the one before. */
    for (const pauseMs of [0, 0, 60_000, 120_000]) {
      vi.setSystemTime(Date.now() + pauseMs);
      await bro.runBroToBroSteps();
      states.push((await calendarStates(bro))[0]);
    }
    /* oxlint-enable eslint/no-await-in-loop */

    expect(composio.proxy).toHaveBeenCalledTimes(3);
    expect(states).toEqual(["pending", "pending", "pending", "failed"]);
    expect(await confirmedReports(bro)).toEqual([
      [petya.workspaceId, "skipped_no_calendar"],
      [savely.workspaceId, "failed"],
    ]);
  });
});

describe("the second version's step", () => {
  beforeEach(() => {
    vi.stubEnv("BRO_TO_BRO_V2_WORKSPACES", "*");
  });

  afterEach(() => {
    vi.stubEnv("BRO_TO_BRO_V2_WORKSPACES", undefined);
  });

  it("lets the peer's place be named only as the place of the meeting a packet settles", async () => {
    const bro = await thread();
    const start = Date.now() + 3 * 24 * 60 * 60_000;
    const leaseToken = await bro.claim();
    await bro.says(
      savely,
      {
        kind: "sent",
        message: {
          action: "propose",
          body: "Поужинаем в «Медси»?",
          proposal: {
            end: new Date(start + 2 * 60 * 60_000).toISOString(),
            place: "Медси",
            start: new Date(start).toISOString(),
            summary: "Ужин",
          },
        },
      },
      leaseToken
    );
    outside.ask.mockImplementation(async ({ purpose }) =>
      purpose === "gate"
        ? { facts: [] }
        : {
            action: "message",
            message: "Пётр в субботу до обеда в «Медси», после — свободен",
            outOfScope: [],
          }
    );

    await bro.runEnvoyStep({
      leaseToken,
      threadId: bro.threadId,
      workspaceId: petya.workspaceId,
    });

    const checked = outside.ask.mock.calls
      .map(([request]) => request)
      .filter((request) => request.purpose === "gate")
      .map(
        (request) =>
          z
            .object({
              messages: z.tuple([z.object({ content: z.string() })]),
            })
            .parse(request).messages[0].content
      );
    expect(checked).toHaveLength(1);
    expect(
      z
        .object({ allowed: z.object({ venues: z.array(z.string()) }) })
        .parse(JSON.parse(checked[0] ?? "{}")).allowed.venues
    ).toEqual([]);
  });
});
