import type { SessionAuthContext } from "eve/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import type { Card } from "@shared/cards/schema";

const fetchMock =
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

const person: SessionAuthContext = {
  attributes: { workspaceId: "workspace-1" },
  authenticator: "telegram-webhook",
  principalId: "user-1",
  principalType: "user",
};

const hotel = "https://ostrovok.ru/hotel/russia/moscow/mid8526976/test_hotel/";
const flight = "https://www.aviasales.ru/search/MOW0112LED1";
const short = (n: number) => `https://ostrovok.tpk.lu/link${String(n)}`;

/** Travelpayouts' answer: each brand address made a link, or `failed`. */
function answer(made: Readonly<Record<string, string | undefined>>) {
  return Response.json({
    code: "success",
    result: {
      links: Object.entries(made).map(([url, partner]) =>
        partner === undefined
          ? {
              code: "failed",
              message: "trs is not subscribed for brand",
              partner_url: "",
              url,
            }
          : { code: "success", partner_url: partner, url }
      ),
    },
    status: 200,
  });
}

/** What a call to Travelpayouts asked for. */
const requestSchema = z.object({
  links: z.array(z.object({ url: z.string() })),
  marker: z.number(),
  shorten: z.boolean(),
  trs: z.number(),
});

function request(call = 0) {
  const body = z.string().parse(fetchMock.mock.calls[call]?.[1].body);
  return requestSchema.parse(JSON.parse(body));
}

function askedLinks(call = 0) {
  return request(call).links.map(({ url }) => url);
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TRAVELPAYOUTS_TOKEN", "tp-test-token");
  vi.stubEnv("TRAVELPAYOUTS_MARKER", "795252");
  vi.stubEnv("TRAVELPAYOUTS_TRS", "591523");
  vi.stubEnv("PARTNER_LINKS_WORKSPACES", "workspace-1");
});

// Not `unstubAllEnvs`: it would lift `tests/setup-env.ts` too.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("messageWithPartnerLinks", () => {
  it("sends the brand links of a message as partner links and leaves the rest", async () => {
    const { messageWithPartnerLinks } = await import("../rewrite");
    fetchMock.mockResolvedValueOnce(
      answer({ [flight]: short(2), [hotel]: short(1) })
    );
    const sent = await messageWithPartnerLinks(
      {
        kind: "message",
        text: `Вот [отель](${hotel}), билеты: ${flight}. Карта: https://yandex.ru/maps/-/abc`,
      },
      person
    );
    expect(sent).toEqual({
      kind: "message",
      text: `Вот [отель](${short(1)}), билеты: ${short(2)}. Карта: https://yandex.ru/maps/-/abc`,
    });
    // Only the brands reach Travelpayouts, under the owner's ids.
    expect(askedLinks()).toEqual([hotel, flight]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.travelpayouts.com/links/v1/create");
    expect(new Headers(init?.headers).get("x-access-token")).toBe(
      "tp-test-token"
    );
    expect(request()).toMatchObject({
      marker: 795252,
      shorten: true,
      trs: 591523,
    });
  });

  it("goes out at once outside the pilot or without a brand link", async () => {
    const { messageWithPartnerLinks } = await import("../rewrite");
    expect(
      messageWithPartnerLinks(
        { kind: "message", text: "Погода: https://yandex.ru/pogoda" },
        person
      )
    ).toBeUndefined();
    vi.stubEnv("PARTNER_LINKS_WORKSPACES", "workspace-2");
    vi.resetModules();
    const outside = await import("../rewrite");
    expect(
      outside.messageWithPartnerLinks({ kind: "link", url: hotel }, person)
    ).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a link Travelpayouts refused, and does not ask for it again soon", async () => {
    const { messageWithPartnerLinks } = await import("../rewrite");
    fetchMock.mockResolvedValueOnce(answer({ [hotel]: undefined }));
    const message = { kind: "message" as const, text: `[Отель](${hotel})` };
    expect(await messageWithPartnerLinks(message, person)).toEqual(message);
    expect(await messageWithPartnerLinks(message, person)).toEqual(message);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends the message as written when Travelpayouts fails", async () => {
    const { messageWithPartnerLinks } = await import("../rewrite");
    fetchMock.mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 })
    );
    const message = { kind: "link" as const, url: hotel };
    expect(await messageWithPartnerLinks(message, person)).toEqual(message);
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    const other = { kind: "link" as const, url: flight };
    expect(await messageWithPartnerLinks(other, person)).toEqual(other);
  });
});

describe("cardWithPartnerLinks", () => {
  it("puts partner links on a card's rows, options and buttons", async () => {
    const { cardWithPartnerLinks } = await import("../rewrite");
    const other = "https://ostrovok.ru/hotel/russia/moscow/mid1/other/";
    fetchMock.mockResolvedValueOnce(
      answer({ [flight]: short(3), [hotel]: short(1), [other]: short(2) })
    );
    const card: Card = {
      actions: [
        { href: flight, label: "Билеты" },
        { href: "tel:+79990000000", label: "Позвонить" },
        { label: "Выбрать", primary: true, submit: "pick" },
      ],
      blocks: [
        {
          layout: "rows",
          rows: [{ href: hotel, title: "Отель у парка" }],
          type: "list",
        },
        {
          id: "hotel",
          initial: [],
          label: "Какой берём?",
          layout: "list",
          multiple: false,
          options: [
            {
              more: { href: other, text: "Тихий" },
              title: "Другой",
              value: "b",
            },
            { title: "Без ссылки", value: "c" },
          ],
          required: true,
          type: "choice",
        },
      ],
      title: "Отели",
      tone: "neutral",
    };
    const linked = await cardWithPartnerLinks(card, {
      workspaceId: "workspace-1",
    });
    expect(
      linked.actions.map((action) => "href" in action && action.href)
    ).toEqual([short(3), "tel:+79990000000", false]);
    expect(linked.blocks).toEqual([
      { ...card.blocks[0], rows: [{ href: short(1), title: "Отель у парка" }] },
      {
        ...card.blocks[1],
        options: [
          {
            more: { href: short(2), text: "Тихий" },
            title: "Другой",
            value: "b",
          },
          { title: "Без ссылки", value: "c" },
        ],
      },
    ]);
    expect(askedLinks()).toEqual([flight, hotel, other]);
  });
});
