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
import { applicationOrigin } from "@shared/environment/origin";
import { objectStorageConfigured } from "@shared/object-storage/s3";
import { cloudruObjectStorage } from "@shared/object-storage/sigv4";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import { decodePage } from "@agent/lib/web-page/decode";
import { searchWeb, webSearchInputSchema } from "@agent/lib/web-search/search";
import { sandboxFilesPath } from "./files";
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
 * network, and never to Bro's own links or bucket (`fetchable`).
 *
 * Each of them also carries what the sandbox puts in its request out to the
 * web: a URL, a query. So a sandbox that was given the person's files
 * (docs/roadmap.md, item 30) gets none of them, for good: an instruction
 * hidden in a sheet or a file name could otherwise send the file's content
 * out in a URL. The task agent's hook marks the sandbox in Object Storage
 * before the first file goes in (`markSandboxHoldsPersonFiles`), and every
 * network call here checks that mark first, whether or not the files pilot
 * is still on; a mark that cannot be read refuses too. The trade-off: a task with the person's files has no web,
 * so Bro looks up what it needs itself and passes it in the message.
 *
 * The content can also leave as text: in the task agent's report, which
 * opens a turn of Bro's that may start or continue a task agent. So the
 * same mark goes on every task agent of that conversation that gets a
 * message the person's own turn did not just send: a new one, a
 * continuation (checked by its `agentId` and the text, since
 * `ctx.session.parent` stays the starting call's for the child's whole
 * life), a steered message
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

/** A host name as compared here: lower case, no trailing dots. */
function hostKey(hostname: string) {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

/**
 * Bro's own hosts and its bucket's: the origin a `share_file` link is on
 * (`BETTER_AUTH_URL` or Vercel's), the deployment's other Vercel names, the
 * router's own address and Object Storage, which a shared file's link
 * redirects to. Read per call: `env` is parsed once anyway.
 */
function ownHosts() {
  // Cloud.ru's Object Storage and the one the `S3_*` settings name: a link
  // to either may still be in a report while Bro moves between them.
  const hosts = new Set<string>([
    hostKey(new URL(cloudruObjectStorage.endpoint).hostname),
  ]);
  if (env.S3_ENDPOINT !== undefined) {
    hosts.add(hostKey(new URL(env.S3_ENDPOINT).hostname));
  }
  const origins = [env.BETTER_AUTH_URL, env.SANDBOX_TOOLS_URL];
  try {
    origins.push(applicationOrigin());
  } catch {
    // No origin outside Vercel without BETTER_AUTH_URL: the rest still count.
  }
  for (const origin of origins) {
    const hostname =
      origin === undefined ? undefined : URL.parse(origin)?.hostname;
    if (hostname !== undefined && hostname !== "") hosts.add(hostKey(hostname));
  }
  for (const name of [
    env.VERCEL_BRANCH_URL,
    env.VERCEL_PROJECT_PRODUCTION_URL,
    env.VERCEL_URL,
  ]) {
    if (name !== undefined) hosts.add(hostKey(name));
  }
  return hosts;
}

/** How many times a URL is decoded in search of a link nested in it. */
const nestedDecodes = 8;

/** One round of percent-decoding; an escape that is no UTF-8 reads byte by byte. */
function decodeEscapes(text: string) {
  return text.replaceAll(/(?:%[\da-f]{2})+/giu, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replaceAll(/%([\da-f]{2})/giu, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16))
      );
    }
  });
}

/**
 * A URL as the servers along its way may read it: as written, then decoded
 * again and again until nothing changes, as each proxy reader decodes the
 * address in its query or path before it fetches that
 * (`api.allorigins.win/raw?url=…`, `r.jina.ai/https%253A…`). Each reading is
 * folded as a host and a path are compared: compatibility forms and
 * ideographic dots as plain ones, lower case, backslashes as slashes, runs
 * of slashes as one.
 */
function readings(href: string) {
  const texts = [fold(href)];
  for (let round = 0; round < nestedDecodes; round += 1) {
    const last = texts.at(-1) ?? "";
    const next = fold(decodeEscapes(last));
    if (next === last) break;
    texts.push(next);
  }
  return texts;
}

