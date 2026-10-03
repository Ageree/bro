import {
  buildSchema,
  type DocumentNode,
  execute,
  parse,
  validate,
  visit,
} from "graphql";
import { z } from "zod";
import { env } from "@shared/environment";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import { searchWeb, webSearchInputSchema } from "@agent/lib/web-search/search";
import { sandboxHoldsPersonFiles } from "./inbox";
import { verifySandboxToolsToken } from "./keys";
import { fetchPublic } from "./public-fetch";

/**
 * The tool router of the code sandbox (`sandbox/README.md`): the GraphQL
 * endpoint the `tools` CLI reaches through `sandboxd`, which adds the token
 * the sandbox never sees. Only tools without actions in their name live
 * here: a prompt injected into a page the task agent reads can at most
 * search, read and download public pages: every hop of a read goes only to
 * an address checked public (`./public-fetch.ts`), never into Bro's own
 * network.
 *
 * Each of them also carries what the sandbox puts in its request out to the
 * web: a URL, a query. So a sandbox that was given the person's files
 * (docs/roadmap.md, item 30) gets none of them, for good: an instruction
 * hidden in a sheet or a file name could otherwise send the file's content
 * out in a URL. The task agent's hook marks the sandbox in Object Storage
 * before the first file goes in (`markSandboxHoldsPersonFiles`), and every
 * network call here checks that mark first; a mark that cannot be read
 * refuses too. The trade-off: a task with the person's files has no web,
 * so Bro looks up what it needs itself and passes it in the message.
 *
 * The content can also leave as text: in the task agent's report, which
 * opens a turn of Bro's that may start or continue a task agent. So the
 * same mark goes on every task agent of that conversation that gets a
 * message the person's own turn did not just send: a new one, a
 * continuation (checked by its `agentId`, since `ctx.session.parent` stays
 * the starting call's for the child's whole life), a steered message
 * (`keepOffWebUnlessSent` in `agent/subagents/task/hooks/person-files.ts`).
 * The report turn's own sends carry no URL a server fetches: a native link
 * and every attachment but the task agent's own files go as plain text
 * (`withoutFetchedUrls` in `agent/tools/messaging.ts`), and where the files
 * reach the task agent Telegram posts text without previews
 * (`agent/channels/telegram.ts`). What stays open: a later turn of the
 * person's may copy report text from the history into a task agent with
 * the web, or fetch with it itself; and a link in Bro's text that iMessage
 * previews.
 */

/** Under `/eve/v1/`, the only prefix that reaches eve in production. */
export const sandboxToolsPath = "/eve/v1/sandbox-tools";

const schema = buildSchema(`
  scalar JSON
  type Tool { name: String!, description: String!, inputSchema: JSON! }
  type ToolResult { ok: Boolean!, output: JSON, error: String }
  type Query { tools: [Tool!]! }
  type Mutation { toolExecute(name: String!, input: JSON!): ToolResult! }
`);

/** A page read for the model is cut here, as eve's own `web_fetch` cuts it. */
const maximumPageCharacters = 50_000;
const maximumPageBytes = 5 * 1024 * 1024;
/** A download rides back to the sandbox base64-encoded through the broker. */
const maximumDownloadBytes = 15 * 1024 * 1024;
const searchTimeoutMs = 45_000;

const webFetchInputSchema = z.object({
  url: z.string().describe("The https:// URL of a public page to read."),
});

const downloadInputSchema = z.object({
  url: z
    .string()
    .describe("The https:// URL of a public file to download, up to 15 MB."),
});

function publicUrl(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:") {
    throw new Error("Only https:// URLs can be fetched.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("Only public hosts can be fetched.");
  }
  return url;
}

const entities: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["gt", ">"],
  ["lt", "<"],
  ["nbsp", " "],
  ["quot", '"'],
  ["#39", "'"],
]);

