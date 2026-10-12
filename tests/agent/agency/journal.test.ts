import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The reversing call a done row keeps, as the journal stores it. */
type UndoStub = {
  readonly input: Readonly<Record<string, string>>;
  readonly tool: string;
} | null;

const agency = vi.hoisted(() => ({
  beginAgencyAction:
    vi.fn<
      (input: {
        readonly inputHash: string;
      }) => Promise<
        | { readonly id: string; readonly kind: "started" }
        | { readonly kind: "duplicate" }
      >
    >(),
  finishAgencyAction:
    vi.fn<
      (
        id: string,
        status: "done" | "failed",
        undo?: UndoStub
      ) => Promise<boolean>
    >(),
}));

vi.mock("@db/services/agency", () => agency);

const worker = {
  attributes: { scheduledRunKind: "agentic", workspaceId: "workspace-1" },
  authenticator: "scheduled-worker",
  principalId: "user-1",
  principalType: "user" as const,
};

const workerContext = {
  session: {
    auth: { current: worker, initiator: null },
    id: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  },
};

const personContext = {
  session: {
    auth: {
      current: {
        attributes: { workspaceId: "workspace-1" },
        authenticator: "authjs",
        principalId: "user-1",
        principalType: "user" as const,
      },
      initiator: null,
    },
    id: "session-2",
    turn: { id: "turn-2", sequence: 0 },
  },
};

const call = {
  actionClass: "send" as const,
  counterparty: "anna@example.com",
  input: JSON.stringify({ subject: "Встреча", to: ["anna@example.com"] }),
  tool: "gmail-send",
};

/** The pilot is read from the environment when the modules load. */
async function journal() {
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", "workspace-1");
  return import("@agent/lib/agency/journal");
}

beforeEach(() => {
  vi.clearAllMocks();
  agency.beginAgencyAction.mockResolvedValue({ id: "row-1", kind: "started" });
  agency.finishAgencyAction.mockResolvedValue(true);
});

afterEach(() => {
  vi.stubEnv("AGENCY_WORKSPACES", "");
});

describe("the input hash of an action", () => {
  it("is the same for one input whatever the order of its keys, and differs for another input or tool", async () => {
    const { agencyInputHash } = await journal();
    const hash = agencyInputHash(
      "gmail-send",
      JSON.stringify({ a: 1, nested: { x: [{ d: 1, c: 2 }], y: "z" } })
    );
    expect(
      agencyInputHash(
        "gmail-send",
        JSON.stringify({ nested: { y: "z", x: [{ c: 2, d: 1 }] }, a: 1 })
      )
    ).toBe(hash);
    expect(
      agencyInputHash(
        "gmail-send",
        JSON.stringify({ a: 2, nested: { x: [{ d: 1, c: 2 }], y: "z" } })
      )
    ).not.toBe(hash);
    expect(
      agencyInputHash(
        "mail-send",
        JSON.stringify({ a: 1, nested: { x: [{ d: 1, c: 2 }], y: "z" } })
      )
    ).not.toBe(hash);
  });
});

describe("a call of the agentic worker through the journal", () => {
  it("runs any other turn's call as it is, journaling nothing", async () => {
    const { journaledAgencyCall } = await journal();
    const run = vi.fn<() => Promise<string>>(() => Promise.resolve("sent"));
    expect(await journaledAgencyCall(personContext, call, run)).toBe("sent");
    expect(run).toHaveBeenCalledOnce();
    expect(agency.beginAgencyAction).not.toHaveBeenCalled();
  });

  it("plans the action before its call, and settles it done with its undo", async () => {
    const { journaledAgencyCall } = await journal();
    const undo = { input: { eventId: "e1" }, tool: "calendar-delete-event" };
    const order: string[] = [];
    agency.beginAgencyAction.mockImplementation(() => {
      order.push("begin");
      return Promise.resolve({ id: "row-1", kind: "started" });
    });
    const result = await journaledAgencyCall(
      workerContext,
      { ...call, actionClass: "calendar", tool: "calendar-create-event" },
      () => {
        order.push("call");
        return Promise.resolve({ id: "e1" });
      },
      () => undo
    );

    expect(result).toEqual({ id: "e1" });
    expect(order).toEqual(["begin", "call"]);
    expect(agency.beginAgencyAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionClass: "calendar",
        counterparty: "anna@example.com",
        runId: "session-1",
        summary: "calendar-create-event: anna@example.com",
        tool: "calendar-create-event",
        undo: null,
        workspaceId: "workspace-1",
      })
    );
    expect(agency.finishAgencyAction).toHaveBeenCalledWith(
      "row-1",
      "done",
      undo
    );
  });

  it("settles an action that throws as failed, and rethrows its error", async () => {
    const { journaledAgencyCall } = await journal();
    await expect(
      journaledAgencyCall(workerContext, call, () =>
        Promise.reject(new Error("SMTP refused"))
      )
    ).rejects.toThrow("SMTP refused");
    expect(agency.finishAgencyAction).toHaveBeenCalledWith("row-1", "failed");
  });

  it("refuses a repeat of an action without calling it again", async () => {
    const { journaledAgencyCall } = await journal();
    agency.beginAgencyAction.mockResolvedValue({ kind: "duplicate" });
    const run = vi.fn<() => Promise<string>>(() => Promise.resolve("sent"));
    await expect(journaledAgencyCall(workerContext, call, run)).rejects.toThrow(
      "already taken in an earlier run"
    );
    expect(run).not.toHaveBeenCalled();
    expect(agency.finishAgencyAction).not.toHaveBeenCalled();
  });
});
