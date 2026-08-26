import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(import.meta.dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  const k = t.slice(0, i);
  const v = t.slice(i + 1);
  if (process.env[k] === undefined) process.env[k] = v;
}

const { sessionFor } = await import("../agent/lib/composio.ts");

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function nestedData(payload: unknown): Record<string, unknown> | null {
  const root = rec(payload);
  if (!root) return null;
  return rec(root.data) ?? root;
}

function ok(result: { successful?: boolean; error?: unknown; data?: unknown }): boolean {
  if (result.successful === false) return false;
  if (typeof result.error === "string" && result.error.length > 0) return false;
  const d = rec(result.data);
  if (d?.success === false) return false;
  if (typeof d?.error === "string" && d.error.length > 0) return false;
  return true;
}

function requiredArgs(
  schema: unknown,
  slug: string,
): Record<string, unknown> | null {
  const s = rec(schema) ?? {};
  const json =
    rec(s.input_schema) ??
    rec(s.inputParameters) ??
    rec(s.input_parameters) ??
    rec(s.parameters) ??
    s;
  const required = json.required;
  const args: Record<string, unknown> = {};
  if (Array.isArray(required)) {
    for (const name of required) {
      if (typeof name !== "string") return null;
      if (name === "query") args.query = "Hacker News";
      else if (name === "size" || name === "limit") args[name] = 3;
      else if (name === "page") args.page = 0;
      else {
        console.error("skip", slug, "needs", name);
        return null;
      }
    }
  }
  const props = rec(json.properties);
  if (props?.query && args.query === undefined) args.query = "Hacker News";
  if (props?.size && args.size === undefined) args.size = 3;
  return args;
}

function titlesFrom(data: unknown): string[] {
  const blob = JSON.stringify(data);
  const titles: string[] = [];
  for (const m of blob.matchAll(/"title"\s*:\s*"([^"]{8,120})"/g)) {
    if (m[1]) titles.push(m[1]);
    if (titles.length >= 3) break;
  }
  return titles;
}

const session = await sessionFor("local-dev");
console.log("session", session.sessionId);

const connected = await session.toolkits({ isConnected: true });
console.log(
  "connected_toolkits",
  connected.items.map((t) => t.slug).join(",") || "(none)",
);

const hn = await session.toolkits({ toolkits: ["hackernews"] });
const hnItem = hn.items[0];
console.log(
  "hackernews",
  hnItem
    ? `no_auth=${hnItem.isNoAuth} active=${hnItem.connection?.isActive ?? false}`
    : "missing",
);

const search = await session.execute("COMPOSIO_SEARCH_TOOLS", {
  queries: [{ use_case: "Get the latest Hacker News front page posts" }],
  session: { generate_id: true },
});
if (!ok(search)) {
  throw new Error(`search failed: ${String(search.error ?? rec(search.data)?.error ?? "unknown")} log=${search.logId ?? "?"}`);
}

const searchData = nestedData(search.data) ?? rec(search.data) ?? {};
const results = Array.isArray(searchData.results) ? searchData.results : [];
const first = rec(results[0]);
const slugs = [
  ...(Array.isArray(first?.primary_tool_slugs) ? first.primary_tool_slugs : []),
  ...(Array.isArray(first?.related_tool_slugs) ? first.related_tool_slugs : []),
].filter((s): s is string => typeof s === "string");
const schemas = rec(searchData.tool_schemas) ?? {};
console.log("discovered", slugs.join(",") || "(none)");

let used = "";
let executed: Awaited<ReturnType<typeof session.execute>> | undefined;
for (const slug of slugs) {
  const args = requiredArgs(schemas[slug], slug);
  if (!args) continue;
  const result = await session.execute(slug, args);
  used = slug;
  executed = result;
  if (ok(result)) break;
}

if (!executed || !used) {
  throw new Error("no discovered tool could be executed");
}
if (!ok(executed)) {
  throw new Error(
    `execute failed: ${String(executed.error ?? rec(executed.data)?.error ?? "unknown")} tool=${used} log=${executed.logId ?? "?"}`,
  );
}

const logId = executed.logId;
if (!logId) {
  throw new Error(`tool ${used} returned no log id`);
}

const preview = titlesFrom(executed.data);
console.log("tool", used);
console.log("log_id", logId);
console.log("successful", executed.successful ?? rec(executed.data)?.success ?? true);
if (preview.length) console.log("preview", preview.join(" | "));
console.log("ok");
