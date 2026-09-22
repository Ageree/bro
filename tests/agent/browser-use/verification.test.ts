import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const findBrowserUseSessionCdpUrl = vi.hoisted(() =>
  vi.fn<
    (sessionId: string, signal?: AbortSignal) => Promise<string | undefined>
  >()
);

const cdpCommandSchema = z.object({ id: z.number().int(), method: z.string() });

vi.mock("@agent/lib/browser-use/client", () => ({
  findBrowserUseSessionCdpUrl,
}));

import { verifyBrowserRun } from "@agent/lib/browser-use/verification";
import type { BrowserVerificationPlan } from "@shared/browser/verification";

const sessionId = "22222222-2222-4222-8222-222222222222";
const pageUrl = "https://shop.test/confirmation";

const plan = {
  checks: [
    {
      description: "The chosen offer is present",
      groupId: "offer",
      id: "title",
      mandatory: true,
      predicate: {
        caseSensitive: false,
        expected: "Blue mug",
        kind: "text_exact",
      },
    },
    {
      description: "The offer stays under budget",
      groupId: "offer",
      id: "price",
      mandatory: true,
      predicate: {
        currency: "USD",
        decimalSeparator: ".",
        kind: "number",
        maximum: 20,
      },
    },
  ],
  version: 1,
} satisfies BrowserVerificationPlan;

function result(checks = evidence()) {
  return `RESULT: done\nNEEDS: none\nCHECKS: ${JSON.stringify({ version: 1, checks })}`;
}

function evidence() {
  return [
    {
      checkId: "title",
      pageUrl,
      scopeSelector: '[data-offer-id="42"]',
      selector: ".title",
    },
    {
      checkId: "price",
      pageUrl,
      scopeSelector: '[data-offer-id="42"]',
      selector: ".price",
    },
  ];
}

class FakeSocket extends EventTarget {
  static closed = 0;
  static constructed = 0;
  static hangOnRuntime = false;
  static observations: unknown[] = [];
  static pageUrl = pageUrl;
  readonly url: string;

  constructor(url: string | URL) {
    super();
    FakeSocket.constructed += 1;
    this.url = String(url);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  close() {
    FakeSocket.closed += 1;
  }

  send(value: string) {
    const command = cdpCommandSchema.parse(JSON.parse(value));
    if (command.method === "Runtime.evaluate" && FakeSocket.hangOnRuntime)
      return;
    const replyResult =
      command.method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "top-frame" } } }
        : command.method === "Page.createIsolatedWorld"
          ? { executionContextId: 7 }
          : {
              result: {
                value: {
                  observations: FakeSocket.observations,
                  pageUrl: FakeSocket.pageUrl,
                },
              },
            };
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: command.id,
            result: replyResult,
          }),
        })
      )
    );
  }
}

