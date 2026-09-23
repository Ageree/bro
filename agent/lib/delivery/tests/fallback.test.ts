import { describe, expect, it } from "vitest";
import {
  fallbackDeliveryText,
  replyLanguageFor,
  turnFailureNotice,
} from "@agent/lib/delivery/fallback";

describe("fallbackDeliveryText", () => {
  it("delivers text the model wrote instead of calling send_message", () => {
    expect(fallbackDeliveryText("  не могу, это против правил\n")).toBe(
      "не могу, это против правил"
    );
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "DELIVERY_COMPLETE",
    " DELIVERY_COMPLETE\n",
  ])("delivers nothing for %j", (message) => {
    expect(fallbackDeliveryText(message)).toBeUndefined();
  });

  it("drops a delivery marker appended to real text", () => {
    expect(fallbackDeliveryText("уточни дату\n\nDELIVERY_COMPLETE")).toBe(
      "уточни дату"
    );
  });
});

describe("turn failure notice", () => {
  it.each([402, 429, 500, 503])(
    "says Bro is resting when the provider answered %i",
    (statusCode) => {
      expect(
        turnFailureNotice(
          { code: "MODEL_CALL_FAILED", details: { statusCode } },
          "ru"
        )
      ).toBe("я прилёг, скоро вернусь");
    }
  );

  it("reads the upstream status a gateway passed along", () => {
    expect(
      turnFailureNotice(
        {
          code: "MODEL_CALL_FAILED",
          details: { statusCode: 400, upstreamStatusCode: 402 },
        },
        "en"
      )
    ).toBe("taking a quick nap, back soon");
  });

  it.each([
    { code: "MODEL_CALL_FAILED", details: { statusCode: 400 } },
    { code: "MODEL_CALL_FAILED" },
    { code: "TOOL_FAILED", details: { statusCode: 503 } },
  ])("apologizes when the provider is not down: %o", (failure) => {
    expect(turnFailureNotice(failure, "ru")).toContain("Что-то сломалось");
  });

  it("answers in English only to text with no Cyrillic at all", () => {
    expect(replyLanguageFor("where is my order?")).toBe("en");
    expect(replyLanguageFor("где мой order?")).toBe("ru");
    expect(replyLanguageFor("👍")).toBe("ru");
    expect(replyLanguageFor(undefined)).toBe("ru");
  });
});
