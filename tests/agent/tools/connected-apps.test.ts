import { ConnectionAuthorizationRequiredError } from "eve/connections";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type { Approval, ApprovalContext } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";
import { appsNamedByPerson } from "@agent/lib/connected-apps/mentions";
import { withApprovalCard } from "@shared/chat/approval-card";
import { backgroundTurnMarker } from "@shared/chat/background-turn";
import { accessScopeForUser } from "@shared/identity/access-scope";

import connectAppTools, { connectApp } from "@agent/tools/connect_app";
import notionTools, {
  notionAddTask,
  notionRead,
  notionSearch,
} from "@agent/tools/notion";
import slackTools, {
  slackRead,
  slackSearch,
  slackSendMessage,
} from "@agent/tools/slack";

const userId = "better-auth:user-1";
const scope = accessScopeForUser(userId);

let composio: FakeComposio;

beforeEach(() => {
  vi.clearAllMocks();
  composio = fakeComposio();
  composio.connect({
    id: "ca_notion",
    toolkit: "notion",
    authConfigId: "ac_notion",
  });
  composio.connect({
    id: "ca_slack",
    toolkit: "slack",
    authConfigId: "ac_slack",
  });
});

/** Runs a tool that returns one result rather than a stream. */
async function run<Input, Output extends object>(
  tool: {
    readonly execute: (
      input: Input,
      context: ToolContext
    ) => Output | Promise<Output> | AsyncIterable<Output>;
  },
  input: Input,
  context: ToolContext
) {
  const result = await tool.execute(input, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("The tool returns one result, not a stream.");
  }
  return result;
}

/** The n-th request the proxy passed to the app. */
function proxied(call: number) {
  const request = composio.proxy.mock.calls[call]?.[0];
  if (!request) throw new Error(`No proxied request ${String(call)}.`);
  return request;
}

