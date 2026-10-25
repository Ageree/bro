import { TRPCError } from "@trpc/server";
import * as z from "zod";
import {
  acceptOpenedBroInvite,
  createBroInvite,
  openBroInvite,
} from "@db/services/bro-to-bro/invites";
import {
  confirmBroLink,
  removeBroLink,
  setBroLinkCalendar,
  setBroLinkLabel,
  setBroLinkShareNotes,
} from "@db/services/bro-to-bro/links";
import { readBroThreadForSide } from "@db/services/bro-to-bro/threads";
import { applicationOrigin } from "@shared/environment/origin";
import {
  telegramLinkConfigured,
  telegramStartUrl,
} from "@shared/identity/telegram-link";
import { broToBroAccess, broToBroSwitchedOn } from "@web/auth/bro-to-bro";
import { createTRPCRouter, protectedProcedure } from "./init";

/** An invite token as `createBroInvite` mints it: base64url. */
export const broInviteTokenSchema = z.string().regex(/^[\w-]{16,64}$/u);

/** Why an invite cannot be accepted, in the person's words. */
export const broInviteRefusals = {
  unknown: "Такого приглашения нет. Попроси новую ссылку.",
  self: "Это твоё приглашение: отправь ссылку тому, кого зовёшь.",
  used: "Приглашение уже приняли. Попроси новую ссылку.",
  expired: "Срок приглашения истёк. Попроси новую ссылку.",
  already_linked: "Эта связь уже есть.",
  none: "Открой ссылку приглашения ещё раз.",
} as const;

function refuseInvite(kind: keyof typeof broInviteRefusals) {
  return new TRPCError({
    code: kind === "unknown" ? "NOT_FOUND" : "CONFLICT",
    message: broInviteRefusals[kind],
  });
}

const unavailable = "Бро-связи тебе пока недоступны.";
const linkGone = () =>
  new TRPCError({
    code: "NOT_FOUND",
    message: "Такой связи уже нет. Обнови страницу.",
  });

/** The person's own links and threads: on for them, or a link of theirs. */
const linkedProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if ((await broToBroAccess(ctx.scope)) === "off") {
    throw new TRPCError({ code: "FORBIDDEN", message: unavailable });
  }
  return next();
});

/** New links: only where Bro ↔ Bro is on for the workspace. */
const enabledProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if ((await broToBroAccess(ctx.scope)) !== "on") {
    throw new TRPCError({ code: "FORBIDDEN", message: unavailable });
  }
  return next();
});

const linkInput = z.object({ linkId: z.uuid() });

/**
 * The cabinet's «Бро-связи» (docs/bro-to-bro.md, «Кабинет»): inviting and
 * accepting, what each link opens to the peer, and the journal of a thread
 * as the person's own side sees it. The page reads the lists itself.
 */
export const broToBroRouter = createTRPCRouter({
  /** A single-use invite: the bot's link and the cabinet's, 7 days. */
  invite: enabledProcedure
    .input(z.object({ label: z.string().trim().max(200) }))
    .mutation(async ({ ctx, input }) => {
      const created = await createBroInvite(ctx.scope, { label: input.label });
      if (created.kind === "refused") {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "За сутки — не больше 10 приглашений. Попробуй завтра.",
        });
      }
      const web = new URL("/workspace", applicationOrigin());
      web.searchParams.set("bro_invite", created.token);
      return {
        expiresAt: created.expiresAt.toISOString(),
        telegram: telegramLinkConfigured()
          ? telegramStartUrl(`bro_${created.token}`)
          : null,
        web: web.toString(),
      };
    }),
  /**
   * The person accepts the invite on the card. It is opened again first:
   * the accept takes the invite this account opened last, which is then the
   * one the card shows.
   */
  acceptInvite: protectedProcedure
    .input(z.object({ token: broInviteTokenSchema }))
    .mutation(async ({ ctx, input }) => {
      if (!broToBroSwitchedOn()) {
        throw new TRPCError({ code: "FORBIDDEN", message: unavailable });
      }
      const opened = await openBroInvite(input.token, ctx.scope);
      if (opened.kind !== "opened") throw refuseInvite(opened.kind);
      const accepted = await acceptOpenedBroInvite(ctx.scope, "web");
      if (accepted.kind !== "accepted") throw refuseInvite(accepted.kind);
      return { inviterName: accepted.inviterName };
    }),
  /** The inviter confirms that the right person accepted. */
  confirm: enabledProcedure
    .input(linkInput)
    .mutation(async ({ ctx, input }) => {
      const confirmed = await confirmBroLink(
        ctx.scope,
        input.linkId,
        "cabinet"
      );
      if (confirmed.kind === "none") throw linkGone();
      if (confirmed.kind === "not_inviter") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Связь подтверждает тот, кто приглашал.",
        });
      }
    }),
  setCalendar: linkedProcedure
    .input(linkInput.extend({ allowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (!(await setBroLinkCalendar(ctx.scope, input.linkId, input.allowed))) {
        throw linkGone();
      }
    }),
  setShareNotes: linkedProcedure
    .input(linkInput.extend({ notes: z.string().trim().max(2000) }))
    .mutation(async ({ ctx, input }) => {
      if (!(await setBroLinkShareNotes(ctx.scope, input.linkId, input.notes))) {
        throw linkGone();
      }
    }),
  setLabel: linkedProcedure
    .input(linkInput.extend({ label: z.string().trim().max(200) }))
    .mutation(async ({ ctx, input }) => {
      if (!(await setBroLinkLabel(ctx.scope, input.linkId, input.label))) {
        throw linkGone();
      }
    }),
  /** Removes the link for both; what was already said stays said. */
  remove: linkedProcedure.input(linkInput).mutation(async ({ ctx, input }) => {
    const removed = await removeBroLink(ctx.scope, input.linkId);
    if (removed.kind === "none") throw linkGone();
    return { cancelledThreads: removed.cancelledThreads };
  }),
  /**
   * One thread as the person's own side sees it: their own errand, question
   * and held draft, and what the envoys actually said. Another side's
   * errand and answers never leave `readBroThreadForSide`.
   */
  thread: linkedProcedure
    .input(z.object({ threadId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const thread = await readBroThreadForSide(
        input.threadId,
        ctx.scope.workspaceId
      );
      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Таких переговоров нет.",
        });
      }
      const { own } = thread;
      const held = own.heldMessage;
      return {
        topic: thread.topic,
        status: thread.status,
        deadlineAt: thread.deadlineAt.toISOString(),
        closedAt: thread.closedAt?.toISOString() ?? null,
        peer: thread.peer,
        own: {
          goal: own.mandate?.goal ?? null,
          details: own.mandate?.details ?? null,
          answers: own.ownerAnswers,
          question: own.pendingQuestion,
          held: held
            ? {
                at: held.at,
                body: held.body,
                proposal: held.proposal ?? null,
                reason: held.reason,
                approved: held.approved,
              }
            : null,
          confirmed:
            thread.agreedProposalId !== null &&
            own.confirmedProposalId === thread.agreedProposalId,
          declined: own.declinedAt !== null,
          calendar: own.calendarState,
        },
        messages: thread.messages.map((message) => ({
          id: message.id,
          from: message.from,
          action: message.action,
          body: message.body,
          proposal: message.proposal,
          approvedByOwner: message.approvedByOwner,
          at: message.createdAt.toISOString(),
        })),
      };
    }),
});
