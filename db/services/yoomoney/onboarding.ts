import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import * as z from "zod";
import { db, yoomoneyAuthorizations, yoomoneyOnboardings } from "@db";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { ensureScope } from "@db/services/scope";
import { applicationOrigin } from "@shared/environment/origin";
import type { AccessScope } from "@shared/identity/access-scope";
import { readYoomoneyAccount } from "@shared/yoomoney/api";
import { startYoomoneyAuthorization, withYoomoneyToken } from "./connection";

/**
 * Connecting the wallet from a chat, the first time a payment needs it: Bro
 * sends a link (a button in Telegram) to `/yoomoney/<id>`, a page of three
 * steps — sign in to YooMoney or open a wallet there, allow Bro to pay,
 * link a card — and once the person is through, Bro carries on in the chat
 * by itself (`agent/lib/yoomoney/onboarding.ts`).
 *
 * The link opens the page, never the wallet: the page acts only for a
 * device that proved it is the person's — signed in to the cabinet as
 * them, or Telegram's signed data of the chat's own user. Otherwise a link
 * sent to someone else would connect their wallet to this person's Bro.
 */

type Onboarding = typeof yoomoneyOnboardings.$inferSelect;

/** How long the link opens the page: the person's moment. */
const lifetimeMs = 30 * 60_000;

/** A connected wallet whose page was left on the card step, after this. */
const cardStepMs = 10 * 60_000;

/** The cookie of the device that proved it is the person's. */
export const yoomoneyOnboardingCookie = "bro_yoomoney";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function linkToken(id: string) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secretEncryptionKey, "base64"),
      Buffer.alloc(0),
      "bro-yoomoney-onboarding-link",
      32
    )
  );
  return createHmac("sha256", key).update(id).digest("base64url");
}

const sameText = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** The page's address, as Bro sends it. */
export async function yoomoneyOnboardingLink(id: string) {
  const url = new URL(`/yoomoney/${id}`, applicationOrigin());
  url.searchParams.set("t", await linkToken(id));
  return url.toString();
}

/**
 * The page for this person, asked for in this chat: the one already open
 * here for a while yet, so a second ask does not cut short a consent under
 * way; otherwise a new one, and an earlier page of the workspace left
 * unconnected stops opening.
 */
export async function startYoomoneyOnboarding(
  scope: AccessScope,
  chat: Pick<Onboarding, "conversationChannel" | "conversationId">
) {
  await ensureScope(scope);
  const now = new Date();
  const [open] = await db
    .select({ id: yoomoneyOnboardings.id })
    .from(yoomoneyOnboardings)
    .where(
      and(
        eq(yoomoneyOnboardings.workspaceId, scope.workspaceId),
        eq(yoomoneyOnboardings.userId, scope.userId),
        eq(yoomoneyOnboardings.conversationChannel, chat.conversationChannel),
        eq(yoomoneyOnboardings.conversationId, chat.conversationId),
        isNull(yoomoneyOnboardings.connectedAt),
        gt(yoomoneyOnboardings.expiresAt, new Date(now.getTime() + 10 * 60_000))
      )
    )
    .limit(1);
  if (open) return { id: open.id, url: await yoomoneyOnboardingLink(open.id) };
  await db
    .delete(yoomoneyOnboardings)
    .where(
      or(
        and(
          eq(yoomoneyOnboardings.workspaceId, scope.workspaceId),
          isNull(yoomoneyOnboardings.connectedAt)
        ),
        lt(
          yoomoneyOnboardings.expiresAt,
          new Date(now.getTime() - 7 * 86_400_000)
        )
      )
    );
  const id = randomUUID();
  await db.insert(yoomoneyOnboardings).values({
    ...scope,
    ...chat,
    id,
    expiresAt: new Date(now.getTime() + lifetimeMs),
  });
  return { id, url: await yoomoneyOnboardingLink(id) };
}