function resolveContext(authenticator = "photon-imessage") {
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current: {
          attributes: { workspaceId: scope.workspaceId },
          authenticator,
          principalId: userId,
          principalType: "user",
        },
        initiator: null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

async function resolvedNames(
  definition: typeof connectAppTools | typeof notionTools | typeof slackTools,
  context: DynamicResolveContext = resolveContext()
) {
  const resolved = await definition.events["turn.started"]?.({}, context);
  return resolved ? Object.keys(resolved).toSorted() : [];
}

const cardOptions = [
  { id: "approve", label: "Approve" },
  { id: "cancel", label: "Cancel" },
];

describe("approvals", () => {
  it("shows the Notion task and the Slack message on their cards", () => {
    const notion = withApprovalCard(
      {
        action: {
          input: { due: "2026-09-24", title: "Q3 planning" },
          toolName: "notion-add-task",
        },
        kind: "tool-approval",
        options: cardOptions,
        prompt: "Approve tool call: notion-add-task",
      },
      "ru"
    );
    const slack = withApprovalCard(
      {
        action: {
          input: { text: "Встреча в четверг.\nКабинет 5", to: "Sam" },
          toolName: "slack-send-message",
        },
        kind: "tool-approval",
        options: cardOptions,
        prompt: "Approve tool call: slack-send-message",
      },
      "ru"
    );

    expect(notion.prompt).toBe(
      "Добавлю задачу в Notion: Q3 planning.\nСрок — 2026-09-24.\nДобавить?"
    );
    // A line break in the text cannot pass for another line of the card.
    expect(slack.prompt).toBe(
      "Отправлю в Slack Sam:\n\nВстреча в четверг. Кабинет 5\n\nОтправить?"
    );
  });

  it("asks before every write, and before a read outside the person's own turn", async () => {
    const decisions = await Promise.all(
      ["photon-imessage", "browser-result"].map(async (authenticator) => [
        await decide(notionSearch, { query: "Пароли" }, authenticator),
        await decide(notionRead, { id: "page-1", kind: "page" }, authenticator),
        await decide(slackRead, { from: "#general", limit: 30 }, authenticator),
        await decide(slackSearch, { count: 20, query: "inv" }, authenticator),
      ])
    );

    expect(decisions).toEqual([
      Array.from({ length: 4 }, () => "not-applicable"),
      Array.from({ length: 4 }, () => "user-approval"),
    ]);
    expect(await decide(notionAddTask, { title: "Q3 planning" })).toBe(
      "user-approval"
    );
    expect(await decide(slackSendMessage, { text: "Hi", to: "Sam" })).toBe(
      "user-approval"
    );
  });

  it("refuses a Slack message to a bare ID the card could not name", async () => {
    const bare = await Promise.all(
      ["C07ABCDEF", " U0SAMPARK ", "D0SAMPARK"].map(async (to) =>
        decide(slackSendMessage, { text: "Hi", to })
      )
    );

    expect(bare).toMatchObject([
      { type: "denied" },
      { type: "denied" },
      { type: "denied" },
    ]);
    expect(await decide(slackSendMessage, { text: "Hi", to: "#general" })).toBe(
      "user-approval"
    );
  });

  it("shows what a read would open on its card", () => {
    expect(readCard("notion-search", { query: "Пароли" })).toBe(
      "Поищу в Notion: Пароли.\nПоискать?"
    );
    expect(readCard("notion-search", {})).toBe(
      "Посмотрю в Notion недавно изменённые страницы.\nПосмотреть?"
    );
    expect(readCard("notion-read", { id: "page-1" })).toBe(
      "Открою в Notion page-1.\nОткрыть?"
    );
    expect(readCard("slack-read", { from: "#general", threadTs: "17.1" })).toBe(
      "Прочитаю сообщения в Slack: #general (ветка 17.1).\nПрочитать?"
    );
    expect(readCard("slack-search", { query: "invoice" })).toBe(
      "Поищу в Slack: invoice.\nПоискать?"
    );
  });
});

/** A read's approval card as the person sees it in Russian. */
function readCard(toolName: string, input: Record<string, string>) {
  return withApprovalCard(
    {
      action: { input, toolName },
      kind: "tool-approval",
      options: cardOptions,
      prompt: `Approve tool call: ${toolName}`,
    },
    "ru"
  ).prompt;
}

/** What a tool's approval policy decides for a call in a turn. */
async function decide<TInput>(
  tool: { readonly approval?: Approval<TInput> | undefined },
  toolInput: ApprovalContext<TInput>["toolInput"],
  authenticator = "photon-imessage"
) {
  const approval = tool.approval;
  if (approval === undefined) throw new Error("The tool has no policy.");
  const policy = "request" in approval ? approval.request : approval;
  return policy({
    ...composioToolContext("ca_slack", { authenticator }),
    approvedTools: new Set(),
    toolInput,
  });
}
const tasksSource = {
  database_type: "tasks",
  id: "ds-tasks",
  object: "data_source",
  properties: {
    Due: { type: "date" },
    Status: { type: "status" },
    "Task name": { type: "title" },
  },
  title: [{ plain_text: "My Tasks" }],
};

const notesSource = {
  id: "ds-notes",
  object: "data_source",
  properties: { Name: { type: "title" } },
  title: [{ plain_text: "Reading notes" }],
};

describe("notion-add-task", () => {
  it("adds the task to the person's tasks database with its due date", async () => {
    composio.proxy
      .mockResolvedValueOnce({ data: { results: [notesSource, tasksSource] } })
      .mockResolvedValueOnce({
        data: { id: "page-1", url: "https://www.notion.so/page-1" },
      });

    const result = await run(
      notionAddTask,
      { due: "2026-09-24", title: "Q3 planning" },
      composioToolContext("ca_notion")
    );

    expect(result).toEqual({
      database: "My Tasks",
      dueSet: true,
      pageId: "page-1",
      status: "created",
      url: "https://www.notion.so/page-1",
    });
    const search = proxied(0);
    expect(search.connectedAccountId).toBe("ca_notion");
    expect(search.url.toString()).toBe("https://api.notion.com/v1/search");
    // The Notion API answers in the shape of the version asked for.
    expect(search.headers).toEqual({ "Notion-Version": "2026-03-11" });
    expect(search.body).toEqual({
      filter: { property: "object", value: "data_source" },
      page_size: 50,
    });
    expect(proxied(1).body).toEqual({
      parent: { data_source_id: "ds-tasks", type: "data_source_id" },
      properties: {
        Due: { date: { start: "2026-09-24" } },
        "Task name": { title: [{ text: { content: "Q3 planning" } }] },
      },
    });
  });

  it("looks past the first page of databases", async () => {
    composio.proxy
      .mockResolvedValueOnce({
        data: { next_cursor: "cursor-2", results: [notesSource] },
      })
      .mockResolvedValueOnce({
        data: { next_cursor: null, results: [tasksSource] },
      })
      .mockResolvedValueOnce({ data: { id: "page-2" } });

    await expect(
      run(
        notionAddTask,
        { title: "Q3 planning" },
        composioToolContext("ca_notion")
      )
    ).resolves.toMatchObject({ database: "My Tasks", status: "created" });
    expect(proxied(1).body).toMatchObject({ start_cursor: "cursor-2" });
  });

  it("names what it saw instead of guessing a database", async () => {
    composio.proxy.mockResolvedValueOnce({ data: { results: [notesSource] } });

    await expect(
      run(
        notionAddTask,
        { title: "Q3 planning" },
        composioToolContext("ca_notion")
      )
    ).resolves.toEqual({ databases: ["Reading notes"], status: "not_found" });
    expect(composio.proxy).toHaveBeenCalledOnce();
  });

  it("asks for authorization again when Notion rejects the grant", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: { message: "unauthorized" },
      status: 401,
    });
    const context = composioToolContext("ca_notion");

    await expect(
      run(notionAddTask, { title: "Q3 planning" }, context)
    ).rejects.toThrow("authorization required");
    expect(context.requireAuth).toHaveBeenCalledOnce();
    expect(context.getToken.mock.calls[0]?.[1]).toEqual({
      authKey: "composio-notion",
    });
  });

  it("asks for authorization again when Composio no longer has the account", async () => {
    composio.accounts.splice(0);
    const context = composioToolContext("ca_notion");

    await expect(
      run(notionAddTask, { title: "Q3 planning" }, context)
    ).rejects.toThrow("authorization required");
    expect(context.requireAuth).toHaveBeenCalledOnce();
  });
});

