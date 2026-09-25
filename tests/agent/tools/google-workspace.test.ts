import type { DynamicResolveContext, ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GmailModule from "@agent/lib/google-workspace/gmail";
import type {
  GmailCompose,
  searchGmail,
  updateGmail,
} from "@agent/lib/google-workspace/gmail";

const gmail = vi.hoisted(() => ({
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
function declinedSendTurn(approved: boolean) {
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

  it("shows the card once the thread was read, in this turn or before", async () => {
    const approval = await sendApproval(
      [
        {
          content: [
            {
              output: {
                type: "json" as const,
                value: {
                  thread: {
                    id: "thread-thursday",
                    messages: [{ id: "m-thursday" }, { id: null }],
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
        asked,
      ],
      reply
    );
    expect(approval).toBe("user-approval");
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
