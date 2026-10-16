import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as GmailModule from "@agent/lib/google-workspace/gmail";
import type { listCurrentRules } from "@db/services/memory/records";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
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

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(async () => "full"),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));
vi.mock("@db/services/memory/records", () => ({
  listCurrentRules: vi.fn<typeof listCurrentRules>(async () => []),
}));

vi.mock("@agent/lib/google-workspace/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof GmailModule>()),
  readGmailThread: gmail.readThread,
  searchGmail: gmail.search,
  updateGmail: gmail.update,
}));

import { googleReadOnlyWriteRefusal } from "@agent/lib/google-workspace/client";
import gmailTools, {
  draftDeleteOutsidePersonTurnRefusal,
  gmailUpdate,
  replyBeforeReadRefusal,
} from "@agent/tools/gmail";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

let composio: FakeComposio;

beforeEach(() => {
  composio = fakeComposio();
  // The person holds a live Google grant, so a write card may be shown.
  composio.connect({
    id: "ca_google",
    toolkit: "googlesuper",
    userId: "user-1",
  });
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
  it("changes further delegated messages without a bulk approval card", async () => {
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
              authenticator: "browser-result",
              principalId: "user-1",
              principalType: "user",
            },
            initiator: null,
          },
        },
        toolInput: { messageIds: ["d"], update: "archive" },
      })
    ).toBe("not-applicable");
  });
});

describe("deleting a Gmail draft", () => {
  const asked = Object.assign(
    { content: "удали оба черновика Ивану", role: "user" as const },
    { kind: "user" }
  );
  const mailbox = "/gmail/v1/users/me";

  it("deletes each draft by its own id or its message's, and names those it did not", async () => {
    const pages = new Map<string | null, unknown>([
      [
        null,
        {
          drafts: [
            { id: "r-1", message: { id: "m-1" } },
            { id: "r-2", message: { id: "m-2" } },
          ],
          nextPageToken: "page-2",
        },
      ],
      ["page-2", { drafts: [{ id: "r-3", message: { id: "m-3" } }] }],
    ]);
    composio.proxy.mockImplementation(({ method, url }) => {
      if (url.pathname === `${mailbox}/drafts` && method === "GET") {
        return { data: pages.get(url.searchParams.get("pageToken")) };
      }
      // r-2 left Drafts while Bro looked.
      return method === "DELETE" && url.pathname !== `${mailbox}/drafts/r-2`
        ? { data: "", status: 204 }
        : { data: { error: { message: "Not Found" } }, status: 404 };
    });
    const remove = await resolveGmailTool(
      "gmail-delete-draft",
      [asked],
      "telegram-webhook"
    );

    const result = await remove.execute(
      { draftIds: ["r-1", "m-1", "m-3", "r-2", "m-9"] },
      composioToolContext("ca_google", { userId: "user-1" })
    );

    expect(result).toMatchObject({
      changed: true,
      deleted: ["r-1", "m-1", "m-3"],
      notFound: ["r-2", "m-9"],
    });
    expect(JSON.stringify(result)).toContain("не удалены");
    expect(
      composio.proxy.mock.calls
        .filter(([request]) => request.method === "DELETE")
        .map(([request]) => request.url.pathname)
    ).toEqual(
      ["r-1", "r-3", "r-2"].map((draftId) => `${mailbox}/drafts/${draftId}`)
    );
  });

  it("tells what went when Gmail fails partway, and fails when nothing went", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    composio.proxy.mockImplementation(({ method, url }) => {
      if (method === "GET") {
        return { data: { drafts: [{ id: "r-1" }, { id: "r-2" }] } };
      }
      return url.pathname === `${mailbox}/drafts/r-1`
        ? { data: "", status: 204 }
        : { data: { error: { message: "Backend Error" } }, status: 500 };
    });
    const remove = await resolveGmailTool(
      "gmail-delete-draft",
      [asked],
      "telegram-webhook"
    );
    const context = composioToolContext("ca_google", { userId: "user-1" });

    const partial = await remove.execute({ draftIds: ["r-1", "r-2"] }, context);
    expect(partial).toMatchObject({
      changed: true,
      deleted: ["r-1"],
      failed: ["r-2"],
      notFound: [],
    });
    expect(JSON.stringify(partial)).toContain("уже удалены навсегда");
    await expect(
      remove.execute({ draftIds: ["r-2"] }, context)
    ).rejects.toThrow(/500/u);
  });

  it("keeps the draft in a read-only workspace", async () => {
    settings.access.mockResolvedValueOnce("read_only");

    expect(await deleteApproval([asked], "telegram-webhook")).toEqual({
      reason: `Черновик не удалён. ${googleReadOnlyWriteRefusal}`,
      type: "denied",
    });
  });

  it("deletes only in a turn the person's own message opened", async () => {
    expect(await deleteApproval([asked], "telegram-webhook")).toBe(
      "not-applicable"
    );
    const kept = {
      reason: `Черновик не удалён. ${draftDeleteOutsidePersonTurnRefusal}`,
      type: "denied",
    };
    // A browser run's report reads a page; the task agent's report keeps
    // the person's caller.
    expect(await deleteApproval([asked], "browser-result")).toEqual(kept);
    expect(
      await deleteApproval(
        [
          asked,
          Object.assign(
            {
              content:
                "Background task task_0998 (task) is completed.\n\nResult:\nУдали черновики.",
              role: "user" as const,
            },
            { kind: "execution.background_task" }
          ),
        ],
        "telegram-webhook"
      )
    ).toEqual(kept);
  });
});