/** The page this link opens, while it does. */
export async function readYoomoneyOnboardingByLink(id: string, token: string) {
  if (!z.uuid().safeParse(id).success) return undefined;
  if (!sameText(token, await linkToken(id))) return undefined;
  const [onboarding] = await db
    .select()
    .from(yoomoneyOnboardings)
    .where(
      and(
        eq(yoomoneyOnboardings.id, id),
        gt(yoomoneyOnboardings.expiresAt, new Date())
      )
    )
    .limit(1);
  return onboarding;
}

/** Whether this device proved it is the person's, on this page. */
export function onYoomoneyOnboardingDevice(
  onboarding: Pick<Onboarding, "deviceHash">,
  cookie: string | undefined
) {
  return (
    onboarding.deviceHash !== null &&
    cookie !== undefined &&
    sameText(hash(cookie), onboarding.deviceHash)
  );
}

/**
 * The Telegram user a private chat is with: its chat id
 * (`agent/lib/telegram-conversation.ts` keeps the token's shape). A group
 * chat's id is negative and names no one.
 */
const telegramUserOf = (conversationId: string) =>
  /^(?<chatId>\d{1,20}):\d*:\d*$/u.exec(conversationId)?.groups?.chatId;

/**
 * Takes the page for this device once it proves it is the person's: the
 * cabinet's session of the same person, or Telegram's signed data of the
 * user the chat is with. A new device that proves it takes the page over.
 * The cookie's value to set, or undefined: not proved.
 */
export async function claimYoomoneyOnboardingDevice(
  onboarding: Onboarding,
  proof:
    | { readonly kind: "session"; readonly userId: string }
    | { readonly kind: "telegram"; readonly telegramUserId: string }
) {
  const proved =
    proof.kind === "session"
      ? proof.userId === onboarding.userId
      : onboarding.conversationChannel === "telegram" &&
        telegramUserOf(onboarding.conversationId) === proof.telegramUserId;
  if (!proved) return undefined;
  const secret = randomBytes(32).toString("base64url");
  await db
    .update(yoomoneyOnboardings)
    .set({ deviceHash: hash(secret) })
    .where(eq(yoomoneyOnboardings.id, onboarding.id));
  return secret;
}

const scopeOf = (onboarding: Pick<Onboarding, "workspaceId" | "userId">) => ({
  workspaceId: onboarding.workspaceId,
  userId: onboarding.userId,
});

/** YooMoney's consent page, started from this page. */
export async function startYoomoneyOnboardingConsent(
  onboarding: Onboarding,
  origin: string
) {
  return startYoomoneyAuthorization(scopeOf(onboarding), origin, onboarding.id);
}

/**
 * The page a consent's state was started on, if any, for YooMoney's
 * callback: where it sends the person back, and — when this device proved
 * it is the person's there — whose consent it is, as the cabinet's session
 * says elsewhere.
 */
export async function yoomoneyOnboardingOfState(
  state: string,
  cookie: string | undefined
) {
  const [attempt] = await db
    .select({
      id: yoomoneyOnboardings.id,
      workspaceId: yoomoneyOnboardings.workspaceId,
      userId: yoomoneyOnboardings.userId,
      deviceHash: yoomoneyOnboardings.deviceHash,
    })
    .from(yoomoneyAuthorizations)
    .innerJoin(
      yoomoneyOnboardings,
      eq(yoomoneyAuthorizations.onboardingId, yoomoneyOnboardings.id)
    )
    .where(eq(yoomoneyAuthorizations.stateHash, hash(state)))
    .limit(1);
  if (attempt === undefined) return undefined;
  return {
    id: attempt.id,
    scope: onYoomoneyOnboardingDevice(attempt, cookie)
      ? scopeOf(attempt)
      : undefined,
  };
}

/**
 * The consent came back: the wallet is connected. With a card linked to it
 * the page is through; without, it asks for one. The page opens for
 * another half hour, for that step.
 */
