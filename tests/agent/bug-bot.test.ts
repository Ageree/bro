import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
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
import { z } from "zod";
import * as Database from "@db";
import * as schema from "@db/schema";
import type * as EnvModule from "@shared/environment";
import { bugBotTarget } from "@agent/lib/bug-bot/target";
import {
  handleBugBotUpdate,
  maximumReportLength,
  reportsPerHour,
} from "@agent/lib/bug-bot/process";
import { runBugBotTick } from "@agent/lib/bug-bot/tick";

const capture = vi.hoisted(() => ({
  // SAFETY: The mock factory fills this object with the real environment before any test runs.
  env: {} as Record<string, string | undefined>,
}));

vi.mock("@shared/environment", async (importOriginal) => {
  const original = await importOriginal<typeof EnvModule>();
  Object.assign(capture.env, original.env, {
    BUG_BOT: "on",
    OPS_ALERT_BOT_TOKEN: "bug-token",
    OPS_ALERT_CHAT_ID: "900",
    TELEGRAM_BOT_TOKEN: "bro-token",
  });
  return { ...original, env: capture.env };
});

const client = new PGlite();
const database = drizzle(client, { schema });

beforeAll(async () => {
  await migrate(database, { migrationsFolder: "db/migrations" });
  // SAFETY: PGlite implements the same Drizzle query-builder contract used by these services; only the driver changes.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the real bug-report tables with an isolated PostgreSQL-compatible test database.
  vi.spyOn(Database, "db", "get").mockReturnValue(database as never);
}, 20_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await client.close();
});

const target = { botToken: "bug-token", ownerChatId: "900" };
const callSchema = z.object({
  method: z.string(),
  body: z.record(z.string(), z.json()),
});
const now = new Date("2026-10-12T10:00:00Z");

/** The Bot API as a list of calls; `getUpdates` answers what the test queued. */
function stubBotApi(options: { updates?: unknown[]; status?: number } = {}) {
  let sentId = 500;
  const calls: z.output<typeof callSchema>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const method = new Request(input).url.split("/").at(-1) ?? "";
      const body = z
        .record(z.string(), z.json())
        .parse(JSON.parse(z.string().parse(init?.body)));
      calls.push({ body, method });
      if (method === "getUpdates") {
        if (options.status) {
          return Response.json(
            { description: "Conflict", error_code: options.status, ok: false },
            { status: options.status }
          );
        }
        const updates = options.updates ?? [];
        options.updates = [];
        return Response.json({ ok: true, result: updates });
      }
      sentId += 1;
      return Response.json({ ok: true, result: { message_id: sentId } });
    })
  );
  return calls;
}

function privateMessage(
  updateId: number,
  text: string,
  userId = 77,
  extra = {}
) {
  return {
    message: {
      chat: { id: userId, type: "private" },
      from: { first_name: "Маша", id: userId, username: "masha" },
      message_id: updateId,
      text,
      ...extra,
    },
    update_id: updateId,
  };
}

describe("when the bug bot is on", () => {
  afterEach(() => {
    capture.env.BUG_BOT = "on";
    capture.env.OPS_ALERT_BOT_TOKEN = "bug-token";
    capture.env.OPS_ALERT_CHAT_ID = "900";
  });

  it("is on with its own token and a chat", () => {
    expect(bugBotTarget()).toEqual(target);
  });

  it("stays off with Bro's own token, which tg-bridge reads", () => {
    capture.env.OPS_ALERT_BOT_TOKEN = "bro-token";
    expect(bugBotTarget()).toBeUndefined();
  });

  it("stays off without a token, a chat or the flag", () => {
    capture.env.OPS_ALERT_BOT_TOKEN = undefined;
    expect(bugBotTarget()).toBeUndefined();
    capture.env.OPS_ALERT_BOT_TOKEN = "bug-token";
    capture.env.OPS_ALERT_CHAT_ID = undefined;
    expect(bugBotTarget()).toBeUndefined();
    capture.env.OPS_ALERT_CHAT_ID = "900";
    capture.env.BUG_BOT = "off";
    expect(bugBotTarget()).toBeUndefined();
  });

  it("never reads updates with Bro's token", async () => {
    capture.env.OPS_ALERT_BOT_TOKEN = "bro-token";
    const calls = stubBotApi();
    await runBugBotTick();
    expect(calls).toEqual([]);
  });
});

