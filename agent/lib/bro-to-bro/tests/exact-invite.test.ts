import { describe, expect, it, vi } from "vitest";

// eve's state outside a session: one value per slot.
vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    return {
      get: () => value,
      update(next: (current: T) => T) {
        value = next(value);
      },
    };
  },
}));

const { recordBroInviteLinks, withExactBroInviteLinks } =
  await import("@agent/lib/bro-to-bro/exact-invite");

/** The links of one invite on 25.10, and DeepSeek's copy of them: the token's last character lost. */
const links = {
  telegram:
    "https://t.me/bro0000obot?start=bro_gOa-7dAF6aPwjXKAMaU4lbXHVeh0TtJm",
  web: "https://brobro.tech/workspace?bro_invite=gOa-7dAF6aPwjXKAMaU4lbXHVeh0TtJm",
};
const copied =
  "в Telegram — https://t.me/bro0000obot?start=bro_gOa-7dAF6aPwjXKAMaU4lbXHVeh0TtJ, если Telegram не нужен — brobro.tech/workspace?bro_invite=gOa-7dAF6aPwjXKAMaU4lbXHVeh0TtJ (там кнопка «Принять»).";

describe("the invite links a message carries", () => {
  it("go out as written before any invite was made", () => {
    const message = { kind: "message" as const, text: copied };
    expect(withExactBroInviteLinks(message)).toBe(message);
  });

  it("are the links of the invite made last, whatever the model copied", () => {
    recordBroInviteLinks(links);

    expect(withExactBroInviteLinks({ kind: "message", text: copied })).toEqual({
      kind: "message",
      text: `в Telegram — ${links.telegram}, если Telegram не нужен — ${links.web} (там кнопка «Принять»).`,
    });
    expect(
      withExactBroInviteLinks({ kind: "link", url: links.web.slice(0, -3) })
    ).toEqual({ kind: "link", url: links.web });
  });
});
