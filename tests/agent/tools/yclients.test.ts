import type { ModelMessage } from "ai";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as z from "zod";
import type { bookingLinksOf } from "@agent/lib/yclients/links";
import type { sendInPage } from "@agent/lib/yclients/page";
import type { readUserProfile } from "@db/services/user-profile";

const services = vi.hoisted(() => ({
  links: vi.fn<typeof bookingLinksOf>(),
  page: vi.fn<typeof sendInPage>(),
  phone: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("@agent/lib/yclients/links", () => ({
  bookingLinksOf: services.links,
}));
// The pool browser's tab: the calls are answered here, from a table.
vi.mock("@agent/lib/yclients/page", () => ({
  YclientsPageError: class YclientsPageError extends Error {
    override readonly name = "YclientsPageError";

    constructor(
      readonly sent: boolean,
      message: string
    ) {
      super(message);
    }
  },
  sendInPage: services.page,
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

/**
 * YClients' answers by method and path, as the page gets them, with every
 * request kept. An answer that throws is a request the network failed.
 */
function yclients(answers: Record<string, (body: string | null) => Response>) {
  const requests: {
    body: string | null;
    token: string;
    url: URL;
    writes: boolean;
  }[] = [];
  services.page.mockImplementation(async (_workspaceId, token, sent, writes) =>
    Promise.all(
      sent.map(async (one) => {
        const url = new URL(one.path, "https://api.yclients.com");
        requests.push({ body: one.body, token, url, writes });
        const answer = answers[`${one.method} ${url.pathname}`];
        if (answer === undefined) throw new Error(`Unexpected ${url.pathname}`);
        let response: Response;
        try {
          response = answer(one.body);
        } catch {
          return { status: 0, text: "" };
        }
        return { status: response.status, text: await response.text() };
      })
    )
  );
  return requests;
}

const ok = (data: z.core.util.JSONType, status = 200) =>
  Response.json({ data, meta: [], success: true }, { status });

const booking = {
  action: "book" as const,
  company,
  datetime: "2026-10-24T11:00:00+03:00",
  personAskedToBook: true as const,
  services: [7],
  staff: 0,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("YCLIENTS_TOKEN", "widget-token");
  vi.stubEnv("YCLIENTS_WORKSPACES", "*");
  services.phone.mockResolvedValue("8 (916) 150-22-39");
});

// Not `vi.unstubAllEnvs()`: it would take the test setup's own env away too
// (`tests/setup-env.ts`); each test sets the pilot's two names afresh.
afterEach(() => {
  services.page.mockReset();
});

describe("yclients", () => {
  it("is not there outside the pilot or without the token", async () => {
    vi.stubEnv("YCLIENTS_WORKSPACES", "workspace:bob");
    const outside = (await yclientsModule()).events["step.started"];
    expect(await outside?.({}, resolveContext(asked))).toBeNull();
    vi.resetModules();
    vi.stubEnv("YCLIENTS_WORKSPACES", "*");
    vi.stubEnv("YCLIENTS_TOKEN", "");
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
      [`GET /api/v1/company/${String(company)}`]: () =>
        ok({
          address: "Мичуринский проспект, 56",
          id: company,
          title: "Топган",
        }),
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
      total: 1,
    });
    expect(requests[0]?.token).toBe("widget-token");
    expect(requests.every((request) => !request.writes)).toBe(true);
  });

  it("lists a company's services and names the place they are at", async () => {
    yclients({
      [`GET /api/v1/book_services/${String(company)}`]: () =>
        ok({
          category: [{ id: 3, title: "Стрижки" }],
          services: [
            {
              category_id: 3,
              id: 7,
              price_max: 2800,
              price_min: 2800,
              seance_length: 3600,
              title: "Мужская стрижка",
            },
          ],
        }),
      [`GET /api/v1/company/${String(company)}`]: () =>
        ok({
          address: "Мичуринский пр-т, 56",
          city: "Москва",
          id: company,
          title: "ТОПГАН Москва Мичуринский пр-т ЖК Небо",
        }),
    });

    expect(
      await (
        await tool(asked)
      ).execute({ action: "services", company }, callContext())
    ).toEqual({
      ok: true,
      place: {
        address: "Москва, Мичуринский пр-т, 56",
        title: "ТОПГАН Москва Мичуринский пр-т ЖК Небо",
      },
      services: [
        {
          category: "Стрижки",
          id: 7,
          minutes: 60,
          priceRub: "2800",
          title: "Мужская стрижка",
        },
      ],
      total: 1,
    });
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
      // The 25th is closed: its times are not looked at.
      [`GET /api/v1/book_times/${String(company)}/0/2026-10-25`]: () =>
        ok(["not a slot"]),
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
      readThrough: "2026-10-25",
    });
    expect(requests[1]?.url.searchParams.getAll("service_ids[]")).toEqual([
      "7",
    ]);
  });

  it("books in the person's own turn with their name and phone, once", async () => {
    const requests = yclients({
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
      `/api/v1/book_record/${String(company)}`,
    ]);
    expect(requests[0]?.writes).toBe(true);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
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
    expect(requests).toHaveLength(1);
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
      [`POST /api/v1/book_record/${String(company)}`]: () =>
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
    expect(requests).toHaveLength(1);

    // A gateway's 504 page after the booking went out: it may exist.
    const gateway = yclients({
      [`POST /api/v1/book_record/${String(company)}`]: () =>
        new Response("<html>504 Gateway Time-out</html>", { status: 504 }),
    });
    const again = await tool(asked);
    expect(
      JSON.stringify(await again.execute(booking, callContext()))
    ).toContain("Do not book again");
    expect(await again.execute(booking, callContext())).toMatchObject({
      ok: false,
    });
    expect(gateway).toHaveLength(1);
  });

  it("books again after a tab that never sent the booking, but not after one that may have", async () => {
    const { YclientsPageError } = await import("@agent/lib/yclients/page");
    services.page.mockRejectedValueOnce(new YclientsPageError(false, "tab"));
    const booker = await tool(asked);
    expect(
      JSON.stringify(await booker.execute(booking, callContext()))
    ).not.toContain("Do not book again");
    services.page.mockRejectedValueOnce(new YclientsPageError(true, "call"));
    expect(
      JSON.stringify(await booker.execute(booking, callContext()))
    ).toContain("Do not book again");
    expect(await booker.execute(booking, callContext())).toMatchObject({
      ok: false,
    });
    expect(services.page).toHaveBeenCalledTimes(2);
  });

  it("books once for two calls of one step", async () => {
    const { promise: held, resolve: release } =
      Promise.withResolvers<undefined>();
    const requests = yclients({
      [`POST /api/v1/book_record/${String(company)}`]: () =>
        ok([{ id: 1, record_hash: "abc", record_id: 7 }], 201),
    });
    services.phone.mockImplementationOnce(async () => {
      await held;
      return "+7 916 150-22-39";
    });
    const booker = await tool(asked);

    const both = Promise.all([
      booker.execute(booking, callContext()),
      booker.execute(booking, callContext()),
    ]);
    release(undefined);
    const [first, second] = await both;

    expect(first).toMatchObject({ booked: true });
    expect(second).toMatchObject({ ok: false });
    expect(
      requests.filter((request) => request.url.pathname.includes("book_record"))
    ).toHaveLength(1);
  });

  it("lists every branch of a network's form, not only its default one", async () => {
    services.links.mockResolvedValue({
      kind: "found",
      links: [{ company: undefined, form: 383_401 }],
    });
    yclients({
      "GET /api/v1/bookform/383401": () =>
        ok({ company_id: 1, group_id: 77, phone_confirmation: false }),
      "GET /api/v1/company/1": () =>
        ok({ address: "Тверская, 1", id: 1, title: "Glow&Go Центр" }),
      "GET /api/v1/companies": () =>
        ok([
          { address: "Тверская, 1", id: 1, title: "Glow&Go Центр" },
          { address: "Мичуринский проспект, 56", id: 2, title: "Glow&Go Небо" },
        ]),
    });

    const found = await (
      await tool(asked)
    ).execute({ action: "find", link: "https://glowgo.ru" }, callContext());

    expect(found).toMatchObject({
      places: [
        { company: 1, form: 383_401, phoneConfirmation: null },
        { address: "Мичуринский проспект, 56", company: 2, form: 383_401 },
      ],
      total: 2,
    });
  });

  it("asks the salon for an SMS code when it refuses a booking without one", async () => {
    const requests = yclients({
      [`POST /api/v1/book_record/${String(company)}`]: () =>
        Response.json(
          { meta: { errors: [{ code: 432 }] }, success: false },
          { status: 422 }
        ),
      [`POST /api/v1/book_code/${String(company)}`]: () => ok(null, 201),
    });
    const booker = await tool(asked);

    expect(await booker.execute(booking, callContext())).toMatchObject({
      codeSent: true,
    });
    expect(requests.at(-1)?.url.pathname).toBe(
      `/api/v1/book_code/${String(company)}`
    );
  });

  it("takes a code only as a number of its own in the person's words", async () => {
    const requests = yclients({});
    const booker = await tool([{ content: "запиши на 11:00", role: "user" }]);

    expect(
      await booker.execute({ ...booking, code: "1100" }, callContext())
    ).toMatchObject({ ok: false });
    expect(requests).toHaveLength(0);
  });

  it("names the free days past a range longer than the days it read", async () => {
    yclients({
      [`GET /api/v1/book_dates/${String(company)}`]: () =>
        ok({ booking_dates: ["2026-10-30", "2026-10-31"] }),
      // The seven days read are all closed.
      ...Object.fromEntries(
        [23, 24, 25, 26, 27, 28, 29].map((day) => [
          `GET /api/v1/book_times/${String(company)}/0/2026-10-${String(day)}`,
          () => ok([]),
        ])
      ),
    });

    const found = await (
      await tool(asked)
    ).execute(
      {
        action: "slots",
        company,
        from: "2026-10-23",
        services: [7],
        staff: 0,
        to: "2026-10-31",
      },
      callContext()
    );

    expect(found).toMatchObject({
      days: [],
      laterDays: ["2026-10-30", "2026-10-31"],
      readThrough: "2026-10-29",
    });
  });
});
