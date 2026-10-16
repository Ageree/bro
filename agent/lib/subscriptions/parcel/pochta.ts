import { z } from "zod";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import type { ParcelStatus } from "@shared/subscriptions/parcel";

/**
 * A parcel's status at Russian Post, read the way its own tracking page reads
 * it: one plain GET of the site's JSON, no browser, no account. It answers
 * from a server in Russia (Selectel, 15.10: 0.1–0.2 s) and refuses a foreign
 * address with an HTML page and 417. The official API (`rtm34`) needs a
 * login, and gives 100 readings a day on a plain sign-up.
 */
const trackingUrl =
  "https://www.pochta.ru/api/tracking/api/v1/trackings/by-barcodes";

/** One item's answer is 3–10 KB; a much bigger one is not it. */
const maximumAnswerBytes = 512 * 1024;

const browserUserAgent =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/**
 * Russian Post's operation codes (tracking.pochta.ru, «Коды операций»): 2
 * handed over (attribute 2: to the sender), 3 a return, 6 storage, 12 a
 * failed delivery attempt (it waits at the office), 16 destroyed, 18 lost,
 * 8 processing, whose attributes below say it waits to be collected.
 */
const handedOver = 2;
const toTheSender = 2;
const returning = 3;
const storage = 6;
const failedAttempt = 12;
const lostTypes: ReadonlySet<number> = new Set([16, 18]);
const processing = 8;
const registeredTypes: ReadonlySet<number> = new Set([13, 20, 27, 28, 37]);
/**
 * Processing that means it waits to be collected: at the place of delivery
 * (2), in a locker (9), at a pickup centre (14), its storage running out or
 * extended (10, 23, 27, 28, 33, 35, 42, 43) or over (40).
 */
const waitingAttributes: ReadonlySet<number> = new Set([
  2, 9, 10, 14, 23, 27, 28, 33, 35, 40, 42, 43,
]);
/** Storage running out within two days: 10 (a locker), 42 and 43. */
const endingAttributes: ReadonlySet<number> = new Set([10, 42, 43]);

/** A day as `YYYY-MM-DD` on Moscow's clock, where the carrier counts days. */
function moscowDay(at: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Moscow",
    year: "numeric",
  }).format(at);
}

/** A field of the carrier's that does not read as expected is left out. */
const text = z.string().nullish().catch(null);
const code = z.number().int().nullish().catch(null);
const flag = z.boolean().nullish().catch(null);
/**
 * A date the carrier gives as `YYYY-MM-DD`: an ISO date or date-time (its
 * own day, whatever the offset says), «20.10.2026», or epoch milliseconds.
 */
const day = z
  .union([
    z
      .number()
      .int()
      .min(0)
      .max(8_640_000_000_000_000)
      .transform((at) => moscowDay(new Date(at))),
    z.string().transform(dayOfText),
  ])
  .nullish()
  .catch(null);

const operationSchema = z.object({
  cityName: text,
  date: text,
  description: text,
  humanStatus: text,
  index: text,
  operationAttr: code,
  operationType: code,
});

const trackingItemSchema = z.object({
  barcode: z.string(),
  commonStatus: text,
  endStorageDate: day,
  hasBeenGiven: flag,
  isReturned: flag,
  lastDayInOps: day,
  lastOperationAttr: code,
  lastOperationType: code,
  shipmentTripInfo: z
    .object({
      expectedDeliveryDate: day,
      expectedDeliveryDateAvailable: flag,
      isExpectedDeliveryDateAvailable: flag,
    })
    .nullish()
    .catch(null),
  title: text,
  trackingHistoryItemList: z.array(operationSchema).nullish().catch(null),
  trackingItemOperationGroupStatuses: z
    .array(
      z.object({
        originTrackingHistoryItems: z
          .array(operationSchema)
          .nullish()
          .catch(null),
      })
    )
    .nullish()
    .catch(null),
});

const answerSchema = z.object({
  detailedTrackings: z.array(
    z.object({ trackingItem: trackingItemSchema.nullish().catch(null) })
  ),
});

type TrackingItem = z.output<typeof trackingItemSchema>;
type Operation = z.output<typeof operationSchema>;

/**
 * What a reading found: the parcel as code sees it, or why there is none —
 * the carrier refused the request (`blocked`), it did not answer
 * (`unreachable`), or its answer did not read (`unreadable`).
 */
export type ParcelRead =
  | {
      readonly kind: "parcel";
      readonly status: ParcelStatus;
      readonly expectedOn: string | null;
      readonly storageUntil: string | null;
      /** The carrier says its storage ends within two days. */
      readonly storageEnding: boolean;
      readonly place: string | null;
      readonly lastEvent: string | null;
      readonly lastEventAt: string | null;
      readonly title: string | null;
    }
  | {
      readonly kind: "blocked" | "unreachable" | "unreadable";
      readonly reason: string;
    };

function dayOfText(value: string) {
  const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(value)?.[1];
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})/u.exec(value);
  const candidate =
    iso ?? (dotted ? dotted.slice(1, 4).toReversed().join("-") : undefined);
  return z.iso.date().safeParse(candidate).data ?? null;
}

