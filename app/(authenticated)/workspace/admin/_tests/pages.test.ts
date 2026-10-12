import { beforeEach, describe, expect, it, vi } from "vitest";
import * as TurnLog from "@db/services/turn-log";
import * as Admin from "@web/auth/admin";
import * as RequestScope from "@web/auth/request-scope";
import Page from "../[workspace]/page";
import { adminQuery } from "../_lib/caller";

const notFoundMock = vi.hoisted(() =>
  vi.fn<() => never>(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
);
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

const adminMock = vi.spyOn(Admin, "isAdminScope");
const turnsMock = vi.spyOn(TurnLog, "listWorkspaceTurns");
vi.spyOn(RequestScope, "requireRequestScope").mockResolvedValue({
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
});
vi.spyOn(TurnLog, "describeWorkspace").mockResolvedValue("Person");

const page = (workspace: string) =>
  Page({
    params: Promise.resolve({ workspace }),
    searchParams: Promise.resolve({}),
  });

describe("owner page queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    turnsMock.mockResolvedValue([]);
  });

  it("show a visitor who is not the owner the 404 page", async () => {
    adminMock.mockResolvedValue(false);

    await expect(adminQuery((admin) => admin.users())).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  it("answer 404, not an error, to a broken escape from a visitor", async () => {
    adminMock.mockResolvedValue(false);

    await expect(page("%E0%A4%A")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(turnsMock).not.toHaveBeenCalled();
  });

  it("answer 404 to the owner for a broken escape, and read nothing", async () => {
    adminMock.mockResolvedValue(true);

    await expect(page("%")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(turnsMock).not.toHaveBeenCalled();
  });

  it("render the owner's workspace page", async () => {
    adminMock.mockResolvedValue(true);

    await expect(page("personal%3Ap1")).resolves.toBeTruthy();
    expect(turnsMock).toHaveBeenCalledWith(
      "personal:p1",
      expect.objectContaining({ failedOnly: false, limit: 200 })
    );
  });
});
