import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as browserRunsService from "@db/services/browser-runs";
import type { browserTaskApproval } from "@agent/tools/browser_task";
import type { AccessScope } from "@shared/identity/access-scope";
import { toolContext } from "@tests/helpers/tool-context";

type BrowserInput = NonNullable<Parameters<typeof browserTaskApproval>[0]>;

const agency = vi.hoisted(() => ({
  agencyActionRecorded:
    vi.fn<(workspaceId: string, hash: string) => Promise<boolean>>(),
  agencyBudgetUsage:
    vi.fn<(workspaceId: string, since: Date) => Promise<Map<string, number>>>(),
}));
const profile = vi.hoisted(() => ({
  readUserProfile: vi.fn<
    () => Promise<{
      addressLine1: string | null;
      addressLine2: string | null;
      phone: string | null;
    }>
  >(),
  readWorkspaceTimeZone: vi.fn<() => Promise<string>>(),
}));
const runs = vi.hoisted(() => ({
  readLatestBrowserRunForScope:
    vi.fn<
      (
        scope: AccessScope,
        id: string
      ) => Promise<ReturnType<typeof workerRow> | undefined>
    >(),
}));

vi.mock("@db/services/agency", () => agency);
vi.mock("@db/services/user-profile", () => profile);
vi.mock("@db/services/browser-runs", async (importOriginal) => ({
  ...(await importOriginal<typeof browserRunsService>()),
  readLatestBrowserRunForScope: runs.readLatestBrowserRunForScope,
}));

const runId = "00000000-0000-4000-8000-000000000001";
const workspaceId = "workspace-1";

/** A free booking, named exactly: what the agentic worker may start. */
const freeBooking = {
  chargeRub: 0,
  forWhom: "Алиса",
  kind: "appointment" as const,
  personalData: ["имя", "телефон"],
  what: "запись к терапевту",
  when: "вторник 20.10, 09:40",
  where: "поликлиника №12",
};

