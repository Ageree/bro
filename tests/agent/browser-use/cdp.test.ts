import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  callInPageOverCdp,
  captureViewportOverCdp,
  typeOneTimeCodeOverCdp,
  visitPageOverCdp,
} from "@agent/lib/browser-use/cdp";
import {
  clearBrowserVmSettings,
  importWithSettings,
} from "@tests/helpers/browser-vm";
import {
  startFakeCdpBrowser,
  type CdpBrowserFixture,
  type FakeCdpBrowser,
  type FakeElementSpec,
} from "@tests/helpers/cdp-browser";

const code = "482913";
let browser: FakeCdpBrowser | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

async function fake(fixture: CdpBrowserFixture) {
  browser = await startFakeCdpBrowser(fixture);
  return browser;
}

/** The page, one frame in its own renderer, one sharing the page's. */
const bankInsideAds: CdpBrowserFixture["sessions"] = {
  "": {
    attaches: ["bank-session"],
    frames: [
      { depth: 0, id: "top" },
      { depth: 1, id: "ad" },
    ],
  },
  "bank-session": { frames: [{ depth: 0, id: "bank" }] },
};

describe("typing a one-time code over CDP", () => {
  it("types into the embedded frame that scores highest, and only there", async () => {
    const fixture = await fake({
      // 1 is the page, 2 the ad frame beside it, 3 the bank's own renderer.
      injections: {
        1: { ok: false },
        2: { ok: true, score: 20 },
        3: { ok: true, score: 80 },
      },
      sessions: bankInsideAds,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ inFrame: true, searched: 3, typed: true });
    expect(fixture.applied).toEqual([3]);
  });

  it("scores every frame before it types into any of them", async () => {
    const fixture = await fake({
      injections: {
        1: { ok: false },
        2: { ok: true, score: 20 },
        3: { ok: true, score: 80 },
      },
      sessions: bankInsideAds,
    });

    await typeOneTimeCodeOverCdp(fixture.url, code);

    // A page carrying a bank frame and three ad frames must not get the code
    // sprayed across all four: the scoring pass is what makes that impossible.
    const evaluations = fixture.calls.filter(
      (call) => call.method === "Runtime.evaluate"
    );
    const applying = evaluations.filter((call) =>
      String(call.params.expression).endsWith(", true)")
    );
    expect(applying).toHaveLength(1);
    expect(evaluations.at(-1)).toBe(applying[0]);
  });

  it("leaves the code to the cloud agent when only a weak frame offers a field", async () => {
    const fixture = await fake({
      // A focused input with no naming signal is what an unrelated widget looks
      // like, and a one-time code is not handed over on a guess.
      injections: { 1: { ok: false }, 2: { ok: true, score: 20 } },
      sessions: {
        "": {
          frames: [
            { depth: 0, id: "top" },
            { depth: 1, id: "widget" },
          ],
        },
      },
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ searched: 2, typed: false });
    expect(fixture.applied).toEqual([]);
  });

  it("keeps a tie in the page's own document", async () => {
    const fixture = await fake({
      injections: { 1: { ok: true, score: 80 }, 2: { ok: true, score: 80 } },
      sessions: {
        "": {
          frames: [
            { depth: 0, id: "top" },
            { depth: 1, id: "other" },
          ],
        },
      },
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry.inFrame).toBe(false);
    expect(fixture.applied).toEqual([1]);
  });

  it("reaches a frame that answers on its own session", async () => {
    const fixture = await fake({
      injections: {
        1: { ok: false },
        2: { ok: false },
        3: { ok: true, score: 80 },
      },
      sessions: bankInsideAds,
    });

    await typeOneTimeCodeOverCdp(fixture.url, code);

    // Flat auto-attach is what makes a cross-process frame addressable at all:
    // without it the bank's session is never opened and its field never seen.
    const attaching = fixture.calls.filter(
      (call) => call.method === "Target.setAutoAttach"
    );
    expect(attaching.every((call) => call.params.flatten === true)).toBe(true);
    expect(
      fixture.calls.some(
        (call) =>
          call.method === "Runtime.evaluate" &&
          call.sessionId === "bank-session"
      )
    ).toBe(true);
  });

  it("reports a one-character box that swallowed only the first digit", async () => {
    const fixture = await fake({
      injections: { 1: { ok: true, partial: true, score: 60 } },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ partial: true, typed: true });
  });

  it("puts a code from a site's letter only into that site's own frames", async () => {
    // The page is https://top.test/, its ad frame and the bank's are not.
    const fixture = await fake({
      injections: {
        1: { ok: true, score: 50 },
        2: { ok: true, score: 90 },
        3: { ok: true, score: 90 },
      },
      sessions: bankInsideAds,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code, {
      domain: "top.test",
    });

    expect(entry).toMatchObject({ inFrame: false, typed: true });
    expect(fixture.applied).toEqual([1]);
  });

  it("types a code from a site's letter nowhere when the page is another site", async () => {
    // A run that ended on a lookalike or a fallback site.
    const fixture = await fake({
      injections: { 1: { ok: true, score: 90 }, 2: { ok: true, score: 90 } },
      sessions: {
        "": {
          frames: [
            { depth: 0, id: "top" },
            { depth: 1, id: "ozon" },
          ],
        },
      },
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code, {
      domain: "ozon.test",
    });

    expect(entry.typed).toBe(false);
    expect(fixture.applied).toEqual([]);
    expect(
      fixture.calls.some((call) => call.method === "Runtime.evaluate")
    ).toBe(false);
  });

  it("does nothing at all for an empty code", async () => {
    const fixture = await fake({
      injections: { 1: { ok: true, score: 80 } },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, "   ");

    expect(entry.typed).toBe(false);
    expect(fixture.calls).toEqual([]);
  });
});

/** `count` one-character boxes, named box1… in order. */
function codeBoxes(count: number): FakeElementSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    attributes: { maxlength: "1", name: `box${String(index + 1)}` },
    tag: "input",
  }));
}

