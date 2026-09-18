import { describe, expect, it } from "vitest";
import {
  browserQuotaNote,
  browserRunAllowance,
  localDayKey,
  localMonthKey,
  messageAllowance,
  messagePaywallText,
  withinAllowance,
} from "@agent/lib/billing/limits";

// 23:30 UTC on the last day of September is already October in Vladivostok and
// still September in Moscow: the two zones disagree about both keys at once.
const lateSeptember = new Date("2026-09-30T23:30:00.000Z");

describe("usage limits", () => {
  it("keys a period on the workspace's own calendar", () => {
    expect(localDayKey(lateSeptember, "Europe/Moscow")).toBe("2026-10-01");
    expect(localMonthKey(lateSeptember, "Europe/Moscow")).toBe("2026-10");
    expect(localDayKey(lateSeptember, "Asia/Vladivostok")).toBe("2026-10-01");
    expect(localDayKey(lateSeptember, "America/New_York")).toBe("2026-09-30");
    expect(localMonthKey(lateSeptember, "America/New_York")).toBe("2026-09");
  });

  it("separates the free and paid allowances", () => {
    expect(messageAllowance(false)).toBe(30);
    expect(messageAllowance(true)).toBe(500);
    expect(browserRunAllowance(false)).toBe(5);
    expect(browserRunAllowance(true)).toBe(60);
  });

  it("delivers the whole allowance and turns away the one after it", () => {
    expect(withinAllowance(30, 30)).toBe(true);
    expect(withinAllowance(31, 30)).toBe(false);
    expect(withinAllowance(1, 5)).toBe(true);
  });

  it("offers the pay link only when there is one", () => {
    const payUrl = "https://bro.example/api/pay";

    expect(messagePaywallText(payUrl)).toContain(payUrl);
    expect(messagePaywallText(payUrl)).toContain("2000 ₽/мес");
    expect(messagePaywallText(undefined)).not.toContain("http");
    expect(browserQuotaNote(payUrl)).toContain(payUrl);
    expect(browserQuotaNote(undefined)).not.toContain("http");
  });
});
