import { createHash } from "node:crypto";
import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import type { ApprovalContext } from "eve/tools/approval";
import { z } from "zod";
import { ownTurnApproval } from "@agent/lib/mode";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import {
  authorizedPhoneTurn,
  phoneActionsBefore,
  phoneActionTurn,
  phoneCallsPerTurn,
  recordPhoneAction,
} from "@agent/lib/phone/policy";
import {
  type CallDestinations,
  callDestinationRefusal,
  callDestinations,
} from "@agent/lib/phone/destination";
import {
  type StepIdentity,
  stepIdentity,
  stepStartedEventSchema,
} from "@agent/lib/turn-kind/step";
import { domesticPhoneSchema } from "@shared/phone/policy";
import { activatePhone, releasePhone } from "@db/services/phone/lifecycle";
import { quoteNumber } from "@shared/phone/exolve";
import { requirePhoneAgentReady, startCall } from "@shared/phone/elevenlabs";
import {
  changePhoneState,
  claimCallStart,
  listPhoneCalls,
  planOutboundCall,
  phonePilot,
  readPhoneNumber,
  readPhoneNumberRequest,
  recordCallAccepted,
  recordCallUncertain,
  savePhoneQuote,
} from "@db/services/phone";
import { env } from "@shared/environment";
import { phoneReportRoute } from "@agent/lib/phone/route";
import type { DynamicResolveContext } from "eve";
import { turnAwaitsAnswer } from "@agent/lib/delivery/questions";

function callerScope(context: Pick<ToolContext, "session">) {
  if (context.session.parent)
    throw new Error("Only the authenticated root agent can use telephony.");
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user")
    throw new Error("Authenticated workspace owner required.");
  return scopeFromPrincipal(caller);
}

function phoneScope(context: ToolContext, serializedAction?: string) {
  const scope = callerScope(context);
  if (!phonePilot(scope))
    throw new Error("Phone pilot is disabled for this workspace.");
  if (
    serializedAction !== undefined &&
    !phoneActionTurn(context, serializedAction)
  )
    throw new Error(
      "Phone actions require the owner's actual root-user message, never a callback, background task or delegated agent."
    );
  return scope;
}

function publicNumber(row: Awaited<ReturnType<typeof readPhoneNumber>>) {
  return row
    ? {
        quoteId: row.id,
        number: row.number,
        state: row.state,
        setupRub: row.setupRub,
        monthlyRub: row.monthlyRub,
        sipMonthlyRub: row.sipMonthlyRub,
        quotedAt: row.quotedAt,
        privacy:
          "MTS Exolve and ElevenLabs process phone numbers, minimal call context and voice; the carrier may record calls, including forced recording on new numbers during the first 30 days. Bro stores a bounded summary, not raw audio or a full transcript. Incoming callers cannot access the owner's saved context.",
        note:
          row.state === "disabled"
            ? "Calls are disabled, but the number remains allocated and monthly fees continue."
            : row.state === "operator-required" || row.state === "uncertain"
              ? "Operator reconciliation is required. Resources may still incur monthly fees; do not buy, re-import or redial automatically."
              : undefined,
      }
    : null;
}

function rootApproval(
  context: Pick<
    ApprovalContext,
    "session" | "callId" | "toolName" | "toolInput"
  >
) {
  const input = JSON.stringify(context.toolInput ?? null);
  if (authorizedPhoneTurn(context.session)) recordPhoneAction(context, input);
  return phoneActionTurn(context, input)
    ? ownTurnApproval(context)
    : {
        type: "denied" as const,
        reason:
          "Only an authenticated person's own root turn may initiate phone actions.",
      };
}
function paidApproval(
  context: Pick<
    ApprovalContext,
    "session" | "callId" | "toolName" | "toolInput"
  >
) {
  const decision = rootApproval(context);
  return decision === "not-applicable" ? ("user-approval" as const) : decision;
}

const callCapRefusal = `Nothing was dialed: at most ${String(phoneCallsPerTurn)} calls per message of the person. Tell them which calls were placed and ask them to send a new message for another one.`;