function fold(text: string) {
  return withoutDotSegments(
    text
      .normalize("NFKC")
      // A URL parser drops these from a host (UTS 46) where NFKC keeps them.
      .replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "")
      .replaceAll("\u3002", ".")
      .toLowerCase()
      .replaceAll("\\", "/")
      .replaceAll(/\/{2,}/gu, "/")
  );
}

/** `/./` and `/x/../` resolved, as a URL parser resolves them in a path. */
function withoutDotSegments(text: string) {
  let folded = text;
  for (;;) {
    const next = folded
      .replaceAll(/\/\.(?=\/|$)/gu, "")
      .replace(/\/[^/?#]+\/\.\.(?=\/|$)/u, "");
    if (next === folded) return folded;
    folded = next;
  }
}

/**
 * The hosts and paths of the `http(s):` addresses written into a reading,
 * as a proxy reader's own URL parser would make them of the text it got.
 */
function nestedAddresses(text: string) {
  const found: string[] = [];
  for (const match of text.matchAll(/https?:\/+[^\s"'<>]+/gu)) {
    const url = URL.parse(match[0].replace(/^(https?:)\/+/u, "$1//"));
    if (url !== null) found.push(`${hostKey(url.hostname)}${url.pathname}`);
  }
  return found;
}

/** A character a host name may hold, so a match next to it is another name. */
function hostCharacter(character: string | undefined) {
  return character !== undefined && /[a-z\d-]/u.test(character);
}

/** Whether the text names the host or a name under it anywhere. */
function mentionsHost(text: string, host: string) {
  for (
    let at = text.indexOf(host);
    at !== -1;
    at = text.indexOf(host, at + 1)
  ) {
    if (
      !hostCharacter(text[at - 1]) &&
      !hostCharacter(text[at + host.length])
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the router may request this URL for a sandbox: a public host, and
 * nothing of Bro's own. A `share_file` link is public and signed, and it may
 * reach a task agent with the web through a report that carries it; fetched
 * there, the file the link opens would leave with the next request. So no
 * hop goes to Bro or its bucket, to a shared file's path on any host (a
 * deployment answers it under many names), or to a proxy reader that
 * fetches either for it: no reading of the URL, decoded however deep, may
 * name one of Bro's hosts or the shared files' path, in its host, path or
 * query. Every redirect hop is asked the same (`allowUrl`). The price: a
 * page whose address merely mentions Bro's domain is not read either.
 */
function fetchable(url: URL) {
  if (isBlockedHost(url.hostname)) return false;
  const own = [...ownHosts()];
  return readings(url.href).every((reading) =>
    [reading, ...nestedAddresses(reading)].every(
      (text) =>
        !text.includes(sandboxFilesPath) &&
        !own.some((host) => mentionsHost(text, host))
    )
  );
}

function publicUrl(value: string) {
  const url = URL.parse(value);
  if (url?.protocol !== "https:") {
    throw new Error("Only https:// URLs can be fetched.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new Error("Only public hosts can be fetched.");
  }
  if (!fetchable(url)) {
    throw new Error(
      "Bro's own links, its shared files included, cannot be fetched from the sandbox."
    );
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

async function fetchPage(input: z.infer<typeof webFetchInputSchema>) {
  const url = publicUrl(input.url);
  const download = await downloadWithin(url, maximumPageBytes, {
    allowUrl: fetchable,
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
    allowUrl: fetchable,
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
    // Whatever TASK_FILES_WORKSPACES says now: a sandbox given the person's
    // files while it named the workspace keeps them, so clearing the flag
    // must not give it the web back. Only without Object Storage could no
    // file ever have come in. The cost: every web call of every pilot
    // sandbox waits on one GET first, and while Object Storage is down or
    // slow (up to `markTimeoutMs`) no sandbox has the web at all. No answer
    // is cached: a "no" goes stale the moment the hook marks the sandbox,
    // just before its first file goes in.
    if (tool.network && objectStorageConfigured()) {
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
