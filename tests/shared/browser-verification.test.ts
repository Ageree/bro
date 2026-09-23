import { describe, expect, it } from "vitest";
import {
  browserVerificationPlanSchema,
  browserVerificationProofSchema,
  browserVerificationSafeUrlSchema,
} from "@shared/browser/verification";

interface PredicateFixture {
  readonly caseSensitive?: boolean;
  readonly decimalSeparator?: "." | ",";
  readonly expected?: string;
  readonly kind: string;
  readonly maximum?: number | string;
  readonly minimum?: number | string;
}

function acceptsPredicate(
  predicate: PredicateFixture,
  purpose?: "identity" | "order_reference"
) {
  return browserVerificationPlanSchema.safeParse({
    checks: [
      {
        description: "Verification evidence",
        id: "evidence",
        mandatory: true,
        predicate,
        purpose,
      },
    ],
    version: 1,
  }).success;
}

describe("browser verification contracts", () => {
  it("bounds plans and rejects duplicate stable ids", () => {
    const check = {
      description: "Confirmation is visible",
      id: "confirmation",
      predicate: {
        caseSensitive: false,
        expected: "Confirmed",
        kind: "text_contains",
      },
    } as const;
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [check, check],
        version: 1,
      }).success
    ).toBe(false);
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [{ ...check, mandatory: false }],
        version: 1,
      }).success
    ).toBe(false);
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: Array.from({ length: 17 }, (_, index) => ({
          ...check,
          id: `check-${String(index)}`,
        })),
        version: 1,
      }).success
    ).toBe(false);
  });

  it("accepts only locator evidence, never scripts or arbitrary predicates", () => {
    expect(
      browserVerificationProofSchema.safeParse({
        checks: [
          {
            checkId: "confirmation",
            javascript: "document.body.innerText",
            pageUrl: "https://shop.test/done",
            scopeSelector: "#order-42",
            selector: ".status",
          },
        ],
        version: 1,
      }).success
    ).toBe(false);
  });

  it("requires explicit order purposes to use compatible predicates", () => {
    const base = {
      description: "Order evidence",
      id: "order-evidence",
      mandatory: true,
    } as const;
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [
          {
            ...base,
            predicate: {
              caseSensitive: true,
              expected: "ABC",
              kind: "text_contains",
            },
            purpose: "order_reference",
          },
          {
            ...base,
            id: "order-total",
            predicate: {
              currency: "RUB",
              decimalSeparator: ".",
              kind: "number",
              minimum: 100,
            },
            purpose: "order_total",
          },
        ],
        version: 1,
      }).success
    ).toBe(true);
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [
          {
            ...base,
            predicate: {
              currency: "USD",
              decimalSeparator: ".",
              kind: "number",
              minimum: 100,
            },
            purpose: "order_total",
          },
        ],
        version: 1,
      }).success
    ).toBe(false);
    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [
          {
            ...base,
            predicate: {
              caseSensitive: true,
              expected: "ABC",
              kind: "text_absent",
            },
            purpose: "order_reference",
          },
        ],
        version: 1,
      }).success
    ).toBe(false);
  });

  it("accepts exact, partial, and bounded date predicates only in valid combinations", () => {
    expect(acceptsPredicate({ expected: "2026-10-16", kind: "date" })).toBe(
      true
    );
    expect(acceptsPredicate({ expected: "--10-16", kind: "date" })).toBe(true);
    expect(acceptsPredicate({ expected: "0001-01-01", kind: "date" })).toBe(
      true
    );
    expect(acceptsPredicate({ expected: "0099-12-31", kind: "date" })).toBe(
      true
    );
    expect(
      acceptsPredicate({
        kind: "date",
        maximum: "2025-12-31",
        minimum: "2025-01-01",
      })
    ).toBe(true);
    expect(acceptsPredicate({ expected: "2025-02-29", kind: "date" })).toBe(
      false
    );
    expect(acceptsPredicate({ expected: "--02-30", kind: "date" })).toBe(false);
    expect(acceptsPredicate({ kind: "date" })).toBe(false);
    expect(
      acceptsPredicate({
        expected: "--10-16",
        kind: "date",
        minimum: "2025-01-01",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        kind: "date",
        maximum: "2025-01-01",
        minimum: "2025-12-31",
      })
    ).toBe(false);
  });

  it("allows identity only for positive text predicates", () => {
    expect(
      acceptsPredicate(
        { caseSensitive: false, expected: "SKU-1", kind: "text_exact" },
        "identity"
      )
    ).toBe(true);
    expect(acceptsPredicate({ kind: "text_present" }, "identity")).toBe(true);
    expect(
      acceptsPredicate(
        { decimalSeparator: ".", kind: "number", minimum: 1 },
        "identity"
      )
    ).toBe(false);
    expect(
      acceptsPredicate(
        { caseSensitive: false, expected: "old", kind: "text_absent" },
        "identity"
      )
    ).toBe(false);

    expect(
      browserVerificationPlanSchema.safeParse({
        checks: [
          {
            description: "Order reference",
            id: "reference",
            mandatory: true,
            predicate: { kind: "text_present" },
            purpose: "order_reference",
          },
        ],
        version: 1,
      }).success
    ).toBe(false);
  });

  it("accepts safe capture or expected link predicates only", () => {
    expect(acceptsPredicate({ kind: "link" })).toBe(true);
    expect(
      acceptsPredicate({
        expected: "https://downloads.test/releases/app.zip#checksums",
        kind: "link",
      })
    ).toBe(true);
    expect(
      acceptsPredicate({
        expected: "HTTPS://EXAMPLE.COM/files",
        kind: "link",
      })
    ).toBe(true);
    expect(
      browserVerificationSafeUrlSchema.parse("HTTPS://EXAMPLE.COM/files")
    ).toBe("https://example.com/files");
    expect(
      acceptsPredicate({
        expected:
          "https://example.com/?url=https%3A%2F%2Fother.example%2Fdocs%3Fpage%3D1%23section",
        kind: "link",
      })
    ).toBe(true);
    expect(
      acceptsPredicate({ expected: "/releases/app.zip", kind: "link" })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected: "https://user:secret@downloads.test/app.zip",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected: "https://downloads.test/app.zip?access_token=secret",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected: "https://downloads.test/app.zip#access_token=secret",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected:
          "https://example.com/?url=https%3A%2F%2Fother.example%2F%3Faccess_token%3Dtest-secret",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected:
          "https://example.com/#url=https%3A%2F%2Fother.example%2F%3Faccess_token%3Dtest-secret",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({
        expected:
          "https://example.com/?url=https%2525253A%2525252F%2525252Fother.example",
        kind: "link",
      })
    ).toBe(false);
    expect(
      acceptsPredicate({ expected: "javascript:alert(1)", kind: "link" })
    ).toBe(false);
  });
});
