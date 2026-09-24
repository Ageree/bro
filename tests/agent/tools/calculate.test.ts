import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";
import calculateTools, { calculate } from "@agent/tools/calculate";

const principal = {
  attributes: { workspaceId: "personal:workspace" },
  authenticator: "photon-imessage",
  principalId: "user-1",
  principalType: "user",
};

const toolContext = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  async getSandbox() {
    throw new Error("The calculator uses no sandbox.");
  },
  getSkill() {
    throw new Error("The calculator uses no skill.");
  },
  async getToken() {
    throw new Error("The calculator uses no token.");
  },
  requireAuth() {
    throw new Error("The calculator needs no authorization.");
  },
  session: {
    auth: { current: principal, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
  toolName: "calculate",
} satisfies ToolContext;

function resolveContext(authenticator: string, scheduledRunKind?: string) {
  const current = { ...principal, authenticator };
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current,
        initiator: scheduledRunKind
          ? {
              ...current,
              attributes: { ...current.attributes, scheduledRunKind },
            }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

async function run(...lines: string[]) {
  const result = await calculate.execute({ lines }, toolContext);
  if (Symbol.asyncIterator in result) {
    throw new Error("calculate returns one result, not a stream.");
  }
  return result.results;
}

/** One line's result with every field readable; a missing one is undefined. */
async function value(expression: string) {
  const [result] = await run(expression);
  if (!result) throw new Error("calculate returns one result per line.");
  return { error: undefined, exact: undefined, value: undefined, ...result };
}

describe("calculate", () => {
  it("adds money exactly where floating point drifts", async () => {
    expect(await value("0.1 + 0.2")).toEqual({
      exact: true,
      expression: "0.1 + 0.2",
      value: "0.3",
    });
    expect((await value("1234.56 * 3 - 0.68")).value).toBe("3703");
  });

  it("splits a bill with a tip and rounds each share to kopecks", async () => {
    const results = await run(
      "total = 8450 + 12%",
      "share = total / 3",
      "round(share, 2)"
    );
    expect(results).toEqual([
      { exact: true, expression: "total = 8450 + 12%", value: "9464" },
      {
        exact: false,
        expression: "share = total / 3",
        value: "3154.6666666667",
      },
      { exact: true, expression: "round(share, 2)", value: "3154.67" },
    ]);
  });

  it("reads percentages as a calculator does", async () => {
    expect((await value("15%")).value).toBe("0.15");
    expect((await value("1200 * 15%")).value).toBe("180");
    expect((await value("1200 + 15%")).value).toBe("1380");
    expect((await value("1200 - 15%")).value).toBe("1020");
    expect((await value("(120000 + 30000) * 13%")).value).toBe("19500");
  });

  it("converts currency with a given rate and keeps thousands groups", async () => {
    expect((await value("4 500 × 0.0108")).value).toBe("48.6");
    expect((await value("250 000 / 96.35")).exact).toBe(false);
    expect((await value("round(250 000 / 96.35, 2)")).value).toBe("2594.71");
  });

  it("rounds halves away from zero and floors or ceils on request", async () => {
    expect((await value("round(2.5)")).value).toBe("3");
    expect((await value("round(-2.5)")).value).toBe("-3");
    expect((await value("round(1.005, 2)")).value).toBe("1.01");
    expect((await value("round(1234, -2)")).value).toBe("1200");
    expect((await value("floor(-1.21, 1)")).value).toBe("-1.3");
    expect((await value("ceil(1.21, 1)")).value).toBe("1.3");
  });

  it("follows operator precedence and powers", async () => {
    expect((await value("2 + 3 * 4")).value).toBe("14");
    expect((await value("-2^2")).value).toBe("-4");
    expect((await value("2^3^2")).value).toBe("512");
    expect((await value("2^-2")).value).toBe("0.25");
    expect((await value("10000 * (1 + 16%/12)^12")).exact).toBe(false);
    expect((await value("sum(1, 2, 3.5) + max(1, 7) - min(4, -1)")).value).toBe(
      "14.5"
    );
    expect(await value("sqrt(2)")).toMatchObject({
      exact: false,
      value: "1.4142135624",
    });
  });

  it("takes roots of numbers a double cannot hold instead of returning 0", async () => {
    const results = await run(
      "x = sqrt(1e-400)",
      "x * 1e200",
      "sqrt(9e400) / 1e200",
      "pow(8e-390, 1/3) * 1e130"
    );
    expect(
      results.slice(1).map((result) => ("value" in result ? result.value : ""))
    ).toEqual(["1", "3", "2"]);
    expect((await value("sqrt((1e-400)^2)")).error).toBe(
      "The result is too small to compute."
    );
    expect((await value("pow(2, 1e-400)")).error).toBe(
      "The number is too small for this function."
    );
  });

  it("reports a failing line and still computes the others", async () => {
    const results = await run("1 / 0", "2 + 2", "x * 2");
    expect(results).toEqual([
      { error: "Division by zero.", expression: "1 / 0" },
      { exact: true, expression: "2 + 2", value: "4" },
      { error: "Unknown name «x».", expression: "x * 2" },
    ]);
  });

  it("asks for a dot rather than guessing a decimal comma", async () => {
    expect(await value("12,5 * 2")).toMatchObject({ error: "Unexpected «,»." });
  });
});

describe("calculate refuses anything but arithmetic", () => {
  it.each([
    "process.exit(1)",
    "constructor",
    "__proto__",
    "toString()",
    "globalThis",
    "this.constructor.constructor('return process')()",
    "require('fs')",
    "`${1}`",
    "1; 2",
    "a => a",
    "[1, 2]",
    "eval('1')",
    "Function('return 1')()",
  ])("rejects %s", async (expression) => {
    expect((await value(expression)).error).toBeTypeOf("string");
  });

  it("cannot shadow a function or reach Object's prototype by name", async () => {
    const results = await run("round = 5", "hasOwnProperty = 1", "valueOf");
    expect(results[0]?.error).toBeTypeOf("string");
    expect(results[1]).toMatchObject({ exact: true, value: "1" });
    expect(results[2]?.error).toBeTypeOf("string");
  });

  it("refuses numbers too large to compute instead of hanging", async () => {
    for (const expression of [
      "10^100000",
      "9^9^9",
      "pow(2, 5000)",
      "1e100000",
      "(10^400)^10",
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each case is a separate refusal.
      expect((await value(expression)).error).toBeTypeOf("string");
    }
  });

  it("refuses expressions nested or chained past its limits", async () => {
    const nested = `${"(".repeat(100)}1${")".repeat(100)}`;
    expect((await value(nested)).error).toBe(
      "The expression is nested too deeply."
    );
    const chained = Array.from({ length: 250 }, () => "1").join("+");
    expect((await value(chained)).error).toBe("The expression is too long.");
  });
});

describe("calculate availability", () => {
  it("is offered in conversations and user-set tasks, not Bro's own checks", async () => {
    const resolve = calculateTools.events["turn.started"];
    if (!resolve) throw new Error("calculate resolves per turn.");
    const names = async (authenticator: string, kind?: string) =>
      Object.keys(
        (await resolve({}, resolveContext(authenticator, kind))) ?? {}
      );

    expect(await names("photon-imessage")).toEqual(["calculate"]);
    expect(await names("scheduled-worker")).toEqual(["calculate"]);
    expect(await names("scheduled-worker", "proactive")).toEqual([]);
  });
});
