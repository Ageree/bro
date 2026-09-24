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

      expect(output).toEqual({
        type: "text",
        value:
          "The message was submitted to the active channel. Do not repeat it in assistant text.",
      });
    }
  );

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

  it("delivers the first message of a turn as written", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    expect(await sendMessage.execute(repeated, toolContext())).toEqual(
      repeated
    );
  });
});

describe("send_message reply language", () => {
  const russianReply = {
    kind: "message" as const,
    text: "Нашёл отличное место: «Пушкин» на Тверском, столик на четверых есть.",
  };
  const englishReply = {
    kind: "message" as const,
    text: "Found a great spot: Pushkin on Tverskoy, and they have a table for four.",
  };

  it("bounces a Russian reply to an English message for a rewrite", async () => {
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage("find a dinner spot for four tomorrow at 7:30"),
    ]);

    const output = await sendMessage.execute(russianReply, toolContext());
    expect(output).toEqual({ language: "en", skipped: "language" });
    expect(sendMessageOutputSchema.safeParse(output).success).toBe(false);
    const modelOutput = await sendMessage.toModelOutput?.({
      language: "en",
      skipped: "language",
    });
    expect(modelOutput?.type === "text" ? modelOutput.value : "").toContain(
      "Rewrite the same message in English"
    );
    expect(await sendMessage.execute(englishReply, toolContext())).toEqual(
      englishReply
    );
  });

  it("bounces an English reply to a Russian message", async () => {
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage("найди, где поужинать вчетвером завтра в 19:30"),
    ]);

    expect(await sendMessage.execute(englishReply, toolContext())).toEqual({
      language: "ru",
      skipped: "language",
    });
    expect(await sendMessage.execute(russianReply, toolContext())).toEqual(
      russianReply
    );
  });

  it("lets a Russian reply with an English brand through", async () => {
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage("что купить, iPhone или Pixel?"),
    ]);
    const reply = { kind: "message" as const, text: "Бери iPhone 17 Pro" };

    expect(await sendMessage.execute(reply, toolContext())).toEqual(reply);
  });

  it("gives up bouncing after two retries in a turn", async () => {
    const bounced = (id: string) => [
      {
        content: [
          {
            input: russianReply,
            toolCallId: id,
            toolName: "send_message",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: {
              type: "text" as const,
              value:
                "Not delivered, wrong language: the person wrote in English.",
            },
            toolCallId: id,
            toolName: "send_message",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ];
    const sendMessage = await resolveSendMessage("channel:eve", [
      personMessage("find a dinner spot for four tomorrow at 7:30"),
      ...bounced("call-1"),
      ...bounced("call-2"),
    ]);

    expect(await sendMessage.execute(russianReply, toolContext())).toEqual(
      russianReply
    );
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
