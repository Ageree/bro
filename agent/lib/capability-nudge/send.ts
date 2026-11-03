import type { AttachSessionFn } from "eve/channels";
import { untriedCapabilities, tipsPilot } from "@agent/lib/capability-tips";
import { sendCodeNotice } from "@agent/lib/delivery/code-notice";
import {
  claimCapabilityTip,
  listQuietWorkspaces,
  readCapabilityHistory,
} from "@db/services/capability-tips";
import {
  readRememberedConversations,
  rememberedMessenger,
} from "@db/services/proactive";
import { readProactiveMessages } from "@db/services/user-profile";

const day = 24 * 60 * 60_000;

/** A person is quiet after this long without a message of their own… */
const quietMs = 3 * day;
/** …and is let go after this: whoever left for good is not pestered. */
const goneMs = 30 * day;
/** Someone who only tried Bro once or twice has no habit to remind of. */
const minTurns = 3;
/** One nudge in a week, three in all. */
const restMs = 7 * day;
const maxNudges = 3;
const nudgesPerTick = 20;

/** Moscow day hours, in UTC: 10:00–20:00. */
const firstHourUtc = 7;
const lastHourUtc = 17;

const nudgeKey = "nudge";

/**
 * What Bro writes first to someone who went quiet: one sentence on one
 * thing they have not tried, in plain text. No buttons and no keyboard: the
 * person just answers in the chat.
 */
export function nudgeText(invite: string) {
  return `Давно не болтали. Кстати, я могу ${invite}. Напиши, что нужно, — займусь.`;
}

/**
 * Once an hour by day: people who talked to Bro, then went quiet for three
 * days, hear from it with one thing it can do that they never asked for
 * (CAPABILITY_TIPS_WORKSPACES, the same pilot as the tips in replies).
 * Code's own words, no model. Not to a person who turned Bro's first messages
 * off, and not to one with no messenger (the web chat has no push).
 */
export async function nudgeQuietPeople(
  delivery: { readonly attachSession?: AttachSessionFn },
  now: Date
) {
  const hour = now.getUTCHours();
  if (hour < firstHourUtc || hour > lastHourUtc) return;
  const quiet = await listQuietWorkspaces(now, {
    goneMs,
    limit: nudgesPerTick * 5,
    minTurns,
    quietMs,
  });
  let sent = 0;
  for (const scope of quiet) {
    if (sent >= nudgesPerTick) return;
    // oxlint-disable-next-line eslint/no-await-in-loop -- one person at a time keeps the tick's reads and sends bounded.
    if (await nudgeOne(delivery, scope, now)) sent += 1;
  }
}

async function nudgeOne(
  delivery: { readonly attachSession?: AttachSessionFn },
  scope: { readonly userId: string; readonly workspaceId: string },
  now: Date
) {
  try {
    if (!tipsPilot(scope)) return false;
    if (!(await readProactiveMessages(scope))) return false;
    const remembered = await readRememberedConversations(scope.workspaceId);
    const target = remembered && rememberedMessenger(remembered);
    if (!target) return false;
    const use = await readCapabilityHistory(scope.workspaceId);
    const { untried } = await untriedCapabilities(
      scope,
      target.conversationChannel === "telegram" ? "telegram" : "web",
      use
    );
    const offer = untried.find((capability) => !capability.setup);
    if (!offer) return false;
    const claimed = await claimCapabilityTip(
      scope.workspaceId,
      [nudgeKey],
      { limit: 1, maxOffers: maxNudges, restMs, spacingMs: day },
      now
    );
    if (claimed.length === 0) return false;
    await sendCodeNotice(
      delivery,
      {
        ...target,
        about: {},
        userId: scope.userId,
        workspaceId: scope.workspaceId,
      },
      nudgeText(offer.invite)
    );
    console.info("[capabilities] nudge", { offered: offer.id });
    return true;
  } catch (error) {
    console.warn("[capabilities] nudge failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}
