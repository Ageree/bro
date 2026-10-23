import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import type { bookingLinksOf } from "@agent/lib/yclients/links";
import type { readUserProfile } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  links: vi.fn<typeof bookingLinksOf>(),
  phone: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("@agent/lib/yclients/links", () => ({
  bookingLinksOf: services.links,
}));
vi.mock("@agent/lib/browser-use/facts", () => ({
  readOwnPhone: services.phone,
}));
vi.mock("@db/services/user-profile", async () => {
  const { emptyUserProfile } = await import("@shared/user-profile/schema");
  return {
    readUserProfile: vi.fn<typeof readUserProfile>(async () => ({
      ...emptyUserProfile,
      firstName: "Савелий",
      lastName: "Соловьев",
    })),
  };
});

import { backgroundTurnMarker } from "@shared/chat/background-turn";

const workspaceId = "workspace:alice";
const company = 555;

function caller() {
  return {
    attributes: { conversationChannel: "eve", workspaceId },
    authenticator: "authjs",
    principalId: "alice",
    principalType: "user" as const,
  };
}

function resolveContext(messages: ModelMessage[]): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: { current: caller(), initiator: null }, id: "session-1" },
  };
}

function callContext(): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("No sandbox.");
    },
    getSkill: () => {
      throw new Error("No skill.");
    },
    getToken: () => {
      throw new Error("No token.");
    },
    requireAuth: (): never => {
      throw new Error("No token.");
    },
    session: {
      auth: { current: caller(), initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "yclients",
  };
}

let turn = 0;

/** The tool's module as the env of the test sets it up: env is read on import. */
async function yclientsModule() {
  return (await import("@agent/tools/yclients")).default;
}

/** The tool as a step of a new turn with these messages sees it. */
async function tool(messages: ModelMessage[]) {
  turn += 1;
  const resolve = (await yclientsModule()).events["step.started"];
  const tools = resolve
    ? await resolve(
        { data: { stepIndex: 0, turnId: `turn_${String(turn)}` } },
        resolveContext(messages)
      )
    : null;
  if (!tools || !("yclients" in tools)) throw new Error("Expected yclients.");
  return tools.yclients;
}

const asked: ModelMessage[] = [
  {
    content: "Запиши меня в Топган на завтра, чтобы закончить до 16:00",
    role: "user",
  },
];

/** YClients' answers by method and path, with every request kept. */
function yclients(answers: Record<string, (body: string | null) => Response>) {
  const requests: { body: string | null; headers: Headers; url: URL }[] = [];
  const fetch = vi.fn<
    (input: string | URL, init?: RequestInit) => Promise<Response>
  >(async (input, init) => {
    const url = new URL(input);
    const body = z
      .string()
      .nullable()
      .catch(null)
      .parse(init?.body ?? null);
    requests.push({ body, headers: new Headers(init?.headers), url });
    const answer = answers[`${init?.method ?? "GET"} ${url.pathname}`];
    if (answer === undefined) throw new Error(`Unexpected ${url.pathname}`);
    return answer(body);
  });
  vi.stubGlobal("fetch", fetch);
  return requests;
}

const ok = (data: z.core.util.JSONType, status = 200) =>
  Response.json({ data, meta: [], success: true }, { status });

const booking = {
  action: "book",
  company,
  datetime: "2026-10-24T11:00:00+03:00",
  personAskedToBook: true,
  services: [7],
  staff: 0,
} as const;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("YCLIENTS_PARTNER_TOKEN", "partner-token");
  vi.stubEnv("YCLIENTS_WORKSPACES", "*");
  services.phone.mockResolvedValue("8 (916) 150-22-39");
});

