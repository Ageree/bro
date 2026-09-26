import type { DynamicResolveContext, ToolContext } from "eve/tools";
import type { ApprovalStatus } from "eve/tools/approval";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getGoogleWorkspaceAccess } from "@db/services/settings";
import { withApprovalCard } from "@shared/chat/approval-card";
import { accessScopeForUser } from "@shared/identity/access-scope";
import {
  composioToolContext,
  type FakeComposio,
  fakeComposio,
} from "@tests/helpers/composio";

const settings = vi.hoisted(() => ({
  access: vi.fn<typeof getGoogleWorkspaceAccess>(),
}));

vi.mock("@db/services/settings", () => ({
  getGoogleWorkspaceAccess: settings.access,
}));

import appsTools, { apps } from "@agent/tools/apps";
import { composioToolReadsOnly } from "@agent/lib/composio/tools";
import { googleReadOnlyWriteRefusal } from "@agent/lib/google-workspace/client";

const userId = "better-auth:user-1";
const scope = accessScopeForUser(userId);

let composio: FakeComposio;

const appendValues = {
  description: "Append rows of values to a spreadsheet range.",
  input_parameters: {
    properties: {
      range: { description: "A1 range, e.g. Sheet1!A:C", type: "string" },
      spreadsheet_id: { description: "The spreadsheet id.", type: "string" },
      values: { description: "Rows to append.", type: "array" },
      value_input_option: { type: "string" },
    },
    required: ["spreadsheet_id", "range", "values"],
  },
  name: "Append Values to Spreadsheet",
  slug: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
  tags: ["updateHint", "createHint"],
  toolkit: "googlesuper",
};

const readValues = {
  name: "Get Spreadsheet Values",
  slug: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
  tags: ["readOnlyHint", "openWorldHint"],
  toolkit: "googlesuper",
};

beforeEach(() => {
  vi.clearAllMocks();
  settings.access.mockResolvedValue("full");
  composio = fakeComposio();
  composio.connect({ id: "ca_google", toolkit: "googlesuper" });
  composio.connect({ id: "ca_todoist", toolkit: "todoist" });
  composio.tools.push(
    appendValues,
    readValues,
    {
      name: "Send Email",
      slug: "GOOGLESUPER_SEND_EMAIL",
      tags: ["openWorldHint"],
      toolkit: "googlesuper",
    },
    {
      name: "Mislabelled",
      slug: "TODOIST_DELETE_TASK",
      tags: ["readOnlyHint"],
      toolkit: "todoist",
    },
    {
      name: "Get Tasks",
      slug: "TODOIST_GET_ALL_TASKS",
      tags: ["readOnlyHint"],
      toolkit: "todoist",
    },
    {
      is_deprecated: true,
      slug: "TODOIST_OLD",
      toolkit: "todoist",
    }
  );
});

async function run(
  input: Parameters<typeof apps.execute>[0],
  context: ToolContext = composioToolContext("ca_google")
) {
  const result = await apps.execute(input, context);
  if (Symbol.asyncIterator in result) {
    throw new Error("apps returns one result, not a stream.");
  }
  return result;
}

async function approvalOf(
  input: Parameters<typeof apps.execute>[0],
  authenticator = "photon-imessage"
): Promise<ApprovalStatus> {
  const approval = apps.approval;
  if (approval === undefined) throw new Error("apps has no approval policy.");
  const policy = "request" in approval ? approval.request : approval;
  return policy({
    ...composioToolContext("ca_google", { authenticator }),
    approvedTools: new Set(),
    toolInput: input,
    toolName: "apps",
  });
}

/** An `apps` card as the person sees it in Russian. */
function cardOf(input: Parameters<typeof apps.execute>[0]) {
  return withApprovalCard(
    {
      action: { input, toolName: "apps" },
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
      prompt: "Approve tool call: apps",
    },
    "ru"
  ).prompt;
}

