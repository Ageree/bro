import { afterEach, describe, expect, it } from "vitest";
import {
  captureViewportOverCdp,
  typeOneTimeCodeOverCdp,
} from "@agent/lib/browser-use/cdp";
import {
  startFakeCdpBrowser,
  type CdpBrowserFixture,
  type FakeCdpBrowser,
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
