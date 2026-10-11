import { describe, expect, it } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { goBookingRequest, recordGoTurn } from "@agent/lib/yandex/go/policy";

function session(authenticator = "local-dev", turnId = "turn-1") {
  return {
    id: "session-1",
    turn: { id: turnId, sequence: 1 },
    auth: {
      initiator: null,
      current: {
        authenticator,
        principalId: "alice",
        principalType: "user" as const,
        attributes: { workspaceId: "workspace:alice" },
      },
    },
  };
}

describe("Go actual-person request boundary", () => {
  it.each([
    ["Закажи такси до дома", null],
    ["Бро, вызови мне такси до дома", null],
    ["Please book a taxi to the gym", null],
    ["Закажи такси до 1500₽", 150000],
    ["Закажи такси не дороже 1 500,50 рублей", 150050],
    ["Закажи такси не более 0,01 руб", 1],
    ["Book a taxi up to 20.25 RUB", 2025],
  ])(
    "authorizes only the current recorded person request: %s",
    (text, quoteCeilingMinor) => {
      contextStorage.run(new ContextContainer(), () => {
        const current = session();
        expect(goBookingRequest(current, [text])).toBeNull();
        recordGoTurn(current, "start");
        recordGoTurn(current, "person-message", text);
        expect(goBookingRequest(current, [text])).toEqual({
          quoteCeilingMinor,
          payment: null,
        });
      });
    }
  );

  it.each([
    "Сколько стоит такси?",
    "Не заказывай такси",
    "Закажи такси, если будет дешевле",
    "Закажи такси завтра",
    "Закажи такси после звонка",
    "Он написал «закажи такси»",
    "«Закажи такси» — пример команды",
    "Закажи такси до -1 ₽",
    "Закажи такси до 1.234 ₽",
    "Закажи такси до 10 USD",
    "Закажи такси до 700 ₽, не более 1000 ₽",
  ])(
    "refuses price-only, reported, conditional or unsupported bounds: %s",
    (text) => {
      contextStorage.run(new ContextContainer(), () => {
        const current = session();
        recordGoTurn(current, "person-message", text);
        expect(goBookingRequest(current, [text])).toBeNull();
      });
    }
  );

  it("binds a direct request to the exact current turn, root, user and workspace", () => {
    const text = "Закажи такси до найденного адреса";
    contextStorage.run(new ContextContainer(), () => {
      const current = session();
      recordGoTurn(current, "person-message", text);
      expect(goBookingRequest(current, [text])).not.toBeNull();
      expect(
        goBookingRequest(session("local-dev", "later-turn"), [text])
      ).toBeNull();
      expect(goBookingRequest(session("scheduled-worker"), [text])).toBeNull();
      expect(goBookingRequest(session("browser-result"), [text])).toBeNull();
      expect(goBookingRequest(current, ["Другой заказ"])).toBeNull();
      expect(
        goBookingRequest(
          {
            ...current,
            parent: {
              callId: "parent",
              rootSessionId: "root",
              sessionId: "root",
              turn: { id: "parent", sequence: 0 },
            },
          },
          [text]
        )
      ).toBeNull();
      expect(
        goBookingRequest(
          {
            ...current,
            auth: {
              ...current.auth,
              current: { ...current.auth.current, principalId: "bob" },
            },
          },
          [text]
        )
      ).toBeNull();
      expect(
        goBookingRequest(
          {
            ...current,
            auth: {
              ...current.auth,
              current: {
                ...current.auth.current,
                attributes: { workspaceId: "workspace:bob" },
              },
            },
          },
          [text]
        )
      ).toBeNull();
    });
    expect(goBookingRequest(session(), [text])).toBeNull();
  });

  it("keeps an inherited-human callback taint sticky and resets authorization at a new turn", () => {
    const text = "Закажи такси";
    contextStorage.run(new ContextContainer(), () => {
      const current = session();
      recordGoTurn(current, "person-message", text);
      recordGoTurn(current, "background-message", text);
      recordGoTurn(current, "person-message", text);
      expect(goBookingRequest(current, [text])).toBeNull();
      const next = session("local-dev", "turn-2");
      recordGoTurn(next, "start");
      expect(goBookingRequest(next, [text])).toBeNull();
      recordGoTurn(next, "person-message", text);
      expect(goBookingRequest(next, [text])).not.toBeNull();
    });
  });
});