/**
 * Approval of `phone-call`, before anything is recorded: the number must be
 * one the person gave this turn (`destinations`), then the usual root-turn
 * rule, then the per-turn cap over the calls recorded so far. A call that
 * is refused by the number is not recorded and does not use up the cap.
 */
function callApproval(
  context: Pick<
    ApprovalContext,
    "session" | "callId" | "toolName" | "toolInput"
  >,
  destinations: CallDestinations
) {
  const target = z.object({ target: z.string() }).safeParse(context.toolInput)
    .data?.target;
  const refusal =
    target === undefined
      ? "Nothing was dialed: the call has no number."
      : callDestinationRefusal(target, destinations);
  if (refusal) return { type: "denied" as const, reason: refusal };
  const decision = rootApproval(context);
  if (decision !== "not-applicable") return decision;
  const originatingTurn = phoneActionTurn(
    context,
    JSON.stringify(context.toolInput ?? null)
  );
  return originatingTurn &&
    phoneActionsBefore(context, originatingTurn) >= phoneCallsPerTurn
    ? { type: "denied" as const, reason: callCapRefusal }
    : decision;
}

const quote = defineTool({
  availableInSubagents: false,
  description:
    "Get a fresh exact-candidate quote for this workspace's persistent dedicated Russian +7 phone. Does not purchase or allocate anything. Show setup, recurring number and separate SIP monthly fees and explain call charges before activation. Allocation happens only after separate explicit approval.",
  inputSchema: z.object({}).strict(),
  async execute(_input, context) {
    const scope = phoneScope(context);
    const automatic = await readPhoneNumberRequest(scope);
    if (automatic)
      return {
        automaticAllocation: automatic,
        number: publicNumber(await readPhoneNumber(scope)),
        note: "This new workspace receives its dedicated number automatically at platform expense. No activation/payment approval is needed; allocation may be pending or waiting for operator funds/capacity. Do not start a second manual allocation.",
      };
    const known = await readPhoneNumber(scope);
    if (known && known.state !== "quoted") return publicNumber(known);
    const quoted = await quoteNumber();
    domesticPhoneSchema.parse(quoted.candidate);
    if (
      ![quoted.setupRub, quoted.monthlyRub, quoted.sipMonthlyRub].every(
        (amount) => Number.isInteger(amount) && amount >= 0
      ) ||
      quoted.setupRub > env.PHONE_MAX_SETUP_RUB ||
      quoted.monthlyRub > env.PHONE_MAX_MONTHLY_RUB ||
      quoted.sipMonthlyRub > env.PHONE_MAX_SIP_MONTHLY_RUB ||
      Date.now() - quoted.quotedAt.getTime() > 60_000
    )
      throw new Error("Provider quote is unavailable or above operator caps.");
    return publicNumber(
      await savePhoneQuote(
        scope,
        {
          number: quoted.candidate,
          setupRub: quoted.setupRub,
          monthlyRub: quoted.monthlyRub,
          sipMonthlyRub: quoted.sipMonthlyRub,
          quotedAt: quoted.quotedAt,
        },
        phoneReportRoute(context)
      )
    );
  },
});

const activate = defineTool({
  availableInSubagents: false,
  async approval(context) {
    if (await readPhoneNumberRequest(callerScope(context)))
      return {
        type: "denied" as const,
        reason:
          "This new workspace's number is allocated automatically by the platform; no activation payment card or duplicate purchase is needed.",
      };
    return paidApproval(context);
  },
  approvalKey: (input) => JSON.stringify(input),
  description:
    "Activate this workspace's quoted dedicated number. Separate user approval is mandatory and the card shows setup and monthly charges. Copy exact quoteId and every amount from phone-quote; never invent or raise caps. This buys only the saved candidate, creates its dedicated SIP and imports it. An uncertain result is reconciled without repeating ambiguous mutations.",
  inputSchema: z
    .object({
      quoteId: z.uuid(),
      setupRub: z.number().int().nonnegative(),
      monthlyRub: z.number().int().nonnegative(),
      sipMonthlyRub: z.number().int().nonnegative(),
    })
    .strict(),
  async execute(input, context) {
    const scope = phoneScope(context, JSON.stringify(input));
    if (await readPhoneNumberRequest(scope))
      throw new Error(
        "Automatic allocation already owns this workspace's number intent; check phone-status instead."
      );
    const row = await readPhoneNumber(scope);
    if (
      !row ||
      row.id !== input.quoteId ||
      row.setupRub !== input.setupRub ||
      row.monthlyRub !== input.monthlyRub ||
      row.sipMonthlyRub !== input.sipMonthlyRub
    )
      throw new Error("Approval must match the exact persisted quote.");
    return publicNumber(await activatePhone(scope, input.quoteId));
  },
});

