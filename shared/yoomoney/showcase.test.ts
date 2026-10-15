import { afterEach, describe, expect, it, vi } from "vitest";
import { fillYoomoneyService } from "./showcase";

const form = {
  title: "МегаФон (Россия)",
  hidden_fields: { ShopID: "918550" },
  form: [
    {
      type: "group",
      items: [
        {
          type: "text",
          name: "topped_up_phone",
          label: "Телефон",
          required: true,
        },
        { type: "amount", name: "netSum", label: "Сумма", required: true },
      ],
    },
    { type: "submit", label: "Заплатить" },
  ],
};

/** The catalogue: the form, then the payment's parameters for its step. */
function catalogue(
  step = "https://yoomoney.ru/api/showcase/validate/337/step"
) {
  const posted: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: { body?: URLSearchParams }) => {
      if (init.body === undefined) {
        return Response.json(form, {
          status: 300,
          headers: { Location: step },
        });
      }
      posted.push(init.body);
      expect(url.toString()).toBe(step);
      return Response.json({
        params: { pattern_id: "337", ...Object.fromEntries(init.body) },
      });
    })
  );
  return posted;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a service of YooMoney's catalogue", () => {
  it("asks for a missing required field, then gives the payment's parameters", async () => {
    const posted = catalogue();
    expect(
      await fillYoomoneyService("337", [
        { name: "topped_up_phone", value: "9261234567" },
      ])
    ).toMatchObject({
      kind: "fields",
      fields: [{ name: "topped_up_phone" }, { name: "netSum" }],
    });
    expect(posted).toEqual([]);

    expect(
      await fillYoomoneyService("337", [
        { name: "topped_up_phone", value: "9261234567" },
        { name: "netSum", value: "100" },
      ])
    ).toEqual({
      kind: "ready",
      title: "МегаФон (Россия)",
      params: {
        pattern_id: "337",
        ShopID: "918550",
        topped_up_phone: "9261234567",
        netSum: "100",
      },
      shown: [
        { label: "Телефон", value: "9261234567" },
        { label: "Сумма", value: "100" },
      ],
    });
  });

  it("follows a step only on the catalogue itself", async () => {
    const posted = catalogue("https://elsewhere.example/api/showcase/1");
    await expect(
      fillYoomoneyService("337", [
        { name: "topped_up_phone", value: "9261234567" },
        { name: "netSum", value: "100" },
      ])
    ).rejects.toThrow("ЮMoney");
    expect(posted).toEqual([]);
  });
});