/** WB ID's code component: a whole-code field and five boxes that move the
 *  focus themselves, inside an open shadow root, its button beside them. */
const wbIdCodeField: FakeElementSpec = {
  shadow: [
    {
      attributes: {
        autocomplete: "one-time-code",
        maxlength: "6",
        name: "code",
      },
      tag: "input",
    },
    ...codeBoxes(5),
    { tag: "button", text: "Войти" },
  ],
  tag: "ui-field-code",
};

const onePage: CdpBrowserFixture["sessions"] = {
  "": { frames: [{ depth: 0, id: "top" }] },
};

describe("the code entry program on a page", () => {
  it("inserts the whole code into a one-time-code field inside a shadow root", async () => {
    const fixture = await fake({
      documents: {
        1: [{ tag: "button", text: "Оплатить" }, wbIdCodeField],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toEqual({
      inFrame: false,
      insertedText: true,
      partial: false,
      searched: 1,
      submitted: true,
      typed: true,
    });
    // One trusted insertion into the whole-code field, never the boxes one by
    // one: typed key by key they moved their own focus and scrambled the code.
    const [field, ...boxes] = fixture.page(1).fields;
    expect(field).toEqual({
      name: "code",
      value: code,
      writes: ["insertText"],
    });
    expect(boxes).toHaveLength(5);
    for (const box of boxes) expect(box.writes).toEqual([]);
    const inserted = fixture.calls.filter(
      (call) => call.method === "Input.insertText"
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.params.text).toBe(code);
    // The confirm button is found in the shadow root too; a pay button never.
    expect(fixture.page(1).clicked).toEqual(["Войти"]);
    expect(fixture.applied).toEqual([1]);
  });

  it("sends the insertion on the session of the frame that won", async () => {
    const fixture = await fake({
      documents: { 3: [wbIdCodeField] },
      injections: { 1: { ok: false }, 2: { ok: false } },
      sessions: bankInsideAds,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({
      inFrame: true,
      insertedText: true,
      typed: true,
    });
    const inserted = fixture.calls.find(
      (call) => call.method === "Input.insertText"
    );
    expect(inserted?.sessionId).toBe("bank-session");
    expect(fixture.page(3).fields[0]?.value).toBe(code);
  });

  it("still fills four to eight boxes one by one when no field takes the whole code", async () => {
    const fixture = await fake({
      documents: {
        1: [...codeBoxes(6), { tag: "button", text: "Подтвердить" }],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({
      insertedText: false,
      partial: false,
      submitted: true,
      typed: true,
    });
    expect(
      fixture
        .page(1)
        .fields.map((box) => box.value)
        .join("")
    ).toBe(code);
    for (const box of fixture.page(1).fields) {
      expect(box.writes).toEqual(["setter"]);
    }
    expect(
      fixture.calls.some((call) => call.method === "Input.insertText")
    ).toBe(false);
  });

  it("still sets the value of a field too short to take the code", async () => {
    const fixture = await fake({
      documents: {
        1: [{ attributes: { maxlength: "4", name: "otp" }, tag: "input" }],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ insertedText: false, typed: true });
    expect(fixture.page(1).fields).toEqual([
      { name: "otp", value: code, writes: ["setter"] },
    ]);
  });

  it("sets the value instead of inserting where the focus did not land", async () => {
    // An insertion goes wherever the focus is, not where it was asked to go.
    const fixture = await fake({
      documents: {
        1: [
          { attributes: { name: "search" }, focused: true, tag: "input" },
          { attributes: { name: "code" }, tag: "input", unfocusable: true },
        ],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ insertedText: false, typed: true });
    expect(fixture.page(1).fields).toEqual([
      { name: "search", value: "", writes: [] },
      { name: "code", value: code, writes: ["setter"] },
    ]);
    expect(
      fixture.calls.some((call) => call.method === "Input.insertText")
    ).toBe(false);
  });

  it("puts only the first digit into a lone one-character box and says so", async () => {
    const fixture = await fake({
      documents: {
        1: [{ attributes: { maxlength: "1", name: "code" }, tag: "input" }],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry).toMatchObject({ partial: true, typed: true });
    expect(fixture.page(1).fields).toEqual([
      { name: "code", value: "4", writes: ["setter"] },
    ]);
  });

  it("never fills a password field, in a shadow root or out of one", async () => {
    const password: FakeElementSpec = {
      attributes: {
        autocomplete: "one-time-code",
        name: "otp",
        type: "password",
      },
      focused: true,
      tag: "input",
    };
    const fixture = await fake({
      documents: {
        1: [password, { shadow: [password], tag: "ui-field-code" }],
      },
      injections: {},
      sessions: onePage,
    });

    const entry = await typeOneTimeCodeOverCdp(fixture.url, code);

    expect(entry.typed).toBe(false);
    for (const field of fixture.page(1).fields) {
      expect(field).toMatchObject({ value: "", writes: [] });
    }
    expect(fixture.applied).toEqual([]);
    expect(
      fixture.calls.some((call) => call.method === "Input.insertText")
    ).toBe(false);
  });
});

describe("photographing the viewport over CDP", () => {
  it("captures the page the finished run is showing as a JPEG", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fixture = await fake({
      injections: {},
      screenshot: jpeg.toString("base64"),
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const shot = await captureViewportOverCdp(fixture.url);

    expect(Buffer.from(shot)).toEqual(jpeg);
    const capture = fixture.calls.find(
      (call) => call.method === "Page.captureScreenshot"
    );
    expect(capture?.params.format).toBe("jpeg");
    expect(capture?.sessionId).toBeUndefined();
  });

  it("refuses a browser that answers with no image", async () => {
    const fixture = await fake({
      injections: {},
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    await expect(captureViewportOverCdp(fixture.url)).rejects.toThrow(
      "The browser returned no screenshot."
    );
  });
});

describe("reaching a browser VM's debugger", () => {
  it("looks the VM's private address up before the connect timeout starts", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fixture = await fake({
      injections: {},
      screenshot: jpeg.toString("base64"),
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });
    // 203.0.113.7 is unroutable here: only the private address answers.
    const listing = vi.fn<() => Promise<Map<string, string>>>(
      async () => new Map([["203.0.113.7", "127.0.0.1"]])
    );
    // The Compute API client, as private-route uses it.
    vi.doMock("@agent/lib/browser-vm/cloudru", () => ({
      listCloudRuPrivateAddresses: listing,
    }));
    onTestFinished(() => {
      clearBrowserVmSettings();
      vi.doUnmock("@agent/lib/browser-vm/cloudru");
      vi.restoreAllMocks();
      vi.resetModules();
    });
    const cdp = await importWithSettings(
      { CLOUDRU_PRIVATE_ROUTING: "on" },
      async () => import("@agent/lib/browser-use/cdp")
    );
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const { port } = new URL(fixture.url);

    // The debugger URL a browser VM hands out, on its sslip.io name.
    const shot = await cdp.captureViewportOverCdp(
      `ws://203-0-113-7.sslip.io:${port}`
    );

    expect(Buffer.from(shot)).toEqual(jpeg);
    // A Compute API listing must not eat the ten seconds to connect in.
    expect(listing).toHaveBeenCalledTimes(1);
    expect(listing.mock.invocationCallOrder[0]).toBeLessThan(
      timeouts.mock.invocationCallOrder[0] ?? 0
    );
  });
});

describe("visiting a signed-in page over CDP", () => {
  it("opens the page without its pictures and says where it ended up", async () => {
    const fixture = await fake({
      injections: {},
      page: { url: "https://www.ozon.ru/my/main" },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const page = await visitPageOverCdp(
      fixture.url,
      "https://www.ozon.ru/my/main",
      "ozon.ru"
    );

    expect(page).toEqual({
      leftPage: false,
      passwordField: false,
      url: "https://www.ozon.ru/my/main",
    });
    // The page itself is let through, and held until it is checked.
    expect(
      fixture.calls.find((call) => call.method === "Fetch.enable")
    ).toBeDefined();
    expect(
      fixture.calls
        .filter(
          (call) =>
            call.method.startsWith("Fetch.") && call.method !== "Fetch.enable"
        )
        .map((call) => [call.method, call.params.requestId])
    ).toEqual([["Fetch.continueRequest", "request-1"]]);
    const navigate = fixture.calls.find(
      (call) => call.method === "Page.navigate"
    );
    expect(navigate?.params.url).toBe("https://www.ozon.ru/my/main");
    // The managed proxy bills by the gigabyte; cookies do not ride on images.
    const blocked = fixture.calls.find(
      (call) => call.method === "Network.setBlockedURLs"
    );
    expect(blocked?.params.urls).toEqual(expect.arrayContaining(["*.jpg"]));
    // Nothing is typed and nothing is pressed.
    expect(fixture.applied).toEqual([]);
  }, 15_000);

  it("reports a sign-in form the page turned into", async () => {
    const fixture = await fake({
      injections: {},
      page: { password: true, url: "https://id.yandex.ru/" },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    await expect(
      visitPageOverCdp(fixture.url, "https://id.yandex.ru/", "yandex.ru")
    ).resolves.toEqual({
      leftPage: false,
      passwordField: true,
      url: "https://id.yandex.ru/",
    });
  }, 15_000);

  it("blocks the page from going anywhere but the recorded one, and says so", async () => {
    const fixture = await fake({
      injections: {},
      page: {
        requests: [
          // A redirect to another site's sign-in, with the profile's cookies.
          { url: "https://passport.example/auth?retpath=ozon" },
          // A page of the same site that acts when it is opened.
          { url: "https://www.ozon.ru/logout" },
          // The site's own frame loads; a stranger's does not.
          { frame: "widget", url: "https://pay.ozon.ru/widget" },
          { frame: "widget", url: "https://ads.example/frame" },
        ],
        url: "https://www.ozon.ru/my/main",
      },
      sessions: {
        "": {
          frames: [
            { depth: 0, id: "top" },
            { depth: 1, id: "widget" },
          ],
        },
      },
    });

    const page = await visitPageOverCdp(
      fixture.url,
      "https://www.ozon.ru/my/main",
      "ozon.ru"
    );

    expect(page.leftPage).toBe(true);
    expect(
      fixture.calls
        .filter(
          (call) =>
            call.method.startsWith("Fetch.") && call.method !== "Fetch.enable"
        )
        .map((call) => [
          call.method,
          call.params.requestId,
          call.params.errorReason,
        ])
    ).toEqual([
      ["Fetch.continueRequest", "request-1", undefined],
      ["Fetch.failRequest", "request-2", "BlockedByClient"],
      ["Fetch.failRequest", "request-3", "BlockedByClient"],
      ["Fetch.continueRequest", "request-4", undefined],
      ["Fetch.failRequest", "request-5", "BlockedByClient"],
    ]);
  }, 15_000);
});

describe("calling a function in a page over CDP", () => {
  const argument = { query: "'); alert(1); ('" };

  it("hands the function its argument as data and returns what it answered", async () => {
    const fixture = await fake({
      injections: {},
      page: { answer: { status: "ok" }, url: "https://id.yandex.ru/" },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const called = await callInPageOverCdp(fixture.url, {
      argument,
      fn: "async function (args) { return args; }",
      loaded: "interactive",
      runOn: () => true,
      url: "https://id.yandex.ru/",
    });

    expect(called).toEqual({
      ran: true,
      url: "https://id.yandex.ru/",
      value: { status: "ok" },
    });
    const call = fixture.calls.find(
      (item) => item.method === "Runtime.callFunctionOn"
    );
    expect(call?.params).toMatchObject({
      arguments: [{ value: argument }],
      awaitPromise: true,
      functionDeclaration: "async function (args) { return args; }",
      objectId: "global-1",
      returnByValue: true,
    });
    // The argument is never part of any source that is evaluated.
    expect(
      fixture.calls
        .filter((item) => item.method === "Runtime.evaluate")
        .every((item) => !item.params.expression?.includes("alert"))
    ).toBe(true);
    const blocked = fixture.calls.find(
      (item) => item.method === "Network.setBlockedURLs"
    );
    expect(blocked?.params.urls).toEqual(expect.arrayContaining(["*.jpg"]));
  }, 15_000);

  it("runs nothing in a page it was not meant to land on", async () => {
    const fixture = await fake({
      injections: {},
      page: { answer: { status: "ok" }, url: "https://evil.example/" },
      sessions: { "": { frames: [{ depth: 0, id: "top" }] } },
    });

    const called = await callInPageOverCdp(fixture.url, {
      argument: {},
      fn: "async function () { return 1; }",
      loaded: "complete",
      runOn: (url) => url.startsWith("https://id.yandex.ru/"),
      url: "https://id.yandex.ru/",
    });

    expect(called).toEqual({ ran: false, url: "https://evil.example/" });
    expect(
      fixture.calls.some((item) => item.method === "Runtime.callFunctionOn")
    ).toBe(false);
  }, 15_000);
});
