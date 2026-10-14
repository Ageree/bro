import { beforeEach, describe, expect, it, vi } from "vitest";
import type { agencyActions } from "@db";
import type * as agency from "@db/services/agency";
import type * as agencySettings from "@db/services/agency-settings";
import type * as calendar from "@agent/lib/google-workspace/calendar";
import { agencyControl } from "@agent/tools/agency_control";
import { fullDeployment, stubDeployment } from "@tests/helpers/system-prompt";
import { catalogContext, toolCatalog } from "@tests/helpers/tool-catalog";
import { toolContext } from "@tests/helpers/tool-context";

const mocks = vi.hoisted(() => ({
  deleteCalendarEvent: vi.fn<typeof calendar.deleteCalendarEvent>(),
  findAgencyActions: vi.fn<typeof agency.findAgencyActions>(),
  isAgencyPaused: vi.fn<typeof agencySettings.isAgencyPaused>(),
  listRecentAgencyActions: vi.fn<typeof agency.listRecentAgencyActions>(),
  markAgencyActionUndone: vi.fn<typeof agency.markAgencyActionUndone>(),
  setAgencyPaused: vi.fn<typeof agencySettings.setAgencyPaused>(),
}));

vi.mock("@agent/lib/google-workspace/calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof calendar>()),
  deleteCalendarEvent: mocks.deleteCalendarEvent,
}));
vi.mock("@db/services/agency", () => ({
  findAgencyActions: mocks.findAgencyActions,
  listRecentAgencyActions: mocks.listRecentAgencyActions,
  markAgencyActionUndone: mocks.markAgencyActionUndone,
}));
vi.mock("@db/services/agency-settings", () => ({
  isAgencyPaused: mocks.isAgencyPaused,
  setAgencyPaused: mocks.setAgencyPaused,
}));

type AgencyRow = typeof agencyActions.$inferSelect;

const workspaceId = "workspace:alice";
const eventId = "0c7e5a1e-8f2d-4b7a-9c1e-3d2f4a5b6c7d";

const eventRow: AgencyRow = {
  actionClass: "calendar",
  counterparty: null,
  createdAt: new Date("2026-10-12T09:00:00.000Z"),
  id: eventId,
  inputHash: "hash-1",
  runId: "run-1",
  status: "done",
  summary: "Создал событие «Стоматолог» на 14 октября, 10:00",
  tool: "calendar-create-event",
  undo: {
    input: {
      calendarId: "primary",
      eventId: "google-event-1",
      eventStart: "2026-10-14T10:00:00+03:00",
      eventTitle: "Стоматолог",
    },
    tool: "calendar-delete-event",
  },
  updatedAt: new Date("2026-10-12T09:00:00.000Z"),
  workspaceId,
};

