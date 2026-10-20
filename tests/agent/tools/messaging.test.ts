import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { describe, expect, it, vi } from "vitest";
import type * as SandboxFiles from "@agent/lib/sandbox/files";
import messaging from "@agent/tools/messaging";

const taskFiles = vi.hoisted(() => ({
  here: vi.fn<() => boolean>(() => false),
  pilot: vi.fn<() => boolean>(() => false),
}));
vi.mock("@agent/lib/sandbox/pilot", () => ({
  // Whether the report's conversation may hold the person's files: the
  // files pilot or the mark of one of its task agents
  // (`reportTurnHoldsFiles`).
  reportTurnHoldsFiles: async () => await Promise.resolve(taskFiles.here()),
  // The files pilot itself, which mends the task agent's links.
  taskFilesOfCaller: () => taskFiles.pilot(),
}));
/** A link `share_file` made: Bro's own origin, signed for the task agent's file. */
const sharedFile =
  "https://bro.example.test/eve/v1/sandbox-files/0123456789abcdef01234567/chart.png?sig=ok";
vi.mock("@agent/lib/sandbox/files", async (importOriginal) => ({
  ...(await importOriginal<typeof SandboxFiles>()),
  isSharedFileLink: (url: string) => url === sharedFile,
}));
const earlyReply = vi.hoisted(() => ({
  pilot: vi.fn<() => boolean>(() => false),
}));
vi.mock("@agent/lib/delivery/pilot", () => ({
  // The turn's verdict of EARLY_REPLY_WORKSPACES for the caller.
  earlyReplyPilotOfCaller: async () =>
    await Promise.resolve(earlyReply.pilot()),
}));
import { sendMessageOutputSchema } from "@shared/chat/message-delivery";
import {
  headsUpDeliveredNotice,
  rewriteSendNotice,
} from "@agent/lib/delivery/turn-sends";

describe("send_message channel notes", () => {
  it.each(["channel:eve"])(
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

describe("send_message and the delivery sentinel", () => {
  // The instructions ask for DELIVERY_COMPLETE as plain text after the last
  // delivery; on 04.10 a model wrote it into send_message instead, and the
  // person received a message «DELIVERY_COMPLETE».
  it.each([
    ["the sentinel alone", "DELIVERY_COMPLETE"],
    [
      "the sentinel with eve's empty marker",
      "DELIVERY_COMPLETE\n<eve-empty-delivery/>",
    ],
  ])("never delivers %s", async (_case, text) => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("напомни завтра"),
    ]);

    const output = await sendMessage.execute(
      { kind: "message", replyTo: { kind: "current" }, text },
      toolContext()
    );
    expect(output).toEqual({ skipped: "sentinel" });
    expect(sendMessageOutputSchema.safeParse(output).success).toBe(false);
    const modelOutput = await sendMessage.toModelOutput?.({
      skipped: "sentinel",
    });
    expect(modelOutput?.type === "text" ? modelOutput.value : "").toBe(
      "Not delivered: DELIVERY_COMPLETE is bookkeeping, not a message — the person never reads it. If the reply is done, end the turn now without calling any tool."
    );
  });

  it("delivers the text written around the sentinel without it", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("напомни завтра"),
    ]);

    expect(
      await sendMessage.execute(
        {
          kind: "message",
          replyTo: { kind: "current" },
          text: "Готово, напомню завтра в 10:00.\n\nDELIVERY_COMPLETE",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      replyTo: { kind: "current" },
      text: "Готово, напомню завтра в 10:00.",
    });
  });

  it("delivers the attachment of a send whose only text is the sentinel", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("пришли фото кота"),
    ]);
    const attachments = [
      { kind: "image" as const, url: "https://example.com/cat.jpg" },
    ];

    expect(
      await sendMessage.execute(
        {
          attachments,
          kind: "message",
          replyTo: { kind: "current" },
          text: "DELIVERY_COMPLETE",
        },
        toolContext()
      )
    ).toEqual({ attachments, kind: "message", replyTo: { kind: "current" } });
  });
});

/** A Lavka product photo on Yandex's image CDN. */
const photo = (name: string) =>
  `https://avatars.mds.yandex.net/get-grocery-goods/1/${name}/600x600`;

describe("send_message and pictures written into the text", () => {
  // 20.10: the model wrote Lavka's photos as ![…](https://…), which
  // Telegram posts as «!» and a bare link.
  it("attaches them and keeps each caption as a line", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("покажи котлеты из Лавки"),
    ]);

    expect(
      await sendMessage.execute(
        {
          attachments: [{ kind: "image", url: photo("b") }],
          kind: "message",
          replyTo: { kind: "current" },
          text: `Вот котлеты:\n\n![Котлеты «Индилайт», 400 г — 399 ₽](${photo("a")})  \n![Бифштекс, 200 г — 135 ₽](${photo("b")})\n\n\n![](${photo("c")})\n\nЧто берём?`,
        },
        toolContext()
      )
    ).toEqual({
      attachments: [
        { kind: "image", url: photo("b") },
        { kind: "image", url: photo("a") },
        { kind: "image", url: photo("c") },
      ],
      kind: "message",
      replyTo: { kind: "current" },
      text: "Вот котлеты:\n\nКотлеты «Индилайт», 400 г — 399 ₽\nБифштекс, 200 г — 135 ₽\n\nЧто берём?",
    });
  });

  it("leaves Bro's own artifacts and the pictures past ten attachments as written", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("покажи котлеты из Лавки"),
    ]);
    const nine = Array.from({ length: 9 }, (_, index) => ({
      kind: "image" as const,
      url: photo(String(index)),
    }));
    const text = `![картинка](/artifacts/0b9f6c2e-6c8f-4a7e-9a39-6d0f3f2a1b11)\n![Первая](${photo("x")})\n![Вторая](${photo("y")})`;

    expect(
      await sendMessage.execute(
        { attachments: nine, kind: "message", text },
        toolContext()
      )
    ).toEqual({
      attachments: [...nine, { kind: "image", url: photo("x") }],
      kind: "message",
      text: `![картинка](/artifacts/0b9f6c2e-6c8f-4a7e-9a39-6d0f3f2a1b11)\nПервая\n![Вторая](${photo("y")})`,
    });
  });

  it("sends a text of pictures alone as the pictures", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("скинь фото"),
    ]);

    expect(
      await sendMessage.execute(
        { kind: "message", text: `![](${photo("a")})` },
        toolContext()
      )
    ).toEqual({
      attachments: [{ kind: "image", url: photo("a") }],
      kind: "message",
    });
  });
});

