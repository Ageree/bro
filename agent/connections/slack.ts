import { defineOpenAPIConnection } from "eve/connections";
import { approveAllButReads } from "@agent/lib/connected-apps/approval";
import { connectedAppAuth } from "@agent/lib/connected-apps/auth";
import { slackApiBaseUrl } from "@agent/lib/connected-apps/slack";

const cursor = {
  description: "Pagination cursor from the previous page's next_cursor.",
  in: "query",
  name: "cursor",
  schema: { type: "string" },
} as const;

function limit(maximum: number) {
  return {
    in: "query",
    name: "limit",
    schema: { default: Math.min(100, maximum), maximum, type: "integer" },
  } as const;
}

function required(name: string, description: string) {
  return {
    description,
    in: "query",
    name,
    required: true,
    schema: { type: "string" },
  } as const;
}

const slackResponse = {
  "200": {
    content: {
      "application/json": {
        schema: { additionalProperties: true, type: "object" },
      },
    },
    description:
      "Slack's answer; `ok: false` with an `error` code when the call failed.",
  },
} as const;

function read(
  operationId: string,
  summary: string,
  parameters: readonly object[]
) {
  return {
    get: { operationId, parameters, responses: slackResponse, summary },
  };
}

const readOperations = [
  "conversations_history",
  "conversations_list",
  "conversations_replies",
  "search_messages",
  "users_info",
  "users_list",
  "users_lookupByEmail",
];

// Slack publishes no current OpenAPI document, so the few read methods Bro
// needs are pinned here. Sending goes through `slack-send-message`, which
// finds the recipient itself and waits for approval.
export default defineOpenAPIConnection({
  baseUrl: slackApiBaseUrl,
  description:
    "The person's own Slack workspace, read-only: find people and channels, read channel and DM history and threads, and search messages. To send a Slack message, use the slack-send-message tool.",
  auth: connectedAppAuth("slack"),
  approval: approveAllButReads(readOperations),
  operations: { allow: readOperations },
  spec: {
    info: { title: "Slack Web API (read)", version: "1.0.0" },
    openapi: "3.0.3",
    paths: {
      "/conversations.history": read(
        "conversations_history",
        "Messages in a channel or DM, newest first.",
        [
          required("channel", "Channel or DM ID."),
          limit(200),
          cursor,
          {
            description: "Only messages after this Unix timestamp.",
            in: "query",
            name: "oldest",
            schema: { type: "string" },
          },
        ]
      ),
      "/conversations.list": read(
        "conversations_list",
        "Channels and DMs the person belongs to or can see.",
        [
          {
            in: "query",
            name: "types",
            schema: {
              default: "public_channel,private_channel,im,mpim",
              type: "string",
            },
          },
          {
            in: "query",
            name: "exclude_archived",
            schema: { default: true, type: "boolean" },
          },
          limit(1000),
          cursor,
        ]
      ),
      "/conversations.replies": read(
        "conversations_replies",
        "The replies of one thread.",
        [
          required("channel", "Channel or DM ID."),
          required("ts", "The thread's parent message timestamp."),
          limit(200),
          cursor,
        ]
      ),
      "/search.messages": read(
        "search_messages",
        "Search messages with Slack search syntax (from:@name, in:#channel).",
        [
          required("query", "Slack search query."),
          {
            in: "query",
            name: "count",
            schema: { default: 20, maximum: 100, type: "integer" },
          },
        ]
      ),
      "/users.info": read("users_info", "One person's profile by user ID.", [
        required("user", "User ID."),
      ]),
      "/users.list": read(
        "users_list",
        "People in the workspace with their IDs, names, and titles.",
        [limit(200), cursor]
      ),
      "/users.lookupByEmail": read(
        "users_lookupByEmail",
        "Find a person by email address.",
        [required("email", "Email address.")]
      ),
    },
  },
});
