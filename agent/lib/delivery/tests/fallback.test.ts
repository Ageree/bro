import { describe, expect, it } from "vitest";
import { fallbackDeliveryText } from "@agent/lib/delivery/fallback";

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
