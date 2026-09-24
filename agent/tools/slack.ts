import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import {
  connectedAppAuth,
  connectedAppConfigured,
} from "@agent/lib/connected-apps/auth";
import { slackApiBaseUrl } from "@agent/lib/connected-apps/slack";
import { resolveModeValue } from "@agent/lib/mode";

/** Slack errors that mean the grant itself is gone, not the request. */
const revokedGrantErrors = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

const slackResponseSchema = z.looseObject({
  error: z.string().optional(),
  ok: z.boolean(),
});

const nextCursorSchema = z.object({
  response_metadata: z.object({ next_cursor: z.string() }).optional(),
});

const memberSchema = z.object({
  deleted: z.boolean().optional(),
  id: z.string(),
  is_bot: z.boolean().optional(),
  name: z.string().default(""),
  profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
      title: z.string().optional(),
    })
    .default({}),
  real_name: z.string().optional(),
});

type Member = z.infer<typeof memberSchema>;

const channelSchema = z.object({ id: z.string(), name: z.string().optional() });

const userIdPattern = /^[UW][A-Z0-9]{6,}$/u;
const conversationIdPattern = /^[CGD][A-Z0-9]{6,}$/u;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Pages of people or channels read before giving up on a name. */
const maximumPages = 10;

/**
 * Calls one Slack Web API method with the person's own token. Reads go as a
 * query string, writes as JSON. Slack answers 200 with `ok: false` for a
 * failed call; a revoked grant starts the authorization again instead of
 * failing the call.
 */
async function callSlack(
  ctx: ToolContext,
  method: string,
  params: Record<string, string | number | boolean>,
  kind: "read" | "write"
) {
  const auth = connectedAppAuth("slack");
  const { token } = await ctx.getToken(auth);
  const url = new URL(`${slackApiBaseUrl}/${method}`);
  const headers = new Headers({ authorization: `Bearer ${token}` });
  let body: string | null = null;
  if (kind === "write") {
    headers.set("content-type", "application/json; charset=utf-8");
    body = JSON.stringify(params);
  } else {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    body,
    headers,
    method: kind === "write" ? "POST" : "GET",
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(auth);
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `Slack is rate limiting ${method}; try again${retryAfter ? ` in ${retryAfter} s` : " shortly"}.`
    );
  }
  // An outage or a proxy answers with HTML, not Slack's JSON envelope.
  const parsed = slackResponseSchema.safeParse(
    await response.json().catch(() => undefined)
  );
  if (!parsed.success) {
    throw new Error(
      `Slack ${method} answered ${String(response.status)} without its JSON response.`
    );
  }
  const payload = parsed.data;
  if (!payload.ok) {
    if (payload.error && revokedGrantErrors.has(payload.error)) {
      ctx.requireAuth(auth);
    }
    throw new Error(`Slack ${method} failed: ${payload.error ?? "unknown"}.`);
  }
  return payload;
}