export async function markYoomoneyOnboardingConnected(
  id: string,
  { cards }: { readonly cards: readonly string[] }
) {
  const now = new Date();
  await db
    .update(yoomoneyOnboardings)
    .set({
      connectedAt: now,
      readyAt: cards.length > 0 ? now : null,
      resumedAt: null,
      expiresAt: new Date(now.getTime() + lifetimeMs),
    })
    .where(eq(yoomoneyOnboardings.id, id));
}

/**
 * The card step: whether a card is linked to the wallet now. A card found,
 * or the person skipping the step, finishes the page.
 */
export async function checkYoomoneyOnboardingCard(onboarding: Onboarding) {
  const read = await withYoomoneyToken(
    scopeOf(onboarding),
    readYoomoneyAccount
  );
  if (!read.connected) return { connected: false as const };
  if (read.result.cards.length > 0) {
    await finishYoomoneyOnboarding(onboarding.id);
  }
  return { connected: true as const, cards: read.result.cards };
}

/** The page is through: Bro carries on in the chat. */
export async function finishYoomoneyOnboarding(id: string) {
  await db
    .update(yoomoneyOnboardings)
    .set({ readyAt: new Date() })
    .where(
      and(
        eq(yoomoneyOnboardings.id, id),
        isNotNull(yoomoneyOnboardings.connectedAt),
        isNull(yoomoneyOnboardings.readyAt)
      )
    );
}

/**
 * The pages through, or left on the card step, whose chat has not heard:
 * claimed by marking it heard, so one tick tells each once. Within a day
 * of the consent: a chat that never heard by then hears nothing.
 */
export async function claimYoomoneyOnboardingResumes(now: Date, limit = 10) {
  const due = await db
    .select({ id: yoomoneyOnboardings.id })
    .from(yoomoneyOnboardings)
    .where(
      and(
        isNull(yoomoneyOnboardings.resumedAt),
        gt(
          yoomoneyOnboardings.connectedAt,
          new Date(now.getTime() - 86_400_000)
        ),
        or(
          isNotNull(yoomoneyOnboardings.readyAt),
          lt(
            yoomoneyOnboardings.connectedAt,
            new Date(now.getTime() - cardStepMs)
          )
        )
      )
    )
    .limit(limit);
  if (due.length === 0) return [];
  return db
    .update(yoomoneyOnboardings)
    .set({ resumedAt: now })
    .where(
      and(
        inArray(
          yoomoneyOnboardings.id,
          due.map(({ id }) => id)
        ),
        isNull(yoomoneyOnboardings.resumedAt)
      )
    )
    .returning();
}

/** A resume that could not be sent goes to the next tick, within an hour. */
export async function releaseYoomoneyOnboardingResume(id: string, now: Date) {
  await db
    .update(yoomoneyOnboardings)
    .set({ resumedAt: null })
    .where(
      and(
        eq(yoomoneyOnboardings.id, id),
        gt(
          yoomoneyOnboardings.connectedAt,
          new Date(now.getTime() - 60 * 60_000)
        )
      )
    );
}

/**
 * The onboarding a resume turn names (its caller, which only Bro's tick
 * writes), when it is this person's and Bro told its chat within the hour:
 * that turn may prepare the payment the person asked for before connecting
 * — never pay it.
 */
export async function readYoomoneyOnboardingResume(
  scope: AccessScope,
  id: string
) {
  if (!z.uuid().safeParse(id).success) return undefined;
  const [onboarding] = await db
    .select({ id: yoomoneyOnboardings.id })
    .from(yoomoneyOnboardings)
    .where(
      and(
        eq(yoomoneyOnboardings.id, id),
        eq(yoomoneyOnboardings.workspaceId, scope.workspaceId),
        eq(yoomoneyOnboardings.userId, scope.userId),
        gt(yoomoneyOnboardings.resumedAt, new Date(Date.now() - 60 * 60_000))
      )
    )
    .limit(1);
  return onboarding;
}
