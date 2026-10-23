import type { ModelMessage } from "ai";
import type { DynamicResolveContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../../node_modules/eve/dist/src/context/container.js";
import { toolContext } from "@tests/helpers/tool-context";

const book = vi.hoisted(() => ({
  deleteContact:
    vi.fn<() => Promise<{ kind: "deleted" | "missing"; name: string }>>(),
  saveContact:
    vi.fn<
      () => Promise<{ kind: string; row: { name: string; phones: string[] } }>
    >(),
}));

vi.stubEnv("TELEGRAM_BOT_USERNAME", "phone_test_bot");
vi.mock("@db/services/phone", () => ({ phonePilot: () => true }));
vi.mock("@db/services/contacts", () => ({
  contactsPilot: () => true,
  deleteContact: book.deleteContact,
  findContacts: async () => [
    {
      aliases: [],
      familiar: true,
      name: "Мама",
      note: null,
      phones: ["+79161234567"],
    },
  ],
  listContacts: vi.fn<() => void>(),
  normalizeDomesticPhone: (raw: string) =>
    raw === "bad" ? undefined : "+79161234567",
  saveContact: book.saveContact,
}));

import { recordPhoneTurn } from "@agent/lib/phone/policy";
import contactTools from "@agent/tools/phone-contacts";

const baseContext = toolContext("contact-save");

function person(text: string): ModelMessage {
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

function resolveContext(
  messages = [person("Запомни: мама — +7 916 123-45-67")]
): DynamicResolveContext {
  return {
    channel: { kind: "channel:eve", metadata: {} },
    messages,
    model: null,
    session: { auth: baseContext.session.auth, id: "session-1" },
  };
}

async function setUp(
  opened: "person-message" | "background-message",
  phones = ["8 916 123 45 67"]
) {
  const context = {
    ...baseContext,
    session: { ...baseContext.session, id: "session-1" },
    toolName: "contact-save",
  };
  recordPhoneTurn(context.session, "start");
  recordPhoneTurn(context.session, opened);
  const tools = await contactTools.events["step.started"]?.(
    {},
    resolveContext()
  );
  const tool =
    tools && "contact-save" in tools ? tools["contact-save"] : undefined;
  if (!tool) throw new Error("Expected contact-save.");
  const policy = tool.approval;
  if (policy === undefined) throw new Error("Expected a policy.");
  const approval = "request" in policy ? policy.request : policy;
  const input = { name: "Мама", phones };
  return {
    decide: () =>
      approval({
        ...context,
        approvedTools: new Set(),
        callId: "call-1",
        toolInput: input,
      }),
    save: () => tool.execute(input, { ...context, callId: "call-1" }),
    tools,
  };
}

/** contact-delete in a turn the person opened with these messages. */
async function deleteIn(messages: ModelMessage[]) {
  const context = {
    ...baseContext,
    session: { ...baseContext.session, id: "session-1" },
    toolName: "contact-delete",
  };
  recordPhoneTurn(context.session, "start");
  recordPhoneTurn(context.session, "person-message");
  const tools = await contactTools.events["step.started"]?.(
    {},
    resolveContext(messages)
  );
  const tool =
    tools && "contact-delete" in tools ? tools["contact-delete"] : undefined;
  if (!tool?.approval) throw new Error("Expected contact-delete.");
  const approval =
    "request" in tool.approval ? tool.approval.request : tool.approval;
  const input = { name: "брат" };
  await approval({
    ...context,
    approvedTools: new Set(),
    callId: "call-1",
    toolInput: input,
  });
  return tool.execute(input, { ...context, callId: "call-1" });
}

function inContext(run: () => Promise<void>) {
  return () => contextStorage.run(new ContextContainer(), run);
}

beforeEach(() => {
  book.deleteContact.mockReset();
  book.deleteContact.mockResolvedValue({ kind: "deleted", name: "Брат" });
  book.saveContact.mockReset();
  book.saveContact.mockResolvedValue({
    kind: "created",
    row: { name: "Мама", phones: ["+79161234567"] },
  });
});

describe("contact tools", () => {
  it(
    "save a contact on the person's own message",
    inContext(async () => {
      const contacts = await setUp("person-message");
      expect(await contacts.decide()).toBe("not-applicable");
      expect(await contacts.save()).toMatchObject({ saved: true });
      expect(book.saveContact).toHaveBeenCalledOnce();
    })
  );

  it(
    "refuse a save in a turn a background message opened",
    inContext(async () => {
      const contacts = await setUp("background-message");
      expect(await contacts.decide()).toMatchObject({ type: "denied" });
      await expect(contacts.save()).rejects.toThrow(/own message/u);
      expect(book.saveContact).not.toHaveBeenCalled();
    })
  );

  it(
    "ask again instead of saving a number that is not a +7 number",
    inContext(async () => {
      const contacts = await setUp("person-message", ["bad"]);
      expect(await contacts.decide()).toBe("not-applicable");
      expect(await contacts.save()).toMatchObject({ saved: false });
      expect(book.saveContact).not.toHaveBeenCalled();
    })
  );

  it(
    "find a contact for phone-call",
    inContext(async () => {
      const contacts = await setUp("person-message");
      const find = contacts.tools?.["contact-find"];
      const found = await find?.execute(
        { query: "маме" },
        { ...baseContext, toolName: "contact-find" }
      );
      expect(found).toMatchObject({
        contacts: [{ name: "Мама", phones: ["+79161234567"] }],
      });
    })
  );

  it(
    "delete a contact only when the person asked to forget one",
    inContext(async () => {
      // 23.10: Bro called contact-delete looking the brother up for a taxi.
      expect(
        await deleteIn([person("Вызови такси моему брату до моего дома")])
      ).toMatchObject({ deleted: false });
      expect(book.deleteContact).not.toHaveBeenCalled();
      expect(await deleteIn([person("Забудь номер брата")])).toMatchObject({
        deleted: true,
      });
      expect(book.deleteContact).toHaveBeenCalledOnce();
    })
  );

  it(
    "delete the one the person named after Bro asked which",
    inContext(async () => {
      expect(
        await deleteIn([
          person("Удали Сашу"),
          { role: "assistant", content: "Какого Сашу: с работы или соседа?" },
          person("С работы"),
        ])
      ).toMatchObject({ deleted: true });
    })
  );
});
