import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatSummary } from "@shared/chat/schema";
import { ChatRow } from "./chat-row";

const chat = {
  channel: null,
  createdAt: "2026-10-21T11:00:00.000Z",
  sessionId: "session-1",
  title: "Планы на неделю",
  updatedAt: "2026-10-21T12:00:00.000Z",
  usage: { costUsd: 0.0069, inputTokens: 120_000, outputTokens: 8_500 },
} satisfies ChatSummary;

describe("chat row of «Все чаты»", () => {
  it("shows the owner the chat's tokens and dollars", () => {
    const html = renderToStaticMarkup(
      <ChatRow chat={chat} mainThread={undefined} showUsage />
    );

    expect(html).toContain("Планы на неделю");
    expect(html).toMatch(/128,5\sтыс\. токенов · \$0\.0069/u);
  });

  it("shows anyone else the title and the date, no tokens", () => {
    const html = renderToStaticMarkup(
      <ChatRow chat={chat} mainThread={undefined} showUsage={false} />
    );

    expect(html).toContain("Планы на неделю");
    expect(html).toContain('dateTime="2026-10-21T12:00:00.000Z"');
    expect(html).not.toContain("токен");
    expect(html).not.toContain("$");
  });

  it("keeps naming the main thread without the tokens", () => {
    const html = renderToStaticMarkup(
      <ChatRow chat={chat} mainThread="iMessage" showUsage={false} />
    );

    expect(html).toContain("iMessage");
    expect(html).toContain("Главная ветка");
    expect(html).not.toContain("токен");
    expect(html).not.toContain(" · ");
  });
});