/** Elements whose content is never text a reader sees. */
const hiddenElements: ReadonlySet<string> = new Set([
  "noscript",
  "script",
  "style",
  "svg",
  "template",
]);
/** Closing tags after which a reader sees a new line. */
const lineBreakTags: ReadonlySet<string> = new Set([
  "br",
  "/div",
  "/h1",
  "/h2",
  "/h3",
  "/h4",
  "/h5",
  "/h6",
  "/li",
  "/p",
  "/tr",
]);

function decodeEntity(match: string, name: string) {
  const known = entities.get(name.toLowerCase());
  if (known !== undefined) return known;
  const hex = /^#x([\da-f]{1,6})$/iu.exec(name)?.[1];
  const decimal = /^#(\d{1,7})$/u.exec(name)?.[1];
  const code =
    hex === undefined
      ? decimal === undefined
        ? undefined
        : Number.parseInt(decimal, 10)
      : Number.parseInt(hex, 16);
  // A code point past Unicode would make the whole page fail to read.
  return code === undefined || code > 0x10_ffff
    ? match
    : String.fromCodePoint(code);
}

/**
 * Readable text of a page: no scripts, styles or tags, one blank line at
 * most. One pass with `indexOf`, never a backtracking pattern over the page:
 * a hostile page of unclosed `<script` tags must not stall the router.
 */
