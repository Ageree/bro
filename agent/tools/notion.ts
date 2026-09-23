import { defineDynamic, defineTool, type ToolContext } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";
import { connectedAppAuth } from "@agent/lib/connected-apps/auth";
import { notionApi } from "@agent/lib/connected-apps/notion";
import { resolveModeValue } from "@agent/lib/mode";

const richTextSchema = z.array(z.object({ plain_text: z.string() }));

const dataSourceSchema = z.object({
  database_type: z.string().nullish(),
  id: z.string(),
  in_trash: z.boolean().optional(),
  object: z.literal("data_source"),
  properties: z.record(z.string(), z.object({ type: z.string() })),
  title: richTextSchema.default([]),
});

type DataSource = z.infer<typeof dataSourceSchema>;

const searchResultsSchema = z.object({
  results: z.array(z.unknown()),
});

const createdPageSchema = z.object({
  id: z.string(),
  url: z.string().optional(),
});

const notionErrorSchema = z.object({ message: z.string() });

/** Titles that read as a to-do list in English or Russian. */
const taskListTitle = /\btasks?\b|to-?\s?dos?|задач|дела/iu;

/** Date property names that read as a due date, best first. */
const dueDateName = /due|deadline|срок|дедлайн|when|когда|date|дата/iu;

function plainTitle(source: DataSource) {
  return source.title
    .map((part) => part.plain_text)
    .join("")
    .trim();
}

/**
 * The data source the task goes into. A named one is matched by title;
 * otherwise Notion's own tasks databases win, then anything titled as a to-do
 * list. Anything else is not guessed at.
 */
function chooseDataSource(sources: DataSource[], name: string | undefined) {
  if (name) {
    const wanted = name.toLocaleLowerCase();
    return (
      sources.find(
        (source) => plainTitle(source).toLocaleLowerCase() === wanted
      ) ??
      sources.find((source) =>
        plainTitle(source).toLocaleLowerCase().includes(wanted)
      )
    );
  }
  return (
    sources.find((source) => source.database_type === "tasks") ??
    sources.find((source) => taskListTitle.test(plainTitle(source)))
  );
}

function propertyNamed(
  source: DataSource,
  type: string,
  preferred?: RegExp
): string | undefined {
  const names = Object.entries(source.properties)
    .filter(([, property]) => property.type === type)
    .map(([propertyName]) => propertyName);
  return (
    (preferred && names.find((propertyName) => preferred.test(propertyName))) ??
    names[0]
  );
}

/** The body of Notion's `POST /v1/search`, as far as this tool uses it. */
interface NotionSearchRequest {
  filter: { property: "object"; value: "data_source" };
  page_size: number;
  query?: string;
}

type NotionPropertyValue =
  | { title: { text: { content: string } }[] }
  | { date: { start: string } };

/** The body of Notion's `POST /v1/pages`, as far as this tool uses it. */
interface NotionCreatePageRequest {
  markdown?: string;
  parent: { data_source_id: string; type: "data_source_id" };
  properties: Record<string, NotionPropertyValue>;
}

async function notionRequest(
  ctx: ToolContext,
  path: string,
  body: NotionSearchRequest | NotionCreatePageRequest
) {
  const auth = connectedAppAuth("notion");
  const { token } = await ctx.getToken(auth);
  const response = await fetch(new URL(path, notionApi.baseUrl), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "notion-version": notionApi.version,
    },
    method: "POST",
    signal: ctx.abortSignal,
  });
  if (response.status === 401) ctx.requireAuth(auth);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = notionErrorSchema.safeParse(payload);
    throw new Error(
      `Notion answered ${String(response.status)}${error.success ? `: ${error.data.message}` : "."}`
    );
  }
  return payload;
}

export const notionAddTask = defineTool({
  approval: always(),
  description:
    "Add one task to the person's own Notion tasks. This requires user approval. Call it directly with the task title as the person said it: the tool finds their tasks database itself (Notion's tasks database, or one titled Tasks, To-do, Задачи), so no search is needed first. Pass `database` only when the person named a specific database. `due` sets the database's date property when it has one. Returns status `created` with the page URL, or `not_found` with the databases the tool could see, to ask the person which one they mean.",
  inputSchema: z.object({
    database: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "The Notion database the person named; leave out for their tasks."
      ),
    due: z
      .union([z.iso.date(), z.iso.datetime({ offset: true })])
      .optional()
      .describe("Due date (YYYY-MM-DD) or date-time with offset."),
    notes: z.string().trim().min(1).max(20_000).optional(),
    title: z.string().trim().min(1).max(2_000),
  }),
  async execute(input, ctx) {
    const search: NotionSearchRequest = {
      filter: { property: "object", value: "data_source" },
      page_size: 50,
    };
    if (input.database) search.query = input.database;
    const searched = searchResultsSchema.parse(
      await notionRequest(ctx, "/v1/search", search)
    );
    const sources = searched.results.flatMap((result) => {
      const parsed = dataSourceSchema.safeParse(result);
      return parsed.success && !parsed.data.in_trash ? [parsed.data] : [];
    });
    const target = chooseDataSource(sources, input.database);
    const titleProperty = target && propertyNamed(target, "title");
    if (!target || !titleProperty) {
      return {
        databases: sources.slice(0, 15).map(plainTitle),
        status: "not_found" as const,
      };
    }

    const dueProperty = input.due
      ? propertyNamed(target, "date", dueDateName)
      : undefined;
    const properties: NotionCreatePageRequest["properties"] = {
      [titleProperty]: { title: [{ text: { content: input.title } }] },
    };
    if (dueProperty && input.due) {
      properties[dueProperty] = { date: { start: input.due } };
    }
    const page: NotionCreatePageRequest = {
      parent: { data_source_id: target.id, type: "data_source_id" },
      properties,
    };
    if (input.notes) page.markdown = input.notes;
    const created = createdPageSchema.parse(
      await notionRequest(ctx, "/v1/pages", page)
    );
    return {
      database: plainTitle(target),
      dueSet: dueProperty !== undefined,
      pageId: created.id,
      status: "created" as const,
      url: created.url ?? null,
    };
  },
});

export default defineDynamic({
  events: {
    "turn.started": (_event, context) =>
      resolveModeValue(context, {
        interactive: { "notion-add-task": notionAddTask },
      }),
  },
});