describe("apps search", () => {
  it("lists Google's Sheets and Docs tools only, with trimmed parameters", async () => {
    const result = await run({
      action: "search",
      app: "google",
      task: "append rows to spreadsheet",
    });

    expect(result).toEqual({
      tools: [
        {
          description: "Append rows of values to a spreadsheet range.",
          name: "Append Values to Spreadsheet",
          parameters: {
            range: "string — A1 range, e.g. Sheet1!A:C",
            spreadsheet_id: "string — The spreadsheet id.",
            value_input_option: "string",
            values: "array — Rows to append.",
          },
          required: ["spreadsheet_id", "range", "values"],
          tool: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
          writes: true,
        },
        {
          description: "",
          name: "Get Spreadsheet Values",
          parameters: {},
          required: [],
          tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
          writes: false,
        },
      ],
    });
    const search = composio.requests.find(({ path }) => path === "/tools");
    expect(search).toBeDefined();
  });

  it("leaves deprecated tools out", async () => {
    const result = await run(
      { action: "search", app: "todoist", task: "list tasks" },
      composioToolContext("ca_todoist")
    );

    expect(result).toMatchObject({
      tools: [
        expect.objectContaining({ tool: "TODOIST_DELETE_TASK" }),
        expect.objectContaining({ tool: "TODOIST_GET_ALL_TASKS" }),
      ],
    });
  });
});

describe("apps run", () => {
  it("reads a sheet at once on the person's own Google connection", async () => {
    composio.execute.mockReturnValue({
      data: { values: [["2026-09-01", "Кафе", "450"]] },
      successful: true,
    });
    const input = {
      action: "run" as const,
      app: "google" as const,
      arguments: '{"spreadsheet_id":"sheet-1","ranges":["A:C"]}',
      tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
    };

    expect(await approvalOf(input)).toBe("not-applicable");
    await expect(run(input)).resolves.toEqual({
      result: { values: [["2026-09-01", "Кафе", "450"]] },
      status: "done",
      wrote: false,
    });
    expect(composio.execute).toHaveBeenCalledExactlyOnceWith(
      "GOOGLESUPER_GET_SPREADSHEET_VALUES",
      {
        arguments: { ranges: ["A:C"], spreadsheet_id: "sheet-1" },
        connected_account_id: "ca_google",
        user_id: userId,
      }
    );
  });

  it("asks the person before a write, and refuses it in a read-only workspace", async () => {
    const input = {
      action: "run" as const,
      app: "google" as const,
      arguments: '{"spreadsheet_id":"sheet-1","range":"A:C","values":[["x"]]}',
      summary: "Добавить платёж в таблицу «Бюджет»",
      tool: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
    };

    expect(await approvalOf(input)).toBe("user-approval");
    settings.access.mockResolvedValue("read_only");
    expect(await approvalOf(input)).toEqual({
      reason: googleReadOnlyWriteRefusal,
      type: "denied",
    });
  });

  it("tells the turn a write went through", async () => {
    await expect(
      run({
        action: "run",
        app: "google",
        arguments:
          '{"spreadsheet_id":"sheet-1","range":"A:C","values":[["x"]]}',
        tool: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
      })
    ).resolves.toMatchObject({ status: "done", wrote: true });
  });

  it("asks before a tool whose name says it writes, whatever its tags", async () => {
    expect(
      await approvalOf({
        action: "run",
        app: "todoist",
        arguments: '{"task_id":"1"}',
        tool: "TODOIST_DELETE_TASK",
      })
    ).toBe("user-approval");
  });

  it("refuses Google mail through apps and a tool of another app", async () => {
    await expect(
      run({
        action: "run",
        app: "google",
        arguments: "{}",
        tool: "GOOGLESUPER_SEND_EMAIL",
      })
    ).resolves.toMatchObject({ status: "refused" });
    await expect(
      run(
        {
          action: "run",
          app: "todoist",
          arguments: "{}",
          tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
        },
        composioToolContext("ca_todoist")
      )
    ).resolves.toMatchObject({ status: "refused" });
    expect(composio.execute).not.toHaveBeenCalled();
  });

  it("refuses arguments that are not a JSON object", async () => {
    await expect(
      run({
        action: "run",
        app: "google",
        arguments: "[1, 2]",
        tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
      })
    ).resolves.toMatchObject({ status: "refused" });
  });

  it("returns the app's refusal for the model to fix", async () => {
    composio.execute.mockReturnValue({
      data: {},
      error: "Missing required field: range",
      successful: false,
    });

    await expect(
      run({
        action: "run",
        app: "google",
        arguments: '{"spreadsheet_id":"sheet-1"}',
        tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
      })
    ).resolves.toEqual({
      error: "Missing required field: range",
      status: "failed",
    });
  });

  it("shows the sign-in card again when the grant is rejected", async () => {
    composio.execute.mockReturnValue({
      data: { status_code: 401 },
      error: "401 Unauthorized",
      successful: false,
    });
    const context = composioToolContext("ca_todoist");

    await expect(
      run(
        {
          action: "run",
          app: "todoist",
          arguments: "{}",
          tool: "TODOIST_GET_ALL_TASKS",
        },
        context
      )
    ).rejects.toThrow("authorization required");
    expect(context.requireAuth.mock.calls[0]?.[1]).toEqual({
      authKey: "composio-todoist",
    });
  });
});

