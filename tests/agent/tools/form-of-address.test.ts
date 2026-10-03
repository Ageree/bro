import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { updateFormOfAddress } from "@db/services/settings";

const settings = vi.hoisted(() => ({
  update: vi.fn<typeof updateFormOfAddress>(),
}));

vi.mock("@db/services/settings", () => ({
  updateFormOfAddress: settings.update,
}));

// eve's state outside a session: one value per slot.
vi.mock("eve/context", () => ({
  defineState<T>(_name: string, initial: () => T) {
    let value = initial();
    return {
      get: () => value,
      update(next: (current: T) => T) {
        value = next(value);
      },
    };
  },
}));

import formOfAddressTools, {
  aboutSomeoneElse,
} from "@agent/tools/form_of_address";
import {
  recordCompactionCompleted,
  recordMessageReceived,
  recordStepStarted,
  recordStepHistory,
  recordTurnStarted,
} from "@agent/lib/compaction/record";

/**
 * A person's turn whose steps began up to `steps`, its first step having
 * read `opening` before any compaction.
 */
function personTurn(
  turnId: string,
  steps: number,
  opening: DynamicResolveContext["messages"] = [person("привет")]
) {
  recordTurnStarted(turnId);
  recordMessageReceived({ turnId });
  recordStepHistory({ sessionId: "session-1", stepIndex: 0, turnId }, opening);
  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    recordStepStarted({ stepIndex, turnId });
  }
}

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

  describe("after eve compacted the conversation", () => {
    const summary = [
      Object.assign(
        {
          content: "Summary of our conversation so far:",
          role: "user" as const,
        },
        { kind: "context.compaction" }
      ),
      { content: "Сводка.", role: "assistant" as const },
    ];
    const letter = person(
      "ответь Ирине Павловне про встречу. на вы, как обычно"
    );

    it("saves nothing inside the turn: the person's words are unknown", async () => {
      // eve compacted inside the turn and put an older message of the
      // person's back after the kept results: it is not this turn's, and
      // the letter «на вы» this turn asked for is gone (RU d09).
      personTurn("turn_7", 4);
      recordCompactionCompleted("turn_7");
      const tool = await resolveTool([...summary, person("привет")], {
        data: { stepIndex: 3, turnId: "turn_7" },
      });

      const result = await tool.execute({ formal: true }, toolContext());

      expect(settings.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ saved: false });
      expect(JSON.stringify(result)).toContain("compacted");
    });

    it("saves nothing for a turn it has no record of", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      personTurn("turn_8", 2);
      const tool = await resolveTool([...summary, person("давай на вы")], {
        data: { stepIndex: 1, turnId: "turn_other" },
      });

      await tool.execute({ formal: true }, toolContext());

      expect(settings.update).not.toHaveBeenCalled();
    });

    it("looks for the letter next to an opener compaction narrowed", async () => {
      // «ответь Ирине…» went unanswered in an earlier turn, or steered this
      // one; eve compacted at the first step and kept no results, and the
      // step after runs where the first step's words are not kept.
      const history = [...summary, letter, person("ну?")];
      personTurn("turn_11", 1, [letter, person("ну?")]);
      recordCompactionCompleted("turn_11");
      recordStepStarted({ stepIndex: 1, turnId: "turn_11" });
      const tool = await resolveTool(history, {
        data: { stepIndex: 1, turnId: "turn_11" },
      });

      const result = await tool.execute({ formal: true }, toolContext());

      expect(settings.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ saved: false });
    });

    it("looks for the letter in a message that steered the turn after it", async () => {
      personTurn("turn_12", 0, [letter]);
      await resolveTool([letter], {
        data: { stepIndex: 0, turnId: "turn_12" },
      });
      recordStepStarted({ stepIndex: 0, turnId: "turn_12" });
      recordCompactionCompleted("turn_12");
      recordStepStarted({ stepIndex: 1, turnId: "turn_12" });
      const tool = await resolveTool(
        [...summary, letter, person("на вы, как обычно")],
        { data: { stepIndex: 1, turnId: "turn_12" } }
      );

      await tool.execute({ formal: true }, toolContext());

      expect(settings.update).not.toHaveBeenCalled();
    });

    it("saves after a compaction that wrote no summary", async () => {
      // eve only reordered memory records: the summary is an earlier
      // turn's, and the words are this turn's own.
      const history = [...summary, person("давай на вы")];
      personTurn("turn_13", 3, history);
      recordCompactionCompleted("turn_13");
      const tool = await resolveTool(history, {
        data: { stepIndex: 2, turnId: "turn_13" },
      });

      await tool.execute({ formal: true }, toolContext());

      expect(settings.update).toHaveBeenCalledOnce();
    });

    it("reads a later turn's words as before", async () => {
      personTurn("turn_9", 3);
      const letterTool = await resolveTool([...summary, letter], {
        data: { stepIndex: 2, turnId: "turn_9" },
      });
      await letterTool.execute({ formal: true }, toolContext());
      expect(settings.update).not.toHaveBeenCalled();

      personTurn("turn_10", 3);
      const tool = await resolveTool([...summary, person("давай на вы")], {
        data: { stepIndex: 2, turnId: "turn_10" },
      });
      await tool.execute({ formal: true }, toolContext());
      expect(settings.update).toHaveBeenCalledOnce();
    });
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

async function resolveTool(
  messages: DynamicResolveContext["messages"],
  event: { readonly data?: { stepIndex: number; turnId: string } } = {}
) {
  const resolve = formOfAddressTools.events["step.started"];
  if (!resolve) throw new Error("form_of_address must resolve on each step.");
  const tools = await resolve(event, {
    channel: { kind: "channel:telegram", metadata: {} },
    messages,
    model: null,
    session: { auth, id: "session-1" },
  });
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
