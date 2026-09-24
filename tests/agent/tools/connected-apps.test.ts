import type { ApprovalContext, ApprovalPolicy } from "eve/tools/approval";
import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type * as ConnectModule from "@vercel/connect";
import type {
  getConnectorMetadata,
  getTokenResponse,
  startAuthorization,
} from "@vercel/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const connect = vi.hoisted(() => ({
  getConnectorMetadata: vi.fn<typeof getConnectorMetadata>(),
  getTokenResponse: vi.fn<typeof getTokenResponse>(),
  startAuthorization: vi.fn<typeof startAuthorization>(),
}));

vi.mock("@vercel/connect", async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectModule>()),
  getConnectorMetadata: connect.getConnectorMetadata,
  getTokenResponse: connect.getTokenResponse,
  startAuthorization: connect.startAuthorization,
}));

import {
  ConnectError,
  ConnectorInstallationRequiredError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import notionConnections from "@agent/connections/notion";
import slackConnections from "@agent/connections/slack";
import { connectApp } from "@agent/tools/connect_app";
import { notionAddTask } from "@agent/tools/notion";
import { slackSendMessage } from "@agent/tools/slack";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function toolContext(requireAuth = vi.fn<ToolContext["requireAuth"]>()) {
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
      return { token: "user-token" };
    },
    requireAuth,
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
      turn: { id: "turn-1", sequence: 0 },
    },
    toolName: "test",
  } satisfies ToolContext;
}

async function addTask(
  input: Parameters<typeof notionAddTask.execute>[0],
  context: ToolContext = toolContext()
) {
  const result = await notionAddTask.execute(input, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("notion-add-task returns one result, not a stream.");
  }
  return result;
}

async function sendSlack(
  input: Parameters<typeof slackSendMessage.execute>[0],
  context: ToolContext = toolContext()
) {
  const result = await slackSendMessage.execute(input, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("slack-send-message returns one result, not a stream.");
  }
  return result;
}

async function connectTo(app: "notion" | "slack") {
  const result = await connectApp.execute({ app }, toolContext());
  if (Symbol.asyncIterator in result) {
    throw new Error("connect_app returns one result, not a stream.");
  }
  return result;
}

const attachedConnector = {
  createdAt: 0,
  id: "scl_1",
  name: "connector",
  service: "oauth",
  type: "oauth",
  uid: "connector",
  updatedAt: 0,
  vendor: {},
};

function resolveContext(
  authenticator = "photon-imessage",
  initiatorAttributes?: Record<string, string>
) {
  const current = {
    attributes: { workspaceId: "personal:workspace" },
    authenticator,
    principalId: "user-1",
    principalType: "user",
  };
  return {
    channel: { kind: "channel:photon", metadata: {} },
    messages: [],
    model: null,
    session: {
      auth: {
        current,
        initiator: initiatorAttributes
          ? {
              ...current,
              attributes: { ...current.attributes, ...initiatorAttributes },
            }
          : null,
      },
      id: "session-1",
    },
  } satisfies DynamicResolveContext;
}

/** The parts of one resolved OpenAPI connection these tests look at. */
const resolvedConnectionSchema = z.object({
  approval: z.custom<ApprovalPolicy>(
    (value) => z.function().safeParse(value).success
  ),
  baseUrl: z.string(),
  operations: z.unknown(),
});

/** The one connection a dynamic connection file resolves for this turn. */
async function resolveConnection(
  connections: typeof notionConnections,
  context: DynamicResolveContext = resolveContext()
) {
  const resolved = await connections.events["turn.started"]?.({}, context);
  return resolved ? resolvedConnectionSchema.parse(resolved) : null;
}

async function requireConnection(connections: typeof notionConnections) {
  const connection = await resolveConnection(connections);
  if (!connection) throw new Error("Expected one resolved connection.");
  return connection;
}

function decide(approval: ApprovalPolicy, toolName: string) {
  return approval({
    ...toolContext(),
    approvedTools: new Set<string>(),
    toolInput: {},
    toolName,
  } satisfies ApprovalContext);
}

function requestUrl(call: number) {
  return z.instanceof(URL).parse(fetchMock.mock.calls[call]?.[0]).href;
}

function requestBody(call: number) {
  const body: unknown = JSON.parse(
    z.string().parse(fetchMock.mock.calls[call]?.[1]?.body)
  );
  return body;
}

