import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
import * as Admin from "@web/auth/admin";
import * as RequestScope from "@web/auth/request-scope";
import AllChatsPage from "./page";

const adminMock = vi.spyOn(Admin, "isAdminScope");

const usage = { costUsd: 0.2, inputTokens: 3_000_000, outputTokens: 600_000 };

vi.spyOn(RequestScope, "requireRequestScope").mockResolvedValue({
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
});
vi.spyOn(Chats, "listChatsPage").mockResolvedValue({
  chats: [
    {
      channel: null,
      createdAt: "2026-10-21T11:00:00.000Z",
      sessionId: "session-1",
      title: "Планы на неделю",
      updatedAt: "2026-10-21T12:00:00.000Z",
      usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
    },
  ],
  next: null,
});
vi.spyOn(Chats, "summarizeChats").mockResolvedValue({ count: 1469, usage });
vi.spyOn(Chats, "newestChatsOfChannels").mockResolvedValue([]);

describe("«Все чаты»", () => {
  beforeEach(() => vi.clearAllMocks());

  it("counts the owner's tokens and dollars", async () => {
    adminMock.mockResolvedValue(true);

    const html = renderToStaticMarkup(await AllChatsPage());

    expect(html).toMatch(/Расход — 3,6\sмлн токенов · \$0\.20/u);
    expect(html).toContain("0 токенов");
  });

  it("counts anyone else's chats and nothing more", async () => {
    adminMock.mockResolvedValue(false);

    const html = renderToStaticMarkup(await AllChatsPage());

    expect(html).toMatch(/1\s469 разговоров/u);
    expect(html).toContain("Планы на неделю");
    expect(html).not.toContain("Расход");
    expect(html).not.toContain("токен");
  });
});
