import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Chats from "@db/services/chats";
import * as Sessions from "@db/services/sessions";
import * as RequestScope from "@web/auth/request-scope";
import ChatNotFound from "./not-found";
import Page from "./page";

const notFoundMock = vi.hoisted(() =>
  vi.fn<() => never>(() => {
    throw new Error("NEXT_NOT_FOUND");
  })
);
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

const readChatMock = vi.spyOn(Chats, "readChat");
const ownedMock = vi.spyOn(Sessions, "isSessionOwned");
vi.spyOn(RequestScope, "requireRequestScope").mockResolvedValue({
  userId: "better-auth:person-1",
  workspaceId: "personal:p1",
});

const page = (sessionId: string) =>
  Page({
    params: Promise.resolve({ sessionId }),
    searchParams: Promise.resolve({}),
  });

describe("a chat page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says the chat is not found when no chat of this account has the id", async () => {
    readChatMock.mockResolvedValue(undefined);
    ownedMock.mockResolvedValue(false);

    await expect(page("wrun_BOGUS123")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(ownedMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "personal:p1" }),
      "wrun_BOGUS123"
    );
  });

  it("opens a chat of the account, and a session it owns before the chat is written", async () => {
    readChatMock.mockResolvedValue({
      channel: "http",
      createdAt: "2026-10-21T11:00:00.000Z",
      sessionId: "wrun_known",
      title: "Билеты в Казань",
      updatedAt: "2026-10-21T11:00:00.000Z",
      usage: { costUsd: null, inputTokens: 0, outputTokens: 0 },
    });
    await expect(page("wrun_known")).resolves.toBeTruthy();
    expect(ownedMock).not.toHaveBeenCalled();

    readChatMock.mockResolvedValue(undefined);
    ownedMock.mockResolvedValue(true);
    await expect(page("wrun_new")).resolves.toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});

describe("the not-found chat page", () => {
  it("explains and leads on to a new chat and to all chats", () => {
    const markup = renderToStaticMarkup(<ChatNotFound />);

    expect(markup).toContain("Чат не найден");
    expect(markup).toContain('href="/chat"');
    expect(markup).toContain('href="/chat/history"');
  });
});