describe("notion-search and notion-read", () => {
  it("finds pages and databases by title", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: {
        results: [
          {
            id: "page-1",
            last_edited_time: "2026-09-20T10:00:00.000Z",
            object: "page",
            properties: {
              Name: { title: [{ plain_text: "Q3 plan" }], type: "title" },
            },
            url: "https://www.notion.so/page-1",
          },
          tasksSource,
          { id: "gone", in_trash: true, object: "page", properties: {} },
        ],
      },
    });

    await expect(
      run(notionSearch, { query: "Q3" }, composioToolContext("ca_notion"))
    ).resolves.toEqual({
      results: [
        {
          edited: "2026-09-20T10:00:00.000Z",
          id: "page-1",
          kind: "page",
          title: "Q3 plan",
          url: "https://www.notion.so/page-1",
        },
        {
          edited: null,
          id: "ds-tasks",
          kind: "database",
          title: "My Tasks",
          url: null,
        },
      ],
    });
    expect(proxied(0).body).toEqual({ page_size: 20, query: "Q3" });
  });

  it("reads a page as Markdown and a database as plain rows", async () => {
    composio.proxy
      .mockResolvedValueOnce({
        data: { markdown: "# Q3 plan\n- ship it", truncated: false },
      })
      .mockResolvedValueOnce({
        data: {
          has_more: false,
          results: [
            {
              id: "row-1",
              object: "page",
              properties: {
                Due: {
                  date: { end: null, start: "2026-09-30" },
                  type: "date",
                },
                Status: { status: { name: "In progress" }, type: "status" },
                "Task name": {
                  title: [{ plain_text: "Ship Q3" }],
                  type: "title",
                },
              },
              url: "https://www.notion.so/row-1",
            },
          ],
        },
      });
    const context = composioToolContext("ca_notion");

    await expect(
      run(notionRead, { id: "page-1", kind: "page" }, context)
    ).resolves.toEqual({
      kind: "page",
      markdown: "# Q3 plan\n- ship it",
      truncated: false,
    });
    await expect(
      run(notionRead, { id: "ds-tasks", kind: "database" }, context)
    ).resolves.toEqual({
      kind: "database",
      more: false,
      rows: [
        {
          id: "row-1",
          properties: {
            Due: "2026-09-30",
            Status: "In progress",
            "Task name": "Ship Q3",
          },
          url: "https://www.notion.so/row-1",
        },
      ],
    });
    expect(proxied(0).url.pathname).toBe("/v1/pages/page-1/markdown");
    expect(proxied(1).url.pathname).toBe("/v1/data_sources/ds-tasks/query");
  });
});

