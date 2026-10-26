import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";
import { telegramContact } from "@agent/lib/contact-share/telegram";

type Raw = TelegramMessage["raw"];

function message(raw: Raw): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "42", type: "private" },
    messageId: "1",
    raw,
    text: "",
  };
}

function card(userId: number | undefined, forwardDate?: number): Raw {
  const contact = { first_name: "Света", phone_number: "79990000001" };
  return {
    contact: userId === undefined ? contact : { ...contact, user_id: userId },
    forward_date: forwardDate,
  };
}

describe("telegramContact", () => {
  it("reads the sender's own card as their verified number", () => {
    expect(telegramContact(message(card(42)), "42")).toEqual({
      kind: "own",
      phone: "+79990000001",
    });
  });

  it("reads another account's card, a card with no account and a forwarded own card as a number they talk about", () => {
    expect(telegramContact(message(card(7)), "42")).toEqual({
      kind: "other",
      name: "Света",
      phone: "+79990000001",
    });
    expect(telegramContact(message(card(undefined)), "42")?.kind).toBe("other");
    expect(telegramContact(message(card(42, 1)), "42")?.kind).toBe("other");
  });

  it("ignores a message with no card or a number that is no number", () => {
    expect(telegramContact(message({ text: "привет" }), "42")).toBeUndefined();
    expect(
      telegramContact(
        message({ contact: { first_name: "A", phone_number: "12" } }),
        "42"
      )
    ).toBeUndefined();
  });
});