describe("apps approval policy", () => {
  const readSheet = {
    action: "run" as const,
    app: "google" as const,
    arguments: '{"spreadsheet_id":"sheet-1"}',
    tool: "GOOGLESUPER_GET_SPREADSHEET_VALUES",
  };

  it("asks the person even for a read in the report of a browser run", async () => {
    expect(await approvalOf(readSheet, "browser-result")).toBe("user-approval");
    expect(await approvalOf(readSheet, "telegram-webhook")).toBe(
      "not-applicable"
    );
    expect(
      await approvalOf(
        { action: "search", app: "todoist", task: "list tasks" },
        "browser-result"
      )
    ).toBe("not-applicable");
  });

  it("refuses a tool it cannot look up instead of skipping the card", async () => {
    const unknown = { ...readSheet, tool: "GOOGLESUPER_GET_SHEET_NAMES" };
    await expect(approvalOf(unknown)).resolves.toMatchObject({
      type: "denied",
    });

    const fakeFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) =>
        new URL(input instanceof Request ? input.url : input).pathname.endsWith(
          "/tools/TODOIST_LIST_PROJECTS"
        )
          ? Response.json(
              { error: { message: "down", slug: "Internal", status: 503 } },
              { status: 503 }
            )
          : fakeFetch(input, init)
    );
    await expect(
      approvalOf({
        action: "run",
        app: "todoist",
        arguments: "{}",
        tool: "TODOIST_LIST_PROJECTS",
      })
    ).resolves.toMatchObject({ type: "denied" });
  });

  it("refuses a tool of another app and arguments that are not an object", async () => {
    await expect(
      approvalOf({ ...readSheet, app: "todoist" })
    ).resolves.toMatchObject({ type: "denied" });
    await expect(
      approvalOf({ ...readSheet, arguments: "[1, 2]" })
    ).resolves.toMatchObject({ type: "denied" });
  });

  it("refuses a write the card cannot show whole", async () => {
    const write = {
      action: "run" as const,
      app: "todoist" as const,
      tool: "TODOIST_DELETE_TASK",
    };

    expect(
      await approvalOf({
        ...write,
        arguments: JSON.stringify({ content: "x".repeat(3_000) }),
      })
    ).toBe("user-approval");
    await expect(
      approvalOf({
        ...write,
        arguments: JSON.stringify({ content: "x".repeat(3_600) }),
      })
    ).resolves.toMatchObject({ type: "denied" });
  });
});

