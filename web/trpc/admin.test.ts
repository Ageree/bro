import { beforeEach, describe, expect, it, vi } from "vitest";
import * as TurnLog from "@db/services/turn-log";
import type { AccessScope } from "@shared/identity/access-scope";
import * as Admin from "@web/auth/admin";
import { appRouter } from "./router";

const adminMock = vi.spyOn(Admin, "isAdminScope");
const usersMock = vi.spyOn(TurnLog, "listOwnerUsers");
const transcriptMock = vi.spyOn(TurnLog, "readTurnTranscript");
const turnsMock = vi.spyOn(TurnLog, "listWorkspaceTurns");
const channelsMock = vi.spyOn(TurnLog, "workspaceChannels");

const scope = {
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
} satisfies AccessScope;
const admin = () =>
  appRouter.createCaller({ origin: "https://example.com", scope }).admin;

describe("owner pages in tRPC", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers an ordinary user NOT_FOUND and reads no data", async () => {
    adminMock.mockResolvedValue(false);

    await expect(admin().users()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin().turns({ workspaceId: "personal:o1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin().transcript({ turnLogId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(usersMock).not.toHaveBeenCalled();
    expect(turnsMock).not.toHaveBeenCalled();
    expect(transcriptMock).not.toHaveBeenCalled();
  });

  it("serves the owner", async () => {
    adminMock.mockResolvedValue(true);
    usersMock.mockResolvedValue([]);
    channelsMock.mockResolvedValue(new Map());
    turnsMock.mockResolvedValue([]);

    await expect(admin().users()).resolves.toEqual([]);
    await expect(
      admin().turns({ workspaceId: "personal:o1", failedOnly: true })
    ).resolves.toEqual([]);
  });
});

describe("the owner list", () => {
  it("admits a listed id or email in any case, and nobody on an empty list", () => {
    const account = { email: "Owner@Example.com", id: "owner-1" };

    expect(Admin.adminListAdmits([], account)).toBe(false);
    expect(Admin.adminListAdmits(["owner-1"], account)).toBe(true);
    expect(Admin.adminListAdmits(["owner@example.com"], account)).toBe(true);
    expect(Admin.adminListAdmits(["other"], account)).toBe(false);
    expect(
      Admin.adminListAdmits(["undefined"], { email: undefined, id: "x" })
    ).toBe(false);
  });
});
