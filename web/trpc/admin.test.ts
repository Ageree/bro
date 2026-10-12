import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessScope } from "@shared/identity/access-scope";

const scope = {
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
} satisfies AccessScope;
const owner = {
  userId: "better-auth:owner-1",
  workspaceId: "personal:o1",
} satisfies AccessScope;

/** The router, the access check and the services it reads, freshly loaded. */
async function load() {
  vi.resetModules();
  const [TurnLog, Users, Admin, { appRouter }] = await Promise.all([
    import("@db/services/turn-log"),
    import("@db/services/users"),
    import("@web/auth/admin"),
    import("./router"),
  ]);
  const email = vi.spyOn(Users, "readAccountEmail");
  const users = vi.spyOn(TurnLog, "listOwnerUsers").mockResolvedValue([]);
  const turns = vi.spyOn(TurnLog, "listWorkspaceTurns").mockResolvedValue([]);
  const transcript = vi.spyOn(TurnLog, "readTurnTranscript");
  vi.spyOn(TurnLog, "describeWorkspace").mockResolvedValue("Person");
  return {
    Admin,
    admin: (as: AccessScope) =>
      appRouter.createCaller({ origin: "https://example.com", scope: as })
        .admin,
    email,
    transcript,
    turns,
    users,
  };
}

describe("owner pages in tRPC", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    // The test setup owns the rest of the environment.
    vi.stubEnv("ADMIN_USER_IDS", undefined);
  });

  it("admit nobody with ADMIN_USER_IDS unset, and read nothing", async () => {
    const { admin, email, transcript, turns, users } = await load();

    await expect(admin(owner).users()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      admin(owner).turns({ workspaceId: "personal:o1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin(owner).transcript({ turnLogId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(email).not.toHaveBeenCalled();
    expect(users).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });

  it("answer a user who is not listed NOT_FOUND, without reading data", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "owner-1");
    const { admin, email, transcript, turns, users } = await load();
    email.mockResolvedValue("person@example.com");

    await expect(admin(scope).users()).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      admin(scope).turns({ workspaceId: "personal:o1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      admin(scope).transcript({ turnLogId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(users).not.toHaveBeenCalled();
    expect(turns).not.toHaveBeenCalled();
    expect(transcript).not.toHaveBeenCalled();
  });

  it("serve a listed id without looking up the email", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "owner-1");
    const { admin, email } = await load();

    await expect(admin(owner).users()).resolves.toEqual([]);
    await expect(
      admin(owner).turns({ failedOnly: true, workspaceId: "personal:p1" })
    ).resolves.toMatchObject({ label: "Person", turns: [] });
    expect(email).not.toHaveBeenCalled();
  });

  it("serve a listed email", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "Someone@Example.com");
    const { admin, email } = await load();
    email.mockResolvedValue("someone@example.com");

    await expect(admin(scope).users()).resolves.toEqual([]);
    expect(email).toHaveBeenCalledOnce();
  });
});

describe("the owner list", () => {
  it("admits a listed id or email in any case, and nobody on an empty list", async () => {
    const { Admin } = await load();
    const account = { email: "Owner@Example.com", id: "owner-1" };

    expect(Admin.adminListAdmits([], account)).toBe(false);
    expect(Admin.adminListAdmits(["owner-1"], account)).toBe(true);
    expect(Admin.adminListAdmits(["owner@example.com"], account)).toBe(true);
    expect(Admin.adminListAdmits(["other"], account)).toBe(false);
  });
});
