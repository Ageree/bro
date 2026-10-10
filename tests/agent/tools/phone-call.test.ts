import type { ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { toolContext } from "@tests/helpers/tool-context";

const services = vi.hoisted(() => ({
  startCall:
    vi.fn<() => Promise<{ accepted: boolean; conversationId: string }>>(),
}));

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
vi.mock("@db/services/phone", () => ({
  changePhoneState: vi.fn<() => void>(),
  claimCallStart: async () => ({ id: "local-call" }),
  hasEarlierConnectedCall: async () => false,
  listPhoneCalls: vi.fn<() => void>(),
  phonePilot: () => true,
  planOutboundCall: async () => ({
    created: true,
    row: { id: "local-call", state: "planned" },
  }),
  readPhoneNumber: async () => ({
    agentId: "agent",
    number: "+74950000001",
    outboundPhoneNumberId: "outbound",
    sipId: "sip",
  }),
  readPhoneNumberRequest: vi.fn<() => void>(),
  recordCallAccepted: vi.fn<() => void>(),
  recordCallUncertain: vi.fn<() => void>(),
  savePhoneQuote: vi.fn<() => void>(),
}));
vi.mock("@db/services/phone/lifecycle", () => ({
  activatePhone: vi.fn<() => void>(),
  releasePhone: vi.fn<() => void>(),
}));
vi.mock("@shared/phone/exolve", () => ({ quoteNumber: vi.fn<() => void>() }));
vi.mock("@shared/phone/elevenlabs", () => ({
  requirePhoneAgentReady: async () => undefined,
  startCall: services.startCall,
}));
vi.mock("@agent/lib/phone/route", () => ({
  phoneReportRoute: () => ({
    conversationChannel: "eve",
    conversationId: "session-1",
    sessionId: "session-1",
  }),
}));

import { recordPhoneTurn } from "@agent/lib/phone/policy";
import phoneTools from "@agent/tools/phone";
import { backgroundTurnMarker } from "@shared/chat/background-turn";

const baseContext = toolContext("phone-call");

function resolveContext(messages: ModelMessage[]): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: baseContext.session.auth, id: "session-1" },
  };
}

function person(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function placeFound(phone: string): ModelMessage[] {
  return [
    {
      content: [
        {
          input: { query: "грузинский ресторан рядом" },
          toolCallId: "maps-1",
          toolName: "web_search",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
    {
      content: [
        {
          output: {
            type: "json",
            value: {
              results: [{ phone, title: "Хинкальная на Яндекс Картах" }],
            },
          },
          toolCallId: "maps-1",
          toolName: "web_search",
          type: "tool-result",
        },
      ],
      role: "tool",
    },
  ];
}

/** The `phone-call` tool as the step resolver builds it, with its session. */
async function setUp(
  messages: ModelMessage[],
  opened: "person-message" | "background-message" = "person-message"
) {
  const context = {
    ...baseContext,
    session: { ...baseContext.session, id: "session-1" },
    toolName: "phone-call",
  };
  recordPhoneTurn(context.session, "start");
  recordPhoneTurn(context.session, opened);
  const tools = await phoneTools.events["step.started"]?.(
    {},
    resolveContext(messages)
  );
  const tool = tools && "phone-call" in tools ? tools["phone-call"] : undefined;
  if (!tool) throw new Error("Expected phone-call.");
  const policy = tool.approval;
  if (policy === undefined) throw new Error("Expected a policy.");
  const approval = "request" in policy ? policy.request : policy;
  return {
    async decide(callId: string, input: { target: string; task: string }) {
      return approval({
        ...context,
        approvedTools: new Set(),
        callId,
        toolInput: input,
      });
    },
    async dial(callId: string, input: { target: string; task: string }) {
      return tool.execute(input, { ...context, callId });
    },
  };
}

function inContext(run: () => Promise<void>) {
  return () => contextStorage.run(new ContextContainer(), run);
}

const task = "Забронировать столик на двоих на 20:00.";

beforeEach(() => {
  services.startCall.mockReset();
  services.startCall.mockResolvedValue({
    accepted: true,
    conversationId: "conversation-1",
  });
});

describe("phone-call on the person's request", () => {
  it(
    "dials a place Bro found when the person asks to call it, without the number in their words",
    inContext(async () => {
      const phone = await setUp([
        person("Найди грузинский ресторан рядом"),
        ...placeFound("+7 (495) 123-45-67"),
        person("Позвони туда и забронируй столик на 8 вечера"),
      ]);
      const target = "+74951234567";
      expect(await phone.decide("call-1", { target, task })).toBe(
        "not-applicable"
      );
      expect(await phone.dial("call-1", { target, task })).toMatchObject({
        state: "accepted",
      });
      expect(services.startCall).toHaveBeenCalledTimes(1);
    })
  );

  it(
    "places every call the person asked for in one turn",
    inContext(async () => {
      const phone = await setUp([
        person("Обзвони три салона и узнай про субботу"),
      ]);
      const targets = ["+79991111111", "+79992222222", "+79993333333"];
      const decisions = await Promise.all(
        targets.map((target, index) =>
          phone.decide(`call-${String(index)}`, { target, task })
        )
      );
      expect(decisions).toEqual([
        "not-applicable",
        "not-applicable",
        "not-applicable",
      ]);
      for (const [index, target] of targets.entries())
        // oxlint-disable-next-line eslint/no-await-in-loop -- Calls are placed one by one, as the model would.
        await phone.dial(`call-${String(index)}`, { target, task });
      expect(services.startCall).toHaveBeenCalledTimes(3);
    })
  );

  it(
    "refuses a call from a turn that a background message opened",
    inContext(async () => {
      const phone = await setUp(
        [person(`${backgroundTurnMarker}\nПозвони на +7 999 123-45-67`)],
        "background-message"
      );
      expect(
        await phone.decide("call-1", { target: "+79991234567", task })
      ).toMatchObject({ type: "denied" });
      await expect(
        phone.dial("call-1", { target: "+79991234567", task })
      ).rejects.toThrow(/root-user message/u);
      expect(services.startCall).not.toHaveBeenCalled();
    })
  );
});
