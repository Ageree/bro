import { z } from "zod";
import {
  followsLiveLocation,
  liveSharingSeen,
  recordShared,
  sharedBefore,
  type SharedPoint,
} from "@db/services/location";
import { readWorkspaceTimeZone } from "@db/services/user-profile";
import type { AccessScope } from "@shared/identity/access-scope";
import { pointAddress } from "./address";
import { hitLine, sharedLine } from "./note";
import type { CardPoint } from "./vcf";

/** What of a failed write is safe to log: the error's kind and SQLSTATE. */
const failureSchema = z.object({
  cause: z.object({ code: z.string() }).optional().catch(undefined),
  name: z.string(),
});

/**
 * Stores the points the person's own message shared and runs each through
 * their place reminders (`recordShared`), then gives the turn's context
 * lines: one per point, and one per reminder it fired, which this very
 * turn says (`via: "message"`). A failed write still gets its point's line,
 * without an address: the person sent it, and the turn should know.
 */
export async function ingestShared(
  scope: AccessScope,
  points: readonly SharedPoint[]
): Promise<string[]> {
  const timeZone = await readWorkspaceTimeZone(scope).catch(
    () => "Europe/Moscow"
  );
  const lines: string[] = [];
  for (const point of points) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- A message shares one point, rarely a few; each fires reminders in order.
    lines.push(...(await ingestOne(scope, point, timeZone)));
  }
  return lines;
}

/** A shared point as its context line reads it, with what is known. */
function noted(point: SharedPoint, address: string | null) {
  return {
    accuracyM: point.accuracyM ?? null,
    address,
    kind: point.kind,
    label: point.label ?? null,
    lat: point.lat,
    liveKey: point.liveKey ?? null,
    lon: point.lon,
    recordedAt: point.recordedAt,
    source: point.source,
  };
}

async function ingestOne(
  scope: AccessScope,
  point: SharedPoint,
  timeZone: string
) {
  try {
    const { hits, row } = await recordShared(scope, point, { via: "message" });
    // Where Bro follows a live share, a single Telegram point too asks
    // whether one was ever seen (`sharedLine`).
    const watching = await followsLiveLocation(scope);
    const asksLive =
      (point.liveKey ?? null) !== null ||
      (watching && point.kind === "position" && point.source === "telegram");
    const [address, firstEver, liveSeen] = await Promise.all([
      row ? pointAddress(scope, row) : (point.address ?? null),
      row ? sharedBefore(scope, row.id).then((before) => !before) : false,
      asksLive ? liveSharingSeen(scope) : false,
    ]);
    console.info("[location] shared", {
      hits: hits.length,
      kind: point.kind,
      source: point.source,
      stored: row !== undefined,
      workspaceId: scope.workspaceId,
    });
    return [
      sharedLine(noted(point, address), {
        firstEver,
        liveSeen,
        timeZone,
        watching,
      }),
      ...hits.map(hitLine),
    ];
  } catch (error) {
    const failure = failureSchema.safeParse(error).data;
    console.warn("[location] record failed", {
      error: failure?.name,
      sqlState: failure?.cause?.code,
      workspaceId: scope.workspaceId,
    });
    return [
      sharedLine(noted(point, point.address ?? null), {
        firstEver: false,
        liveSeen: false,
        timeZone,
      }),
    ];
  }
}

/**
 * A location card from iMessage as a shared point: where the person is when
 * Apple named it their current location, and then it only says they arrived
 * (iMessage has no live share, and a card says nothing of accuracy).
 */
export function iMessageShare(
  card: CardPoint,
  messageId: string,
  index: number,
  now = new Date()
): SharedPoint {
  return {
    accuracyM: null,
    address: null,
    arriveAllowed: card.kind === "position",
    externalId: `imessage:${messageId}:${String(index)}`,
    kind: card.kind,
    label: card.label,
    lat: card.lat,
    leaveAllowed: false,
    live: false,
    liveKey: null,
    lon: card.lon,
    recordedAt: now,
    source: "imessage",
  };
}
