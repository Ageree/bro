import { NextResponse } from "next/server";
import type * as z from "zod";
import {
  countCardResponses,
  markCardWatched,
  readCardByLink,
  readCardPress,
  readCardResponse,
  saveCardResponse,
  saveCardIntent,
} from "@db/services/cards";
import { channelAccountScope } from "@db/services/channel-identities";
import { cardsEnabled } from "@shared/cards/pilot";
import {
  type respondReplySchema,
  respondRequestSchema,
} from "@shared/cards/respond";
import { cardResponseSchema, describeCardAnswer } from "@shared/cards/response";
import { secretInAnswer } from "@shared/cards/safety";
import { applicationOrigin } from "@shared/environment/origin";
import { telegramWebAppUser } from "@web/auth/telegram-web-app";

/** Answers a workspace's cards take in `windowMs`: each one is a turn of Bro's. */
const answersPerWindow = 10;
const windowMs = 10 * 60_000;

const reply = (body: z.input<typeof respondReplySchema>, status = 200) =>
  NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
    status,
  });

/**
 * The answer of an interactive card (`docs/cards.md`), from its page
 * (`app/(public)/card/[id]`): `open` asks whether this viewer may answer and
 * what they already answered, `send` keeps the answer the person gave with a
 * submit button, and `watch` tells the open page how the card and their
 * latest press stand (`docs/cards-apps.md`, 3.1), noting that the card is
 * open in front of them. Only the person the card was sent to: Telegram's signed
 * launch data of the Mini App (`telegramWebAppUser`) names the user, and
 * their Telegram is bound to the card's owner. Anyone else who opens a
 * forwarded link reads the card, never an answer, and cannot send one.
 *
 * The answer is checked against the card at its revision
 * (`cardResponseSchema`), its fields against the secrets a card never takes
 * (`secretInAnswer`), and kept once per revision; the turn it becomes in the
 * chat is Bro's to send (`agent/lib/cards/answers.ts`).
 */
export async function POST(
  request: Request,
  { params }: RouteContext<"/api/cards/[id]/respond">
) {
  const { id } = await params;
  if (request.headers.get("origin") !== applicationOrigin()) {
    return reply({ status: "refused" }, 403);
  }
  const body = respondRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!body.success) return reply({ status: "malformed" }, 400);
  const found = await readCardByLink(id);
  if (!found) return reply({ status: "gone" }, 404);
  if (found.conversationId === null || !cardsEnabled(found)) {
    return reply({ status: "closed" }, 403);
  }
  const telegramUserId = telegramWebAppUser(body.data.initData, {
    notBefore: found.createdAt,
  });
  if (telegramUserId === undefined) return reply({ status: "unverified" }, 403);
  const owner = await channelAccountScope("telegram", telegramUserId);
  if (
    owner?.userId !== found.userId ||
    owner.workspaceId !== found.workspaceId
  ) {
    return reply({ status: "foreign" }, 403);
  }
  if (body.data.kind === "watch") {
    const [, press, answered] = await Promise.all([
      markCardWatched(found.id, new Date()),
      readCardPress(found.id),
      readCardResponse(found.id, found.revision),
    ]);
    return reply({
      answer:
        answered === undefined
          ? undefined
          : {
              answer: { action: answered.action, values: answered.values },
              delivery: answered.state,
            },
      card: body.data.revision === found.revision ? undefined : found.card,
      press,
      revision: found.revision,
      status: "watch",
    });
  }
  if (body.data.revision !== found.revision) {
    return reply({ status: "stale" }, 409);
  }
  const kept = await readCardResponse(found.id, found.revision);
  if (body.data.kind === "open") {
    return reply(
      kept === undefined
        ? { status: "open" }
        : {
            answer: { action: kept.action, values: kept.values },
            delivery: kept.state,
            status: "sent",
          }
    );
  }
  const parsed = cardResponseSchema(found.card, found.revision).safeParse({
    action: body.data.action,
    revision: body.data.revision,
    values: body.data.values,
  });
  if (!parsed.success) {
    return reply(
      {
        issues: parsed.error.issues.map((issue) => ({
          id:
            issue.path[0] === "values" && issue.path.length > 1
              ? String(issue.path[1])
              : null,
          message: issue.message,
        })),
        status: "invalid",
      },
      422
    );
  }
  const secret = secretInAnswer(found.card, parsed.data);
  if (secret !== undefined) {
    return reply({ id: secret.id, kind: secret.kind, status: "secret" }, 422);
  }
  const sent = body.data;
  const intent = found.card.actions.some(
    (action) => "intent" in action && action.intent === sent.action
  );
  if (
    body.data.item !== undefined &&
    !found.card.blocks.some(
      (block) =>
        block.type === "choice" &&
        block.options.some((option) => option.value === sent.item)
    )
  ) {
    return reply(
      {
        status: "invalid",
        issues: [{ id: null, message: "Такого варианта в карточке нет." }],
      },
      422
    );
  }
  if (intent) {
    if (kept)
      return reply(
        {
          status: "answered",
          answer: { action: kept.action, values: kept.values },
          delivery: kept.state,
        },
        409
      );
    const outcome = await saveCardIntent(found, {
      answer: parsed.data,
      item: body.data.item,
      summary: describeCardAnswer(found.card, parsed.data).text,
      telegramUserId,
    });
    if (outcome === "busy") return reply({ status: "busy" }, 429);
    return reply({
      status: "intent",
      outcome,
      press: await readCardPress(found.id),
    });
  }
  if (
    kept === undefined &&
    (await countCardResponses(
      found.workspaceId,
      new Date(Date.now() - windowMs)
    )) >= answersPerWindow
  ) {
    return reply({ status: "busy" }, 429);
  }
  const saved = await saveCardResponse(found, {
    answer: parsed.data,
    summary: describeCardAnswer(found.card, parsed.data).text,
    telegramUserId,
  });
  return reply(
    {
      answer: saved.answer,
      delivery: saved.state,
      status: saved.outcome === "answered" ? "answered" : "sent",
    },
    saved.outcome === "answered" ? 409 : 200
  );
}
