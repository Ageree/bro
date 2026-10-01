import { buildSchema, graphql } from "graphql";
import { z } from "zod";
import { downloadWithin } from "@agent/lib/inbound-media/download";
import { resolveMediaType } from "@agent/lib/inbound-media/media-type";
import { isBlockedHost } from "@agent/lib/outbound-media/attachments";
import {
  searchWeb,
  webSearchInputSchema,
} from "@agent/lib/web-search/openrouter";
import { verifySandboxToolsToken } from "./keys";

/**
 * The tool router of the code sandbox (`sandbox/README.md`): the GraphQL
 * endpoint the `tools` CLI reaches through `sandboxd`, which adds the token
 * the sandbox never sees. Only tools without the person's data and without
 * actions in their name live here: a prompt injected into a page the task
 * agent reads can at most search, read and download public pages.
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

/** Readable text of a page: no scripts, styles or tags, one blank line at most. */
export function pageText(html: string) {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(#?\w+);/gu, (match, name: string) => {
      const known = entities.get(name.toLowerCase());
      if (known !== undefined) return known;
      const code = /^#x([\da-f]+)$/iu.exec(name)?.[1];
      if (code !== undefined)
        return String.fromCodePoint(Number.parseInt(code, 16));
      const decimal = /^#(\d+)$/u.exec(name)?.[1];
      return decimal === undefined
        ? match
        : String.fromCodePoint(Number.parseInt(decimal, 10));
    })
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
}

/** A router tool as the GraphQL resolvers see it, whatever its input. */
interface ResolvedRouterTool {
  readonly description: string;
  readonly inputSchema: Json;
  readonly run: (input: Json) => Promise<Json>;
}

function routerTool<T extends z.ZodType>(
  tool: RouterTool<T>
): ResolvedRouterTool {
  return {
    description: tool.description,
    inputSchema: jsonSchema.parse(z.toJSONSchema(tool.inputSchema)),
    run: async (input: Json) =>
      await tool.execute(tool.inputSchema.parse(input)),
  };
}

const routerTools = new Map<string, ResolvedRouterTool>([
  [
    "web_search",
    routerTool({
      description:
        "Search the web. Returns pages with title, URL and an excerpt; read one in full with web_fetch.",
      execute: search,
      inputSchema: webSearchInputSchema,
    }),
  ],
  [
    "web_fetch",
    routerTool({
      description:
        "Read a public web page as plain text (up to 50 000 characters).",
      execute: fetchPage,
      inputSchema: webFetchInputSchema,
    }),
  ],
  [
    "download",
    routerTool({
      description:
        "Download a public file (up to 15 MB). The CLI saves it: tools download <url> <path>.",
      execute: downloadFile,
      inputSchema: downloadInputSchema,
    }),
  ],
]);

const toolExecuteArgsSchema = z.object({
  input: jsonSchema,
  name: z.string().min(1),
});

const rootValue = {
  toolExecute: async (rawArgs: Readonly<Record<string, Json>>) => {
    const args = toolExecuteArgsSchema.parse(rawArgs);
    const tool = routerTools.get(args.name.replaceAll("-", "_"));
    if (tool === undefined) {
      return { error: `There is no tool ${args.name}.`, ok: false };
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
  const result = await graphql({
    operationName: body.data.operationName ?? undefined,
    rootValue,
    schema,
    source: body.data.query,
    variableValues: body.data.variables ?? undefined,
  });
  console.info("[sandbox-tools] request", {
    errors: result.errors?.length ?? 0,
    sandboxId: claims.sb,
  });
  return Response.json(result);
}
