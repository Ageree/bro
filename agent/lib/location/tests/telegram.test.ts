import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it } from "vitest";
import { telegramLocation } from "@agent/lib/location/telegram";

function message(raw: TelegramMessage["raw"]): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "100", type: "private" },
    messageId: "5",
    raw: { date: 1_760_000_000, message_id: 5, ...raw },
    text: "",
  };
}

const location = { latitude: 55.7512, longitude: 37.6184 };

describe("a location shared in Telegram", () => {
  it("takes the person's own GPS point as where they are", () => {
    expect(
      telegramLocation(
        message({ location: { ...location, horizontal_accuracy: 12.4 } })
      )
    ).toMatchObject({
      accuracyM: 12,
      arriveAllowed: true,
      externalId: "telegram:100:5:1760000000",
      kind: "position",
      leaveAllowed: true,
      liveKey: null,
      recordedAt: new Date(1_760_000_000_000),
      source: "telegram",
    });
  });

  it("keys the first point of a live share", () => {
    expect(
      telegramLocation(message({ location: { ...location, live_period: 900 } }))
    ).toMatchObject({ kind: "position", live: false, liveKey: "100:5" });
  });

  it("takes a venue as probably there, for an arrival only", () => {
    expect(
      telegramLocation(
        message({
          location,
          venue: {
            address: "Кудринская пл.\n46",
            location,
            title: "Кофемания",
          },
        })
      )
    ).toMatchObject({
      accuracyM: null,
      address: "Кудринская пл. 46",
      arriveAllowed: true,
      kind: "position",
      label: "Кофемания",
      leaveAllowed: false,
      source: "telegram_venue",
    });
  });

  it("takes a forwarded point and a dropped pin as a place", () => {
    expect(
      telegramLocation(
        message({
          forward_origin: { type: "user" },
          location: { ...location, horizontal_accuracy: 5 },
        })
      )
    ).toMatchObject({
      arriveAllowed: false,
      kind: "place",
      leaveAllowed: false,
    });
    expect(telegramLocation(message({ location }))).toMatchObject({
      kind: "place",
    });
    expect(telegramLocation(message({ text: "привет" }))).toBeUndefined();
  });
});
