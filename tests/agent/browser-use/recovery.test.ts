import { describe, expect, it } from "vitest";
import {
  maximumRecoveries,
  nextRecovery,
  recoverableErrand,
  recoveryRetryAt,
  recoveryTask,
} from "@agent/lib/browser-use/recovery";

const base = {
  action: undefined,
  attempt: 0,
  canStart: true,
  interrupted: false,
  needs: "none",
  phase: null,
} as const;

describe("what a settled run of a recoverable errand leads to", () => {
  it("checks the site first when a run broke off", () => {
    expect(nextRecovery({ ...base, interrupted: true })).toEqual({
      attempt: 1,
      kind: "retry",
      phase: "verify",
    });
  });

  it("checks again when the check or the finish broke off, up to the cap", () => {
    expect(
      nextRecovery({
        ...base,
        attempt: 1,
        interrupted: true,
        phase: "continue",
      })
    ).toEqual({ attempt: 2, kind: "retry", phase: "verify" });
    expect(maximumRecoveries).toBe(2);
    expect(
      nextRecovery({
        ...base,
        attempt: 2,
        interrupted: true,
        phase: "verify",
      })
    ).toEqual({ kind: "exhausted" });
  });

  it("is exhausted when no background run can start, however few checks were used", () => {
    expect(
      nextRecovery({ ...base, canStart: false, interrupted: true })
    ).toEqual({ kind: "exhausted" });
  });

  it("closes on done, finishes on not_done, and asks the person otherwise", () => {
    const check = { ...base, attempt: 1, phase: "verify" } as const;

    expect(nextRecovery({ ...check, action: "done" })).toEqual({
      kind: "verified",
    });
    expect(nextRecovery({ ...check, action: "not_done" })).toEqual({
      attempt: 1,
      kind: "retry",
      phase: "continue",
    });
    expect(nextRecovery({ ...check, action: "unknown" })).toEqual({
      kind: "unclear",
    });
    expect(nextRecovery(check)).toEqual({ kind: "unclear" });
  });

  it("never finishes the errand when no run can start for it", () => {
    expect(
      nextRecovery({
        ...base,
        action: "not_done",
        attempt: 1,
        canStart: false,
        phase: "verify",
      })
    ).toEqual({ kind: "unclear" });
  });

  it("leaves a check that stopped for a code to the usual report", () => {
    expect(
      nextRecovery({
        ...base,
        action: "not_done",
        attempt: 1,
        needs: "sms_code",
        phase: "verify",
      })
    ).toEqual({ kind: "none" });
  });

  it("takes no verdict from a run that is not a check", () => {
    expect(nextRecovery({ ...base, action: "done" })).toEqual({ kind: "none" });
    expect(
      nextRecovery({ ...base, action: "not_done", phase: "continue" })
    ).toEqual({ kind: "none" });
  });
});

describe("which errands recover by themselves", () => {
  it("takes the ones that carry the person's permission to act", () => {
    expect(recoverableErrand({ paymentAllowed: true, submission: null })).toBe(
      true
    );
    expect(
      recoverableErrand({ paymentAllowed: false, submission: { what: "x" } })
    ).toBe(true);
    expect(recoverableErrand({ paymentAllowed: false, submission: null })).toBe(
      false
    );
  });
});

describe("the recovery schedule", () => {
  it("backs the checks off and finishes at once", () => {
    const now = new Date("2026-10-14T12:00:00.000Z");
    const minutes = (at: Date) => (at.getTime() - now.getTime()) / 60_000;

    expect(minutes(recoveryRetryAt("verify", 1, now))).toBe(1);
    expect(minutes(recoveryRetryAt("verify", 2, now))).toBe(3);
    expect(minutes(recoveryRetryAt("continue", 1, now))).toBe(0);
  });
});

describe("the recovery instruction", () => {
  const options = { attempt: 1, onVm: true, reference: "(ref 2)" } as const;

  it("makes the check read-only and asks for a verdict line", () => {
    const task = recoveryTask("Добавь продукт", {
      ...options,
      phase: "verify",
    });

    expect(task.startsWith("Добавь продукт\n\n[Recovery")).toBe(true);
    expect(task).toContain("READ-ONLY");
    expect(task).toContain("Do not press any submit, order, book, pay");
    expect(task).toContain("ACTION: done");
    expect(task).toContain("ACTION: not_done");
    expect(task).toContain("ACTION: unknown");
    expect(task).toContain("When in doubt, write unknown");
    expect(task.endsWith("\n\n(ref 2)")).toBe(true);
  });

  it("finishes the errand once, after one last look", () => {
    const task = recoveryTask("Добавь продукт", {
      ...options,
      phase: "continue",
    });

    expect(task).toContain("nothing of this errand was created");
    expect(task).toContain("do not do it again");
    expect(task).not.toContain("READ-ONLY");
  });

  it("replaces an earlier note, whether recovery or anti-bot", () => {
    const first = recoveryTask("Добавь продукт", {
      ...options,
      phase: "verify",
    });
    const second = recoveryTask(first, {
      ...options,
      attempt: 2,
      phase: "continue",
      reference: "(ref 3)",
    });
    const afterWall = recoveryTask(
      "Добавь продукт\n\n[Retry after an anti-bot check] old\n\n(ref 1)",
      { ...options, phase: "verify" }
    );

    expect(second.match(/\[Recovery after/gu)).toHaveLength(1);
    expect(second).not.toContain("(ref 2)");
    expect(second).not.toContain("READ-ONLY");
    expect(afterWall).not.toContain("anti-bot");
    expect(afterWall).not.toContain("(ref 1)");
  });
});