export function pageText(html: string) {
  const lower = html.toLowerCase();
  const pieces: string[] = [];
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf("<", at);
    if (open === -1) {
      pieces.push(html.slice(at));
      break;
    }
    pieces.push(html.slice(at, open));
    if (lower.startsWith("<!--", open)) {
      const end = lower.indexOf("-->", open + 4);
      pieces.push(" ");
      at = end === -1 ? html.length : end + 3;
      continue;
    }
    const close = html.indexOf(">", open + 1);
    if (close === -1) break;
    const tag =
      /^\/?[a-z][a-z\d]*/u.exec(lower.slice(open + 1, close))?.[0] ?? "";
    if (hiddenElements.has(tag)) {
      const end = lower.indexOf(`</${tag}`, close + 1);
      const after = end === -1 ? -1 : html.indexOf(">", end);
      pieces.push(" ");
      at = after === -1 ? html.length : after + 1;
      continue;
    }
    pieces.push(lineBreakTags.has(tag) ? "\n" : " ");
    at = close + 1;
  }
  return pieces
    .join("")
    .replace(/&(#?\w{1,32});/gu, decodeEntity)
    .replace(/[ \t\f\v\r]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * A page's text in its own encoding: many Russian sites still serve
 * windows-1251, named in the header or in a `<meta>` near the top.
 */
export function decodePage(bytes: Uint8Array, mediaType: string | undefined) {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString("latin1");
  const charset =
    /charset=["']?([\w-]+)/iu.exec(mediaType ?? "")?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head)?.[1] ??
    /encoding=["']([\w-]+)["']/iu.exec(head)?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchPage(input: z.infer<typeof webFetchInputSchema>) {
  const url = publicUrl(input.url);
  const download = await downloadWithin(url, maximumPageBytes, {
    allowUrl: (next) => !isBlockedHost(next.hostname),
    fetch: fetchPublic,
    headers: { "user-agent": "Mozilla/5.0 (compatible; BroSandbox/1.0)" },
  });
  if (download.kind === "oversize") throw new Error("The page is over 5 MB.");
  if (download.kind === "failed") {
    throw new Error(`The page did not open: ${download.reason}.`);
  }
  const raw = decodePage(download.bytes, download.mediaType);
  const html =
    /html|xml/iu.test(download.mediaType ?? "") || /^\s*</u.test(raw);
  const text = html ? pageText(raw) : raw;
  return {
    content: text.slice(0, maximumPageCharacters),
    contentType: download.mediaType ?? "",
    truncated: text.length > maximumPageCharacters,
    url: url.href,
  };
}

function downloadFileName(url: URL) {
  const last = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  const clean = last.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 120);
  return clean.length > 0 ? clean : "download";
}

async function downloadFile(input: z.infer<typeof downloadInputSchema>) {
  const url = publicUrl(input.url);
  const download = await downloadWithin(url, maximumDownloadBytes, {
    allowUrl: (next) => !isBlockedHost(next.hostname),
    fetch: fetchPublic,
  });
  if (download.kind === "oversize") throw new Error("The file is over 15 MB.");
  if (download.kind === "failed") {
    throw new Error(`The file did not download: ${download.reason}.`);
  }
  return {
    base64: Buffer.from(download.bytes).toString("base64"),
    bytes: download.bytes.byteLength,
    fileName: downloadFileName(url),
    mediaType:
      resolveMediaType(download.bytes, download.mediaType) ??
      "application/octet-stream",
  };
}

async function search(input: z.infer<typeof webSearchInputSchema>) {
  const results = await searchWeb(input, AbortSignal.timeout(searchTimeoutMs));
  return results.map((result) => ({
    snippet: result.snippet,
    title: result.title,
    url: result.url,
  }));
}

/** What crosses the GraphQL boundary: a tool's input and output are JSON. */
const jsonSchema = z.json();
type Json = z.infer<typeof jsonSchema>;

interface RouterTool<T extends z.ZodType> {
  readonly description: string;
  readonly execute: (input: z.infer<T>) => Promise<Json>;
  readonly inputSchema: T;
  /** Whether a call sends what the sandbox gave it out to the web. */
  readonly network: boolean;
}

/** A router tool as the GraphQL resolvers see it, whatever its input. */
interface ResolvedRouterTool {
  readonly description: string;
  readonly inputSchema: Json;
  readonly network: boolean;
  readonly run: (input: Json) => Promise<Json>;
}

function routerTool<T extends z.ZodType>(
  tool: RouterTool<T>
): ResolvedRouterTool {
  return {
    description: tool.description,
    inputSchema: jsonSchema.parse(z.toJSONSchema(tool.inputSchema)),
    network: tool.network,
    run: async (input: Json) =>
      await tool.execute(tool.inputSchema.parse(input)),
  };
}

/** One check of the mark, its retry included. */
const markTimeoutMs = 10_000;

/**
 * Why the sandbox may not reach the web, or undefined when it may: the
 * answer the task agent reads in place of the tool's output.
 */
async function networkRefusal(sandboxId: string) {
  try {
    const holds = await sandboxHoldsPersonFiles(
      sandboxId,
      AbortSignal.timeout(markTimeoutMs)
    );
    return holds
      ? "This sandbox holds the person's files, so it has no web access: web_search, web_fetch and download are off here for good. Work with the files and what Bro wrote; name in your report what you could not look up, and Bro will find it."
      : undefined;
  } catch (error) {
    console.warn("[sandbox-tools] person files mark unread", {
      error: error instanceof Error ? error.name : "unknown",
      sandboxId,
    });
    return "The web tools are off for now: it could not be checked whether this sandbox holds the person's files. Try again in a minute, or do without the web and say so in your report.";
  }
}

const routerTools = new Map<string, ResolvedRouterTool>([
  [
    "web_search",
    routerTool({
      description:
        "Search the web. Returns pages with title, URL and an excerpt; read one in full with web_fetch.",
      execute: search,
      inputSchema: webSearchInputSchema,
      network: true,
    }),
  ],
  [
    "web_fetch",
    routerTool({
      description:
        "Read a public web page as plain text (up to 50 000 characters).",
      execute: fetchPage,
      inputSchema: webFetchInputSchema,
      network: true,
    }),
  ],
  [
    "download",
    routerTool({
      description:
        "Download a public file (up to 15 MB). The CLI saves it: tools download <url> <path>.",
      execute: downloadFile,
      inputSchema: downloadInputSchema,
      network: true,
    }),
  ],
]);

const toolExecuteArgsSchema = z.object({
  input: jsonSchema,
  name: z.string().min(1),
});

/** What every resolver knows of the request: whose sandbox sent it. */
interface RouterContext {
  readonly sandboxId: string;
}

const rootValue = {
  toolExecute: async (
    rawArgs: Readonly<Record<string, Json>>,
    context: RouterContext
  ) => {
    const args = toolExecuteArgsSchema.parse(rawArgs);
    const tool = routerTools.get(args.name.replaceAll("-", "_"));
    if (tool === undefined) {
      return { error: `There is no tool ${args.name}.`, ok: false };
    }
    // Without the files pilot no sandbox gets the person's files, and a web
    // call does not wait on Object Storage (`TASK_FILES_WORKSPACES`).
    if (tool.network && (env.TASK_FILES_WORKSPACES ?? []).length > 0) {
      const refusal = await networkRefusal(context.sandboxId);
      if (refusal !== undefined) return { error: refusal, ok: false };
    }
    try {
      return { ok: true, output: await tool.run(args.input) };
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? `Invalid input: ${z.prettifyError(error)}`
          : error instanceof Error
            ? error.message
            : "The tool failed.";
      return { error: message, ok: false };
    }
  },
  tools: () =>
    [...routerTools].map(([name, tool]) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name,
    })),
};

/**
 * One tool call per request: aliases or fragments could otherwise run a
 * dozen calls under the broker's one-request rate limit and size cap.
 */
function singleCallRefusal(document: DocumentNode) {
  const seen = { calls: 0, fragments: 0 };
  visit(document, {
    Field(node) {
      if (node.name.value === "toolExecute") seen.calls += 1;
    },
    FragmentDefinition() {
      seen.fragments += 1;
    },
    InlineFragment() {
      seen.fragments += 1;
    },
  });
  if (seen.fragments > 0) return "Fragments are not supported.";
  if (seen.calls > 1) return "One toolExecute per request.";
  return undefined;
}

const requestSchema = z.object({
  operationName: z.string().nullish(),
  query: z.string().min(1).max(10_000),
  variables: z.record(z.string(), jsonSchema).nullish(),
});

/**
 * Answers one GraphQL request of a sandbox. The bearer token is the one
 * `sandboxd` adds; without a valid one nothing runs.
 */
export async function answerSandboxToolRequest(request: Request) {
  const token = /^Bearer (\S+)$/u.exec(
    request.headers.get("authorization") ?? ""
  )?.[1];
  const claims =
    token === undefined ? undefined : verifySandboxToolsToken(token);
  if (claims === undefined) {
    return Response.json(
      { errors: [{ message: "Unauthorized." }] },
      { status: 401 }
    );
  }
  const body = requestSchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!body.success) {
    return Response.json(
      { errors: [{ message: "A GraphQL request body is required." }] },
      { status: 400 }
    );
  }
  let document: DocumentNode;
  try {
    document = parse(body.data.query);
  } catch (error) {
    return Response.json({
      errors: [
        { message: error instanceof Error ? error.message : "Bad query." },
      ],
    });
  }
  const refusal = singleCallRefusal(document);
  const errors = refusal === undefined ? validate(schema, document) : [];
  if (refusal !== undefined || errors.length > 0) {
    return Response.json({
      errors:
        refusal === undefined
          ? errors.map((error) => ({ message: error.message }))
          : [{ message: refusal }],
    });
  }
  const contextValue: RouterContext = { sandboxId: claims.sb };
  const result = await execute({
    contextValue,
    document,
    operationName: body.data.operationName ?? undefined,
    rootValue,
    schema,
    variableValues: body.data.variables ?? undefined,
  });
  console.info("[sandbox-tools] request", {
    errors: result.errors?.length ?? 0,
    sandboxId: claims.sb,
  });
  return Response.json(result);
}