describe("send_message and the early reply", () => {
  const headsUp = {
    kind: "message" as const,
    replyTo: { kind: "current" as const },
    text: "Секунду, запускаю браузер",
  };

  it("returns the heads-up for a rewrite outside the pilot, as before", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("найди крем для рук на озоне"),
    ]);

    const output = await sendMessage.execute(headsUp, toolContext());
    expect(output).toEqual({ rewrite: "status" });
    const modelOutput = await sendMessage.toModelOutput?.({
      rewrite: "status",
    });
    expect(modelOutput?.type === "text" ? modelOutput.value : "").toBe(
      rewriteSendNotice("status")
    );
    // A delivered message keeps its usual note.
    const delivered = await sendMessage.toModelOutput?.(headsUp);
    expect(delivered?.type === "text" ? delivered.value : "").toMatch(
      /^The message was submitted to the active channel\. Do not repeat/u
    );
  });

  it("delivers it in the pilot and tells the model the answer is still owed", async () => {
    earlyReply.pilot.mockReturnValue(true);
    try {
      const sendMessage = await resolveSendMessage("channel:telegram", [
        personMessage("найди крем для рук на озоне"),
      ]);

      const output = await sendMessage.execute(headsUp, toolContext());
      expect(output).toEqual(headsUp);
      expect(sendMessageOutputSchema.safeParse(output).success).toBe(true);
      const modelOutput = await sendMessage.toModelOutput?.(headsUp);
      const note = modelOutput?.type === "text" ? modelOutput.value : "";
      expect(note.startsWith(headsUpDeliveredNotice)).toBe(true);
      expect(note).toContain("Native quoted replies are unavailable");
    } finally {
      earlyReply.pilot.mockReturnValue(false);
    }
  });

  it("gives the answer in the pilot its usual note", async () => {
    earlyReply.pilot.mockReturnValue(true);
    try {
      const sendMessage = await resolveSendMessage("channel:telegram", [
        personMessage("сколько будет 2+2?"),
      ]);
      const answer = { kind: "message" as const, text: "4" };

      expect(await sendMessage.execute(answer, toolContext())).toEqual(answer);
      const modelOutput = await sendMessage.toModelOutput?.(answer);
      expect(modelOutput?.type === "text" ? modelOutput.value : "").toMatch(
        /^The message was submitted to the active channel\./u
      );
    } finally {
      earlyReply.pilot.mockReturnValue(false);
    }
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

  it("gives a bare shop address https:// before any channel sees it", async () => {
    const sendMessage = await resolveSendMessage("channel:telegram");

    expect(
      await sendMessage.execute(
        {
          kind: "message",
          text: "вот [карточка](mvideo.ru/products/tv-1) и mvideo.ru/products/tv-2",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      text: "вот [карточка](https://mvideo.ru/products/tv-1) и https://mvideo.ru/products/tv-2",
    });
    expect(sendMessage.description).toContain("[word](https://full-address)");
  });

  it("shows the address of a link in a report that may hold the files", async () => {
    taskFiles.here.mockReturnValue(true);
    const sendMessage = await resolveSendMessage("channel:telegram", [
      personMessage("Разбери таблицу"),
      taskReport,
    ]);

    expect(
      await sendMessage.execute(
        {
          kind: "message",
          text: "Итог: [таблица](https://evil.example/s?d=c2VjcmV0)",
        },
        toolContext()
      )
    ).toEqual({
      kind: "message",
      text: "Итог: таблица: https://evil.example/s?d=c2VjcmV0",
    });
  });

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

  it("mends a task file link the model miswrote, in the files pilot", async () => {
    taskFiles.here.mockReturnValue(true);
    const reported = Object.assign(
      {
        content: `Background task task_1 (task) is completed.\n\nResult:\nГрафик: ${sharedFile}`,
        role: "user" as const,
      },
      { kind: "execution.background_task" }
    );
    const miswritten = sharedFile.replace("01234567/", "01234566/");
    const send = {
      attachments: [{ kind: "image" as const, url: miswritten }],
      kind: "message" as const,
      text: "Готово",
    };

    taskFiles.pilot.mockReturnValue(true);
    const pilot = await resolveSendMessage("channel:telegram", [
      personMessage("Построй график"),
      reported,
    ]);
    expect(await pilot.execute(send, toolContext())).toEqual({
      attachments: [{ kind: "image", url: sharedFile }],
      kind: "message",
      text: "Готово",
    });

    // Outside the pilot the link stays as written, so it goes as text.
    taskFiles.pilot.mockReturnValue(false);
    const outside = await resolveSendMessage("channel:telegram", [
      personMessage("Построй график"),
      reported,
    ]);
    expect(await outside.execute(send, toolContext())).toEqual({
      kind: "message",
      text: `Готово\n${miswritten}`,
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
