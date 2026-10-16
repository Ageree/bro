import { describe, expect, it } from "vitest";
import {
  judgeParcelCheck,
  startingParcelState,
} from "@agent/lib/subscriptions/parcel/check";
import { carrierLetterNumbers } from "@agent/lib/subscriptions/parcel/mail";
import {
  certainParcelNumbersIn,
  parcelNumbersIn,
} from "@agent/lib/subscriptions/parcel/number";
import {
  type ParcelRead,
  pochtaReading,
} from "@agent/lib/subscriptions/parcel/pochta";
import { parcelStateSchema } from "@shared/subscriptions/parcel";

const number = "10100012345678";
const now = new Date("2026-10-15T09:00:00.000Z");

/** One operation as Russian Post's site gives it. */
function operation(
  date: string,
  operationType: number,
  operationAttr: number,
  humanStatus: string,
  description = "101000, Москва"
) {
  return { date, description, humanStatus, operationAttr, operationType };
}

type Operation = ReturnType<typeof operation>;

/**
 * The site's answer for `number`, shaped as `by-barcodes` answered from
 * Selectel (15.10): fields the reading does not use are left out.
 */
function answer(item: {
  readonly endStorageDate?: string;
  readonly shipmentTripInfo?: {
    readonly expectedDeliveryDate: string;
    readonly isExpectedDeliveryDateAvailable: boolean;
  };
  readonly trackingHistoryItemList: readonly Operation[];
  readonly trackingItemOperationGroupStatuses?: readonly {
    readonly originTrackingHistoryItems: readonly Operation[];
  }[];
}) {
  return JSON.stringify({
    detailedTrackings: [
      {
        trackingItem: { barcode: number, title: "Посылка из Казани", ...item },
      },
    ],
    trackingsDto: null,
  });
}

const accepted = operation(
  "2026-10-12T10:00:00.000+03:00",
  1,
  2,
  "Принято в отделении связи",
  "420000, Казань"
);
const sorted = operation(
  "2026-10-13T18:30:00.000+03:00",
  8,
  3,
  "Прибыло в сортировочный центр",
  "140983, Москва"
);
const arrived = operation(
  "2026-10-15T08:10:00.000+03:00",
  8,
  2,
  "Прибыло в место вручения",
  "101000, Москва"
);

function inTransit(expected = "2026-10-17T12:00:00.000+03:00") {
  return answer({
    shipmentTripInfo: {
      expectedDeliveryDate: expected,
      isExpectedDeliveryDateAvailable: true,
    },
    trackingHistoryItemList: [sorted, accepted],
  });
}

function read(body: string) {
  return pochtaReading(body, number);
}

describe("reading Russian Post's answer", () => {
  it("reads a parcel on its way with the date the carrier expects", () => {
    expect(read(inTransit())).toEqual({
      expectedOn: "2026-10-17",
      kind: "parcel",
      lastEvent: "Прибыло в сортировочный центр",
      lastEventAt: "2026-10-13T15:30:00.000Z",
      place: "140983, Москва",
      status: "in_transit",
      storageEnding: false,
      storageUntil: null,
      title: "Посылка из Казани",
    });
  });

  it("takes the newest operation from every list the site splits it into", () => {
    const reading = read(
      answer({
        endStorageDate: "2026-10-22",
        trackingHistoryItemList: [accepted],
        trackingItemOperationGroupStatuses: [
          { originTrackingHistoryItems: [sorted] },
          { originTrackingHistoryItems: [arrived] },
        ],
      })
    );
    expect(reading).toMatchObject({
      lastEvent: "Прибыло в место вручения",
      place: "101000, Москва",
      status: "arrived",
      storageUntil: "2026-10-22",
    });
  });

  it.each([
    [
      "handed over",
      operation(arrived.date, 2, 1, "Вручение адресату"),
      "delivered",
    ],
    [
      "handed back",
      operation(arrived.date, 2, 2, "Вручение отправителю"),
      "returned",
    ],
    ["sent back", operation(arrived.date, 3, 1, "Возврат"), "returned"],
    ["lost", operation(arrived.date, 18, 1, "Регистрация утраты"), "lost"],
    [
      "in a locker",
      operation(arrived.date, 8, 9, "Прибыло в почтомат"),
      "arrived",
    ],
    [
      "a failed attempt",
      operation(arrived.date, 12, 1, "Неудачная попытка вручения"),
      "arrived",
    ],
    [
      "only a number",
      operation(arrived.date, 28, 0, "Присвоен трек-номер"),
      "registered",
    ],
  ] as const)("reads a parcel %s", (_case, last, status) => {
    expect(
      read(answer({ trackingHistoryItemList: [last, accepted] }))
    ).toMatchObject({ status });
  });

  it("reads a number the carrier does not know yet, and storage running out", () => {
    expect(read(answer({ trackingHistoryItemList: [] }))).toMatchObject({
      lastEvent: null,
      status: "unknown",
    });
    expect(
      read(
        answer({
          trackingHistoryItemList: [
            operation(arrived.date, 8, 42, "Истекает срок хранения"),
          ],
        })
      )
    ).toMatchObject({ status: "arrived", storageEnding: true });
  });

  it("refuses an answer about another number or of another shape", () => {
    expect(pochtaReading(inTransit(), "10100099999999")).toEqual({
      kind: "unreadable",
      reason: "no-item",
    });
    expect(read(JSON.stringify({ error: "x" }))).toEqual({
      kind: "unreadable",
      reason: "shape",
    });
  });
});

