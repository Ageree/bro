import { defineDynamic, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { sendBlueIMessage } from "../lib/inkbox";
import { sessionFor } from "../lib/composio";
import { tenantId } from "../lib/tenant";

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function conversationId(ctx: ToolContext): string | undefined {
  const attrs =
    ctx.session.auth.current?.attributes ??
    ctx.session.auth.initiator?.attributes;
  const raw = attrs?.conversationId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id === "string" && id.length > 0) return id;
  return undefined;
}

function connectLinks(result: unknown): string[] {
  const blob = JSON.stringify(result ?? "");
  const found = blob.match(/https:\/\/connect\.composio\.dev\/[^\s"\\]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,)]+$/, "")))];
}

async function sendConnectIfAny(ctx: ToolContext, result: unknown): Promise<void> {
  const conv = conversationId(ctx);
  if (!conv) return;
  for (const url of connectLinks(result)) {
    try {
      await sendBlueIMessage({
        conversationId: conv,
        text: `Подключи приложение: ${url}`,
      });
    } catch (err) {
      console.error("composio connect link send failed", err);
    }
  }
}

async function runComposio(
  slug: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const session = await sessionFor(tenantId(ctx));
  const result = await session.execute(slug, rec(input));
  await sendConnectIfAny(ctx, result);
  return result;
}

export default defineDynamic({
  events: {
    "session.started": () => ({
      COMPOSIO_SEARCH_TOOLS: defineTool({
        description:
          "Find tools across the user's apps (Gmail, GitHub, Calendar, …). Start here. Never invent a tool slug.",
        inputSchema: {
          type: "object",
          required: ["queries"],
          properties: {
            queries: {
              type: "array",
              items: {
                type: "object",
                required: ["use_case"],
                properties: {
                  use_case: { type: "string" },
                  known_fields: { type: "string" },
                },
              },
            },
            session: {
              type: "object",
              properties: {
                id: { type: "string" },
                generate_id: { type: "boolean" },
              },
            },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_SEARCH_TOOLS", input, ctx),
      }),
      COMPOSIO_GET_TOOL_SCHEMAS: defineTool({
        description:
          "Get input schemas for tool slugs returned by COMPOSIO_SEARCH_TOOLS. Never guess slugs.",
        inputSchema: {
          type: "object",
          required: ["tool_slugs"],
          properties: {
            tool_slugs: { type: "array", items: { type: "string" } },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_GET_TOOL_SCHEMAS", input, ctx),
      }),
      COMPOSIO_MANAGE_CONNECTIONS: defineTool({
        description:
          "Connect or check this person's apps. Returns a Connect Link when they must authorize. Use for Gmail, GitHub, Calendar, etc.",
        inputSchema: {
          type: "object",
          required: ["toolkits"],
          properties: {
            toolkits: { type: "array", items: { type: "string" } },
            reinitiate_all: { type: "boolean" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_MANAGE_CONNECTIONS", input, ctx),
      }),
      COMPOSIO_MULTI_EXECUTE_TOOL: defineTool({
        description:
          "Execute discovered app tools for this person. Only use slugs from COMPOSIO_SEARCH_TOOLS.",
        inputSchema: {
          type: "object",
          required: ["tools", "sync_response_to_workbench"],
          properties: {
            tools: {
              type: "array",
              items: {
                type: "object",
                required: ["tool_slug", "arguments"],
                properties: {
                  tool_slug: { type: "string" },
                  arguments: { type: "object", additionalProperties: true },
                },
              },
            },
            thought: { type: "string" },
            sync_response_to_workbench: { type: "boolean" },
            current_step: { type: "string" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_MULTI_EXECUTE_TOOL", input, ctx),
      }),
      COMPOSIO_REMOTE_WORKBENCH: defineTool({
        description:
          "Run Python in the remote sandbox for large tool responses. Skip if the data already fits in chat.",
        inputSchema: {
          type: "object",
          required: ["code_to_execute"],
          properties: {
            code_to_execute: { type: "string" },
            thought: { type: "string" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_REMOTE_WORKBENCH", input, ctx),
      }),
      COMPOSIO_REMOTE_BASH_TOOL: defineTool({
        description:
          "Run bash in the remote sandbox for large files. 3-minute limit.",
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_REMOTE_BASH_TOOL", input, ctx),
      }),
    }),
  },
});
