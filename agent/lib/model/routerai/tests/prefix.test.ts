import { afterEach, describe, expect, it, vi } from "vitest";
import { notePrefix } from "../prefix";

// The session `warmCallMiddleware` would mark the call with.
const marked = vi.hoisted(() => new Map<"session", string>());

vi.mock("../warm", () => ({
  callConversationOf: () => marked.get("session"),
}));

function call(
  messages: readonly { role: string; content: string }[],
  tools: readonly { name: string }[] = [{ name: "send_message" }]
) {
  return JSON.stringify({ messages, tools });
}

function noteIn(session: string | undefined, body: string) {
  if (session === undefined) marked.delete("session");
  else marked.set("session", session);
  notePrefix(body);
}

const system = { content: "Ты Бро.", role: "system" };
// Bro's own preamble: the same first message in every conversation.
const preamble = { content: "Профиль и правила.", role: "user" };

describe("where a call's cached prefix broke", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    marked.clear();
  });

  it("names the first message that differs from the session's last call", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const opening = { content: "привет", role: "user" };
    noteIn(
      "wrun_a",
      call([system, opening, { content: "Записка: 12:00", role: "user" }])
    );
    noteIn(
      "wrun_a",
      call([
        system,
        opening,
        { content: "Записка: 12:01", role: "user" },
        { content: "как дела?", role: "user" },
      ])
    );
    expect(info).toHaveBeenCalledWith(
      "[model] prefix",
      expect.objectContaining({
        brokeAt: 2,
        sessionId: "wrun_a",
        toolsChanged: false,
      })
    );
  });

  it("never compares two sessions that open alike", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    noteIn(
      "wrun_b",
      call([system, preamble, { content: "погода?", role: "user" }])
    );
    noteIn(
      "wrun_c",
      call(
        [system, preamble, { content: "что в календаре?", role: "user" }],
        [{ name: "calendar" }]
      )
    );
    expect(info).not.toHaveBeenCalledWith("[model] prefix", expect.anything());
  });

  it("leaves out a call no session marked", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const body = call([system, preamble]);
    noteIn(undefined, body);
    noteIn(undefined, body);
    expect(info).not.toHaveBeenCalled();
  });
});