beforeEach(() => {
  findBrowserUseSessionCdpUrl.mockResolvedValue("https://debug.test/browser");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json([
          {
            type: "page",
            url: FakeSocket.pageUrl,
            webSocketDebuggerUrl: "wss://debug.test/page/1",
          },
        ])
      )
    )
  );
  FakeSocket.observations = [
    {
      broadScope: false,
      candidateId: 1,
      checkId: "title",
      matchCount: 1,
      scopeCount: 1,
      sensitive: false,
      text: "Blue mug",
      truncated: false,
      visible: true,
    },
    {
      broadScope: false,
      candidateId: 1,
      checkId: "price",
      matchCount: 1,
      scopeCount: 1,
      sensitive: false,
      text: "$19.99",
      truncated: false,
      visible: true,
    },
  ];
  FakeSocket.closed = 0;
  FakeSocket.constructed = 0;
  FakeSocket.hangOnRuntime = false;
  FakeSocket.pageUrl = pageUrl;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("browser verification", () => {
  it("distinguishes a missing CHECKS packet from a malformed one", async () => {
    const missing = await verifyBrowserRun({
      plan,
      result: "RESULT: done\nNEEDS: none",
      sessionId,
    });
    const malformed = await verifyBrowserRun({
      plan,
      result: "RESULT: done\nNEEDS: none\nCHECKS: not-json",
      sessionId,
    });

    expect(missing.defects[0]?.code).toBe("missing_evidence");
    expect(malformed.defects[0]?.code).toBe("invalid_evidence");
  });

  it("verifies declared predicates from one fresh scoped DOM read", async () => {
    const report = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    expect(report.verdict).toBe("verified");
    expect(report.observedChecks).toEqual([
      expect.objectContaining({
        checkId: "title",
        observation: "Blue mug",
        pageUrl,
        status: "passed",
      }),
      expect.objectContaining({
        checkId: "price",
        pageUrl,
        status: "passed",
        value: 19.99,
      }),
    ]);
    expect(report.observedChecks[0]?.observedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u
    );
    expect(findBrowserUseSessionCdpUrl).toHaveBeenCalledWith(
      sessionId,
      expect.any(AbortSignal)
    );
  });

  it("keeps a concrete predicate mismatch separate from unknown", async () => {
    FakeSocket.observations = [
      FakeSocket.observations[0],
      {
        broadScope: false,
        candidateId: 1,
        checkId: "price",
        matchCount: 1,
        scopeCount: 1,
        sensitive: false,
        text: "$29.99",
        truncated: false,
        visible: true,
      },
    ];

    const report = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    expect(report.verdict).toBe("failed");
    expect(report.defects).toContainEqual(
      expect.objectContaining({ checkId: "price", code: "acceptance_failed" })
    );
  });

  it("classifies zero matches as missing and multiple matches as ambiguous", async () => {
    const unresolvedTitle = {
      broadScope: false,
      candidateId: null,
      checkId: "title",
      matchCount: 0,
      scopeCount: 1,
      sensitive: false,
      text: "",
      truncated: false,
      visible: false,
    };
    FakeSocket.observations = [unresolvedTitle, FakeSocket.observations[1]];
    const missing = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    FakeSocket.observations = [
      {
        broadScope: false,
        candidateId: null,
        checkId: "title",
        matchCount: 2,
        scopeCount: 1,
        sensitive: false,
        text: "",
        truncated: false,
        visible: false,
      },
      FakeSocket.observations[1],
    ];
    const ambiguous = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    expect(missing.defects).toContainEqual(
      expect.objectContaining({ checkId: "title", code: "missing_evidence" })
    );
    expect(missing.defects.some(({ code }) => code === "group_mismatch")).toBe(
      false
    );
    expect(ambiguous.defects).toContainEqual(
      expect.objectContaining({ checkId: "title", code: "ambiguous_match" })
    );
  });

  it("keeps resolved candidate conflicts when an optional group member is missing", async () => {
    const conflictPlan = {
      checks: [
        {
          description: "Required title",
          groupId: "offer",
          id: "title",
          mandatory: true,
          predicate: {
            caseSensitive: false,
            expected: "Blue mug",
            kind: "text_exact" as const,
          },
        },
        {
          description: "Required price",
          groupId: "offer",
          id: "price",
          mandatory: true,
          predicate: {
            currency: "USD" as const,
            decimalSeparator: "." as const,
            kind: "number" as const,
            maximum: 20,
          },
        },
        {
          description: "Optional terms",
          groupId: "offer",
          id: "terms",
          mandatory: false,
          predicate: {
            caseSensitive: false,
            expected: "Free delivery",
            kind: "text_contains" as const,
          },
        },
      ],
      version: 1 as const,
    };
    FakeSocket.observations = [
      {
        broadScope: false,
        candidateId: 1,
        checkId: "title",
        matchCount: 1,
        scopeCount: 1,
        sensitive: false,
        text: "Blue mug",
        truncated: false,
        visible: true,
      },
      {
        broadScope: false,
        candidateId: 2,
        checkId: "price",
        matchCount: 1,
        scopeCount: 1,
        sensitive: false,
        text: "$19.99",
        truncated: false,
        visible: true,
      },
      {
        broadScope: false,
        candidateId: null,
        checkId: "terms",
        matchCount: 0,
        scopeCount: 1,
        sensitive: false,
        text: "",
        truncated: false,
        visible: false,
      },
    ];
    const locators = [
      {
        checkId: "title",
        pageUrl,
        scopeSelector: "#offers",
        selector: ".title",
      },
      {
        checkId: "price",
        pageUrl,
        scopeSelector: "#offers",
        selector: ".price",
      },
      {
        checkId: "terms",
        pageUrl,
        scopeSelector: "#offers",
        selector: ".missing-terms",
      },
    ];

    const report = await verifyBrowserRun({
      plan: conflictPlan,
      result: result(locators),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects).toContainEqual(
      expect.objectContaining({ code: "group_mismatch" })
    );
  });

  it("rejects missing, duplicate, broad and cross-container evidence before CDP", async () => {
    const [title, price] = evidence();
    if (!title || !price) throw new Error("The fixture is incomplete.");
    const bad = [title, { ...title }, { ...price, scopeSelector: "body" }];

    const report = await verifyBrowserRun({
      plan,
      result: result(bad),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "duplicate_evidence",
        "invalid_evidence",
        "group_mismatch",
      ])
    );
    expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
  });

  it("rejects evidence spanning more than four existing pages before CDP", async () => {
    const checks = Array.from({ length: 5 }, (_, index) => ({
      description: `Page ${String(index)}`,
      id: `page-${String(index)}`,
      mandatory: true,
      predicate: {
        caseSensitive: false,
        expected: "ready",
        kind: "text_exact" as const,
      },
    }));
    const locators = checks.map(({ id }, index) => ({
      checkId: id,
      pageUrl: `https://shop.test/page-${String(index)}`,
      scopeSelector: "#result",
      selector: ".status",
    }));

    const report = await verifyBrowserRun({
      plan: { checks, version: 1 },
      result: result(locators),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects).toContainEqual(
      expect.objectContaining({ code: "invalid_evidence" })
    );
    expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
  });

  it("allows an omitted optional grouped check", async () => {
    const groupedPlan = {
      checks: [
        {
          description: "Required title",
          groupId: "offer",
          id: "title",
          mandatory: true,
          predicate: {
            caseSensitive: false,
            expected: "Blue mug",
            kind: "text_exact" as const,
          },
        },
        {
          description: "Optional subtitle",
          groupId: "offer",
          id: "subtitle",
          mandatory: false,
          predicate: {
            caseSensitive: false,
            expected: "Ceramic",
            kind: "text_contains" as const,
          },
        },
      ],
      version: 1 as const,
    };
    FakeSocket.observations = [FakeSocket.observations[0]];
    const titleEvidence = evidence()[0];
    if (!titleEvidence) throw new Error("The fixture is incomplete.");

    const report = await verifyBrowserRun({
      plan: groupedPlan,
      result: result([titleEvidence]),
      sessionId,
    });

    expect(report.verdict).toBe("verified");
    expect(report.defects).toEqual([]);
  });

  it("rejects ambiguous prices instead of choosing the first number", async () => {
    FakeSocket.observations[1] = {
      broadScope: false,
      candidateId: 1,
      checkId: "price",
      matchCount: 1,
      scopeCount: 1,
      sensitive: false,
      text: "Was $24.99, now $19.99",
      truncated: false,
      visible: true,
    };

    const report = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects).toContainEqual(
      expect.objectContaining({ checkId: "price", code: "invalid_evidence" })
    );
  });

  it("applies one hard deadline across discovery and websocket connect", async () => {
    class NeverOpeningSocket extends EventTarget {
      close() {
        this.dispatchEvent(new Event("close"));
      }
      send() {
        this.dispatchEvent(new Event("message"));
      }
    }
    vi.stubGlobal("WebSocket", NeverOpeningSocket);
    const started = performance.now();

    const report = await verifyBrowserRun({
      deadlineMs: 50,
      plan,
      result: result(),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects[0]?.code).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(300);
  });

  it("rejects a page that navigated after target discovery", async () => {
    FakeSocket.pageUrl = "https://shop.test/other";

    const report = await verifyBrowserRun({
      plan,
      result: result(),
      sessionId,
    });

    expect(report.verdict).toBe("unverified");
    expect(report.defects[0]?.code).toBe("page_missing");
  });

  it("strips signed and credential query data from observed page URLs", async () => {
    const signedUrl = `${pageUrl}?product=42&authToken=secret&X-Amz-Signature=signed&X-Amz-Credential=credential`;
    FakeSocket.pageUrl = signedUrl;
    const signedEvidence = evidence().map((locator) => ({
      checkId: locator.checkId,
      pageUrl: signedUrl,
      scopeSelector: locator.scopeSelector,
      selector: locator.selector,
    }));

    const report = await verifyBrowserRun({
      plan,
      result: result(signedEvidence),
      sessionId,
    });

    expect(report.verdict).toBe("verified");
    expect(report.observedChecks[0]?.pageUrl).toBe(pageUrl);
    expect(JSON.stringify(report)).not.toMatch(/secret|signed|credential/iu);
  });

  it("aborts between isolated-world setup and evaluation and closes the socket", async () => {
    FakeSocket.hangOnRuntime = true;

    const report = await verifyBrowserRun({
      deadlineMs: 50,
      plan,
      result: result(),
      sessionId,
    });

    expect(report.defects[0]?.code).toBe("timeout");
    expect(report.elapsedMs).toBeLessThan(300);
    expect(FakeSocket.closed).toBe(1);
  });

  it("does not enter a later phase with an already-aborted deadline", async () => {
    findBrowserUseSessionCdpUrl.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve("https://debug.test/browser");
          }, 60)
        )
    );

    const report = await verifyBrowserRun({
      deadlineMs: 50,
      plan,
      result: result(),
      sessionId,
    });

    expect(report.defects[0]?.code).toBe("timeout");
    expect(report.elapsedMs).toBeLessThan(300);
    expect(FakeSocket.constructed).toBe(0);
  });
});
