import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { updateFormOfAddress } from "@db/services/settings";

const settings = vi.hoisted(() => ({
  update: vi.fn<typeof updateFormOfAddress>(),
}));

vi.mock("@db/services/settings", () => ({
  updateFormOfAddress: settings.update,
}));

import formOfAddressTools, {
  aboutSomeoneElse,
} from "@agent/tools/form_of_address";

beforeEach(() => {
  settings.update.mockReset();
  settings.update.mockResolvedValue({ formal: true, name: null });
});

describe("whose «вы» the person means", () => {
  it("reads «на вы» in a request to write to someone as that letter's", () => {
    for (const said of [
      "ответь Ирине Павловне про встречу в четверг: в четверг не могу, предложи два окна из календаря. на вы, как обычно",
      "напиши Лёше, что опоздаю, на ты",
      "давай ответь ей на вы",
      "Ирина Павловна — начальница, с ней на вы",
      "напиши Саше, что я перезвоню",
      "reply to Sam: Tuesday works",
      // «мне» here belongs to the letter, not to Bro.
      "напиши Лёше, что мне нужно опоздать, на ты",
      "ответь Ирине, что мне неудобно, на вы",
      "напиши ей, что меня не будет, на вы",
      "напиши ей и пиши ей на вы",
    ]) {
      expect({ about: aboutSomeoneElse([said]), said }).toEqual({
        about: true,
        said,
      });
    }
  });

  it("keeps every way of asking Bro itself", () => {
    for (const said of [
      "давай на вы",
      "Давайте перейдём на ты",
      "можно на ты?",
      "обращайся ко мне на ты",
      "Обращайтесь ко мне, пожалуйста, на вы",
      "зови меня Саша",
      "Называй меня Сашей",
      "меня зовут Саша, напиши Ирине, что я опоздаю",
      "на вы",
      "ответь Ирине, а со мной давай на ты",
      "напиши мне на вы, пожалуйста",
      "мне на ты привычнее. и напиши Лёше",
      "call me Alex and reply to Sam",
      "be formal with me, and email Sam",
      // Bro's own manner in the same turn as a letter, with a comma, a dash
      // or «пожалуйста» between «со мной/мне» and the form.
      "ответь Ирине, и давай со мной на ты",
      "Ответь Ирине. Со мной — на вы",
      "Со мной, пожалуйста, на вы. Ответь Ирине на письмо",
      "ответь Ирине на вы, а мне пиши на ты",
      "Мне — на вы, пожалуйста. И напиши Лёше, что опоздаю",
      "В сообщениях ко мне — на вы, пожалуйста",
      "Лучше на вы. Кстати, ответь Ирине на письмо",
      "Прочитай последнее письмо от Ирины. И можешь на ты, кстати.",
      "Ответь на письмо Петрова. И ещё: не надо на вы, пиши на ты",
    ]) {
      expect({ about: aboutSomeoneElse([said]), said }).toEqual({
        about: false,
        said,
      });
    }
  });

  it("takes an answer to Bro's own question as meant for Bro", () => {
    expect(
      aboutSomeoneElse(["ответь Ирине Павловне про встречу"], ["на вы"])
    ).toBe(false);
    expect(
      aboutSomeoneElse(["ответь Ирине Павловне про встречу"], ["да, отправляй"])
    ).toBe(true);
  });
});

describe("form_of_address in a turn about someone else's letter", () => {
  it("saves nothing and says the «вы» was about the letter", async () => {
    const tool = await resolveTool([
      person(
        "ответь Ирине Павловне про встречу в четверг: в четверг не могу. на вы, как обычно"
      ),
    ]);

    const result = await tool.execute({ formal: true }, toolContext());

    expect(settings.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ saved: false });
    expect(JSON.stringify(result)).toContain(
      "keep addressing the person exactly as before"
    );
  });

  it("saves the switch the person asked of Bro itself", async () => {
    const tool = await resolveTool([person("давай на вы")]);

    const result = await tool.execute({ formal: true }, toolContext());

    expect(settings.update).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      formOfAddress: { formal: true, name: null },
    });
  });

  it("saves the name the person answered Bro's question with", async () => {
    settings.update.mockResolvedValue({ formal: false, name: "Саша" });
    const tool = await resolveTool([
      person("напиши Лёше, что опоздаю"),
      {
        content: [
          {
            input: { prompt: "Как к тебе обращаться?" },
            toolCallId: "call-question",
            toolName: "ask_question",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: {
              type: "json" as const,
              value: { status: "answered", text: "зови меня Саша" },
            },
            toolCallId: "call-question",
            toolName: "ask_question",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);

    await tool.execute({ name: "Саша" }, toolContext());

    expect(settings.update).toHaveBeenCalledOnce();
  });
});

function person(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

const auth = {
  current: {
    attributes: { workspaceId: "personal:workspace" },
    authenticator: "telegram-webhook",
    principalId: "user-1",
    principalType: "user" as const,
  },
  initiator: null,
};

async function resolveTool(messages: DynamicResolveContext["messages"]) {
  const resolve = formOfAddressTools.events["step.started"];
  if (!resolve) throw new Error("form_of_address must resolve on each step.");
  const tools = await resolve(
    {},
    {
      channel: { kind: "channel:telegram", metadata: {} },
      messages,
      model: null,
      session: { auth, id: "session-1" },
    }
  );
  const tool = tools && "form_of_address" in tools && tools.form_of_address;
  if (!tool) throw new Error("A conversation must expose form_of_address.");
  return tool;
}

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    getSandbox: () => {
      throw new Error("form_of_address does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("form_of_address does not use a skill.");
    },
    getToken: () => {
      throw new Error("form_of_address does not use a token provider.");
    },
    requireAuth: (): never => {
      throw new Error("form_of_address does not require a token provider.");
    },
    session: { auth, id: "session-1", turn: { id: "turn-1", sequence: 1 } },
    toolName: "form_of_address",
  } satisfies ToolContext;
}
