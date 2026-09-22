import { describe, expect, it } from "vitest";
import {
  browserVerificationPlanSchema,
  browserVerificationProofSchema,
} from "@shared/browser/verification";

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
});