/** The worker's own turn: its scheduled run, in the pilot, with a session of its own. */
function workerContext(callId = "call-1") {
  const base = toolContext("browser_task");
  return {
    ...base,
    callId,
    session: {
      ...base.session,
      auth: {
        current: {
          attributes: {
            conversationChannel: "eve",
            conversationId: "web-chat-1",
            scheduledRunKind: "agentic",
            workspaceId,
          },
          authenticator: "scheduled-worker",
          issuer: "open-instinct",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
      id: "worker-session",
    },
  } satisfies ToolContext;
}

/** The report turn of a browser run the worker started, in the person's chat. */
function reportContext() {
  const base = toolContext("browser_task", "browser-result");
  return {
    ...base,
    session: {
      ...base.session,
      auth: {
        current: {
          attributes: {
            browserRunId: runId,
            conversationChannel: "eve",
            conversationId: "web-chat-1",
            workspaceId,
          },
          authenticator: "browser-result",
          issuer: "open-instinct",
          principalId: "user-1",
          principalType: "user" as const,
        },
        initiator: null,
      },
    },
  } satisfies ToolContext;
}

/** The errand row a start left behind, as the report turn reads it. */
function workerRow(startedByPerson: boolean | null) {
  return {
    completedAt: new Date(),
    conversationChannel: "eve",
    conversationId: "web-chat-1",
    delegatedByPerson: false,
    id: runId,
    outcome: "Order: 12345\nNEEDS: decision",
    paymentAllowed: false,
    pendingTask: null,
    rootSessionId: "session-1",
    startedByPerson,
    status: "done",
    submission: { ...freeBooking },
    task: "Запиши на приём к терапевту",
    workspaceId,
  };
}

async function loadBrowserTask(pilot: string) {
  // The approval's pilot is read from the environment when the modules load.
  vi.resetModules();
  vi.stubEnv("AGENCY_WORKSPACES", pilot);
  return import("@agent/tools/browser_task");
}

function start(overrides: Partial<BrowserInput> = {}): BrowserInput {
  return {
    action: "start",
    allowSubmit: true,
    personWants: "done",
    site: "https://clinic.example",
    submission: { ...freeBooking },
    task: "Запиши к терапевту во вторник после 9:00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T09:00:00.000Z"));
  agency.agencyActionRecorded.mockResolvedValue(false);
  agency.agencyBudgetUsage.mockResolvedValue(new Map());
  profile.readWorkspaceTimeZone.mockResolvedValue("Europe/Moscow");
  profile.readUserProfile.mockResolvedValue({
    addressLine1: null,
    addressLine2: null,
    phone: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubEnv("AGENCY_WORKSPACES", "");
  vi.clearAllMocks();
});

// The first case loads the browser tool, which takes seconds under load.
describe("the agentic worker's browser errand", { timeout: 30_000 }, () => {
  it("is granted a free booking it names exactly, in its pilot", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(await browserTaskApproval(start(), workerContext())).toBe(
      "not-applicable"
    );
  });

  it("looks without a grant, since it acts in no one's name", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      await browserTaskApproval(
        { action: "start", personWants: "look", task: "Найди слоты" },
        workerContext()
      )
    ).toBe("not-applicable");
  });

  it("is refused any payment, by allowPayment or by the spend limit", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      JSON.stringify(
        await browserTaskApproval(
          start({ allowPayment: true }),
          workerContext()
        )
      )
    ).toMatch(/never pays/u);
    expect(
      JSON.stringify(
        await browserTaskApproval(
          start({
            withinSpendLimit: {
              currency: "RUB",
              feeRub: 0,
              recurring: false,
              totalRub: 500,
            },
          }),
          workerContext()
        )
      )
    ).toMatch(/never pays/u);
  });

  it("is refused a paid errand, which the run stages up to the person's «Оплачиваю?»", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      JSON.stringify(
        await browserTaskApproval(
          start({ submission: { ...freeBooking, chargeRub: 1200 } }),
          workerContext()
        )
      )
    ).toMatch(/books only what costs nothing/u);
  });

  it("is refused a booking that still has to choose among options", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      await browserTaskApproval(
        start({
          submission: { ...freeBooking, when: "вторник, любое время" },
        }),
        workerContext()
      )
    ).toMatchObject({ type: "denied" });
  });

  it("is refused a start without its submission", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      await browserTaskApproval(
        start({ submission: undefined }),
        workerContext()
      )
    ).toMatchObject({ type: "denied" });
  });

  it("is refused a continuation that acts, since only the person continues one", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      await browserTaskApproval(
        {
          action: "continue",
          allowSubmit: true,
          runId,
          submission: { ...freeBooking },
          task: "Подтверди",
        },
        workerContext()
      )
    ).toMatchObject({ type: "denied" });
  });

  it("is refused once the day's submit budget is used up", async () => {
    agency.agencyBudgetUsage.mockResolvedValue(new Map([["submit", 3]]));
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      JSON.stringify(await browserTaskApproval(start(), workerContext()))
    ).toMatch(/submit actions for today/u);
  });

  it("is refused a booking the journal still holds", async () => {
    agency.agencyActionRecorded.mockResolvedValue(true);
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      JSON.stringify(await browserTaskApproval(start(), workerContext()))
    ).toMatch(/already taken/u);
  });

  it("is refused the text that gives out the person's home phone, which no one named", async () => {
    profile.readUserProfile.mockResolvedValue({
      addressLine1: null,
      addressLine2: null,
      phone: "+7 999 123-45-67",
    });
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      JSON.stringify(
        await browserTaskApproval(
          start({ task: "Запиши, звонить на 8 999 123 45 67" }),
          workerContext()
        )
      )
    ).toMatch(/home address or phone number/u);
  });

  it("is refused a start from a background task, whose errand the person never asked for", async () => {
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    const context = workerContext();
    const background = {
      ...context,
      session: {
        ...context.session,
        auth: {
          current: {
            ...context.session.auth.current,
            authenticator: "background-task",
          },
          initiator: null,
        },
      },
    };
    expect(await browserTaskApproval(start(), background)).toMatchObject({
      type: "denied",
    });
  });

  it("is not granted outside the pilot, as before", async () => {
    const { browserTaskApproval } = await loadBrowserTask("workspace-2");
    expect(
      JSON.stringify(await browserTaskApproval(start(), workerContext()))
    ).toMatch(/nobody is there to confirm/u);
  });

  it("gives a report turn of the worker's errand no consent of the person's", async () => {
    runs.readLatestBrowserRunForScope.mockResolvedValue(workerRow(false));
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    // The report turn reads the errand's stored submission and would carry
    // it on, were it a delegated errand of the person's.
    expect(
      await browserTaskApproval(
        {
          action: "continue",
          allowSubmit: true,
          personWants: "done",
          runId,
          submission: { ...freeBooking },
          task: "Оформи",
        },
        reportContext()
      )
    ).toMatchObject({ type: "denied" });
  });

  it("keeps a report turn of the person's own errand as it was", async () => {
    runs.readLatestBrowserRunForScope.mockResolvedValue(workerRow(true));
    const { browserTaskApproval } = await loadBrowserTask(workspaceId);
    expect(
      await browserTaskApproval(
        {
          action: "continue",
          allowSubmit: true,
          personWants: "done",
          runId,
          submission: { ...freeBooking },
          task: "Оформи",
        },
        reportContext()
      )
    ).toBe("not-applicable");
  });
});
