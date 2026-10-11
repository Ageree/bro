import type { ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { toolContext } from "@tests/helpers/tool-context";

const when = new Date("2026-10-11T09:45:00.000Z");

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
vi.mock("@db/services/phone", () => ({
  changePhoneState: vi.fn<() => void>(),
  claimCallStart: vi.fn<() => void>(),
  hasEarlierConnectedCall: vi.fn<() => void>(),
  listPhoneCalls: async () => [
    {
      carrierRub: null,
      caller: null,
      callerIdentity: null,
      costUsd: "0.0085",
      createdAt: when,
      direction: "outbound",
      id: "call-1",
      outcome: "connected",
      state: "done",
      summary: "Сказал, что это проверка.",
      target: "+74951234567",
      taskSucceeded: true,
    },
  ],
  phonePilot: () => true,
  planOutboundCall: vi.fn<() => void>(),
  readHeldPhoneNumbers: vi.fn<() => void>(),
  readPhoneNumber: async () => ({
    id: "number-1",
    monthlyRub: 100,
    number: "+74950000001",
    quotedAt: when,
    setupRub: 0,
    sipMonthlyRub: 0,
    state: "active",
  }),
  readPhoneNumberRequest: async () => ({
    attempts: 1,
    lastFailure: null,
    nextAttemptAt: when,
    state: "pending",
  }),
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
  requirePhoneAgentReady: vi.fn<() => void>(),
  startCall: vi.fn<() => void>(),
}));
vi.mock("@agent/lib/phone/route", () => ({
  phoneReportRoute: vi.fn<() => void>(),
}));

import phoneTools from "@agent/tools/phone";

const baseContext = toolContext("phone-status");

function person(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

describe("phone-status", () => {
  it("returns plain JSON, with dates as ISO strings", () =>
    contextStorage.run(new ContextContainer(), async () => {
      const resolve: DynamicResolveContext = {
        channel: { kind: "channel:eve", metadata: {} },
        messages: [person("Как прошёл звонок?")],
        model: null,
        session: { auth: baseContext.session.auth, id: "session-1" },
      };
      const tools = await phoneTools.events["step.started"]?.({}, resolve);
      const tool =
        tools && "phone-status" in tools ? tools["phone-status"] : undefined;
      if (!tool) throw new Error("Expected phone-status.");
      const result = await tool.execute({}, baseContext);
      // eve serializes a result as JSON and refuses what does not survive it.
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(result).toMatchObject({
        automaticAllocation: { nextAttemptAt: when.toISOString() },
        calls: [{ createdAt: when.toISOString() }],
        number: { quotedAt: when.toISOString() },
      });
    }));
});
