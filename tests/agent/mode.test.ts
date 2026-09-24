import { describe, expect, it } from "vitest";
import { startedByPerson } from "@agent/lib/mode";

function caller(
  authenticator: string,
  attributes: Record<string, string> = {}
) {
  return {
    attributes,
    authenticator,
    principalId: "better-auth:alice",
    principalType: "user" as const,
  };
}

function session(
  current: ReturnType<typeof caller> | null,
  initiator: ReturnType<typeof caller> | null = null
) {
  return { session: { auth: { current, initiator } } };
}

describe("a turn the person started", () => {
  it("is one the person wrote in the web chat, Telegram or iMessage", () => {
    for (const authenticator of [
      "authjs",
      "local-dev",
      "photon-imessage",
      "telegram-webhook",
    ]) {
      expect(startedByPerson(session(caller(authenticator)))).toBe(true);
    }
  });

  it("is never Bro writing to itself", () => {
    for (const authenticator of [
      // A browser run's report is interactive, but the page wrote it.
      "browser-result",
      "scheduled-worker",
      "scheduled-result",
      "scheduled-input",
      "app",
    ]) {
      expect(startedByPerson(session(caller(authenticator)))).toBe(false);
    }
    // A worker's pending question answered by the person is still the
    // worker's turn.
    expect(
      startedByPerson(
        session(caller("telegram-webhook"), caller("scheduled-worker"))
      )
    ).toBe(false);
    expect(startedByPerson(session(null))).toBe(false);
  });
});
