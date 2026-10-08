import { describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../../node_modules/eve/dist/src/context/container.js";
import { domesticPhoneSchema } from "@shared/phone/policy";

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
const {
  authorizedPhoneTurn,
  phoneActionTurn,
  recordPhoneAction,
  recordPhoneTurn,
} = await import("@agent/lib/phone/policy");

function rootContext(authenticator = "local-dev", turnId = "turn_0") {
  return {
    callId: "call-1",
    toolName: "phone-activate",
    session: {
      id: "session-1",
      turn: { id: turnId, sequence: 0 },
      auth: {
        initiator: null,
        current: {
          authenticator,
          principalId: "alice",
          principalType: "user" as const,
          attributes: { workspaceId: "workspace:alice" },
        },
      },
    },
  };
}

describe("phone authorization in actual Eve durable context", () => {
  it("requires an authenticated root message and preserves only the exact originating action through approval resumption", () => {
    contextStorage.run(new ContextContainer(), () => {
      const original = rootContext();
      expect(authorizedPhoneTurn(original.session)).toBe(false);
      recordPhoneTurn(original.session, "person-message");
      expect(authorizedPhoneTurn(original.session)).toBe(true);
      const input = JSON.stringify({ quoteId: "exact-quote", setupRub: 600 });
      recordPhoneAction(original, input);
      expect(phoneActionTurn(original, input)).toBe("turn_0");
      const resumed = rootContext("local-dev", "turn_1");
      recordPhoneTurn(resumed.session, "start");
      expect(authorizedPhoneTurn(resumed.session)).toBe(false);
      expect(phoneActionTurn(resumed, input)).toBe("turn_0");
      expect(
        phoneActionTurn({ ...resumed, callId: "different-call" }, input)
      ).toBeNull();
      expect(
        phoneActionTurn(
          resumed,
          JSON.stringify({ quoteId: "another-quote", setupRub: 600 })
        )
      ).toBeNull();
      expect(phoneActionTurn(rootContext("phone-result"), input)).toBeNull();
      expect(
        phoneActionTurn(rootContext("scheduled-worker"), input)
      ).toBeNull();
      expect(phoneActionTurn(rootContext("browser-result"), input)).toBeNull();
      const delegated = {
        ...original,
        session: {
          ...original.session,
          parent: {
            callId: "parent-call",
            rootSessionId: "root",
            sessionId: "parent",
            turn: { id: "parent-turn", sequence: 0 },
          },
        },
      };
      expect(phoneActionTurn(delegated, input)).toBeNull();
    });
  });

  it("does not carry a background task's inherited person principal into phone authorization", () => {
    contextStorage.run(new ContextContainer(), () => {
      const original = rootContext();
      recordPhoneTurn(original.session, "background-message");
      recordPhoneAction(original, "{}");
      expect(phoneActionTurn(original, "{}")).toBeNull();
    });
  });

  it("rejects execution outside a managed context rather than guessing the user's permission", () => {
    const original = rootContext();
    expect(authorizedPhoneTurn(original.session)).toBe(false);
    expect(phoneActionTurn(original, "{}")).toBeNull();
  });

  it("refuses an old exact action when the current inherited-person turn is tainted, and keeps the taint sticky", () => {
    contextStorage.run(new ContextContainer(), () => {
      const original = rootContext();
      recordPhoneTurn(original.session, "person-message");
      recordPhoneAction(original, "{}");
      const background = rootContext("local-dev", "turn_1");
      recordPhoneTurn(background.session, "start");
      recordPhoneTurn(background.session, "background-message");
      expect(phoneActionTurn(background, "{}")).toBeNull();
      recordPhoneTurn(background.session, "person-message");
      expect(authorizedPhoneTurn(background.session)).toBe(false);
      expect(phoneActionTurn(background, "{}")).toBeNull();
    });
  });
});

describe("domestic Russian dial targets", () => {
  it.each([
    "+74951234567",
    "+79161234567",
    "+78711234567",
    "+78721234567",
    "+78005553535",
  ])("accepts %s", (number) => {
    expect(domesticPhoneSchema.safeParse(number).success).toBe(true);
  });
  it.each([
    "112",
    "911",
    "+77123456789",
    "+76123456789",
    "+78091234567",
    "+78031234567",
    "sip:alice@example.com",
    "+12125551234",
  ])("refuses %s", (number) => {
    expect(domesticPhoneSchema.safeParse(number).success).toBe(false);
  });
});