const mailRow: AgencyRow = {
  ...eventRow,
  actionClass: "send",
  createdAt: new Date("2026-10-12T08:00:00.000Z"),
  id: "1d8f6b2f-9a3e-4c8b-8d2f-4e3a5b6c7d8e",
  inputHash: "hash-2",
  status: "done",
  summary: "Отправил письмо в сервис",
  tool: "gmail-send",
  undo: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agency_control", () => {
  it("refuses a turn the person's own message did not start", async () => {
    await expect(
      agencyControl.execute(
        { action: "pause" },
        toolContext("agency_control", "browser-result")
      )
    ).rejects.toThrow("only in a turn the person's own message started");

    expect(mocks.setAgencyPaused).not.toHaveBeenCalled();
    expect(mocks.listRecentAgencyActions).not.toHaveBeenCalled();
  });

  it("lists the last actions with short ids, ISO times and what is undoable", async () => {
    mocks.listRecentAgencyActions.mockResolvedValue([eventRow, mailRow]);
    mocks.isAgencyPaused.mockResolvedValue(false);

    const result = await agencyControl.execute(
      { action: "list" },
      toolContext("agency_control")
    );

    expect(mocks.listRecentAgencyActions).toHaveBeenCalledWith(workspaceId, 10);
    expect(result).toEqual({
      actions: [
        {
          id: "0c7e5a1e",
          status: "done",
          summary: "Создал событие «Стоматолог» на 14 октября, 10:00",
          time: "2026-10-12T09:00:00.000Z",
          undoable: true,
        },
        {
          id: "1d8f6b2f",
          status: "done",
          summary: "Отправил письмо в сервис",
          time: "2026-10-12T08:00:00.000Z",
          undoable: false,
        },
      ],
      paused: false,
    });
    // The tool result goes to the model as JSON: it must survive a round trip.
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("pauses and resumes Bro's own work in the workspace", async () => {
    await expect(
      agencyControl.execute({ action: "pause" }, toolContext("agency_control"))
    ).resolves.toEqual({ paused: true });
    await expect(
      agencyControl.execute({ action: "resume" }, toolContext("agency_control"))
    ).resolves.toEqual({ paused: false });

    expect(mocks.setAgencyPaused.mock.calls).toEqual([
      [workspaceId, true],
      [workspaceId, false],
    ]);
  });

  it("says an action without a stored undo cannot be undone, and changes nothing", async () => {
    mocks.findAgencyActions.mockResolvedValue([mailRow]);

    const result = await agencyControl.execute(
      { action: "undo", actionId: "1d8f6b2f" },
      toolContext("agency_control")
    );

    expect(result).toEqual({
      reason:
        "This action has no undo, so it cannot be undone. Say so to the person in one line.",
      undone: false,
    });
    expect(mocks.deleteCalendarEvent).not.toHaveBeenCalled();
    expect(mocks.markAgencyActionUndone).not.toHaveBeenCalled();
  });

  it("deletes the calendar event of an undo through the calendar's delete, then marks it undone", async () => {
    mocks.findAgencyActions.mockResolvedValue([eventRow]);
    mocks.deleteCalendarEvent.mockResolvedValue({ alreadyDeleted: false });
    mocks.markAgencyActionUndone.mockResolvedValue(true);

    const context = toolContext("agency_control");
    const result = await agencyControl.execute(
      { action: "undo", actionId: "0c7e5a1e" },
      context
    );

    expect(mocks.findAgencyActions).toHaveBeenCalledWith(
      workspaceId,
      "0c7e5a1e"
    );
    expect(mocks.deleteCalendarEvent).toHaveBeenCalledWith(context, {
      calendarId: "primary",
      eventId: "google-event-1",
      eventStart: "2026-10-14T10:00:00+03:00",
      eventTitle: "Стоматолог",
    });
    expect(mocks.markAgencyActionUndone).toHaveBeenCalledWith(eventId);
    expect(result).toEqual({
      action: "Создал событие «Стоматолог» на 14 октября, 10:00",
      alreadyDeleted: false,
      undone: true,
    });
  });

  it("refuses an id no action of Bro's has", async () => {
    mocks.findAgencyActions.mockResolvedValue([]);

    const result = await agencyControl.execute(
      { action: "undo", actionId: "ffffffff" },
      toolContext("agency_control")
    );

    expect(result).toEqual({
      reason: "No action of Bro's has this id.",
      undone: false,
    });
    expect(mocks.deleteCalendarEvent).not.toHaveBeenCalled();
  });

  it("is offered only while the pilot names the workspace", async () => {
    stubDeployment({ ...fullDeployment, AGENCY_WORKSPACES: "workspace-1" });
    const offered = (await toolCatalog(catalogContext("web", []))).map(
      ({ name }) => name
    );
    expect(offered).toContain("agency_control");

    stubDeployment({ ...fullDeployment, AGENCY_WORKSPACES: "" });
    const outside = (await toolCatalog(catalogContext("web", []))).map(
      ({ name }) => name
    );
    expect(outside).not.toContain("agency_control");
  }, 60_000);
});
