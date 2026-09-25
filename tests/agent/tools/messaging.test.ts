import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";
import messaging from "@agent/tools/messaging";
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";

describe("send_message channel notes", () => {
  it.each(["channel:eve", "channel:photon", "channel:telegram"])(
    "never tells the model %s delivers an attachment as a link",
    async (channel) => {
      const sendMessage = await resolveSendMessage(channel);

      expect(sendMessage.description).toContain("uploaded to the conversation");
      expect(sendMessage.description).not.toContain("delivered as a link");
      const output = await sendMessage.toModelOutput?.({
        attachments: [
          { kind: "image", url: "https://media.example/result.jpg" },
        ],
        kind: "message",
        text: "Here it is.",
      });

      expect(output?.type === "text" ? output.value : "").toMatch(
        /^The message was submitted to the active channel\. Do not repeat or rephrase it/u
      );
    }
  );

  it("keeps each fact with its option (RU d03, 25.09)", async () => {
    // «все с вегетарианским меню и чеком до 2500», one of three checked.
    const sendMessage = await resolveSendMessage("channel:telegram");

    expect(sendMessage.description).toContain(
      "keep each price and fact with the option it was found for"
    );
    expect(sendMessage.description).toContain(
      "«все» or «ни один» only of the options you checked"
    );
  });

  it("still explains that a quoted reply is delivered unquoted", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    const output = await sendMessage.toModelOutput?.({
      kind: "message",
      replyTo: { kind: "current" },
      text: "Here it is.",
    });

    expect(output?.type === "text" ? output.value : "").toContain(
      "Native quoted replies are unavailable on this channel"
    );
  });
});

describe("send_message in a looping turn", () => {
  const repeated = {
    kind: "message" as const,
    text: "Готово, напомню завтра.",
  };

  it("drops a message the turn already delivered instead of posting it again", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      Object.assign(
        { content: "напомни", role: "user" as const },
        { kind: "user" }
      ),
      {
        content: [
          {
            input: repeated,
            toolCallId: "call-1",
            toolName: "send_message",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: { type: "text" as const, value: "submitted" },
            toolCallId: "call-1",
            toolName: "send_message",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);

    const output = await sendMessage.execute(repeated, toolContext());
    expect(output).toEqual({ skipped: "duplicate" });
    // Channels deliver only a result that parses as a message.
    expect(sendMessageOutputSchema.safeParse(output).success).toBe(false);
    const modelOutput = await sendMessage.toModelOutput?.({
      skipped: "duplicate",
    });
    expect(modelOutput?.type === "text" ? modelOutput.value : "").toContain(
      "Do not send it again"
    );
  });

  it("returns a claim the run has not made yet for a rewrite", async () => {
    const claim = {
      kind: "message" as const,
      text: "код ввёл — кабинет открылся, смотрю штрафы.",
    };
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage("код от госуслуг: 123456"),
      {
        content: [
          {
            input: { action: "continue" },
            toolCallId: "call-1",
            toolName: "browser_task",
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
              value: { runId: "run-2", status: "running" },
            },
            toolCallId: "call-1",
            toolName: "browser_task",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);

    const output = await sendMessage.execute(claim, toolContext());
    expect(output).toEqual({ rewrite: "browser" });
    expect(sendMessageOutputSchema.safeParse(output).success).toBe(false);
    const modelOutput = await sendMessage.toModelOutput?.({
      rewrite: "browser",
    });
    expect(modelOutput?.type === "text" ? modelOutput.value : "").toContain(
      "has done nothing yet"
    );
  });

  it("delivers the first message of a turn as written", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    expect(await sendMessage.execute(repeated, toolContext())).toEqual(
      repeated
    );
  });

  it("groups a rouble sum in thousands on its way out", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    expect(
      await sendMessage.execute(
        {
          kind: "message",
          replyTo: { kind: "current" },
          text: "Стрижка 2000 ₽, код 739204.",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      replyTo: { kind: "current" },
      text: "Стрижка 2 000 ₽, код 739204.",
    });
  });
});

describe("send_message and the reply language", () => {
  // The language is a prompt directive, never a filter: a translation the
  // person asked for is in the other language on purpose.
  it.each([
    [
      "an English translation for a Russian speaker",
      "Переведи на английский: «Встреча переносится на пятницу, 15:00».",
      "The meeting is moved to Friday at 3 PM. Please confirm that works for you.",
    ],
    [
      "a Russian text for an English speaker",
      "Write a short note in Russian for my landlord saying the rent will be two days late.",
      "Здравствуйте! Хочу предупредить, что оплата аренды в этом месяце задержится на два дня.",
    ],
  ])("delivers %s as written", async (_case, request, reply) => {
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage(request),
    ]);
    const message = { kind: "message" as const, text: reply };

    expect(await sendMessage.execute(message, toolContext())).toEqual(message);
  });
});

function personMessage(text: string) {
  // eve adds `kind` to every user-role message it keeps in history.
  return Object.assign(
    { content: text, role: "user" as const },
    { kind: "user" }
  );
}

async function resolveSendMessage(
  channel: string,
  messages: DynamicResolveContext["messages"] = []
) {
  const resolveMessagingTools = messaging.events["step.started"];
  if (!resolveMessagingTools) {
    throw new Error("The messaging tools must resolve on a started turn.");
  }
  const tools = await resolveMessagingTools(
    {},
    { ...dynamicContext(channel), messages }
  );
  if (!tools || "execute" in tools || !("send_message" in tools)) {
    throw new Error(`The ${channel} channel must expose send_message.`);
  }
  return tools.send_message;
}

function dynamicContext(channel: string) {
  return {
    channel: { kind: channel, metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "photon-imessage",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-2",
    getSandbox: () => {
      throw new Error("send_message does not use a sandbox.");
    },
    getSkill: () => {
      throw new Error("send_message does not use a skill.");
    },
    getToken: () => {
      throw new Error("send_message does not use a token provider.");
    },
    requireAuth: (): never => {
      throw new Error("send_message does not require a token provider.");
    },
    session: {
      auth: dynamicContext("channel:telegram").session.auth,
      id: "session-1",
      turn: { id: "turn-1", sequence: 1 },
    },
    toolName: "send_message",
  } satisfies ToolContext;
}
