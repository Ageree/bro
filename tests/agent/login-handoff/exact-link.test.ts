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

const { recordLoginHandoffLink, withExactLoginHandoffLink } =
  await import("@agent/lib/login-handoff/exact-link");

/** The address `site-login-link` made in 10.10. */
const link = "https://brobro.tech/handoff/uU9hry_OH-oo21PlwBlXGYQD-WlOVCI7";
/** The same address as DeepSeek copied it into `send_message`: its tail lost. */
const copied = "https://brobro.tech/handoff/uU9hry_OH-oo21PlwBlXGXl";

describe("the sign-in link a message carries", () => {
  it("goes out as written before any link was made", () => {
    const message = { kind: "message" as const, text: `Вот ${copied}` };
    expect(withExactLoginHandoffLink(message)).toBe(message);
  });

  it("is replaced by the link made last, whatever the model copied", () => {
    recordLoginHandoffLink(link);

    expect(
      withExactLoginHandoffLink({
        kind: "message",
        text: `Ссылка для входа на ozon.ru: ${copied}\nОна работает 30 минут.`,
      })
    ).toEqual({
      kind: "message",
      text: `Ссылка для входа на ozon.ru: ${link}\nОна работает 30 минут.`,
    });
  });

  it("takes an address the model wrote without its scheme", () => {
    recordLoginHandoffLink(link);

    expect(
      withExactLoginHandoffLink({
        kind: "message",
        replyTo: { kind: "current" },
        text: "brobro.tech/handoff/uU9hry_OH-oo21PlwBlXGXl.",
      })
    ).toEqual({
      kind: "message",
      replyTo: { kind: "current" },
      text: `${link}.`,
    });
  });

  it("is replaced in a native link too", () => {
    recordLoginHandoffLink(link);

    expect(withExactLoginHandoffLink({ kind: "link", url: copied })).toEqual({
      kind: "link",
      url: link,
    });
  });

  it("leaves a message without a sign-in address alone", () => {
    recordLoginHandoffLink(link);
    const message = {
      kind: "message" as const,
      text: "Жду, когда войдёте и нажмёте «Готово».",
    };
    expect(withExactLoginHandoffLink(message)).toBe(message);
  });

  it("keeps the attachments of a message it rewrites", () => {
    recordLoginHandoffLink(link);
    const attachments = [
      { kind: "image" as const, url: "https://media.example/a.jpg" },
    ];

    expect(
      withExactLoginHandoffLink({
        attachments,
        kind: "message",
        text: `Ссылка: ${copied}`,
      })
    ).toEqual({ attachments, kind: "message", text: `Ссылка: ${link}` });
  });
});