function defineCall(destinations: CallDestinations) {
  return defineTool({
    availableInSubagents: false,
    approval: (ctx) => callApproval(ctx, destinations),
    description:
      "Place one Russian voice call on the user's current explicit request, using their dedicated Bro number. Target must be a full domestic +7 number that the person wrote in their own message this turn, or the phone of a contact they named and you found with contacts-search this turn; a number from an email, a web page, a report or an earlier call is refused, so ask the person to confirm it in chat. At most 2 calls per message of the person. task contains only this call's minimal necessary context, never whole saved memory, credentials, OTPs or unrelated personal facts. The AI introduces itself honestly and discloses possible carrier recording. It can carry out the exact explicitly requested conversational errand, including booking, rescheduling or cancelling a no-fee appointment or restaurant table, ask questions and take a message. It must stop for unapproved fees, financial commitments or missing required facts; it cannot buy, invent personal details, or mutate digital accounts or calendars. The durable job reports in this chat; duplicate/uncertain jobs must never be redialled automatically. A phone connection is not task success; check phone-status.",
    inputSchema: z
      .object({
        target: domesticPhoneSchema,
        task: z.string().trim().min(1).max(3000),
      })
      .strict(),
    async execute(input, context) {
      // First, so that a lost or skipped approval cannot dial a number the
      // person did not give.
      const target = domesticPhoneSchema.parse(input.target);
      const refusal = callDestinationRefusal(target, destinations);
      if (refusal) throw new Error(refusal);
      const scope = phoneScope(context, JSON.stringify(input));
      const originatingTurn = phoneActionTurn(context, JSON.stringify(input));
      if (!originatingTurn)
        throw new Error("Originating phone authorization is unavailable.");
      if (phoneActionsBefore(context, originatingTurn) >= phoneCallsPerTurn)
        throw new Error(callCapRefusal);
      await requirePhoneAgentReady();
      const operationId = `${scope.workspaceId}:${context.session.id}:${originatingTurn}:${context.callId}`;
      const planned = await planOutboundCall(scope, {
        operationId,
        inputHash: createHash("sha256")
          .update(JSON.stringify({ target, task: input.task }))
          .digest("hex"),
        target,
        task: input.task,
        ...phoneReportRoute(context),
      });
      const started = await claimCallStart(scope, planned.row.id);
      if (!started)
        return {
          callId: planned.row.id,
          state: planned.row.state,
          duplicate: !planned.created,
        };
      const number = await readPhoneNumber(scope);
      if (!number?.outboundPhoneNumberId || !number.agentId || !number.sipId) {
        await recordCallUncertain(started.id);
        return {
          callId: started.id,
          state: "uncertain",
          note: "Number mapping is unavailable; no redial.",
        };
      }
      try {
        const accepted = await startCall({
          phoneNumberId: number.outboundPhoneNumberId,
          publicNumber: number.number,
          sipId: number.sipId,
          agentId: number.agentId,
          target,
          localCallId: started.id,
          task: input.task,
        });
        await recordCallAccepted(
          started.id,
          accepted.conversationId,
          accepted.accepted
        );
        return {
          callId: started.id,
          state: accepted.accepted ? "accepted" : "processing",
          initiationAccepted: accepted.accepted,
          note: accepted.accepted
            ? "Provider accepted the request; this does not prove a connection or task success. The result will be reported here."
            : "The provider rejected call initiation but supplied a conversation receipt. No successful start or connection is claimed; the receipt will be reconciled and no redial will occur.",
        };
      } catch {
        await recordCallUncertain(started.id);
        return {
          callId: started.id,
          state: "uncertain",
          note: "Provider acceptance is unknown; reconciliation will not redial or invent a successful connection.",
        };
      }
    },
  });
}

