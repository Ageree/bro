import { z } from "zod";
import { composioRequest } from "@shared/composio/api";

/** A tool's input parameters as Composio publishes them (JSON Schema). */
const toolParametersSchema = z.object({
  properties: z
    .record(
      z.string(),
      z.object({
        description: z.string().optional(),
        type: z.union([z.string(), z.array(z.string())]).optional(),
      })
    )
    .optional(),
  required: z.array(z.string()).optional(),
});

/** One Composio tool, the fields Bro decides and describes it by. */
const composioToolSchema = z.object({
  description: z.string().default(""),
  input_parameters: toolParametersSchema.default({}),
  is_deprecated: z.boolean().optional(),
  name: z.string(),
  slug: z.string(),
  tags: z.array(z.string()).default([]),
  toolkit: z.object({ slug: z.string() }),
});

export type ComposioTool = z.output<typeof composioToolSchema>;

const toolPageSchema = z.object({ items: z.array(composioToolSchema) });

/** Tools of one toolkit that match a task in words, best first. */
export async function searchComposioTools(
  toolkit: string,
  task: string,
  limit: number,
  signal: AbortSignal
) {
  const { items } = await composioRequest(toolPageSchema, "/tools", {
    query: { limit, query: task, toolkit_slug: toolkit },
    signal,
  });
  return items.filter((tool) => tool.is_deprecated !== true);
}

const knownTools = new Map<string, Promise<ComposioTool>>();

/**
 * One tool by slug, its latest version. Kept per instance: the approval
 * policy and the call itself both ask for the same tool.
 */
export async function readComposioTool(slug: string) {
  const known = knownTools.get(slug);
  if (known) return known;
  const pending = composioRequest(
    composioToolSchema,
    `/tools/${encodeURIComponent(slug)}`
  );
  knownTools.set(slug, pending);
  pending.catch(() => knownTools.delete(slug));
  return pending;
}

/** MCP-style hints Composio tags a tool with when it changes something. */
const writeHints = new Set(["createHint", "destructiveHint", "updateHint"]);

/**
 * Verbs in a tool's slug that change something. A tool tagged read-only
 * whose name says otherwise is still asked about.
 */
const writeVerb =
  /(?:^|_)(?:ADD|APPEND|ARCHIVE|ASSIGN|CANCEL|CLEAR|CLOSE|COMMENT|COMPLETE|COPY|CREATE|DELETE|DRAFT|EDIT|FORWARD|IMPORT|INSERT|INVITE|MERGE|MODIFY|MOVE|PATCH|PIN|POST|PUBLISH|REACT|REMOVE|RENAME|REOPEN|REPLY|SCHEDULE|SEND|SET|SHARE|STAR|TRASH|UNPIN|UNSTAR|UPDATE|UPLOAD|WRITE)(?:_|$)/u;

/**
 * Whether a tool only reads: tagged `readOnlyHint`, with no hint of a change
 * and no changing verb in its name. Anything else counts as a write.
 */
export function composioToolReadsOnly(tool: ComposioTool) {
  const action = tool.slug.slice(tool.toolkit.slug.length + 1);
  return (
    tool.tags.includes("readOnlyHint") &&
    !tool.tags.some((tag) => writeHints.has(tag)) &&
    !writeVerb.test(action)
  );
}

/** Longest parameter description handed to the model. */
const parameterDescriptionLength = 120;

/** Parameters listed for one tool; the required ones always come first. */
const listedParameters = 12;

/**
 * A tool as the model reads it in a search: name, a short description,
 * whether it writes, and its parameters with their types, required first.
 * Full JSON schemas would crowd the context for little gain.
 */
export function describeComposioTool(tool: ComposioTool) {
  const properties = tool.input_parameters.properties ?? {};
  const required = tool.input_parameters.required ?? [];
  const names = [
    ...required,
    ...Object.keys(properties).filter((name) => !required.includes(name)),
  ].slice(0, Math.max(listedParameters, required.length));
  return {
    description: tool.description.slice(0, 300),
    name: tool.name,
    parameters: Object.fromEntries(
      names.map((name) => {
        const property = properties[name];
        const type = [property?.type ?? "any"].flat().join("|");
        const description = (property?.description ?? "")
          .replace(/\s+/gu, " ")
          .slice(0, parameterDescriptionLength);
        return [name, description ? `${type} — ${description}` : type];
      })
    ),
    required,
    tool: tool.slug,
    writes: !composioToolReadsOnly(tool),
  };
}

/** A tool call's arguments: a JSON object keyed by parameter name. */
export const composioToolArgumentsSchema = z.record(z.string(), z.json());

const executionSchema = z.object({
  data: z.json().optional(),
  error: z.string().nullish(),
  successful: z.boolean(),
});

/**
 * Runs one Composio tool as the person: Composio calls the app with the
 * grant of `connectedAccountId`, which never reaches Bro.
 */
export async function executeComposioTool(input: {
  readonly arguments: z.output<typeof composioToolArgumentsSchema>;
  readonly connectedAccountId: string;
  readonly signal: AbortSignal;
  readonly slug: string;
  readonly userId: string;
}) {
  return composioRequest(
    executionSchema,
    `/tools/execute/${encodeURIComponent(input.slug)}`,
    {
      body: {
        arguments: input.arguments,
        connected_account_id: input.connectedAccountId,
        user_id: input.userId,
      },
      method: "POST",
      signal: input.signal,
    }
  );
}
