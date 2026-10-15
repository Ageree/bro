import { beforeEach, describe, expect, it, vi } from "vitest";

const alertOwner = vi.hoisted(() =>
  vi.fn<(key: string, text: string) => Promise<boolean>>()
);

vi.mock("@agent/lib/owner-alert", () => ({ alertOwner }));

import { routerDecision } from "@agent/lib/tool-router/decision";

beforeEach(() => {
  alertOwner.mockReset();
  alertOwner.mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function answer(model: string, answers: Readonly<Record<string, number>>) {
  return {
    answers: new Map(Object.entries(answers)),
    model,
    ms: 90,
    provider: "typesafe" as const,
  };
}

describe("the router's decision", () => {
  it("reads the thresholds of the model the answer names", () => {
    const answers = { browser: 0.2, mail: 0.45, places: 0.41 };
    const direct = routerDecision(answer("jev-1.14.0", answers));
    const fallback = routerDecision(
      answer("typesafe/jev-1.13-20260917", answers)
    );
    // browser 0.3 and mail 0.5 for 1.14; 0.15 and 0.4 for 1.13.
    expect("groups" in direct && direct.groups).toEqual(["places"]);
    expect("groups" in fallback && fallback.groups).toEqual([
      "browser",
      "places",
      "mail",
    ]);
  });

  it("counts a question left unanswered as no", () => {
    const decision = routerDecision(answer("jev-1.14.0", { phone: 0.9 }));
    expect("groups" in decision && decision.groups).toEqual(["phone"]);
  });

  it("fails on a model without thresholds, and tells the owner", () => {
    const decision = routerDecision(answer("jev-1.15.0", { phone: 0.9 }));
    expect(decision).toEqual({
      failure: "uncalibrated",
      model: "jev-1.15.0",
      ms: 90,
    });
    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0]?.[0]).toBe("tool-router:uncalibrated");
  });

  it("passes a failure on", () => {
    expect(routerDecision({ failure: "timeout", ms: 1500 })).toEqual({
      failure: "timeout",
      ms: 1500,
    });
  });
});