const members = [
  {
    id: "U0SAMPARK",
    name: "sam.park",
    profile: { display_name: "Sam", real_name: "Sam Park", title: "PM" },
    real_name: "Sam Park",
  },
  {
    id: "U0SAMLEE1",
    name: "slee",
    profile: { display_name: "", real_name: "Samantha Lee" },
    real_name: "Samantha Lee",
  },
  {
    deleted: true,
    id: "U0SAMOLD1",
    name: "sam.old",
    profile: { real_name: "Sam Old" },
  },
];

function sendSlack(input: { readonly text: string; readonly to: string }) {
  return run(slackSendMessage, input, composioToolContext("ca_slack"));
}

describe("slack-send-message", () => {
  it("finds the person by name and sends them a direct message", async () => {
    composio.proxy
      .mockResolvedValueOnce({ data: { members, ok: true } })
      .mockResolvedValueOnce({
        data: { channel: { id: "D0SAMPARK" }, ok: true },
      })
      .mockResolvedValueOnce({ data: { ok: true, ts: "1726.0001" } });

    const result = await sendSlack({
      text: "Q3 planning is on for Thursday.",
      to: "Sam",
    });

    expect(result).toEqual({
      channel: "D0SAMPARK",
      recipient: { handle: "@sam.park", name: "Sam Park" },
      status: "sent",
      ts: "1726.0001",
    });
    expect(proxied(0).connectedAccountId).toBe("ca_slack");
    expect(proxied(0).method).toBe("GET");
    expect(proxied(0).url.toString()).toBe(
      "https://slack.com/api/users.list?limit=200"
    );
    expect(proxied(1).body).toEqual({ users: "U0SAMPARK" });
    expect(proxied(2).method).toBe("POST");
    expect(proxied(2).body).toEqual({
      channel: "D0SAMPARK",
      text: "Q3 planning is on for Thursday.",
    });
  });

  it("sends nothing and lists candidates when the name is ambiguous", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: {
        members: [
          ...members,
          {
            id: "U0SAMWU11",
            name: "swu",
            profile: { display_name: "Sam", real_name: "Sam Wu" },
            real_name: "Sam Wu",
          },
        ],
        ok: true,
      },
    });

    await expect(sendSlack({ text: "Hi", to: "sam" })).resolves.toEqual({
      candidates: [
        {
          handle: "@sam.park",
          id: "U0SAMPARK",
          name: "Sam Park",
          title: "PM",
        },
        { handle: "@swu", id: "U0SAMWU11", name: "Sam Wu", title: null },
      ],
      status: "ambiguous",
    });
    expect(composio.proxy).toHaveBeenCalledOnce();
  });

  it("reports an unknown recipient without sending", async () => {
    composio.proxy.mockResolvedValueOnce({ data: { members, ok: true } });

    await expect(sendSlack({ text: "Hi", to: "Maria" })).resolves.toEqual({
      status: "not_found",
    });
    expect(composio.proxy).toHaveBeenCalledOnce();
  });

  it("names the person behind a Slack ID in its result", async () => {
    composio.proxy
      .mockResolvedValueOnce({ data: { ok: true, user: members[0] } })
      .mockResolvedValueOnce({
        data: { channel: { id: "D0SAMPARK" }, ok: true },
      })
      .mockResolvedValueOnce({ data: { ok: true, ts: "1726.0002" } });

    await expect(
      sendSlack({ text: "Hi", to: "U0SAMPARK" })
    ).resolves.toMatchObject({
      recipient: { handle: "@sam.park", name: "Sam Park" },
      status: "sent",
    });
    expect(proxied(0).url.toString()).toBe(
      "https://slack.com/api/users.info?user=U0SAMPARK"
    );
  });

  it("reports rate limiting instead of a parse error", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: "slow down",
      headers: { "retry-after": "30" },
      status: 429,
    });

    await expect(sendSlack({ text: "Hi", to: "Sam" })).rejects.toThrow(
      "Slack is rate limiting users.list; try again in 30 s."
    );
  });

  it("reports a response that is not Slack's JSON", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: "<html>Bad gateway</html>",
      status: 502,
    });

    await expect(sendSlack({ text: "Hi", to: "Sam" })).rejects.toThrow(
      "Slack users.list answered 502 without its JSON response."
    );
  });

  it("asks for authorization again when the Slack grant was revoked", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: { error: "token_revoked", ok: false },
    });
    const context = composioToolContext("ca_slack");

    await expect(
      run(slackSendMessage, { text: "Hi", to: "Sam" }, context)
    ).rejects.toThrow("authorization required");
    expect(context.requireAuth).toHaveBeenCalledOnce();
    expect(context.requireAuth.mock.calls[0]?.[1]).toEqual({
      authKey: "composio-slack",
    });
  });
});

