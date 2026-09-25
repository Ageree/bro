import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as GmailModule from "@agent/lib/google-workspace/gmail";
import type {
  GmailCompose,
  readGmailThread,
  searchGmail,
  updateGmail,
} from "@agent/lib/google-workspace/gmail";

const gmail = vi.hoisted(() => ({
  readThread: vi
    .fn<typeof readGmailThread>()
    .mockResolvedValue({ id: "thread-1", messages: [] }),
  search: vi.fn<typeof searchGmail>().mockResolvedValue([]),
  update: vi.fn<typeof updateGmail>().mockResolvedValue({
    action: "archive",
    keptSecurityAlerts: [],
    updatedCount: 2,
  }),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: async () => "full",
}));

vi.mock("@agent/lib/google-workspace/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailModule>()),
  readGmailThread: gmail.readThread,
  searchGmail: gmail.search,
  updateGmail: gmail.update,
}));

import gmailTools, {
  gmailUpdate,
  replyBeforeReadRefusal,
} from "@agent/tools/gmail";
import { fakeComposio } from "@tests/helpers/composio";

beforeEach(() => {
  // The person holds a live Google grant, so a write card may be shown.
  fakeComposio().connect({ toolkit: "googlesuper", userId: "user-1" });
});

describe("Google Workspace tools", () => {
  it("reports the selected Gmail update without an action discriminator", async () => {
    const context = toolContext();
    const result = await gmailUpdate.execute(
      { messageIds: ["message-1", "message-2"], update: "archive" },
      context
    );

    expect(gmail.update).toHaveBeenCalledExactlyOnceWith(
      context,
      ["message-1", "message-2"],
      "archive"
    );
    expect(result).toEqual({ update: "archive", updatedCount: 2 });
  });
});

