import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatUsage } from "@shared/chat/schema";
import { ActivityCard } from "./card";

const usage = {
  costUsd: 0.007,
  inputTokens: 148_000,
  outputTokens: 1_600,
} satisfies ChatUsage;

function card(showInternals: boolean) {
  return renderToStaticMarkup(
    <ActivityCard
      doneCount={0}
      eventsBySession={new Map()}
      onSelect={vi.fn<() => void>()}
      onTraceViewChange={vi.fn<() => void>()}
      sessions={[]}
      showInternals={showInternals}
      statuses={new Map()}
      traceView="imessage"
      usage={usage}
      workingCount={0}
    />
  );
}

describe("activity card", () => {
  it("gives the owner the full trace switch and the chat's tokens and dollars", () => {
    const html = card(true);

    expect(html).toContain("Полная трассировка");
    expect(html).toContain("Расход");
    expect(html).toMatch(/149,6\sтыс\. токенов · \$0\.007/u);
  });

  it("gives anyone else the tasks alone", () => {
    const html = card(false);

    expect(html).toContain("Активность");
    expect(html).toContain("Пока нет задач");
    expect(html).not.toContain("трассировка");
    expect(html).not.toContain("Расход");
    expect(html).not.toContain("токен");
    expect(html).not.toContain("$");
  });
});