describe("slack-read and slack-search", () => {
  it("reads a channel with names in place of user ids", async () => {
    composio.proxy
      .mockResolvedValueOnce({
        data: {
          channels: [{ id: "C0GENERAL1", name: "general" }],
          ok: true,
        },
      })
      .mockResolvedValueOnce({
        data: {
          messages: [
            {
              reply_count: 2,
              text: "Ship it, <@U0SAMLEE1>?",
              ts: "1790000000.000100",
              user: "U0SAMPARK",
            },
          ],
          ok: true,
        },
      })
      .mockResolvedValueOnce({ data: { members, ok: true } });

    await expect(
      run(
        slackRead,
        { from: "#general", limit: 10 },
        composioToolContext("ca_slack")
      )
    ).resolves.toEqual({
      channel: "#general",
      messages: [
        {
          from: "Sam Park",
          replies: 2,
          text: "Ship it, @Samantha Lee?",
          threadTs: null,
          time: "2026-09-21T14:13:20.000Z",
          ts: "1790000000.000100",
        },
      ],
      status: "messages",
    });
    expect(proxied(1).url.toString()).toBe(
      "https://slack.com/api/conversations.history?channel=C0GENERAL1&limit=10"
    );
  });

  it("searches messages with Slack's own syntax", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: {
        messages: {
          matches: [
            {
              channel: { name: "general" },
              permalink: "https://team.slack.com/archives/C0/p1",
              text: "Budget is 12k",
              ts: "1790000000.000100",
              username: "sam.park",
            },
          ],
        },
        ok: true,
      },
    });

    await expect(
      run(
        slackSearch,
        { count: 20, query: "budget in:#general" },
        composioToolContext("ca_slack")
      )
    ).resolves.toEqual({
      matches: [
        {
          channel: "general",
          from: "sam.park",
          permalink: "https://team.slack.com/archives/C0/p1",
          replies: 0,
          text: "Budget is 12k",
          threadTs: null,
          time: "2026-09-21T14:13:20.000Z",
          ts: "1790000000.000100",
        },
      ],
    });
    expect(proxied(0).url.searchParams.get("query")).toBe("budget in:#general");
  });
});