/** A watch of `number` whose last reading was `reading`. */
function watchOf(
  reading: ParcelRead,
  overrides: Partial<Parameters<typeof judgeParcelCheck>[0]> = {}
): Parameters<typeof judgeParcelCheck>[0] {
  if (reading.kind !== "parcel") throw new Error("Expected a parcel.");
  return {
    checkEverySeconds: 3 * 60 * 60,
    expiresAt: new Date("2026-12-01T00:00:00.000Z"),
    failures: 0,
    source: {
      carrier: "pochta",
      number,
      origin: "person",
      title: "Посылка из Казани",
    },
    state: startingParcelState(reading, new Date("2026-10-14T09:00:00.000Z")),
    ...overrides,
  };
}

function summaryOf(check: ReturnType<typeof judgeParcelCheck>) {
  return "outcome" in check && check.outcome.kind === "result"
    ? check.outcome.summary
    : "";
}

describe("judging a parcel check", () => {
  it("stays quiet when nothing changed, and checks again a period later", () => {
    const reading = read(inTransit());
    const check = judgeParcelCheck(watchOf(reading), reading, now);
    expect(check).toMatchObject({
      kind: "quiet",
      nextCheckAt: new Date("2026-10-15T12:00:00.000Z"),
      state: { expectedOn: "2026-10-17", status: "in_transit" },
    });
    // Another sorting centre on the way is no news either.
    const moved = read(
      answer({
        shipmentTripInfo: {
          expectedDeliveryDate: "2026-10-17T12:00:00.000+03:00",
          isExpectedDeliveryDateAvailable: true,
        },
        trackingHistoryItemList: [
          operation(
            "2026-10-14T21:00:00.000+03:00",
            8,
            4,
            "Покинуло сортировочный центр"
          ),
          sorted,
          accepted,
        ],
      })
    );
    expect(judgeParcelCheck(watchOf(reading), moved, now).kind).toBe("quiet");
  });

  it("tells of a new expected date, and not of one the carrier stops giving", () => {
    const watch = watchOf(read(inTransit()));
    const later = judgeParcelCheck(
      watch,
      read(inTransit("2026-10-20T12:00:00.000+03:00")),
      now
    );
    expect(later).toMatchObject({
      kind: "news",
      outcome: { urgency: "normal" },
      state: { expectedOn: "2026-10-20" },
    });
    expect(summaryOf(later)).toContain("2026-10-20");
    expect(summaryOf(later)).toContain("2026-10-17");
    const silent = judgeParcelCheck(
      watch,
      read(answer({ trackingHistoryItemList: [sorted, accepted] })),
      now
    );
    expect(silent).toMatchObject({
      kind: "quiet",
      state: { expectedOn: "2026-10-17" },
    });
  });

  it("tells of the arrival once, and of its storage ending once per date", () => {
    const watch = watchOf(read(inTransit()));
    const waiting = read(
      answer({
        endStorageDate: "2026-10-22T00:00:00.000+03:00",
        trackingHistoryItemList: [arrived, sorted, accepted],
      })
    );
    const arrival = judgeParcelCheck(watch, waiting, now);
    expect(arrival).toMatchObject({
      kind: "news",
      state: { status: "arrived" },
    });
    expect(summaryOf(arrival)).toContain("«101000, Москва»");
    expect(summaryOf(arrival)).toContain("2026-10-22");
    if (arrival.kind !== "news") return;
    const settled = { ...watch, state: parcelStateSchema.parse(arrival.state) };
    expect(judgeParcelCheck(settled, waiting, now).kind).toBe("quiet");

    const twoDaysLeft = new Date("2026-10-20T09:00:00.000Z");
    const ending = judgeParcelCheck(settled, waiting, twoDaysLeft);
    expect(ending).toMatchObject({
      kind: "news",
      outcome: { urgency: "time_sensitive" },
      state: { storageWarned: "2026-10-22" },
    });
    if (ending.kind !== "news") return;
    const warned = { ...watch, state: parcelStateSchema.parse(ending.state) };
    expect(judgeParcelCheck(warned, waiting, twoDaysLeft).kind).toBe("quiet");
    // An extension is a new end, warned of again when it nears.
    const extended = read(
      answer({
        endStorageDate: "2026-10-29",
        trackingHistoryItemList: [arrived, sorted, accepted],
      })
    );
    expect(judgeParcelCheck(warned, extended, twoDaysLeft).kind).toBe("quiet");
    expect(
      judgeParcelCheck(warned, extended, new Date("2026-10-28T09:00:00.000Z"))
        .kind
    ).toBe("news");
  });

  it("ends without a word once handed over, and with one on a return", () => {
    const watch = watchOf(read(inTransit()));
    const handed = read(
      answer({
        trackingHistoryItemList: [
          operation(arrived.date, 2, 1, "Вручение адресату"),
          accepted,
        ],
      })
    );
    expect(judgeParcelCheck(watch, handed, now)).toMatchObject({
      kind: "done",
      state: { status: "delivered" },
    });
    const back = judgeParcelCheck(
      watch,
      read(
        answer({
          trackingHistoryItemList: [
            operation(arrived.date, 3, 1, "Возврат"),
            accepted,
          ],
        })
      ),
      now
    );
    expect(back.kind).toBe("hit");
    expect(summaryOf(back)).toContain("returned to the sender");
    // A return already told is not told again.
    if (back.kind !== "hit" || !back.state) return;
    const told = { ...watch, state: parcelStateSchema.parse(back.state) };
    expect(
      judgeParcelCheck(
        told,
        read(
          answer({
            trackingHistoryItemList: [
              operation(arrived.date, 3, 1, "Возврат"),
              accepted,
            ],
          })
        ),
        now
      ).kind
    ).toBe("done");
  });

  it("takes what a letter told as known: a letter's watch's first reading, or the next one after another letter", () => {
    const letter = watchOf(read(answer({ trackingHistoryItemList: [] })), {
      source: { carrier: "pochta", number, origin: "mail", title: null },
    });
    // «Срок хранения истекает»: the storage end is known, not news later.
    const ending = read(
      answer({
        endStorageDate: "2026-10-16",
        trackingHistoryItemList: [arrived, sorted, accepted],
      })
    );
    const first = judgeParcelCheck(letter, ending, now);
    expect(first).toMatchObject({
      kind: "quiet",
      state: { seen: true, status: "arrived", storageWarned: "2026-10-16" },
    });
    if (first.kind !== "quiet") return;
    const later = { ...letter, state: parcelStateSchema.parse(first.state) };
    expect(judgeParcelCheck(later, ending, now).kind).toBe("quiet");
    // A letter of its return: the watch ends without saying it again.
    const back = read(
      answer({
        trackingHistoryItemList: [
          operation(arrived.date, 3, 1, "Возврат"),
          accepted,
        ],
      })
    );
    expect(judgeParcelCheck(letter, back, now)).toMatchObject({
      kind: "done",
      state: { status: "returned" },
    });
    // The person's own number that turns up already arrived is news…
    const asked = watchOf(read(inTransit()));
    expect(judgeParcelCheck(asked, ending, now).kind).toBe("news");
    // …unless Russian Post's letter of it just went to them.
    const lettered = {
      ...asked,
      state: { ...asked.state, letterPending: true },
    };
    expect(judgeParcelCheck(lettered, ending, now)).toMatchObject({
      kind: "quiet",
      state: { letterPending: false, status: "arrived" },
    });
  });

  it("backs off on a failed reading, and ends at its term", () => {
    const watch = watchOf(read(inTransit()), { failures: 1 });
    expect(
      judgeParcelCheck(watch, { kind: "blocked", reason: "http 417" }, now)
    ).toMatchObject({
      error: "blocked: http 417",
      kind: "failed",
      nextCheckAt: new Date("2026-10-15T21:00:00.000Z"),
      outcome: { kind: "blocked" },
    });
    const over = { ...watch, expiresAt: now };
    expect(judgeParcelCheck(over, read(inTransit()), now).kind).toBe("expired");
    // A letter's number Russian Post never knew ends without a word.
    const unknown = watchOf(read(answer({ trackingHistoryItemList: [] })), {
      expiresAt: now,
      source: { carrier: "pochta", number, origin: "mail", title: null },
    });
    expect(judgeParcelCheck(unknown, read(inTransit()), now)).toEqual({
      kind: "lapsed",
    });
  });
});