describe("bug reports", () => {
  beforeEach(async () => {
    await database.delete(schema.bugReportReplies);
    await database.delete(schema.bugReports);
    await database.delete(schema.bugBotState);
    await database.delete(schema.channelIdentities);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("greets on /start without filing anything", async () => {
    const calls = stubBotApi();
    await handleBugBotUpdate(target, privateMessage(1, "/start"), now);
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"]);
    expect(await database.select().from(schema.bugReports)).toEqual([]);
  });

  it("files a report once per update and forwards it with a tagged header", async () => {
    const calls = stubBotApi();
    const update = privateMessage(2, "кнопка не нажимается");
    await handleBugBotUpdate(target, update, now);
    await handleBugBotUpdate(target, update, now);

    const [report] = await database.select().from(schema.bugReports);
    expect(report).toMatchObject({
      status: "forwarded",
      text: "кнопка не нажимается",
      username: "masha",
      workspaceId: null,
    });
    const forward = calls.find((call) => call.body.chat_id === "900");
    expect(z.string().parse(forward?.body.text)).toMatch(
      new RegExp(
        `^🐞 #bug №${String(report?.id)} · Маша @masha · без кабинета · .*\\n\\nкнопка не нажимается$`,
        "u"
      )
    );
    const toUser = calls.filter((call) => call.body.chat_id === "77");
    expect(toUser).toHaveLength(1);
    expect(JSON.stringify(toUser[0]?.body.text)).toContain(
      `№${String(report?.id)}`
    );
  });

  it("names the workspace of a linked person", async () => {
    stubBotApi();
    await database
      .insert(schema.user)
      .values({ email: "one@example.com", id: "user-1", name: "One" })
      .onConflictDoNothing();
    await database.insert(schema.channelIdentities).values({
      channel: "telegram",
      chatId: "77",
      externalUserId: "77",
      userId: "user-1",
      workspaceId: "workspace:one",
    });
    await handleBugBotUpdate(target, privateMessage(3, "не грузится"), now);
    const [report] = await database.select().from(schema.bugReports);
    expect(report?.workspaceId).toBe("workspace:one");
  });

  it("sends a screenshot by its file id", async () => {
    const calls = stubBotApi();
    await handleBugBotUpdate(
      target,
      {
        message: {
          caption: "вот",
          chat: { id: 77, type: "private" },
          from: { id: 77 },
          message_id: 4,
          photo: [{ file_id: "small" }, { file_id: "big" }],
        },
        update_id: 4,
      },
      now
    );
    const photo = calls.find((call) => call.method === "sendPhoto");
    expect(photo?.body).toMatchObject({ chat_id: "900", photo: "big" });
  });

  it("caps reports per hour and their length", async () => {
    const calls = stubBotApi();
    for (let index = 0; index < reportsPerHour + 1; index += 1) {
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Reports arrive one after another. */
      await handleBugBotUpdate(
        target,
        privateMessage(10 + index, `баг ${String(index)}`),
        now
      );
    }
    expect(await database.select().from(schema.bugReports)).toHaveLength(
      reportsPerHour
    );
    await handleBugBotUpdate(
      target,
      privateMessage(99, "я".repeat(maximumReportLength + 1), 78),
      now
    );
    expect(await database.select().from(schema.bugReports)).toHaveLength(
      reportsPerHour
    );
    expect(calls.at(-1)?.body.chat_id).toBe("78");
    // An hour later the same person may write again.
    await handleBugBotUpdate(
      target,
      privateMessage(100, "ещё баг"),
      new Date(now.getTime() + 61 * 60_000)
    );
    expect(await database.select().from(schema.bugReports)).toHaveLength(
      reportsPerHour + 1
    );
  });

  it("answers the person whose report the owner replied to, only from the owner's chat", async () => {
    const calls = stubBotApi();
    await handleBugBotUpdate(target, privateMessage(20, "баг А", 77), now);
    await handleBugBotUpdate(target, privateMessage(21, "баг Б", 78), now);
    const reports = await database.select().from(schema.bugReports);
    const second = reports.find((report) => report.telegramUserId === "78");
    calls.length = 0;

    const reply = (updateId: number, chatId: number) => ({
      message: {
        chat: { id: chatId, type: "private" },
        from: { id: 1 },
        message_id: updateId,
        reply_to_message: { message_id: second?.forwardMessageId ?? 0 },
        text: "починили",
      },
      update_id: updateId,
    });
    // From a chat that is not the owner's: filed as a report of its own, not an answer.
    await handleBugBotUpdate(target, reply(30, 5), now);
    expect(calls.some((call) => call.body.chat_id === "78")).toBe(false);

    await handleBugBotUpdate(target, reply(31, 900), now);
    await handleBugBotUpdate(target, reply(31, 900), now);
    const answers = calls.filter((call) => call.body.chat_id === "78");
    expect(answers).toHaveLength(1);
    expect(JSON.stringify(answers[0]?.body.text)).toContain("починили");
    const [row] = await database
      .select()
      .from(schema.bugReports)
      .where(
        (await import("drizzle-orm")).eq(schema.bugReports.id, second?.id ?? 0)
      );
    expect(row?.status).toBe("answered");
  });

  it("pauses on a 409 without failing the tick, and reads again after", async () => {
    stubBotApi({ status: 409 });
    await expect(runBugBotTick(() => now)).resolves.toBeUndefined();
    const calls = stubBotApi();
    await runBugBotTick(() => new Date(now.getTime() + 60_000));
    expect(calls).toEqual([]);
    const later = stubBotApi();
    await runBugBotTick(() => new Date(now.getTime() + 6 * 60_000));
    expect(later[0]?.method).toBe("getUpdates");
  }, 70_000);

  it("does not move the offset past an update that failed, and skips a poison one after three tries", async () => {
    const update = privateMessage(50, "баг");
    // The report cannot be filed: the update is retried, not lost.
    const fileFailure = vi
      .spyOn(await import("@db/services/bug-reports"), "fileBugReport")
      .mockRejectedValue(new Error("write failed"));
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      stubBotApi({ updates: [update] });
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Ticks follow one another. */
      await runBugBotTick(() => now);
      /* oxlint-disable-next-line eslint/no-await-in-loop -- Ticks follow one another. */
      const [state] = await database.select().from(schema.bugBotState);
      expect(state?.nextOffset).toBe(0);
      expect(state?.failedCount).toBe(attempt);
      expect(state?.leaseUntil).toBeNull();
    }
    // The third failure skips it, so the queue goes on.
    stubBotApi({ updates: [update] });
    await runBugBotTick(() => now);
    const [state] = await database.select().from(schema.bugBotState);
    expect(state?.nextOffset).toBe(51);
    fileFailure.mockRestore();
  }, 70_000);

  it("never runs two ticks at once", async () => {
    const calls = stubBotApi();
    await database.insert(schema.bugBotState).values({
      id: "bug-bot",
      leaseUntil: new Date(Date.now() + 60_000),
      nextOffset: 0,
    });
    await runBugBotTick(() => now);
    expect(calls).toEqual([]);
  });

  it("answers a repeated /start once a minute", async () => {
    const calls = stubBotApi();
    const later = new Date(now.getTime() + 5 * 60 * 60_000);
    await handleBugBotUpdate(target, privateMessage(60, "/start", 91), later);
    await handleBugBotUpdate(target, privateMessage(61, "/start", 91), later);
    expect(calls).toHaveLength(1);
  });

  it("moves the offset past what it handled", async () => {
    stubBotApi({ updates: [privateMessage(40, "баг")] });
    await runBugBotTick(() => now);
    const [state] = await database.select().from(schema.bugBotState);
    expect(state?.nextOffset).toBe(41);
    expect(await database.select().from(schema.bugReports)).toHaveLength(1);
  }, 70_000);
});