describe("connect_app", () => {
  it("reports a connected app without minting a link", async () => {
    await expect(
      run(
        connectApp,
        { action: "connect", app: "notion" },
        composioToolContext("ca_notion")
      )
    ).resolves.toEqual({ account: null, status: "connected" });
  });

  it("mints a Notion link under its auth config for the person", async () => {
    composio.accounts.splice(0);

    await expect(
      run(
        connectApp,
        { action: "connect", app: "notion" },
        composioToolContext("ca_notion")
      )
    ).resolves.toEqual({
      expiresInMinutes: 10,
      status: "authorize",
      url: "https://connect.composio.dev/link/lk_3",
    });
    expect(
      composio.requests.find(({ path }) => path === "/connected_accounts/link")
        ?.body
    ).toEqual({
      auth_config_id: "ac_notion",
      callback_url: "https://example.com/workspace?app=notion",
      user_id: userId,
    });
  });

  it("finds or makes the project's auth config for another app", async () => {
    await run(
      connectApp,
      { action: "connect", app: "todoist" },
      composioToolContext("ca_x")
    );

    expect(
      composio.requests
        .filter(({ path }) => path.startsWith("/auth_configs"))
        .map(({ method, path }) => `${method} ${path}`)
    ).toEqual(["GET /auth_configs", "POST /auth_configs"]);
    expect(
      composio.requests.find(({ path }) => path === "/connected_accounts/link")
        ?.body
    ).toMatchObject({ auth_config_id: "ac_created_3" });
  });

  it("disconnects by revoking and deleting the app's accounts", async () => {
    await expect(
      run(
        connectApp,
        { action: "disconnect", app: "slack" },
        composioToolContext("ca_slack")
      )
    ).resolves.toEqual({ status: "disconnected" });
    expect(composio.accounts.map(({ id }) => id)).toEqual(["ca_notion"]);
  });

  it("asks only before disconnecting", async () => {
    expect(await decide(connectApp, { action: "connect", app: "slack" })).toBe(
      "not-applicable"
    );
    expect(
      await decide(connectApp, { action: "disconnect", app: "slack" })
    ).toBe("user-approval");
  });
});

describe("app tools exist only where the deployment can connect the app", () => {
  it("offers Notion, Slack and connect_app in a person's turn", async () => {
    expect(await resolvedNames(notionTools)).toEqual([
      "notion-add-task",
      "notion-read",
      "notion-search",
    ]);
    expect(await resolvedNames(slackTools)).toEqual([
      "slack-read",
      "slack-search",
      "slack-send-message",
    ]);
    expect(await resolvedNames(connectAppTools)).toEqual(["connect_app"]);
  });

  it("keeps them in a browser report, where every read asks first", async () => {
    const report = resolveContext("browser-result");
    expect(await resolvedNames(notionTools, report)).toEqual([
      "notion-add-task",
      "notion-read",
      "notion-search",
    ]);
    expect(await resolvedNames(slackTools, report)).toEqual([
      "slack-read",
      "slack-search",
      "slack-send-message",
    ]);
  });

  it("leaves them out of Bro's own background work", async () => {
    const worker = resolveContext("scheduled-worker");
    expect(await resolvedNames(notionTools, worker)).toEqual([]);
    expect(await resolvedNames(slackTools, worker)).toEqual([]);
    expect(await resolvedNames(connectAppTools, worker)).toEqual([]);
  });

  it("hides an app whose auth config the deployment does not name", async () => {
    vi.resetModules();
    vi.stubEnv("COMPOSIO_NOTION_AUTH_CONFIG_ID", "");
    const notion = await import("@agent/tools/notion");
    const slack = await import("@agent/tools/slack");
    vi.stubEnv("COMPOSIO_NOTION_AUTH_CONFIG_ID", "ac_notion");

    expect(await resolvedNames(notion.default)).toEqual([]);
    expect(await resolvedNames(slack.default)).toEqual([
      "slack-read",
      "slack-search",
      "slack-send-message",
    ]);
  });
});

/** A turn the person opened with `text`, as eve keeps it in history. */
function personTurn(text: string, authenticator = "photon-imessage") {
  return {
    ...resolveContext(authenticator),
    messages: [
      Object.assign({ content: text, role: "user" as const }, { kind: "user" }),
    ],
  } satisfies DynamicResolveContext;
}

/** The error eve's `getToken` throws for an app with no account. */
function signInRequired(app: string) {
  const error = new Error("Authorization required.", {
    cause: new ConnectionAuthorizationRequiredError(`composio-${app}`),
  });
  error.name = "ScopedAuthorizationRequiredError";
  return error;
}

/** A tool context whose app has no account, as eve reports it. */
function unconnectedContext(app: string) {
  const context = composioToolContext(`ca_${app}`);
  context.getToken.mockRejectedValue(signInRequired(app));
  return context;
}

/** The Slack tools a turn's resolver hands out. */
async function slackToolsFor(context: DynamicResolveContext) {
  const resolved = await slackTools.events["turn.started"]?.({}, context);
  if (!resolved) throw new Error("Slack tools were not resolved.");
  return resolved;
}