describe("connection approval", () => {
  beforeEach(() => {
    connect.getConnectorMetadata.mockResolvedValue(attachedConnector);
  });

  it("lets Notion reads through and asks before every write", async () => {
    const { approval } = await requireConnection(notionConnections);
    expect(decide(approval, "notion__post-search")).toBe("not-applicable");
    expect(decide(approval, "notion__retrieve-page-markdown")).toBe(
      "not-applicable"
    );
    expect(decide(approval, "notion__post-page")).toBe("user-approval");
    expect(decide(approval, "notion__patch-page")).toBe("user-approval");
    expect(decide(approval, "notion__something-new")).toBe("user-approval");
  });

  it("keeps Slack's connection read-only", async () => {
    const { approval, operations } = await requireConnection(slackConnections);
    expect(decide(approval, "slack__users_list")).toBe("not-applicable");
    const allowed = z
      .object({ allow: z.array(z.string()) })
      .parse(operations).allow;
    expect(allowed).not.toContain("chat_postMessage");
    expect(
      allowed.every((operation) =>
        /^(?:conversations|search|users)_/u.test(operation)
      )
    ).toBe(true);
  });

  it("requires approval for the authored writes", () => {
    expect(notionAddTask.approval).toBeTypeOf("function");
    expect(slackSendMessage.approval).toBeTypeOf("function");
  });
});

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
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ results: [notesSource, tasksSource] })
      )
      .mockResolvedValueOnce(
        Response.json({ id: "page-1", url: "https://www.notion.so/page-1" })
      );

    const result = await addTask({
      due: "2026-09-24",
      title: "Q3 planning",
    });

    expect(result).toEqual({
      database: "My Tasks",
      dueSet: true,
      pageId: "page-1",
      status: "created",
      url: "https://www.notion.so/page-1",
    });
    expect(requestUrl(0)).toBe("https://api.notion.com/v1/search");
    expect(requestBody(0)).toEqual({
      filter: { property: "object", value: "data_source" },
      page_size: 50,
    });
    expect(requestBody(1)).toEqual({
      parent: { data_source_id: "ds-tasks", type: "data_source_id" },
      properties: {
        Due: { date: { start: "2026-09-24" } },
        "Task name": { title: [{ text: { content: "Q3 planning" } }] },
      },
    });
  });

  it("looks past the first page of databases", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ next_cursor: "cursor-2", results: [notesSource] })
      )
      .mockResolvedValueOnce(
        Response.json({ next_cursor: null, results: [tasksSource] })
      )
      .mockResolvedValueOnce(Response.json({ id: "page-2" }));

    await expect(addTask({ title: "Q3 planning" })).resolves.toMatchObject({
      database: "My Tasks",
      status: "created",
    });
    expect(requestBody(1)).toMatchObject({ start_cursor: "cursor-2" });
  });

  it("names what it saw instead of guessing a database", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ results: [notesSource] }));

    const result = await addTask({ title: "Q3 planning" });

    expect(result).toEqual({
      databases: ["Reading notes"],
      status: "not_found",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("asks for authorization again when Notion rejects the token", async () => {
    const requireAuth = vi.fn<ToolContext["requireAuth"]>(() => {
      throw new Error("authorization required");
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ message: "unauthorized" }, { status: 401 })
    );

    await expect(
      addTask({ title: "Q3 planning" }, toolContext(requireAuth))
    ).rejects.toThrow("authorization required");
    expect(requireAuth).toHaveBeenCalledOnce();
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

describe("slack-send-message", () => {
  it("finds the person by name and sends them a direct message", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ members, ok: true }))
      .mockResolvedValueOnce(
        Response.json({ channel: { id: "D0SAMPARK" }, ok: true })
      )
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "1726.0001" }));

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
    expect(requestUrl(0)).toBe("https://slack.com/api/users.list?limit=200");
    expect(requestBody(1)).toEqual({ users: "U0SAMPARK" });
    expect(requestBody(2)).toEqual({
      channel: "D0SAMPARK",
      text: "Q3 planning is on for Thursday.",
    });
  });

  it("sends nothing and lists candidates when the name is ambiguous", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
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
      })
    );

    const result = await sendSlack({ text: "Hi", to: "sam" });

    expect(result).toEqual({
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
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports an unknown recipient without sending", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ members, ok: true }));

    await expect(sendSlack({ text: "Hi", to: "Maria" })).resolves.toEqual({
      status: "not_found",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the person behind a Slack ID in its result", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ ok: true, user: members[0] }))
      .mockResolvedValueOnce(
        Response.json({ channel: { id: "D0SAMPARK" }, ok: true })
      )
      .mockResolvedValueOnce(Response.json({ ok: true, ts: "1726.0002" }));

    await expect(
      sendSlack({ text: "Hi", to: "U0SAMPARK" })
    ).resolves.toMatchObject({
      recipient: { handle: "@sam.park", name: "Sam Park" },
      status: "sent",
    });
    expect(requestUrl(0)).toBe(
      "https://slack.com/api/users.info?user=U0SAMPARK"
    );
  });

  it("reports rate limiting instead of a parse error", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("slow down", {
        headers: { "retry-after": "30" },
        status: 429,
      })
    );

    await expect(sendSlack({ text: "Hi", to: "Sam" })).rejects.toThrow(
      "Slack is rate limiting users.list; try again in 30 s."
    );
  });

  it("reports a response that is not Slack's JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Bad gateway</html>", { status: 502 })
    );

    await expect(sendSlack({ text: "Hi", to: "Sam" })).rejects.toThrow(
      "Slack users.list answered 502 without its JSON response."
    );
  });

  it("asks for authorization again when the Slack grant was revoked", async () => {
    const requireAuth = vi.fn<ToolContext["requireAuth"]>(() => {
      throw new Error("authorization required");
    });
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: "token_revoked", ok: false })
    );

    await expect(
      sendSlack({ text: "Hi", to: "Sam" }, toolContext(requireAuth))
    ).rejects.toThrow("authorization required");
    expect(requireAuth).toHaveBeenCalledOnce();
  });
});