/** The newest operation in the answer, from its every list. */
function newestOperation(item: TrackingItem) {
  const operations: Operation[] = [
    ...(item.trackingHistoryItemList ?? []),
    ...(item.trackingItemOperationGroupStatuses ?? []).flatMap(
      (group) => group.originTrackingHistoryItems ?? []
    ),
  ];
  let newest: { at: number; operation: Operation } | undefined;
  for (const operation of operations) {
    const at = Date.parse(operation.date ?? "");
    if (Number.isNaN(at)) continue;
    if (!newest || at > newest.at) newest = { at, operation };
  }
  return newest;
}

function statusOf(
  item: TrackingItem,
  type: number | null,
  attribute: number | null,
  storageUntil: string | null
): ParcelStatus {
  if (type === handedOver) {
    return attribute === toTheSender ? "returned" : "delivered";
  }
  if (item.hasBeenGiven === true) return "delivered";
  if (type === returning || item.isReturned === true) return "returned";
  if (type !== null && lostTypes.has(type)) return "lost";
  if (
    type === storage ||
    type === failedAttempt ||
    (type === processing &&
      attribute !== null &&
      waitingAttributes.has(attribute)) ||
    storageUntil !== null
  ) {
    return "arrived";
  }
  if (type === null) return "unknown";
  return registeredTypes.has(type) ? "registered" : "in_transit";
}

/** Text of the carrier's, kept short: a reading goes into a report. */
function clipped(value: string | null | undefined, length: number) {
  const words = value?.replaceAll(/\s+/gu, " ").trim();
  if (!words) return null;
  return words.length <= length ? words : `${words.slice(0, length - 1)}…`;
}

/**
 * Reads Russian Post's answer for one number. An item without a single
 * operation is a number the carrier does not know yet (`unknown`): its site
 * answers any well-formed number with an empty one. Throws on text that is
 * not JSON.
 */
export function pochtaReading(body: string, number: string): ParcelRead {
  const parsed = answerSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return { kind: "unreadable", reason: "shape" };
  const item = parsed.data.detailedTrackings
    .map((tracking) => tracking.trackingItem)
    .find((tracking) => tracking?.barcode.toUpperCase() === number);
  if (!item) return { kind: "unreadable", reason: "no-item" };
  const newest = newestOperation(item);
  const type =
    newest?.operation.operationType ?? item.lastOperationType ?? null;
  const attribute =
    newest?.operation.operationAttr ?? item.lastOperationAttr ?? null;
  const storageUntil = item.endStorageDate ?? item.lastDayInOps ?? null;
  const status = statusOf(item, type, attribute, storageUntil);
  const trip = item.shipmentTripInfo;
  const expectedOn =
    trip?.isExpectedDeliveryDateAvailable === true ||
    trip?.expectedDeliveryDateAvailable === true
      ? (trip.expectedDeliveryDate ?? null)
      : null;
  const place = newest
    ? (newest.operation.description ??
      [newest.operation.index, newest.operation.cityName]
        .filter(Boolean)
        .join(", "))
    : null;
  return {
    expectedOn,
    kind: "parcel",
    lastEvent: clipped(newest?.operation.humanStatus ?? item.commonStatus, 200),
    lastEventAt: newest ? new Date(newest.at).toISOString() : null,
    place: clipped(place, 120),
    status,
    storageEnding:
      status === "arrived" &&
      type === processing &&
      attribute !== null &&
      endingAttributes.has(attribute),
    storageUntil: status === "arrived" ? storageUntil : null,
    title: clipped(item.title, 120),
  };
}

/** Answers that are a refusal, not an outage: 417 is its foreign block. */
const blockingStatuses = new Set([
  "http 401",
  "http 403",
  "http 417",
  "http 418",
  "http 429",
  "http 451",
]);

/** Reads one number at Russian Post; nothing about the parcel is logged. */
export async function readPochtaParcel(number: string): Promise<ParcelRead> {
  const url = new URL(trackingUrl);
  url.searchParams.set("language", "ru");
  url.searchParams.set("track-numbers", number);
  const download = await downloadWithin(url, maximumAnswerBytes, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "ru-RU,ru;q=0.9",
      referer: `https://www.pochta.ru/tracking?barcode=${number}`,
      "user-agent": browserUserAgent,
    },
  });
  if (download.kind === "oversize") {
    return { kind: "unreadable", reason: "oversize" };
  }
  if (download.kind === "failed") {
    return blockingStatuses.has(download.reason)
      ? { kind: "blocked", reason: download.reason }
      : { kind: "unreachable", reason: download.reason };
  }
  const body = new TextDecoder().decode(download.bytes);
  try {
    return pochtaReading(body, number);
  } catch {
    // A block page in place of the answer reads as HTML.
    return /<html/iu.test(body.slice(0, 2_000))
      ? { kind: "blocked", reason: "html" }
      : { kind: "unreadable", reason: "not-json" };
  }
}