/** The Notion tools a turn's resolver hands out. */
async function notionToolsFor(context: DynamicResolveContext) {
  const resolved = await notionTools.events["turn.started"]?.({}, context);
  if (!resolved) throw new Error("Notion tools were not resolved.");
  return resolved;
}

describe("an app the person has not connected", () => {
  // RU 25.09, d18: «скинь лёше…» went to slack-search, and the whole turn
  // waited on a Slack sign-in the person never asked for.
  const d18 =
    "в пятницу я к стоматологу, запись где-то в почте. поставь в календарь, закажи такси чтобы точно успеть, и скинь лёше, что освобожусь не раньше восьми";

  it("answers not_connected instead of stopping the turn on a sign-in", async () => {
    const search = (await slackToolsFor(personTurn(d18)))["slack-search"];

    const result = await run(
      search,
      { count: 20, query: "from:Лёша" },
      unconnectedContext("slack")
    );

    expect(result).toMatchObject({ status: "not_connected" });
    expect(JSON.stringify(result)).toContain(
      "Slack is not connected for this person"
    );
    expect(composio.proxy).not.toHaveBeenCalled();
  });

  it("still asks to connect when the person named the app", async () => {
    const search = (
      await slackToolsFor(personTurn("найди в слаке, что писал Лёша"))
    )["slack-search"];

    await expect(
      run(
        search,
        { count: 20, query: "from:Лёша" },
        unconnectedContext("slack")
      )
    ).rejects.toThrow("Authorization required.");
    // The exported tools are the ones a named app gets.
    await expect(
      run(notionSearch, { query: "Q3" }, unconnectedContext("notion"))
    ).rejects.toThrow("Authorization required.");
  });

  it("works as usual for an app the person has connected", async () => {
    composio.proxy.mockResolvedValueOnce({
      data: { messages: { matches: [] }, ok: true },
    });
    const search = (await slackToolsFor(personTurn(d18)))["slack-search"];

    await expect(
      run(
        search,
        { count: 20, query: "from:Лёша" },
        composioToolContext("ca_slack")
      )
    ).resolves.toEqual({ matches: [] });
  });

  it("refuses a card for an unconnected app nobody named, before it parks the turn", async () => {
    composio.accounts.splice(0);
    const send = (await slackToolsFor(personTurn(d18)))["slack-send-message"];
    const task = (
      await notionToolsFor(personTurn("добавь задачу позвонить маме"))
    )["notion-add-task"];

    const sendRefusal = await decide(send, {
      text: "Освобожусь не раньше восьми",
      to: "Лёша",
    });
    expect(sendRefusal).toMatchObject({ type: "denied" });
    expect(JSON.stringify(sendRefusal)).toContain(
      "Slack is not connected for this person"
    );
    expect(await decide(task, { title: "Позвонить маме" })).toMatchObject({
      type: "denied",
    });

    // Named, the card goes ahead and the sign-in follows it.
    const named = (
      await slackToolsFor(
        personTurn("скинь в слак Лёше, что освобожусь не раньше восьми")
      )
    )["slack-send-message"];
    expect(
      await decide(named, { text: "Освобожусь не раньше восьми", to: "Лёша" })
    ).toBe("user-approval");
  });

  it("names an app the way people write it", () => {
    const named = (text: string) =>
      appsNamedByPerson(personTurn(text).messages);

    expect(named("скинь в слак Лёше")).toEqual(["slack"]);
    expect(named("что в Slack'е нового?")).toEqual(["slack"]);
    expect(named("добавь в ноушен задачу")).toEqual(["notion"]);
    expect(named("перенеси карточку в Трелло")).toEqual(["trello"]);
    expect(named("созвон в зуме в 15:00")).toEqual(["zoom"]);
    expect(named(d18)).toEqual([]);
    // A browser report or a prompt Bro writes itself names none.
    expect(
      appsNamedByPerson([
        Object.assign(
          {
            content: `${backgroundTurnMarker}\nBrowser run r1 finished. Slack`,
            role: "user" as const,
          },
          { kind: "user" }
        ),
      ])
    ).toEqual([]);
  });
});
