import { describe, expect, it } from "vitest";
import { nudgeText } from "@agent/lib/capability-nudge/send";

describe("capability nudge", () => {
  it("is one plain sentence about one thing, with no buttons to press", () => {
    const text = nudgeText("напомнить о деле в нужный момент");
    expect(text).toBe(
      "Давно не болтали. Кстати, я могу напомнить о деле в нужный момент. Напиши, что нужно, — займусь."
    );
  });
});
