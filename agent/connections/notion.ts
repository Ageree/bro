import { defineOpenAPIConnection } from "eve/connections";
import { approveAllButReads } from "@agent/lib/connected-apps/approval";
import { connectedAppAuth } from "@agent/lib/connected-apps/auth";
import { notionApi } from "@agent/lib/connected-apps/notion";

/** Operations that only read the person's workspace. */
const readOperations = [
  "get-block-children",
  "get-self",
  "get-users",
  "list-comments",
  "post-database-query",
  "post-search",
  "retrieve-a-block",
  "retrieve-a-data-source",
  "retrieve-a-page",
  "retrieve-a-page-property",
  "retrieve-database",
  "retrieve-page-markdown",
];

/** Operations that change the workspace; each call waits for approval. */
const writeOperations = [
  "create-a-comment",
  "patch-block-children",
  "patch-page",
  "post-page",
  "update-page-markdown",
];

// The registry's "OpenAPI · User" Notion scaffold rather than its MCP one: the
// spec is public, so the tools are discoverable and approval can be asked
// before the person has connected Notion, and the same REST grant serves
// `notion-add-task`.
export default defineOpenAPIConnection({
  spec: notionApi.spec,
  baseUrl: notionApi.baseUrl,
  description:
    "The person's own Notion workspace: search pages and databases (data sources), read and query them, and create or edit pages and comments. To add a task to their Notion tasks, prefer the notion-add-task tool.",
  auth: connectedAppAuth("notion"),
  approval: approveAllButReads(readOperations),
  operations: { allow: [...readOperations, ...writeOperations] },
  toolCall: {
    providedArguments: { "Notion-Version": notionApi.version },
  },
});
