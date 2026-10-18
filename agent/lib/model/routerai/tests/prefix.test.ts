import { afterEach, describe, expect, it, vi } from "vitest";
import { notePrefix } from "../prefix";

function call(messages: readonly { role: string; content: string }[]) {
  return JSON.stringify({ messages, tools: [{ name: "send_message" }] });
}

describe("where a call's cached prefix broke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the first message that differs from the conversation's last call", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const system = { content: "Ты Бро.", role: "system" };
    const opening = { content: "привет", role: "user" };
    notePrefix(
      call([system, opening, { content: "Записка: 12:00", role: "user" }])
    );
    notePrefix(
      call([
        system,
        opening,
        { content: "Записка: 12:01", role: "user" },
        { content: "как дела?", role: "user" },
      ])
    );
    expect(info).toHaveBeenCalledWith(
      "[model] prefix",
      expect.objectContaining({ brokeAt: 2, toolsChanged: false })
    );
  });
});
