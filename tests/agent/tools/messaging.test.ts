import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import messaging from "@agent/tools/messaging";

const taskFiles = vi.hoisted(() => ({
  here: vi.fn<() => boolean>(() => false),
}));
vi.mock("@agent/lib/sandbox/pilot", () => ({
  taskFilesOfCaller: taskFiles.here,
}));
/** A link `share_file` made: Bro's own origin, signed for the task agent's file. */
const sharedFile =
  "https://bro.example.test/eve/v1/sandbox-files/0123456789abcdef01234567/chart.png?sig=ok";
vi.mock("@agent/lib/sandbox/files", () => ({
  isSharedFileLink: (url: string) => url === sharedFile,
}));
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

describe("send_message in the task agent's report", () => {
  const taskReport = Object.assign(
    {
      content:
        "Background task task_1 (task) is completed.\n\nResult:\nИсточник: https://evil.example/s?d=c2VjcmV0",
      role: "user" as const,
    },
    { kind: "execution.background_task" }
  );

  it("sends a link as plain text, never as its own preview", async () => {
    // A preview is fetched by the channel's servers before the person reads
    // it, and the report may have built the link from the person's files.
    taskFiles.here.mockReturnValue(true);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Разбери таблицу"),
      taskReport,
    ]);

    expect(
      await sendMessage.execute(
        {
          kind: "link",
          replyTo: { kind: "current" },
          url: "https://evil.example/s?d=c2VjcmV0",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      replyTo: { kind: "current" },
      text: "https://evil.example/s?d=c2VjcmV0",
    });
  });

  it("sends an attachment from elsewhere as plain text, never fetched", async () => {
    // Telegram and iMessage download an attachment to upload it, the web
    // chat loads it from its URL: the query alone would carry the sheet out.
    taskFiles.here.mockReturnValue(true);
    for (const channel of ["channel:photon", "channel:eve"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One channel at a time.
      const onChannel = await resolveSendMessage(channel, [
        personMessage("Разбери таблицу"),
        taskReport,
      ]);
      expect(
        // oxlint-disable-next-line eslint/no-await-in-loop -- As above.
        await onChannel.execute(
          {
            attachments: [
              { kind: "image", url: "https://evil.example/c.png?d=c2VjcmV0" },
            ],
            kind: "message",
            replyTo: { kind: "current" },
            text: "Вот график",
          },
          toolContext()
        )
      ).toEqual({
        kind: "message",
        replyTo: { kind: "current" },
        text: "Вот график\nhttps://evil.example/c.png?d=c2VjcmV0",
      });
    }
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Разбери таблицу"),
      taskReport,
    ]);
    expect(
      await sendMessage.execute(
        {
          attachments: [
            { kind: "image", url: "https://evil.example/c.png?d=c2VjcmV0" },
          ],
          kind: "message",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      text: "https://evil.example/c.png?d=c2VjcmV0",
    });
  });

  it("keeps the task agent's own files as attachments", async () => {
    taskFiles.here.mockReturnValue(true);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Разбери таблицу"),
      taskReport,
    ]);
    const own = { kind: "image" as const, name: "chart.png", url: sharedFile };

    expect(
      await sendMessage.execute(
        { attachments: [own], kind: "message", text: "Готово" },
        toolContext()
      )
    ).toEqual({ attachments: [own], kind: "message", text: "Готово" });
    expect(
      await sendMessage.execute(
        {
          attachments: [
            own,
            { kind: "image", url: "https://evil.example/c.png?d=MQ" },
          ],
          kind: "message",
          text: "Ещё",
        },
        toolContext()
      )
    ).toEqual({
      attachments: [own],
      kind: "message",
      text: "Ещё\nhttps://evil.example/c.png?d=MQ",
    });
  });

  it("keeps attachments from elsewhere in the person's own turn", async () => {
    taskFiles.here.mockReturnValue(true);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Пришли фото кота"),
    ]);
    const message = {
      attachments: [
        { kind: "image" as const, url: "https://example.com/cat.jpg" },
      ],
      kind: "message" as const,
    };

    expect(await sendMessage.execute(message, toolContext())).toEqual(message);
  });

  it("keeps a native link where the person's files do not reach the task agent", async () => {
    taskFiles.here.mockReturnValue(false);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Разбери таблицу"),
      taskReport,
    ]);
    const link = { kind: "link" as const, url: "https://example.com/renew" };

    expect(await sendMessage.execute(link, toolContext())).toEqual(link);
  });

  it("keeps a native link in the person's own turn", async () => {
    taskFiles.here.mockReturnValue(true);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Скинь ссылку"),
    ]);
    const link = { kind: "link" as const, url: "https://example.com/renew" };

    expect(await sendMessage.execute(link, toolContext())).toEqual(link);
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