/** Every page of one list method, up to {@link maximumPages}. */
async function listAll<T>(
  ctx: ToolContext,
  method: string,
  params: Record<string, string | number | boolean>,
  pick: (payload: z.infer<typeof slackResponseSchema>) => T[]
) {
  const items: T[] = [];
  let cursor = "";
  for (let page = 0; page < maximumPages; page += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each page needs the previous page's cursor.
    const payload = await callSlack(
      ctx,
      method,
      cursor ? { ...params, cursor } : params,
      "read"
    );
    items.push(...pick(payload));
    cursor =
      nextCursorSchema.parse(payload).response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return items;
}

function normalize(value: string | undefined) {
  return (value ?? "").trim().replace(/^@/u, "").toLocaleLowerCase();
}

function memberNames(member: Member) {
  return [
    member.name,
    member.real_name,
    member.profile.real_name,
    member.profile.display_name,
  ]
    .map(normalize)
    .filter((name) => name.length > 0);
}

/**
 * People whose handle, display name, or full name is exactly what the person
 * said; failing that, whose first name is.
 */
function matchMembers(members: Member[], recipient: string) {
  const wanted = normalize(recipient);
  const people = members.filter((member) => !member.deleted && !member.is_bot);
  const exact = people.filter((member) => memberNames(member).includes(wanted));
  if (exact.length > 0) return exact;
  return people.filter((member) =>
    memberNames(member).some((name) => name.split(/\s+/u)[0] === wanted)
  );
}

function describeMember(member: Member) {
  return {
    id: member.id,
    name:
      [
        member.profile.real_name,
        member.real_name,
        member.profile.display_name,
        member.name,
      ].find((value) => value !== undefined && value.length > 0) ?? member.id,
    handle: `@${member.name}`,
    title: member.profile.title?.length ? member.profile.title : null,
  };
}

interface Recipient {
  readonly handle: string | null;
  readonly id: string;
  readonly kind: "user" | "conversation";
  readonly name: string;
}

function userRecipient(member: Member): Recipient {
  const described = describeMember(member);
  return {
    handle: described.handle,
    id: member.id,
    kind: "user",
    name: described.name,
  };
}

async function resolveRecipient(
  ctx: ToolContext,
  to: string
): Promise<
  | { status: "found"; recipient: Recipient }
  | { status: "ambiguous"; candidates: ReturnType<typeof describeMember>[] }
  | { status: "not_found" }
> {
  if (userIdPattern.test(to)) {
    // Named in the result too, so the person sees who the ID was.
    const payload = await callSlack(ctx, "users.info", { user: to }, "read");
    const member = memberSchema.parse(
      z.object({ user: z.unknown() }).parse(payload).user
    );
    return { recipient: userRecipient(member), status: "found" };
  }
  if (conversationIdPattern.test(to)) {
    return {
      recipient: { handle: null, id: to, kind: "conversation", name: to },
      status: "found",
    };
  }
  if (to.startsWith("#")) {
    const wanted = normalize(to.slice(1));
    const channels = await listAll(
      ctx,
      "conversations.list",
      {
        exclude_archived: true,
        limit: 1000,
        types: "public_channel,private_channel",
      },
      (payload) =>
        z.object({ channels: z.array(channelSchema) }).parse(payload).channels
    );
    const channel = channels.find((item) => normalize(item.name) === wanted);
    return channel
      ? {
          recipient: {
            handle: null,
            id: channel.id,
            kind: "conversation",
            name: `#${channel.name ?? wanted}`,
          },
          status: "found",
        }
      : { status: "not_found" };
  }
  if (emailPattern.test(to)) {
    const payload = await callSlack(
      ctx,
      "users.lookupByEmail",
      { email: to },
      "read"
    ).catch((cause: unknown) => {
      if (cause instanceof Error && cause.message.includes("users_not_found")) {
        return undefined;
      }
      throw cause;
    });
    if (!payload) return { status: "not_found" };
    const member = memberSchema.parse(
      z.object({ user: z.unknown() }).parse(payload).user
    );
    return { recipient: userRecipient(member), status: "found" };
  }

  const members = await listAll(ctx, "users.list", { limit: 200 }, (payload) =>
    z
      .object({ members: z.array(z.unknown()) })
      .parse(payload)
      .members.flatMap((item) => {
        const parsed = memberSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
  );
  const matches = matchMembers(members, to);
  const [only] = matches;
  if (matches.length === 1 && only) {
    return {
      recipient: userRecipient(only),
      status: "found",
    };
  }
  if (matches.length > 1) {
    return {
      candidates: matches.slice(0, 10).map(describeMember),
      status: "ambiguous",
    };
  }
  return { status: "not_found" };
}

export const slackSendMessage = defineTool({
  approval: always(),
  description:
    "Send a Slack message as the person, from their own Slack account. This requires user approval. Call it directly with the recipient as the person named them — a first or full name, @handle, email, #channel, or a Slack user or channel ID — and the exact message text; the tool finds the recipient itself, so no lookup is needed first. Returns status `sent`; `ambiguous` with candidate people (nothing was sent: ask the person which one, then call again with that candidate's @handle, which the approval card shows in place of a bare ID); or `not_found` (nothing was sent). A sent result names the resolved recipient; tell the person who it went to.",
  inputSchema: z.object({
    text: z.string().trim().min(1).max(4_000),
    to: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        "Who or where: a name, @handle, email, #channel, or a Slack ID."
      ),
  }),
  async execute(input, ctx) {
    const resolved = await resolveRecipient(ctx, input.to);
    if (resolved.status !== "found") return resolved;
    const { recipient } = resolved;
    const channel =
      recipient.kind === "user"
        ? z
            .object({ channel: z.object({ id: z.string() }) })
            .parse(
              await callSlack(
                ctx,
                "conversations.open",
                { users: recipient.id },
                "write"
              )
            ).channel.id
        : recipient.id;
    const posted = z
      .object({ ts: z.string() })
      .parse(
        await callSlack(
          ctx,
          "chat.postMessage",
          { channel, text: input.text },
          "write"
        )
      );
    return {
      channel,
      recipient: { handle: recipient.handle, name: recipient.name },
      status: "sent" as const,
      ts: posted.ts,
    };
  },
});

// Without a connector on this deployment the tool would only fail, and its
// presence reads to the model as a connected account.
export default defineDynamic({
  events: {
    async "turn.started"(_event, context) {
      const tools = resolveModeValue(context, {
        interactive: { "slack-send-message": slackSendMessage },
      });
      return tools && (await connectedAppConfigured("slack")) ? tools : null;
    },
  },
});
