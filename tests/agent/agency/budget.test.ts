import { describe, expect, it } from "vitest";
import { budgetRefusal } from "@agent/lib/agency/budget";

describe("the day's budget of the agentic worker", () => {
  it("has room for each class while the day's counts are below its limits", () => {
    const usage = new Map([
      ["send", 6],
      ["calendar", 4],
      ["call", 2],
      ["submit", 2],
    ]);
    expect(budgetRefusal(usage, "send")).toBeUndefined();
    expect(budgetRefusal(usage, "calendar")).toBeUndefined();
    expect(budgetRefusal(usage, "call")).toBeUndefined();
    expect(budgetRefusal(usage, "submit")).toBeUndefined();
  });

  it("refuses the class at its limit, and only that class while the total has room", () => {
    const usage = new Map([["send", 8]]);
    expect(budgetRefusal(usage, "send")).toMatch(/limit of send actions/u);
    expect(budgetRefusal(usage, "calendar")).toBeUndefined();
  });

  it("refuses every class once the day's total of 15 is reached", () => {
    const usage = new Map([
      ["send", 5],
      ["calendar", 5],
      ["call", 3],
      ["submit", 2],
    ]);
    expect(budgetRefusal(usage, "calendar")).toMatch(
      /actions taken on its own/u
    );
    expect(budgetRefusal(usage, "submit")).toMatch(/actions taken on its own/u);
  });

  it("grants no 'other' action at all, since none is authorized", () => {
    expect(budgetRefusal(new Map(), "other")).toMatch(
      /limit of other actions/u
    );
  });
});