describe("Gmail reads in one turn", () => {
  it("answers a search the turn already made without asking Google", async () => {
    const search = await resolveGmailSearch([
      Object.assign(
        { content: "triage my inbox", role: "user" as const },
        { kind: "user" }
      ),
      {
        content: [
          {
            input: { query: "in:inbox" },
            toolCallId: "call-1",
            toolName: "gmail-search",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
      {
        content: [
          {
            output: { type: "json" as const, value: { messages: [] } },
            toolCallId: "call-1",
            toolName: "gmail-search",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);

    const repeated = await search.execute(
      { maxResults: 10, query: "in:inbox" },
      toolContext()
    );
    expect(repeated).toEqual({ refused: "duplicate" });
    expect(gmail.search).not.toHaveBeenCalled();
    if (Symbol.asyncIterator in repeated) {
      throw new Error("gmail-search returns one result.");
    }
    const output = await search.toModelOutput?.(repeated);
    expect(output?.type === "text" ? output.value : "").toContain(
      "this exact call already ran in this turn"
    );

    await search.execute({ maxResults: 10, query: "from:bank" }, toolContext());
    expect(gmail.search).toHaveBeenCalledOnce();
  });

  it("says what to try after a search that found nothing", async () => {
    const search = await resolveGmailSearch([
      Object.assign(
        {
          content: "там в почте счёт от репетитора, разберись",
          role: "user" as const,
        },
        { kind: "user" }
      ),
    ]);

    const empty = await search.execute(
      { maxResults: 15, query: "репетитор счёт" },
      toolContext()
    );

    expect(empty).toMatchObject({ messages: [] });
    expect(JSON.stringify(empty)).toContain("contain every one of these words");
  });
});

describe("Gmail changes in one turn", () => {
  it("asks for the fourth message a turn changes, split across calls", async () => {
    const update = await resolveGmailTool("gmail-update", [
      Object.assign(
        { content: "triage my inbox", role: "user" as const },
        { kind: "user" }
      ),
      {
        content: [
          {
            input: { messageIds: ["a", "b", "c"], update: "archive" },
            toolCallId: "call-1",
            toolName: "gmail-update",
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
              value: { update: "archive", updatedCount: 3 },
            },
            toolCallId: "call-1",
            toolName: "gmail-update",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);
    const { approval } = update;
    if (!approval) throw new Error("gmail-update must decide its approval.");
    const policy = "request" in approval ? approval.request : approval;
    const context = toolContext();

    expect(
      await policy({
        ...context,
        approvedTools: new Set(),
        session: {
          ...context.session,
          auth: {
            current: {
              attributes: { workspaceId: "personal:workspace" },
              authenticator: "eve",
              principalId: "user-1",
              principalType: "user",
            },
            initiator: null,
          },
        },
        toolInput: { messageIds: ["d"], update: "archive" },
      })
    ).toBe("user-approval");
  });
});

/** A turn where the person asked for a reply and declined its card. */
function declinedSendTurn(approved: boolean, isAutomatic = false) {
  return [
    Object.assign(
      {
        content: "ответь Ирине Павловне, что в четверг не могу",
        role: "user" as const,
      },
      { kind: "user" }
    ),
    {
      content: [
        {
          input: {
            body: "Ирина Павловна, добрый день!",
            replyToMessageId: "message-1",
            to: ["irina@example.com"],
          },
          toolCallId: "call-send",
          toolName: "gmail-send",
          type: "tool-call" as const,
        },
        {
          approvalId: "approval-send",
          isAutomatic,
          toolCallId: "call-send",
          type: "tool-approval-request" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          approvalId: "approval-send",
          approved,
          type: "tool-approval-response" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
}

/** A `gmail-read-thread` call and its answer: the thread and its messages. */
function threadRead(
  callId: string,
  input: { readonly forReply?: boolean; readonly threadId: string },
  messageIds: readonly string[]
) {
  return [
    {
      content: [
        {
          input,
          toolCallId: callId,
          toolName: "gmail-read-thread",
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
            value: {
              thread: {
                id: input.threadId,
                messages: messageIds.map((id) => ({
                  id,
                  threadId: input.threadId,
                })),
              },
            },
          },
          toolCallId: callId,
          toolName: "gmail-read-thread",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
}

describe("a reply before its thread was read", () => {
  const reply = {
    bcc: [],
    body: "Ирина Павловна, добрый день!",
    cc: [],
    replyToMessageId: "m-thursday",
    to: ["irina@example.com"],
  };
  const asked = Object.assign(
    { content: "ответь Ирине Павловне", role: "user" as const },
    { kind: "user" }
  );

  it("shows no card until the thread with the person's voice is read", async () => {
    expect(await sendApproval([asked], reply)).toEqual({
      reason: replyBeforeReadRefusal,
      type: "denied",
    });
    // A brand-new email has no thread to read.
    expect(
      await sendApproval([asked], { ...reply, replyToMessageId: undefined })
    ).toBe("user-approval");
  });

  it("shows the card once the thread was read for a reply, in this turn or before", async () => {
    const approval = await sendApproval(
      [
        ...threadRead(
          "call-read",
          { forReply: true, threadId: "thread-thursday" },
          ["m-earlier", "m-thursday"]
        ),
        asked,
      ],
      reply
    );
    expect(approval).toBe("user-approval");
  });

  it("does not count a plain read, which brought no voice", async () => {
    const approval = await sendApproval(
      [
        asked,
        ...threadRead("call-read", { threadId: "thread-thursday" }, [
          "m-thursday",
        ]),
      ],
      reply
    );
    expect(approval).toEqual({
      reason: replyBeforeReadRefusal,
      type: "denied",
    });
  });

  it("answers an old message of a long thread the read cut off", async () => {
    const approval = await sendApproval(
      [
        asked,
        {
          content: [
            {
              output: {
                type: "json" as const,
                value: {
                  messages: [{ id: "m-old", threadId: "thread-long" }],
                },
              },
              toolCallId: "call-search",
              toolName: "gmail-search",
              type: "tool-result" as const,
            },
          ],
          role: "tool" as const,
        },
        // The read lists only the last messages of the thread.
        ...threadRead(
          "call-read",
          { forReply: true, threadId: "thread-long" },
          ["m-late"]
        ),
      ],
      { ...reply, replyToMessageId: "m-old" }
    );
    expect(approval).toBe("user-approval");
  });
});

describe("a thread read and the person's voice", () => {
  it("looks up the voice only for a reply, once per addressee and a few times a turn", async () => {
    const read = await resolveGmailTool("gmail-read-thread", [
      Object.assign(
        { content: "ответь Ирине и Саше", role: "user" as const },
        { kind: "user" }
      ),
      {
        content: [
          {
            output: {
              type: "json" as const,
              value: {
                thread: {
                  id: "thread-irina",
                  messages: [],
                  yourEarlierEmails: {
                    emails: [],
                    note: "The person has never emailed irina@example.com themselves…",
                    to: "irina@example.com",
                  },
                },
              },
            },
            toolCallId: "call-read",
            toolName: "gmail-read-thread",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ]);
    const context = toolContext();

    await read.execute({ forReply: true, threadId: "thread-sasha" }, context);
    await read.execute({ threadId: "thread-plain" }, context);

    expect(gmail.readThread.mock.calls.map((call) => call[2])).toEqual([
      { voice: { known: ["irina@example.com"], left: 2 } },
      { voice: null },
    ]);
  });
});

describe("an email the person declined on its card", () => {
  it("is saved as a draft next", async () => {
    const draft = await resolveGmailTool(
      "gmail-draft",
      declinedSendTurn(false)
    );
    expect(draft.description).toMatch(
      /^The person just declined the gmail-send card: save that same email now/u
    );
  });

  it("is not a policy's own refusal, which showed no card", async () => {
    const draft = await resolveGmailTool(
      "gmail-draft",
      declinedSendTurn(false, true)
    );
    expect(draft.description).not.toContain("just declined");
  });

  it("changes nothing once sent", async () => {
    const draft = await resolveGmailTool("gmail-draft", declinedSendTurn(true));
    expect(draft.description).not.toContain("just declined");
  });

  it("is not saved twice", async () => {
    const draft = await resolveGmailTool("gmail-draft", [
      ...declinedSendTurn(false),
      {
        content: [
          {
            input: { body: "…", to: ["irina@example.com"] },
            toolCallId: "call-draft",
            toolName: "gmail-draft",
            type: "tool-call" as const,
          },
        ],
        role: "assistant" as const,
      },
    ]);
    expect(draft.description).not.toContain("just declined");
  });
});

describe("a reply in the person's usual voice", () => {
  const asked = Object.assign(
    {
      content:
        "ответь Ирине Павловне про встречу в четверг: в четверг не могу. на вы, как обычно",
      role: "user" as const,
    },
    { kind: "user" }
  );
  /** The read for a reply, with the formulas the person keeps using. */
  const voiceRead = [
    {
      content: [
        {
          input: { forReply: true, threadId: "thread-thursday" },
          toolCallId: "call-read",
          toolName: "gmail-read-thread",
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
            value: {
              thread: {
                id: "thread-thursday",
                messages: [{ id: "m-thursday", threadId: "thread-thursday" }],
                yourEarlierEmails: {
                  emails: [],
                  note: "These are the person's own emails…",
                  to: "irina@example.com",
                  usual: {
                    greeting: "Ирина Павловна, добрый день!",
                    signOff: "Спасибо! Хорошего дня.",
                  },
                },
              },
            },
          },
          toolCallId: "call-read",
          toolName: "gmail-read-thread",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
  ];
  const reply = {
    bcc: [],
    cc: [],
    replyToMessageId: "m-thursday",
    subject: "Встреча в четверг",
    to: ["Irina@example.com"],
  };
  const stock = {
    ...reply,
    body: "Добрый день, Ирина Павловна!\n\nВ четверг, к сожалению, не смогу.\n\nС уважением,\nСавелий",
  };

  it("sends a stock greeting and sign-off back to be written as the person writes", async () => {
    const approval = z
      .object({ reason: z.string(), type: z.literal("denied") })
      .parse(await sendApproval([asked, ...voiceRead], stock));
    expect(approval.reason).toContain(
      "«Ирина Павловна, добрый день!» и «Спасибо! Хорошего дня.»"
    );
  });

  it("shows the card for a reply that opens and closes as the person does", async () => {
    const approval = await sendApproval([asked, ...voiceRead], {
      ...reply,
      body: "Ирина Павловна, добрый день.\n\nВ четверг не смогу, могу в понедельник в 12:30.\n\nСпасибо, хорошего дня!\nСавелий",
    });
    expect(approval).toBe("user-approval");
  });

  it("reminds once a turn: the same letter again is what the person wants", async () => {
    const approval = await sendApproval(
      [
        asked,
        ...voiceRead,
        {
          content: [
            {
              input: stock,
              toolCallId: "call-send",
              toolName: "gmail-send",
              type: "tool-call" as const,
            },
          ],
          role: "assistant" as const,
        },
      ],
      stock
    );
    expect(approval).toBe("user-approval");
  });

  it("holds no letter to someone else to that voice", async () => {
    const approval = await sendApproval([asked, ...voiceRead], {
      ...stock,
      replyToMessageId: undefined,
      subject: "Отчёт",
      to: ["sam@example.com"],
    });
    expect(approval).toBe("user-approval");
  });
});

/** What gmail-send's policy decides for `toolInput` after `messages`. */
async function sendApproval(
  messages: DynamicResolveContext["messages"],
  toolInput: GmailCompose
) {
  const { approval } = await resolveGmailTool("gmail-send", messages);
  if (!approval) throw new Error("The Gmail write must decide its approval.");
  const policy = "request" in approval ? approval.request : approval;
  const context = toolContext();
  return policy({
    ...context,
    approvedTools: new Set(),
    session: {
      ...context.session,
      auth: {
        current: {
          attributes: { workspaceId: "personal:workspace" },
          authenticator: "eve",
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
    toolInput,
  });
}

async function resolveGmailSearch(messages: DynamicResolveContext["messages"]) {
  return resolveGmailTool("gmail-search", messages);
}

async function resolveGmailTool<
  const TName extends
    | "gmail-draft"
    | "gmail-read-thread"
    | "gmail-search"
    | "gmail-send"
    | "gmail-update",
>(name: TName, messages: DynamicResolveContext["messages"]) {
  const resolve = gmailTools.events["step.started"];
  if (!resolve) throw new Error("The Gmail tools must resolve on every step.");
  const tools = await resolve(
    {},
    {
      channel: { kind: "channel:eve", metadata: {} },
      messages,
      model: null,
      session: {
        auth: {
          current: {
            attributes: { workspaceId: "personal:workspace" },
            authenticator: "eve",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "session-1",
      },
    }
  );
  if (!tools || !("gmail-update" in tools)) {
    throw new Error("An interactive turn must expose the Gmail tools.");
  }
  const tool = tools[name];
  if (!tool) throw new Error(`An interactive turn must expose ${name}.`);
  return tool;
}

function toolContext() {
  return {
    abortSignal: new AbortController().signal,
    callId: "call-1",
    async getSandbox() {
      throw new Error("Sandbox access is outside this focused test.");
    },
    getSkill() {
      throw new Error("Skill access is outside this focused test.");
    },
    async getToken() {
      throw new Error("Token access is outside this focused test.");
    },
    requireAuth() {
      throw new Error("Authorization is outside this focused test.");
    },
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "gmail-update",
  } satisfies ToolContext;
}
