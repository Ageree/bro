import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";
import {
  locationArrived,
  rememberLocationAsked,
  takeKeyboardRemoval,
  telegramLocation,
} from "@agent/lib/location/telegram";

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

  it("takes a live location an inline bot sent as a place it moves, not the person", () => {
    expect(
      telegramLocation(
        message({
          location: { ...location, horizontal_accuracy: 5, live_period: 900 },
          via_bot: { first_name: "Map", id: 555, is_bot: true },
        })
      )
    ).toMatchObject({
      arriveAllowed: false,
      kind: "place",
      leaveAllowed: false,
      liveKey: null,
    });
  });

  it("takes a plain location right after the button as the person's own, for an arrival only", () => {
    const asked = vi.fn<() => boolean>(() => true);
    expect(telegramLocation(message({ location }), { asked })).toMatchObject({
      accuracyM: null,
      arriveAllowed: true,
      kind: "position",
      leaveAllowed: false,
    });
    asked.mockReturnValue(false);
    expect(telegramLocation(message({ location }), { asked })).toMatchObject({
      kind: "place",
    });
    // A measured point does not need the button, and does not use it up.
    asked.mockClear();
    telegramLocation(
      message({ location: { ...location, horizontal_accuracy: 5 } }),
      { asked }
    );
    expect(asked).not.toHaveBeenCalled();
  });

  it("removes the button's keyboard once a location came or its window closed", () => {
    const shown = 1_760_000_000_000;
    rememberLocationAsked("200", shown);
    // Bro's own message right after the button keeps it.
    expect(takeKeyboardRemoval("200", shown + 1_000)).toBe(false);
    locationArrived("200");
    expect(takeKeyboardRemoval("200", shown + 2_000)).toBe(true);
    expect(takeKeyboardRemoval("200", shown + 3_000)).toBe(false);
    rememberLocationAsked("300", shown);
    expect(takeKeyboardRemoval("300", shown + 11 * 60_000)).toBe(true);
  });
});
