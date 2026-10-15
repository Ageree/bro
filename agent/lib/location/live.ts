import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { findChannelIdentity } from "@db/services/channel-identities";
import {
  evaluatePlaceReminders,
  insertPoint,
  locationPilot,
  recentLiveWrite,
} from "@db/services/location";
import { env } from "@shared/environment";
import { accessScopeForUser } from "@shared/identity/access-scope";
import { distanceM, liveKeyOf } from "@shared/location/geometry";

/**
 * The edits of a Telegram live location (`docs/location.md`, «Живая
 * трансляция»). eve's Telegram channel drops `edited_message`, so the VM's
 * bridge posts each edit that carries a location here, with the webhook's
 * secret header (`scripts/cloudru-app-host/tg-bridge/`, flag
 * `TG_BRIDGE_LIVE_LOCATION`). No model turn starts and no message quota is
 * spent: an edit only moves the person's place reminders (a hit's report
 * waits for the schedule tick) and, now and then, is stored as a point of
 * the track. Anything that is not the person's own private chat with Bro in
 * the geolocation pilot is answered 200 and dropped, so the bridge never
 * retries it; only a wrong secret is refused.
 */

export const telegramLocationPath = "/eve/v1/telegram-location";

/** An edit's body is a few hundred bytes; more is not one. */
const bodyCapBytes = 16 * 1024;
/** The reminders are run on a live share at most this often. */
const evaluateEveryMs = 15_000;
/** A live share's point is stored when this much later than the last… */
const storeEveryMs = 60_000;
/** …or this far from it. */
const storeAfterM = 50;
/** Live shares whose last run this instance remembers. */
const rememberedShares = 1_000;

const secretHeader = "x-telegram-bot-api-secret-token";

const editSchema = z.object({
  edited_message: z.object({
    chat: z.object({ id: z.number().int(), type: z.string() }),
    date: z.number().int().positive(),
    edit_date: z.number().int().positive(),
    from: z.object({ id: z.number().int(), is_bot: z.boolean() }),
    location: z.object({
      horizontal_accuracy: z.number().min(0).max(1_500).optional(),
      latitude: z.number().min(-90).max(90),
      live_period: z.number().int().positive().optional(),
      longitude: z.number().min(-180).max(180),
    }),
    message_id: z.number().int().positive(),
  }),
  update_id: z.number().int(),
});

/**
 * When each live share last ran the reminders, by its key: the edit's own
 * time. One eve serves the database (`docs/dev-notes.md`), so this instance
 * sees every edit; after a restart the stored track says which edits are old.
 */
const evaluated = new Map<string, number>();

function rememberEvaluated(liveKey: string, at: number) {
  evaluated.delete(liveKey);
  evaluated.set(liveKey, at);
  for (const oldest of evaluated.keys()) {
    if (evaluated.size <= rememberedShares) break;
    evaluated.delete(oldest);
  }
}

/** Whether the request carries the webhook's secret; fails closed. */
function trusted(request: Request) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
  const given = request.headers.get(secretHeader);
  if (!secret || given === null) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function answer(
  body: Readonly<Record<string, boolean | number>>,
  status = 200
) {
  return Response.json(body, { status });
}

/** The edit in the body, or undefined for anything else. */
async function readEdit(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > bodyCapBytes) return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text) > bodyCapBytes) return undefined;
  try {
    return editSchema.safeParse(JSON.parse(text)).data?.edited_message;
  } catch {
    return undefined;
  }
}

/**
 * One edit of a live location: checked, then run through the person's place
 * reminders at most every 15 s of the share's time, and stored when a
 * minute passed or the person moved 50 m since the last stored point. An
 * edit not newer than the last stored or run one does nothing.
 */
export async function receiveLiveLocation(request: Request, now = new Date()) {
  if (!trusted(request)) return answer({ ok: false }, 401);
  const edit = await readEdit(request);
  if (
    edit?.chat.type !== "private" ||
    edit.chat.id !== edit.from.id ||
    edit.from.is_bot
  ) {
    return answer({ ignored: true });
  }
  const identity = await findChannelIdentity("telegram", String(edit.from.id));
  if (!identity) return answer({ ignored: true });
  const scope = accessScopeForUser(`better-auth:${identity.userId}`);
  if (!locationPilot(scope)) return answer({ ignored: true });

  const liveKey = liveKeyOf(edit.chat.id, edit.message_id);
  const recordedAt = new Date(edit.edit_date * 1000);
  const at = recordedAt.getTime();
  const lastStored = await recentLiveWrite(scope, liveKey);
  const lastEvaluated = evaluated.get(liveKey);
  const newest = Math.max(
    lastStored?.recordedAt.getTime() ?? 0,
    lastEvaluated ?? 0
  );
  if (at <= newest) return answer({ stale: true });

  const point = {
    accuracyM:
      edit.location.horizontal_accuracy === undefined
        ? null
        : Math.round(edit.location.horizontal_accuracy),
    lat: edit.location.latitude,
    lon: edit.location.longitude,
  };
  const evaluate =
    lastEvaluated === undefined || at - lastEvaluated >= evaluateEveryMs;
  // The edit that ends the share (no `live_period`) is the last known point.
  const ended = edit.location.live_period === undefined;
  const store =
    ended ||
    !lastStored ||
    at - lastStored.recordedAt.getTime() >= storeEveryMs ||
    distanceM(lastStored, point) >= storeAfterM;

  const hits = evaluate
    ? await evaluatePlaceReminders(
        scope,
        {
          ...point,
          arriveAllowed: true,
          leaveAllowed: true,
          live: true,
          recordedAt,
        },
        { now, via: "live" }
      )
    : [];
  if (evaluate) rememberEvaluated(liveKey, at);
  const stored = store
    ? (await insertPoint(scope, {
        ...point,
        address: null,
        externalId: `telegram:${String(edit.chat.id)}:${String(edit.message_id)}:${String(edit.edit_date)}`,
        kind: "position",
        label: null,
        liveKey,
        recordedAt,
        source: "telegram_live",
      })) !== undefined
    : false;
  console.info("[location] live", {
    ended,
    evaluated: evaluate,
    hits: hits.length,
    stored,
    workspaceId: scope.workspaceId,
  });
  return answer({ evaluated: evaluate, hits: hits.length, stored });
}
