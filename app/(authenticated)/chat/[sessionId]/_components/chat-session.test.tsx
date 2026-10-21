import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@web/trpc/client", () => ({
  api: {
    chats: { save: { useMutation: () => ({ mutate: vi.fn<() => void>() }) } },
  },
}));

vi.mock("./input/location", () => ({ ShareLocationButton: () => null }));

import { ChatSession } from "./chat-session";

describe("chat session", () => {
  it("gives the activity button a row of its own above the conversation on a phone", () => {
    const markup = renderToStaticMarkup(
      <ChatSession
        filesPilot={false}
        sessionId="session-1"
        showInternals={false}
      />
    );
    const label = markup.indexOf('aria-label="Открыть панель активности"');
    const button = markup.slice(
      markup.lastIndexOf("<button", label),
      markup.indexOf(">", label)
    );

    expect(label).toBeGreaterThan(-1);
    // In the flow and first of the stacked root: a message cannot scroll
    // under it, as it did when the button floated over the conversation.
    expect(button).toContain("order-first");
    expect(button).toContain("md:hidden");
    expect(button).not.toContain("absolute");
    expect(markup).toContain("flex-col");
    expect(markup).toContain("md:flex-row");
  });
});