describe("apps approval card", () => {
  it("shows every argument and every value in full", () => {
    const fields = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `field_${String(index)}`,
        String(index),
      ])
    );
    const body = `${"Всё хорошо. ".repeat(20)}и в конце: пароль 1234`;
    const card = cardOf({
      action: "run",
      app: "outlook",
      arguments: JSON.stringify({ ...fields, body, to: ["a@b.c"] }),
      tool: "OUTLOOK_SEND_EMAIL",
    });

    expect(card).toContain("  field_13: 13");
    expect(card).toContain(`  body: ${body.trim()}`);
    expect(card).toContain('  to: ["a@b.c"]');
    expect(card).not.toContain("…");
  });

  it("names the app, what the call does, the tool and every argument", () => {
    const card = withApprovalCard(
      {
        action: {
          input: {
            action: "run",
            app: "google",
            arguments:
              '{"spreadsheet_id":"sheet-1","range":"Бюджет!A:C","values":[["2026-09-01","Кафе",450]]}',
            summary: "Добавить платёж в таблицу «Бюджет»",
            tool: "GOOGLESUPER_SPREADSHEETS_VALUES_APPEND",
          },
          toolName: "apps",
        },
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve tool call: apps",
      },
      "ru"
    );

    expect(card.prompt).toBe(
      [
        "В Google: добавить платёж в таблицу «Бюджет».",
        "Вызову GOOGLESUPER_SPREADSHEETS_VALUES_APPEND с такими данными:",
        "  spreadsheet_id: sheet-1",
        "  range: Бюджет!A:C",
        '  values: [["2026-09-01","Кафе",450]]',
        "Сделать?",
      ].join("\n")
    );
  });
});

describe("apps exposure", () => {
  it("is left out of background workers", async () => {
    const resolve = appsTools.events["turn.started"];
    if (!resolve) throw new Error("apps resolves per turn.");
    const context = (authenticator: string) =>
      ({
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
      }) satisfies DynamicResolveContext;

    expect(
      Object.keys((await resolve({}, context("photon-imessage"))) ?? {})
    ).toEqual(["apps"]);
    // Kept in a browser report, where its policy asks for every run.
    expect(
      Object.keys((await resolve({}, context("browser-result"))) ?? {})
    ).toEqual(["apps"]);
    expect(await resolve({}, context("scheduled-worker"))).toBeNull();
    expect(await resolve({}, context("scheduled-result"))).toBeNull();
  });
});

/** A Composio tool as its catalog describes it, by slug and tags. */
function tool(slug: string, tags: string[], toolkit = "slack") {
  return {
    description: "",
    input_parameters: {},
    name: slug,
    slug,
    tags,
    toolkit: { slug: toolkit },
  };
}

describe("composioToolReadsOnly", () => {
  it("trusts a read-only tag only on a tool named by a read verb", () => {
    for (const slug of [
      "SLACK_LIST_ALL_CHANNELS",
      "SLACK_FETCHES_CONVERSATION_HISTORY",
      "SLACK_SEARCH_MESSAGES",
    ]) {
      expect(composioToolReadsOnly(tool(slug, ["readOnlyHint"]))).toBe(true);
    }
    for (const slug of [
      "GOOGLESUPER_BATCH_GET_SPREADSHEET_VALUES",
      "GOOGLESUPER_VALUES_GET",
    ]) {
      expect(
        composioToolReadsOnly(tool(slug, ["readOnlyHint"], "googlesuper"))
      ).toBe(true);
    }
  });

  it("counts every other tool as a write, whatever its tags say", () => {
    for (const slug of [
      "SLACK_DELETES_A_MESSAGE_FROM_A_CHAT",
      "SLACK_UPDATES_A_SLACK_MESSAGE",
      "SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL",
      "SLACK_JOIN_AN_EXISTING_CONVERSATION",
      "SLACK_FIND_AND_REPLACE",
      "SLACK_GET_AND_ARCHIVE",
      "SLACK_UPSERT_ROWS",
      "SLACK_EXECUTE_SQL",
    ]) {
      expect(composioToolReadsOnly(tool(slug, ["readOnlyHint"]))).toBe(false);
    }
    for (const slug of [
      "GOOGLESUPER_SHEET_FROM_JSON",
      "GOOGLESUPER_DUPLICATE_SHEET",
    ]) {
      expect(
        composioToolReadsOnly(tool(slug, ["readOnlyHint"], "googlesuper"))
      ).toBe(false);
    }
    expect(composioToolReadsOnly(tool("SLACK_LIST_ALL_CHANNELS", []))).toBe(
      false
    );
    expect(
      composioToolReadsOnly(
        tool("SLACK_LIST_ALL_CHANNELS", ["readOnlyHint", "updateHint"])
      )
    ).toBe(false);
  });
});