describe("connect_app", () => {
  it("mints a Notion link for the user's own subject", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new UserAuthorizationRequiredError("authorize")
    );
    connect.startAuthorization.mockResolvedValue({
      request: "req_1",
      url: "https://connect.example/authorize",
      verifier: "ver_1",
    });

    const result = await connectTo("notion");

    expect(result).toEqual({
      expiresInMinutes: 10,
      status: "authorize",
      url: "https://connect.example/authorize",
    });
    expect(connect.startAuthorization.mock.calls[0]?.[0]).toBe("notion");
    expect(connect.startAuthorization.mock.calls[0]?.[1]).toEqual({
      subject: { id: "user-1", issuer: "openinstinct", type: "user" },
    });
  });

  it("asks Slack for the user scopes it posts and reads with", async () => {
    connect.getTokenResponse.mockRejectedValue(
      new ConnectorInstallationRequiredError("install", { status: 400 })
    );

    const result = await connectTo("slack");

    expect(result).toMatchObject({ status: "not_configured" });
    const scopes = connect.getTokenResponse.mock.calls[0]?.[1]?.scopes ?? [];
    expect(scopes).toContain("chat:write");
    expect(scopes).toContain("users:read");
  });
});

describe("Notion and Slack exist only with a connector on the deployment", () => {
  // The connector check is kept per instance, so each case loads fresh modules.
  async function load() {
    vi.resetModules();
    const [notionTools, slackTools, notion, slack] = await Promise.all([
      import("@agent/tools/notion"),
      import("@agent/tools/slack"),
      import("@agent/connections/notion"),
      import("@agent/connections/slack"),
    ]);
    return {
      async connections() {
        return [
          await resolveConnection(notion.default),
          await resolveConnection(slack.default),
        ].map((connection) => connection !== null);
      },
      async tools(context: DynamicResolveContext = resolveContext()) {
        const resolved = await Promise.all(
          [notionTools.default, slackTools.default].map(async (definition) =>
            definition.events["turn.started"]?.({}, context)
          )
        );
        return resolved.flatMap((tools) =>
          tools && !("execute" in tools) ? Object.keys(tools) : []
        );
      },
    };
  }

  it("hides the tools and connections when Vercel Connect has no connector", async () => {
    connect.getConnectorMetadata.mockRejectedValue(
      new ConnectError("Connector not found", { status: 404 })
    );
    const apps = await load();

    expect(await apps.tools()).toEqual([]);
    expect(await apps.connections()).toEqual([false, false]);
    expect(connect.getConnectorMetadata.mock.calls.map(([uid]) => uid)).toEqual(
      ["notion", "slack"]
    );
  });

  it("hides them when the deployment cannot reach Vercel Connect at all", async () => {
    connect.getConnectorMetadata.mockRejectedValue(
      new Error("The 'x-vercel-oidc-token' header is missing")
    );
    const apps = await load();

    expect(await apps.tools()).toEqual([]);
    expect(await apps.connections()).toEqual([false, false]);
  });

  it("offers them with a connector and asks Vercel Connect once per app", async () => {
    connect.getConnectorMetadata.mockResolvedValue(attachedConnector);
    const apps = await load();

    expect(await apps.tools()).toEqual([
      "notion-add-task",
      "slack-send-message",
    ]);
    expect(await apps.connections()).toEqual([true, true]);
    expect(await apps.tools()).toHaveLength(2);
    expect(connect.getConnectorMetadata).toHaveBeenCalledTimes(2);
  });

  it("keeps them through a Vercel Connect outage and asks again next turn", async () => {
    connect.getConnectorMetadata.mockRejectedValue(
      new ConnectError("Service unavailable", { status: 503 })
    );
    const apps = await load();

    expect(await apps.tools()).toEqual([
      "notion-add-task",
      "slack-send-message",
    ]);
    expect(await apps.tools()).toHaveLength(2);
    expect(connect.getConnectorMetadata).toHaveBeenCalledTimes(4);
  });

  it("leaves them out of Bro's own checks without asking Vercel Connect", async () => {
    connect.getConnectorMetadata.mockResolvedValue(attachedConnector);
    const apps = await load();

    expect(
      await apps.tools(
        resolveContext("scheduled-worker", { scheduledRunKind: "proactive" })
      )
    ).toEqual([]);
    expect(connect.getConnectorMetadata).not.toHaveBeenCalled();
  });
});
