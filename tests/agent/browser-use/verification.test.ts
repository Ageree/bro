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

  it.each(["LINKS: []", "NEXT: none\nSTATUS: complete\nLINKS: []"])(
    "bounds the CHECKS packet before following protocol fields: %s",
    async (following) => {
      const report = await verifyBrowserRun({
        plan,
        result: `${result()}\n${following}`,
        sessionId,
      });

      expect(report.verdict).toBe("verified");
      expect(report.observedChecks).toHaveLength(plan.checks.length);
    }
  );

  it("preserves multiline CHECKS JSON before a decorated LINKS field", async () => {
    const report = await verifyBrowserRun({
      plan,
      result: `RESULT: done\nNEEDS: none\n**CHECKS:**\n${JSON.stringify({ version: 1, checks: evidence() }, null, 2)}\n- **LINKS:** []`,
      sessionId,
    });

    expect(report.verdict).toBe("verified");
    expect(report.observedChecks).toHaveLength(plan.checks.length);
  });

  it.each([
    "CHECKS: not-json\nLINKS: []",
    `${result()}\nLINKS: []\n${result()}`,
  ])(
    "rejects an invalid CHECKS block even with valid LINKS: %s",
    async (packet) => {
      const report = await verifyBrowserRun({
        plan,
        result: packet,
        sessionId,
      });

      expect(report.verdict).toBe("unverified");
      expect(report.defects[0]?.code).toBe("invalid_evidence");
      expect(findBrowserUseSessionCdpUrl).not.toHaveBeenCalled();
    }
  );

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

  it.each([
    ["16 October 2026", null, { expected: "2026-10-16", kind: "date" }],
    ["16 октября 2026 г.", null, { expected: "2026-10-16", kind: "date" }],
    ["октября 16 2026", null, { expected: "2026-10-16", kind: "date" }],
    ["October 16", null, { expected: "--10-16", kind: "date" }],
    ["15 октября", null, { expected: "--10-15", kind: "date" }],
    [
      "Published 2025-06-12",
      null,
      {
        kind: "date",
        maximum: "2025-12-31",
        minimum: "2025-01-01",
      },
    ],
    [
      "Published yesterday",
      "2026-09-22 15:13:35 UTC",
      { expected: "2026-09-22", kind: "date" },
    ],
    [
      "Two adults",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "две персоны",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "ru",
      },
    ],
    [
      "Итого 1 234,56 ₽",
      null,
      {
        currency: "RUB",
        decimalSeparator: ",",
        kind: "number",
        maximum: 1234.56,
        minimum: 1234.56,
      },
    ],
    [
      "Total $1,234.56",
      null,
      {
        currency: "USD",
        decimalSeparator: ".",
        kind: "number",
        maximum: 1234.56,
        minimum: 1234.56,
      },
    ],
  ] as const)(
    "verifies deterministic date and number formats: %s",
    async (text, machineDate, predicate) => {
      const checkPlan = {
        checks: [
          {
            description: "Format evidence",
            id: "format",
            mandatory: true,
            predicate,
          },
        ],
        version: 1,
      } satisfies BrowserVerificationPlan;
      FakeSocket.observations = [
        {
          broadScope: false,
          candidateId: 1,
          checkId: "format",
          machineDate,
          matchCount: 1,
          scopeCount: 1,
          sensitive: false,
          text,
          truncated: false,
          visible: true,
        },
      ];

      const report = await verifyBrowserRun({
        plan: checkPlan,
        result: result([
          {
            checkId: "format",
            pageUrl,
            scopeSelector: "#result",
            selector: ".format",
          },
        ]),
        sessionId,
      });

      expect(report.verdict).toBe("verified");
    }
  );

  it.each([
    ["10/11/2026", null, { expected: "2026-10-11", kind: "date" }],
    ["31 February 2026", null, { expected: "2026-02-28", kind: "date" }],
    ["16 October", null, { expected: "2026-10-16", kind: "date" }],
    ["16 October 2026", "2026-10-17", { expected: "2026-10-16", kind: "date" }],
    [
      "16 October 2026 and 17 October 2026",
      null,
      { expected: "2026-10-16", kind: "date" },
    ],
    [
      "16 October 2025 and 16 October 2026",
      null,
      { expected: "--10-16", kind: "date" },
    ],
    [
      "Tomorrow",
      "2026-10-16Tgarbage",
      { expected: "2026-10-16", kind: "date" },
    ],
    [
      "Tomorrow",
      "2026-10-16 25:13:35 UTC",
      { expected: "2026-10-16", kind: "date" },
    ],
    [
      "Tomorrow",
      "2026-10-16 15:13:35 UTC later",
      { expected: "2026-10-16", kind: "date" },
    ],
    [
      "Two adults, one room",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "2 or two",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "Twenty thousand guests",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 20,
        minimum: 20,
        numberWords: "en",
      },
    ],
    [
      "one hundred items",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 1,
        minimum: 1,
        numberWords: "en",
      },
    ],
    [
      "one and a half portions",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 1,
        minimum: 1,
        numberWords: "en",
      },
    ],
    [
      "двадцать тысяч гостей",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 20,
        minimum: 20,
        numberWords: "ru",
      },
    ],
    [
      "одна с половиной порции",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 1,
        minimum: 1,
        numberWords: "ru",
      },
    ],
    [
      "thirty two adults",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "fifty-two adults",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "two dozen items",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "en",
      },
    ],
    [
      "минус два",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "ru",
      },
    ],
    [
      "две сотни",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
        numberWords: "ru",
      },
    ],
    [
      "2k",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
      },
    ],
    [
      "1 2",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 12,
        minimum: 12,
      },
    ],
    [
      ".5",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 5,
        minimum: 5,
      },
    ],
    [
      "2½",
      null,
      {
        decimalSeparator: ".",
        kind: "number",
        maximum: 2,
        minimum: 2,
      },
    ],
  ] as const)(
    "fails closed for ambiguous or incomplete scalar evidence: %s",
    async (text, machineDate, predicate) => {
      const checkPlan = {
        checks: [
          {
            description: "Ambiguous evidence",
            id: "format",
            mandatory: true,
            predicate,
          },
        ],
        version: 1,
      } satisfies BrowserVerificationPlan;
      FakeSocket.observations = [
        {
          broadScope: false,
          candidateId: 1,
          checkId: "format",
          machineDate,
          matchCount: 1,
          scopeCount: 1,
          sensitive: false,
          text,
          truncated: false,
          visible: true,
        },
      ];

      const report = await verifyBrowserRun({
        plan: checkPlan,
        result: result([
          {
            checkId: "format",
            pageUrl,
            scopeSelector: "#result",
            selector: ".format",
          },
        ]),
        sessionId,
      });

      expect(report.verdict).toBe("unverified");
      expect(report.defects[0]?.code).toBe("invalid_evidence");
    }
  );

  it("preserves a Unicode minus sign in the canonical numeric value", async () => {
    const signedPlan = {
      checks: [
        {
          description: "Signed percentage",
          id: "percentage",
          mandatory: true,
          predicate: {
            decimalSeparator: ".",
            kind: "number" as const,
            maximum: -0.18,
            minimum: -0.18,
          },
        },
      ],
      version: 1 as const,
    } satisfies BrowserVerificationPlan;
    FakeSocket.observations = [
      {
        broadScope: false,
        candidateId: 1,
        checkId: "percentage",
        matchCount: 1,
        scopeCount: 1,
        sensitive: false,
        text: "−0.18%",
        truncated: false,
        visible: true,
      },
    ];

    const report = await verifyBrowserRun({
      plan: signedPlan,
      result: result([
        {
          checkId: "percentage",
          pageUrl,
          scopeSelector: "#result",
          selector: ".percentage",
        },
      ]),
      sessionId,
    });

    expect(report.verdict).toBe("verified");
    expect(report.observedChecks[0]?.value).toBe(-0.18);
  });

  it("captures only safe canonical link values", async () => {
    const linkPlan = {
      checks: [
        {
          description: "Download URL",
          id: "download",
          mandatory: true,
          predicate: {
            expected: "https://downloads.test/releases/app.zip",
            kind: "link" as const,
          },
        },
      ],
      version: 1 as const,
    };
    const observe = (href: string) => {
      FakeSocket.observations = [
        {
          broadScope: false,
          candidateId: 1,
          checkId: "download",
          href,
          matchCount: 1,
          scopeCount: 1,
          sensitive: false,
          text: "app.zip",
          truncated: false,
          visible: true,
        },
      ];
      return verifyBrowserRun({
        plan: linkPlan,
        result: result([
          {
            checkId: "download",
            pageUrl,
            scopeSelector: "#result",
            selector: ".download",
          },
        ]),
        sessionId,
      });
    };

    const safe = await observe("https://downloads.test/releases/app.zip");
    const unsafe = await observe(
      "https://downloads.test/releases/app.zip?access_token=secret"
    );
    const nestedUnsafe = await observe(
      "https://example.com/?url=https%3A%2F%2Fother.example%2F%3Faccess_token%3Dnested-secret"
    );
    const fragmentUnsafe = await observe(
      "https://example.com/#url=https%3A%2F%2Fother.example%2F%3Faccess_token%3Dfragment-secret"
    );

    expect(safe.verdict).toBe("verified");
    expect(safe.observedChecks[0]).toEqual(
      expect.objectContaining({
        observation: "app.zip",
        value: "https://downloads.test/releases/app.zip",
      })
    );
    expect(unsafe.verdict).toBe("unverified");
    expect(nestedUnsafe.verdict).toBe("unverified");
    expect(fragmentUnsafe.verdict).toBe("unverified");
    expect(
      JSON.stringify([unsafe, nestedUnsafe, fragmentUnsafe])
    ).not.toContain("secret");
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