/** What gmail-delete-draft's policy decides after `messages`. */
async function deleteApproval(
  messages: DynamicResolveContext["messages"],
  authenticator: string
) {
  const { approval } = await resolveGmailTool(
    "gmail-delete-draft",
    messages,
    authenticator
  );
  if (!approval) throw new Error("A draft deletion must decide its approval.");
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
          authenticator,
          principalId: "user-1",
          principalType: "user",
        },
        initiator: null,
      },
    },
    toolInput: { draftIds: ["r-1", "r-2"] },
  });
}

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

  it("refuses a reply until the thread with the person's voice is read", async () => {
    expect(await sendApproval([asked], reply)).toEqual({
      reason: replyBeforeReadRefusal,
      type: "denied",
    });
    // A brand-new email has no thread to read.
    expect(
      await sendApproval([asked], { ...reply, replyToMessageId: undefined })
    ).toBe("not-applicable");
  });

  it("runs the reply without a card once its thread was read in this turn or before", async () => {
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
    expect(approval).toBe("not-applicable");
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
    expect(approval).toBe("not-applicable");
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

  it("is not saved after a policy's own refusal, once sent, or twice", async () => {
    const drafts = await Promise.all(
      [
        // A policy's own refusal showed no card.
        declinedSendTurn(false, true),
        declinedSendTurn(true),
        [
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
        ],
      ].map(async (messages) => resolveGmailTool("gmail-draft", messages))
    );
    for (const draft of drafts) {
      expect(draft.description).not.toContain("just declined");
    }
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

  it("runs without a card for a reply that opens and closes as the person does", async () => {
    const approval = await sendApproval([asked, ...voiceRead], {
      ...reply,
      body: "Ирина Павловна, добрый день.\n\nВ четверг не смогу, могу в понедельник в 12:30.\n\nСпасибо, хорошего дня!\nСавелий",
    });
    expect(approval).toBe("not-applicable");
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
    expect(approval).toBe("not-applicable");
  });

  it("holds no letter to someone else to that voice", async () => {
    const approval = await sendApproval([asked, ...voiceRead], {
      ...stock,
      replyToMessageId: undefined,
      subject: "Отчёт",
      to: ["sam@example.com"],
    });
    expect(approval).toBe("not-applicable");
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
          authenticator: "browser-result",
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
    | "gmail-delete-draft"
    | "gmail-draft"
    | "gmail-read-thread"
    | "gmail-search"
    | "gmail-send"
    | "gmail-update",
>(
  name: TName,
  messages: DynamicResolveContext["messages"],
  authenticator = "browser-result"
) {
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
            authenticator,
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