// Not `vi.unstubAllEnvs()`: it would take the test setup's own env away too
// (`tests/setup-env.ts`); each test sets the pilot's two names afresh.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("yclients", () => {
  it("is not there outside the pilot or without the partner token", async () => {
    vi.stubEnv("YCLIENTS_WORKSPACES", "workspace:bob");
    const outside = (await yclientsModule()).events["step.started"];
    expect(await outside?.({}, resolveContext(asked))).toBeNull();
    vi.resetModules();
    vi.stubEnv("YCLIENTS_WORKSPACES", "*");
    vi.stubEnv("YCLIENTS_PARTNER_TOKEN", "");
    const tokenless = (await yclientsModule()).events["step.started"];
    expect(await tokenless?.({}, resolveContext(asked))).toBeNull();
  });

  it("finds the salon's company through the booking form its site links to", async () => {
    services.links.mockResolvedValue({
      kind: "found",
      links: [{ company: undefined, form: 102_887 }],
    });
    const requests = yclients({
      "GET /api/v1/bookform/102887": () =>
        ok({ company_id: company, phone_confirmation: false }),
      "GET /api/v1/companies": () =>
        ok([
          { address: "Мичуринский проспект, 56", id: company, title: "Топган" },
        ]),
    });

    const found = await (
      await tool(asked)
    ).execute(
      { action: "find", link: "топган.рф/барбершопы/мичуринский-пр-т" },
      callContext()
    );

    expect(found).toEqual({
      ok: true,
      places: [
        {
          address: "Мичуринский проспект, 56",
          company,
          form: 102_887,
          phoneConfirmation: false,
          title: "Топган",
        },
      ],
    });
    expect(requests[0]?.headers.get("authorization")).toBe(
      "Bearer partner-token"
    );
    expect(requests[0]?.headers.get("accept")).toBe(
      "application/vnd.yclients.v2+json"
    );
  });

  it("gives the free times of the asked days and names the later free days", async () => {
    const requests = yclients({
      [`GET /api/v1/book_dates/${String(company)}`]: () =>
        ok({ booking_dates: ["2026-10-24", "2026-10-26"] }),
      [`GET /api/v1/book_times/${String(company)}/0/2026-10-24`]: () =>
        ok([
          {
            datetime: "2026-10-24T11:00:00+03:00",
            seance_length: 3600,
            time: "11:00",
          },
        ]),
    });

    const found = await (
      await tool(asked)
    ).execute(
      {
        action: "slots",
        company,
        from: "2026-10-24",
        services: [7],
        staff: 0,
        to: "2026-10-25",
      },
      callContext()
    );

    expect(found).toEqual({
      days: [
        {
          date: "2026-10-24",
          times: [
            {
              datetime: "2026-10-24T11:00:00+03:00",
              minutes: 60,
              time: "11:00",
            },
          ],
        },
      ],
      laterDays: ["2026-10-26"],
      ok: true,
    });
    expect(requests[1]?.url.searchParams.getAll("service_ids[]")).toEqual([
      "7",
    ]);
  });

  it("books in the person's own turn with their name and phone, once", async () => {
    const requests = yclients({
      [`POST /api/v1/book_check/${String(company)}`]: () => ok(null, 201),
      [`POST /api/v1/book_record/${String(company)}`]: () =>
        ok([{ id: 1, record_hash: "abc", record_id: 2_820_023 }], 201),
    });
    const booker = await tool(asked);

    const booked = await booker.execute(booking, callContext());

    expect(booked).toMatchObject({
      booked: true,
      ok: true,
      recordIds: [2_820_023],
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      `/api/v1/book_check/${String(company)}`,
      `/api/v1/book_record/${String(company)}`,
    ]);
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      appointments: [
        { datetime: booking.datetime, id: 1, services: [7], staff_id: 0 },
      ],
      email: "",
      fullname: "Савелий Соловьев",
      phone: "79161502239",
    });
    expect(await booker.execute(booking, callContext())).toMatchObject({
      ok: false,
    });
    expect(requests).toHaveLength(2);
  });

  it("books nothing in a turn the person's message did not open", async () => {
    const requests = yclients({});
    const report = await tool([
      ...asked,
      {
        content: `${backgroundTurnMarker}\n\nBrowser run vm:1 finished.`,
        role: "user",
      },
    ]);

    expect(await report.execute(booking, callContext())).toMatchObject({
      ok: false,
    });
    expect(requests).toHaveLength(0);
  });

  it("sends the SMS code a form asks for, and takes a code only from the person's words", async () => {
    const requests = yclients({
      "GET /api/v1/bookform/102887": () => ok({ phone_confirmation: true }),
      [`POST /api/v1/book_code/${String(company)}`]: () => ok(null, 201),
    });

    expect(
      await (
        await tool(asked)
      ).execute({ ...booking, form: 102_887 }, callContext())
    ).toMatchObject({ codeSent: true, ok: true });
    expect(JSON.parse(requests[1]?.body ?? "")).toEqual({
      fullname: "Савелий Соловьев",
      phone: "79161502239",
    });

    expect(
      await (
        await tool([{ content: "код 4821", role: "user" }])
      ).execute({ ...booking, code: "1234", form: 102_887 }, callContext())
    ).toMatchObject({ ok: false });
    expect(requests).toHaveLength(2);
  });

  it("tells a taken time from a lost answer, and never books again after a lost one", async () => {
    yclients({
      [`POST /api/v1/book_check/${String(company)}`]: () =>
        Response.json(
          {
            meta: { errors: [{ code: 433, message: "занято" }] },
            success: false,
          },
          { status: 422 }
        ),
    });
    const taken = await (await tool(asked)).execute(booking, callContext());
    expect(taken).toMatchObject({ ok: false });
    expect(JSON.stringify(taken)).toContain("taken");

    const requests = yclients({
      [`POST /api/v1/book_check/${String(company)}`]: () => ok(null, 201),
      [`POST /api/v1/book_record/${String(company)}`]: () => {
        throw new TypeError("fetch failed");
      },
    });
    const booker = await tool(asked);
    const lost = await booker.execute(booking, callContext());
    expect(JSON.stringify(lost)).toContain("Do not book again");
    expect(await booker.execute(booking, callContext())).toMatchObject({
      ok: false,
    });
    expect(requests).toHaveLength(2);
  });
});
