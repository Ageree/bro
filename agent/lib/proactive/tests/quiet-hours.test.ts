import { describe, expect, it } from "vitest";
import { quietHoursEnd } from "@agent/lib/proactive/quiet-hours";

describe("proactive quiet hours", () => {
  it("lets daytime and early-evening checks through", () => {
    // 21:59 in Moscow (UTC+3).
    expect(
      quietHoursEnd(new Date("2026-09-23T18:59:30.000Z"), "Europe/Moscow")
    ).toBeUndefined();
    // 08:00 in Moscow.
    expect(
      quietHoursEnd(new Date("2026-09-23T05:00:00.000Z"), "Europe/Moscow")
    ).toBeUndefined();
  });

  it("holds a late-evening check until 08:00 the next local morning", () => {
    // 23:30 in Moscow.
    expect(
      quietHoursEnd(new Date("2026-09-23T20:30:10.000Z"), "Europe/Moscow")
    ).toEqual(new Date("2026-09-24T05:00:00.000Z"));
  });

  it("holds a check after midnight until 08:00 the same local morning", () => {
    // 03:15 in New York (UTC-4 in September).
    expect(
      quietHoursEnd(new Date("2026-09-23T07:15:00.000Z"), "America/New_York")
    ).toEqual(new Date("2026-09-23T12:00:00.000Z"));
  });

  it("still ends at 08:00 local on a night the clocks change", () => {
    // 23:30 EDT before the fall-back; 08:00 EST is 13:00 UTC.
    expect(
      quietHoursEnd(new Date("2026-11-01T03:30:00.000Z"), "America/New_York")
    ).toEqual(new Date("2026-11-01T13:00:00.000Z"));
    // 23:30 EST before the spring-forward; 08:00 EDT is 12:00 UTC.
    expect(
      quietHoursEnd(new Date("2026-03-08T04:30:00.000Z"), "America/New_York")
    ).toEqual(new Date("2026-03-08T12:00:00.000Z"));
  });

  it("reads the hour in the person's zone, not the server's", () => {
    const now = new Date("2026-09-23T20:30:00.000Z");
    expect(quietHoursEnd(now, "Europe/Moscow")).toBeDefined();
    // 13:30 in Los Angeles.
    expect(quietHoursEnd(now, "America/Los_Angeles")).toBeUndefined();
  });
});
