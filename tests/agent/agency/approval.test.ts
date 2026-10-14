import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agency = vi.hoisted(() => ({
  agencyActionRecorded:
    vi.fn<(workspaceId: string, hash: string) => Promise<boolean>>(),
  agencyBudgetUsage:
    vi.fn<(workspaceId: string, since: Date) => Promise<Map<string, number>>>(),
}));
/** The home details of the profile the approval reads. */
interface ProfileStub {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly phone: string | null;
}
const profile = vi.hoisted(() => ({
  readUserProfile: vi.fn<() => Promise<ProfileStub>>(),
  readWorkspaceTimeZone: vi.fn<() => Promise<string>>(),
}));

vi.mock("@db/services/agency", () => agency);
vi.mock("@db/services/user-profile", () => profile);

const worker = {
  attributes: { scheduledRunKind: "agentic", workspaceId: "workspace-1" },
  authenticator: "scheduled-worker",
  principalId: "user-1",
  principalType: "user" as const,
};

/** The worker's session, its own caller being the scheduled worker. */
function workerContext(
  current: Partial<typeof worker & { authenticator: string }> = {}
) {
  return {
    session: {
      auth: {
        current: { ...worker, ...current },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
  };
}

/** A turn a person started in the web chat. */
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

const email = {
  counterparty: "anna@example.com",
  input: JSON.stringify({ subject: "Встреча", to: ["anna@example.com"] }),
  text: "Встреча\nПривет, Анна.",
  tool: "gmail-send",
};

/** The pilot is read from the environment when the approval module loads. */
async function approvals(pilot = "workspace-1") {
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", pilot);
  return import("@agent/lib/agency/approval");
}

/** A moment on the person's clock in Moscow (UTC+3). */
const night = new Date("2026-10-12T21:30:00.000Z"); // 00:30
const day = new Date("2026-10-12T09:00:00.000Z"); // 12:00

beforeEach(() => {
  agency.agencyActionRecorded.mockResolvedValue(false);
  agency.agencyBudgetUsage.mockResolvedValue(new Map());
  profile.readWorkspaceTimeZone.mockResolvedValue("Europe/Moscow");
  profile.readUserProfile.mockResolvedValue({
    addressLine1: null,
    addressLine2: null,
    phone: null,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(day);
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("AGENCY_WORKSPACES", "");
  vi.clearAllMocks();
});

describe("the agentic worker's approval", () => {
  it("is not the agentic worker's to decide outside its turn, so the caller falls back", async () => {
    const { agencyApproval } = await approvals();
    expect(await agencyApproval(personContext, "send", () => email)).toBeNull();
    // A proactive check of the same workspace is not the agentic worker.
    expect(
      await agencyApproval(
        {
          session: {
            ...workerContext({
              attributes: {
                ...worker.attributes,
                scheduledRunKind: "proactive",
              },
            }).session,
          },
        },
        "send",
        () => email
      )
    ).toBeNull();
  });

  it("leaves a workspace outside the pilot to the proactive check", async () => {
    const { agencyApproval } = await approvals("workspace-2");
    expect(
      await agencyApproval(workerContext(), "send", () => email)
    ).toBeNull();
  });

  it("denies a background task's turn, whoever opened it", async () => {
    const { agencyApproval } = await approvals();
    // The background task speaks for the worker that started it.
    const delegated = {
      session: {
        auth: {
          current: { ...worker, authenticator: "background-task" },
          initiator: worker,
        },
        id: "session-3",
        turn: { id: "turn-3", sequence: 0 },
      },
    };
    const background = await agencyApproval(delegated, "send", () => email);
    expect(background).toMatchObject({ type: "denied" });
    expect(agency.agencyBudgetUsage).not.toHaveBeenCalled();
  });

  it("grants an action the worker may take in the day's budget, without a card", async () => {
    const { agencyApproval } = await approvals();
    expect(await agencyApproval(workerContext(), "send", () => email)).toBe(
      "not-applicable"
    );
    expect(agency.agencyBudgetUsage).toHaveBeenCalledWith(
      "workspace-1",
      new Date(day.getTime() - 24 * 60 * 60 * 1000)
    );
  });

  it("denies a send or a call in the person's quiet hours, and grants a calendar change then", async () => {
    const { agencyApproval } = await approvals();
    vi.setSystemTime(night);
    expect(
      await agencyApproval(workerContext(), "send", () => email)
    ).toMatchObject({ type: "denied" });
    expect(
      await agencyApproval(workerContext(), "call", () => ({
        input: "{}",
        tool: "phone-call",
      }))
    ).toMatchObject({ type: "denied" });
    expect(
      await agencyApproval(workerContext(), "calendar", () => ({
        input: "{}",
        tool: "calendar-delete-event",
      }))
    ).toBe("not-applicable");
  });

  it("reads the quiet hours on the person's own clock", async () => {
    const { agencyApproval } = await approvals();
    // 21:30 UTC is 00:30 in Moscow, but 14:30 in Los Angeles: the person's zone decides.
    vi.setSystemTime(night);
    profile.readWorkspaceTimeZone.mockResolvedValue("America/Los_Angeles");
    expect(await agencyApproval(workerContext(), "send", () => email)).toBe(
      "not-applicable"
    );
  });

  it("denies a class whose day is used up, and every action once the day's total is", async () => {
    const { agencyApproval } = await approvals();
    agency.agencyBudgetUsage.mockResolvedValue(new Map([["send", 8]]));
    expect(
      await agencyApproval(workerContext(), "send", () => email)
    ).toMatchObject({ type: "denied" });
    expect(
      await agencyApproval(workerContext(), "calendar", () => ({
        input: "{}",
        tool: "calendar-update-event",
      }))
    ).toBe("not-applicable");

    agency.agencyBudgetUsage.mockResolvedValue(
      new Map([
        ["send", 5],
        ["calendar", 5],
        ["call", 3],
        ["submit", 2],
      ])
    );
    expect(
      await agencyApproval(workerContext(), "calendar", () => ({
        input: "{}",
        tool: "calendar-update-event",
      }))
    ).toMatchObject({ type: "denied" });
  });

  it("denies an action the journal already holds, by its input hash in this workspace", async () => {
    const { agencyApproval } = await approvals();
    agency.agencyActionRecorded.mockResolvedValue(true);
    expect(
      await agencyApproval(workerContext(), "send", () => email)
    ).toMatchObject({ type: "denied" });
    expect(agency.agencyActionRecorded).toHaveBeenCalledWith(
      "workspace-1",
      expect.stringMatching(/^[0-9a-f]{64}$/u)
    );
  });

  it("denies text that gives out the person's home address, unless their goal names it", async () => {
    const { agencyApproval } = await approvals();
    profile.readUserProfile.mockResolvedValue({
      addressLine1: "ул. Ленина, 5",
      addressLine2: null,
      phone: null,
    });
    const letter = {
      ...email,
      text: "Приезжайте на ул. Ленина, 5, к двери.",
    };
    expect(
      await agencyApproval(workerContext(), "send", () => letter)
    ).toMatchObject({ type: "denied" });
    expect(
      await agencyApproval(workerContext(), "send", () => ({
        ...letter,
        goal: "Пригласи мастера по адресу ул. Ленина, 5",
      }))
    ).toBe("not-applicable");
  });

  it("denies text that gives out the person's phone number", async () => {
    const { agencyApproval } = await approvals();
    profile.readUserProfile.mockResolvedValue({
      addressLine1: null,
      addressLine2: null,
      phone: "+7 (900) 123-45-67",
    });
    expect(
      await agencyApproval(workerContext(), "send", () => ({
        ...email,
        text: "Мой номер 8 900 123 45 67, перезвоните.",
      }))
    ).toMatchObject({ type: "denied" });
  });
});