describe("tracking numbers in words and letters", () => {
  it("finds Russian Post numbers as people copy them, and no longer runs", () => {
    expect(
      parcelNumbersIn(
        "трек 1010 0012 3456 78, ещё ra123456785ru и карта 4276 1234 5678 9012"
      )
    ).toEqual([number, "RA123456785RU"]);
    // A whole number followed by digits is still one; a card's tail is none.
    expect(parcelNumbersIn(`следи за ${number} 10100012345679`)).toEqual([
      number,
      "10100012345679",
    ]);
    expect(parcelNumbersIn(`трек ${number} 2 шт`)).toEqual([number]);
    expect(parcelNumbersIn("трек 1010 0012 3456 78 2 шт")).toEqual([number]);
    // A short number before the groups does not hide the real one.
    for (const text of [
      "заказ №12 8008 0123 4567 89",
      "отправил 16.10 8008 0123 4567 89",
      "в 12:30 8008 0123 4567 89",
    ]) {
      expect(parcelNumbersIn(text)).toContain("80080123456789");
    }
    expect(parcelNumbersIn("размеры 42 44 46 48 50 52 54 56")).toEqual([]);
    expect(parcelNumbersIn("заказ 123456789012345 от 15.10")).toEqual([]);
  });

  it("starts nothing on its own from digits that may be more than one number", () => {
    expect(certainParcelNumbersIn("трек 1010 0012 3456 78 2 шт")).toEqual([
      number,
    ]);
    expect(
      certainParcelNumbersIn(`Отправление ${number}, а ещё RA123456785RU`)
    ).toEqual([number, "RA123456785RU"]);
    // Two stretches of 14 digits, or one that a card's tail ends with.
    for (const text of [
      "заказ №12 8008 0123 4567 89",
      "в 12:30 8008 0123 4567 89",
      "карта 4276 1234 5678 9012 34",
    ]) {
      expect(certainParcelNumbersIn(text)).toEqual([]);
    }
    expect(parcelNumbersIn("карта 4276 1234 5678 9012 34")).toEqual([
      "12345678901234",
    ]);
  });

  it("takes numbers only from the carrier's own letters", () => {
    expect(
      carrierLetterNumbers([
        {
          from: "Почта России <noreply@pochta.ru>",
          id: "m1",
          snippet: `Отправление ${number} прибыло в отделение`,
          subject: "Посылка ждёт вас",
        },
        {
          from: "Магазин <shop@example.ru>",
          id: "m2",
          snippet: "Передали в Почту России: RA123456785RU",
          subject: "Заказ отправлен",
        },
        {
          from: "Почта России <news@pochta.ru.example.com>",
          id: "m3",
          snippet: "Трек 10100012345679",
          subject: "Акция",
        },
        {
          from: "Почта России <noreply@pochta.ru>",
          id: "m4",
          snippet: "Заказ №12 8008 0123 4567 89 передан в доставку",
          subject: "Отправление в пути",
        },
      ])
    ).toEqual(new Map([["m1", [number]]]));
  });
});
