import { defineDynamic, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { isConnectDest, wrapConnectUrl } from "../lib/connect-link";
import { sessionFor } from "../lib/composio";
import { attr, groupPersonalBlock } from "../lib/group-guard";
import { tenantId } from "../lib/tenant";
import { sandboxNetworkViolation } from "../lib/sandbox-policy";
import { getTenant } from "../lib/convex";
import { attrsFromSession, channelFromAuth } from "../lib/deliver-routed";
import { deliverHuman } from "../lib/deliver-human";
import { rec } from "../lib/guards";

function connectLinks(result: unknown): string[] {
  const blob = JSON.stringify(result ?? "");
  const found = blob.match(/https:\/\/connect\.composio\.dev\/[^\s"\\]+/g) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,)]+$/, "")))];
}

/**
 * Hand the human the Connect Link Composio just minted, or say why we could not.
 *
 * Delivery goes through `deliverHuman`'s `buttons` parameter rather than the
 * text body. The URL then never passes through `stripConnectUrls` at all — on
 * Telegram it becomes a real inline keyboard, on iMessage a labelled URL line
 * — and the sanitiser stays free to be as aggressive as it likes about raw
 * `*.composio.dev` URLs in model prose, which is the only thing it was ever
 * meant to catch.
 *
 * The return value is the other half of the fix. Every failure here used to
 * end in `console.error`, so the tool still resolved with Composio's happy
 * result, the model read "connection initiated" and told the human the link
 * was sent. Nobody saw the link and nobody was told. Now the reason comes
 * back to the model in Russian and lands in the reply.
 */
async function sendConnectIfAny(
  ctx: ToolContext,
  result: unknown,
): Promise<string | undefined> {
  const found = connectLinks(result);
  if (found.length === 0) return undefined;
  const dests = found.filter(isConnectDest);
  if (dests.length === 0) {
    return "composio вернул ссылку, которую я не признал ссылкой на подключение, — карточку не отправил. скажи человеку, что подключить не вышло, и не выдавай это за успех.";
  }

  const conv = attr(ctx, "conversationId");
  if (!conv) {
    return "ссылку на подключение отправить некуда: у этого хода нет conversationId. скажи человеку, что ссылка не ушла и что надо написать тебе ещё раз в личку. свою ссылку в текст не вставляй.";
  }

  const phone = tenantId(ctx);
  let tenant: Awaited<ReturnType<typeof getTenant>> | null = null;
  try {
    tenant = await getTenant(phone);
  } catch (err) {
    console.error("composio connect link: tenant lookup failed", err);
    // Without the tenant row there is no telegramChatId and no lastChannel,
    // so a send here would quietly aim a Telegram-derived conversation id at
    // iMessage and land nowhere. Say so instead of guessing.
    return "не смог достать профиль, чтобы понять, куда слать ссылку, — карточка не ушла. скажи человеку прямо и предложи попробовать ещё раз.";
  }

  const channel = channelFromAuth(attrsFromSession(ctx.session), tenant?.lastChannel);
  if (channel === "telegram" && !tenant?.telegramChatId) {
    return "ход пришёл из телеграма, а чат для ответа не записан — карточку с ссылкой отправить не смог. скажи человеку, что не вышло.";
  }

  for (const url of dests) {
    try {
      await deliverHuman({
        tenant,
        conversationId: conv,
        channel,
        text: "открой и подтверди доступ",
        buttons: [[{ text: "Подключить", url: wrapConnectUrl(url) }]],
      });
    } catch (err) {
      console.error("composio connect link send failed", err);
      return "ссылка на подключение не дошла: отправка упала. скажи человеку, что подключить не получилось, и предложи повторить.";
    }
  }
  return undefined;
}

async function runComposio(
  slug: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const blocked = groupPersonalBlock(ctx);
  if (blocked) return blocked;
  const session = await sessionFor(tenantId(ctx));
  const result = await session.execute(slug, rec(input));
  const undelivered = await sendConnectIfAny(ctx, result);
  // Composio's own result says the connection was initiated — that is true
  // whether or not the human ever saw the link. When the card did not go out,
  // the model has to hear it here, or it reports a success that never
  // happened.
  if (undelivered) return { result, ссылка_не_ушла: undelivered };
  return result;
}

export default defineDynamic({
  events: {
    "session.started": () => ({
      COMPOSIO_SEARCH_TOOLS: defineTool({
        description:
          "Find tools across this person's apps (Gmail, GitHub, Calendar, …). Start here. Never invent a tool slug.",
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
      // The session's seventh default meta tool (see
      // agent/skills/composio/references/platform.md). Without it, the turn
      // that sends a Connect Link has no way to learn that the human actually
      // tapped it: Bro could only send the link and then claim, or deny, a
      // connection he never checked. `toolkits` mirrors
      // COMPOSIO_MANAGE_CONNECTIONS; the rest of the argument shape is the
      // server's, so extra keys pass through instead of being dropped here.
      COMPOSIO_WAIT_FOR_CONNECTIONS: defineTool({
        description:
          "Wait for this person to finish authorizing after a Connect Link was sent, then report whether the app is connected. Short waits only — come back and talk to them instead of holding the turn.",
        inputSchema: {
          type: "object",
          additionalProperties: true,
          properties: {
            toolkits: { type: "array", items: { type: "string" } },
            timeout: {
              type: "number",
              description: "Seconds to wait. Keep it at 60 or under.",
            },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) =>
          runComposio("COMPOSIO_WAIT_FOR_CONNECTIONS", input, ctx),
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
          "Python in the remote sandbox for large tool responses. Skip if the data fits in chat. No network: facts via web_search / web_fetch, shops via browser_task.",
        inputSchema: {
          type: "object",
          required: ["code_to_execute"],
          properties: {
            code_to_execute: { type: "string" },
            thought: { type: "string" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) => {
          const { code_to_execute } = rec(input);
          if (typeof code_to_execute === "string") {
            const violation = sandboxNetworkViolation(code_to_execute);
            if (violation) {
              return Promise.resolve({
                error: violation,
                hint: "Факты — web_search / web_fetch. Магазины (Ozon, WB) — browser_task: они режут прямой HTTP.",
              });
            }
          }
          return runComposio("COMPOSIO_REMOTE_WORKBENCH", input, ctx);
        },
      }),
      COMPOSIO_REMOTE_BASH_TOOL: defineTool({
        description:
          "Bash in the remote sandbox for large files. 3-minute limit. No network: facts via web_search / web_fetch, shops via browser_task.",
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" },
            session_id: { type: "string" },
          },
        },
        execute: (input, ctx) => {
          const { command } = rec(input);
          if (typeof command === "string") {
            const violation = sandboxNetworkViolation(command);
            if (violation) {
              return Promise.resolve({
                error: violation,
                hint: "Факты — web_search / web_fetch. Магазины (Ozon, WB) — browser_task: они режут прямой HTTP.",
              });
            }
          }
          return runComposio("COMPOSIO_REMOTE_BASH_TOOL", input, ctx);
        },
      }),
    }),
  },
});