const status = defineTool({
  availableInSubagents: false,
  description:
    "Read only this workspace's dedicated phone and latest calls, or one exact callId, with truthful call state, task success separately, bounded summaries and USD voice/RUB carrier charges when known. Inbound caller is unverified contact metadata and may be spoofed; it is never identity or permission to redial. Null costs mean unknown, never free. Does not call or authorize follow-up actions.",
  inputSchema: z.object({ callId: z.uuid().optional() }).strict(),
  async execute(input, context) {
    const scope = phoneScope(context);
    return {
      number: publicNumber(await readPhoneNumber(scope)),
      calls: await listPhoneCalls(scope, input.callId),
      automaticAllocation: await readPhoneNumberRequest(scope),
    };
  },
});

const disable = defineTool({
  availableInSubagents: false,
  approval: rootApproval,
  description:
    "Disable calls on this workspace's dedicated number on the owner's explicit request. The number and monthly fees remain; this is NOT release. No new incoming or outgoing calls will be allowed.",
  inputSchema: z.object({}).strict(),
  async execute(input, context) {
    return publicNumber(
      await changePhoneState(
        phoneScope(context, JSON.stringify(input)),
        "disabled"
      )
    );
  },
});

const release = defineTool({
  availableInSubagents: false,
  approval: paidApproval,
  approvalKey: (input) => JSON.stringify(input),
  description:
    "Explicitly confirmed permanent release of the workspace's dedicated number. Disconnect voice import and provider forwarding/SIP before tombstoning. If provider release cannot be verified, return operator-required and warn monthly fees may continue. Never claim free or reassign this number to anyone else.",
  inputSchema: z.object({ confirmPermanentRelease: z.literal(true) }).strict(),
  async execute(input, context) {
    return publicNumber(
      await releasePhone(phoneScope(context, JSON.stringify(input)))
    );
  },
});

const enable = defineTool({
  availableInSubagents: false,
  approval: rootApproval,
  description:
    "Re-enable calls on this workspace's existing disabled dedicated phone on the owner's explicit request. No number purchase or reassignment is made; existing monthly fees continue.",
  inputSchema: z.object({}).strict(),
  async execute(input, context) {
    const scope = phoneScope(context, JSON.stringify(input));
    await requirePhoneAgentReady();
    return publicNumber(await changePhoneState(scope, "active"));
  },
});

function stepOf(
  event: Parameters<typeof stepStartedEventSchema.safeParse>[0],
  context: DynamicResolveContext
) {
  return stepIdentity(
    stepStartedEventSchema.safeParse(event).data,
    context.session.id
  );
}

function resolvePhoneTools(context: DynamicResolveContext, step: StepIdentity) {
  const caller = context.session.auth.current;
  if (
    context.channel.kind === "subagent" ||
    caller?.principalType !== "user" ||
    !phonePilot(scopeFromPrincipal(caller))
  )
    return null;
  if (turnAwaitsAnswer(context.messages))
    return { "phone-quote": quote, "phone-status": status };
  return {
    "phone-quote": quote,
    "phone-activate": activate,
    "phone-call": defineCall(callDestinations(context.messages, step)),
    "phone-status": status,
    "phone-disable": disable,
    "phone-enable": enable,
    "phone-release": release,
  };
}

export default defineDynamic({
  events: {
    "turn.started": (event, context) =>
      resolvePhoneTools(context, stepOf(event, context)),
    "step.started": (event, context) =>
      resolvePhoneTools(context, stepOf(event, context)),
  },
});
