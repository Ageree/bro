import {
  CHAT_WINDOW_MS,
  DEFAULT_TEMPLATE,
  chatOutcome,
  computerAgentName,
  computerBackend,
  computerDesktopWanted,
  computerExternalId,
  computerInstructions,
  computerPollTimedOut,
  computerTemplate,
  liveViewDecision,
  mapAgentStatus,
} from "../agent/lib/computer-policy.ts";
import {
  listAgents,
  listTemplates,
  liveView,
  maritimeBaseUrl,
  maritimeEnabled,
  planUsage,
  provisionAgent,
  setDesktop,
  setMaritimeFetch,
} from "../agent/lib/maritime.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function throws(
  fn: () => unknown,
  contains: string,
  msg: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    assert(text.includes(contains), `${msg}: got "${text}"`);
    return;
  }
  throw new Error(msg);
}

assert(computerBackend(undefined) === "off", "backend off when unset");
assert(computerBackend("maritime") === "maritime", "backend maritime");
assert(computerBackend("") === "off", "backend empty is off");
assert(computerBackend("kernel") === "off", "backend garbage is off");

const PHONE = "+79001112233";
const ext = computerExternalId(PHONE);
assert(ext.startsWith("bro:"), "externalId prefix");
assert(ext.length === 44, "externalId is bro: + 40 hex");
assert(!ext.includes("7900"), "externalId must not leak the phone");
assert(ext === computerExternalId(PHONE), "externalId is stable");
assert(
  computerExternalId(PHONE) !== computerExternalId("+79004445566"),
  "externalId is per tenant",
);

const agentName = computerAgentName(PHONE);
assert(agentName.startsWith("bro-"), "agent name prefix");
assert(agentName.length === 16, "agent name is bro- + 12 hex");
assert(!agentName.includes("7900"), "agent name must not leak the phone");
assert(agentName === computerAgentName(PHONE), "agent name is stable");
assert(
  computerAgentName(PHONE) !== computerAgentName("+79004445566"),
  "agent name is per tenant",
);
assert(agentName === `bro-${ext.slice(4, 16)}`, "name and id share a digest");

assert(computerTemplate("") === DEFAULT_TEMPLATE, "empty template → default");
assert(computerTemplate("  ") === DEFAULT_TEMPLATE, "blank template → default");
assert(computerTemplate("custom") === "custom", "explicit template");
assert(computerTemplate("  custom  ") === "custom", "template trimmed");

assert(computerDesktopWanted("1") === true, "desktop 1");
assert(computerDesktopWanted("true") === true, "desktop true");
assert(computerDesktopWanted("TRUE") === true, "desktop TRUE");
assert(computerDesktopWanted("0") === false, "desktop 0");
assert(computerDesktopWanted("false") === false, "desktop false");

const instructions = computerInstructions();
assert(instructions.includes("Нужен человек:"), "instructions: Нужен человек:");
assert(instructions.includes("Работаю:"), "instructions: Работаю:");

assert(mapAgentStatus("deploying") === "provisioning", "deploying");
assert(mapAgentStatus("building") === "provisioning", "building");
assert(mapAgentStatus("pending") === "provisioning", "pending");
assert(mapAgentStatus("starting") === "provisioning", "starting");
assert(mapAgentStatus("active") === "ready", "active");
assert(mapAgentStatus("running") === "ready", "running");
assert(mapAgentStatus("sleeping") === "sleeping", "sleeping");
assert(mapAgentStatus("stopped") === "sleeping", "stopped");
assert(mapAgentStatus("error") === "error", "error");
assert(mapAgentStatus("errored") === "error", "errored");
assert(mapAgentStatus("failed") === "error", "failed");
assert(mapAgentStatus("Deploying") === "provisioning", "status case");
assert(mapAgentStatus("weird") === "unknown", "unknown status");
assert(mapAgentStatus(null) === "unknown", "null status");
assert(mapAgentStatus(undefined) === "unknown", "undefined status");

const withUrl = liveViewDecision({ liveViewUrl: "https://live.example/view" });
assert(withUrl.url === "https://live.example/view", "live url present");
assert(withUrl.hint.includes("takeover"), "live hint with url");
const noUrl = liveViewDecision({ liveViewUrl: null });
assert(noUrl.url === undefined, "no url when null");
assert(noUrl.hint.includes("не обещай"), "live hint without url");
const emptyUrl = liveViewDecision({ liveViewUrl: "" });
assert(emptyUrl.url === undefined, "empty live url omitted");

assert(chatOutcome(null, 0) === "empty", "null reply");
assert(chatOutcome(undefined, 100) === "empty", "undefined reply");
assert(chatOutcome("", 100) === "empty", "empty reply");
assert(chatOutcome("Работаю: ищу слот", 100) === "working", "Работаю");
assert(chatOutcome("работаю дальше", 100) === "working", "работаю case");
assert(
  chatOutcome("готово", CHAT_WINDOW_MS) === "working",
  "timeout is working",
);
assert(chatOutcome("[blocked]", 100) === "blocked", "[blocked]");
assert(
  chatOutcome("[blocked]", CHAT_WINDOW_MS + 1_900) === "blocked",
  "a slow [blocked] is still blocked, not working",
);
assert(
  chatOutcome("Нужен человек: капча", 100) === "blocked",
  "Нужен человек",
);
assert(chatOutcome("сделал", 100) === "done", "done reply");

assert(computerPollTimedOut(undefined, 1_000) === false, "no start → false");
assert(computerPollTimedOut(0, 30 * 60_000) === false, "exactly 30 min");
assert(computerPollTimedOut(0, 30 * 60_000 + 1) === true, "over 30 min");

const savedApiUrl = process.env.MARITIME_API_URL;
delete process.env.MARITIME_API_URL;
assert(maritimeBaseUrl() === "https://api.maritime.sh", "default base url");
process.env.MARITIME_API_URL = "https://api.example.com/";
assert(maritimeBaseUrl() === "https://api.example.com", "base url strips /");
if (savedApiUrl !== undefined) process.env.MARITIME_API_URL = savedApiUrl;
else delete process.env.MARITIME_API_URL;

const savedToken = process.env.MARITIME_TOKEN;
delete process.env.MARITIME_TOKEN;
assert(!maritimeEnabled(), "disabled without a token");
await throws(
  () => provisionAgent({ name: "x", templateId: "openclaw_browser", externalId: "bro:x" }),
  "MARITIME_TOKEN",
  "provision must fail loudly without a token",
);

process.env.MARITIME_TOKEN = "test";
const calls: { method: string; url: string; body?: unknown }[] = [];
setMaritimeFetch(async (input, init) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  const parsed = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
  calls.push({ method, url, body: parsed });
  if (url.includes("/desktop-config")) {
    return new Response(
      JSON.stringify({ detail: "desktop requires a paid plan", code: "seat_limit" }),
      { status: 402, headers: { "Content-Type": "application/json" } },
    );
  }
  if (method === "GET" && url.includes("/api/agents")) {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (method === "POST" && /\/api\/agents\/?$/.test(new URL(url).pathname)) {
    const body = parsed && typeof parsed === "object" ? parsed : {};
    return new Response(
      JSON.stringify({
        id: "agt_test",
        name: "name" in body ? body.name : "x",
        status: "deploying",
        externalId: "externalId" in body ? body.externalId : null,
        framework: "openclaw",
        tier: "smart",
        desktopEnabled: false,
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }
  return new Response("{}", { status: 200 });
});

const desk = await setDesktop("agt_test", true);
assert(desk.ok === false, "402 desktop is not ok");
assert(
  !desk.ok && desk.reason === "paid_plan_required",
  "402 maps to paid_plan_required",
);

const provisioned = await provisionAgent({
  name: "bro-test",
  templateId: "openclaw_browser",
  externalId: "bro:abc",
});
assert(provisioned.created === true, "provision creates when list is empty");
assert(provisioned.agent.externalId === "bro:abc", "created agent keeps externalId");
const agentCalls = calls.filter((c) => !c.url.includes("/desktop-config"));
assert(agentCalls.length === 2, "provision is list then create");
assert(agentCalls[0]?.method === "GET", "provision first lists");
assert(agentCalls[1]?.method === "POST", "provision then posts");
const createdBody = agentCalls[1]?.body;
assert(
  createdBody !== null &&
    typeof createdBody === "object" &&
    "externalId" in createdBody &&
    createdBody.externalId === "bro:abc",
  "create posts externalId",
);

setMaritimeFetch(undefined);
if (savedToken !== undefined) process.env.MARITIME_TOKEN = savedToken;
else delete process.env.MARITIME_TOKEN;

if (process.env.MARITIME_LIVE === "1" && process.env.MARITIME_TOKEN?.trim()) {
  const usage = await planUsage();
  assert(typeof usage.plan === "string", "planUsage.plan");
  assert(typeof usage.agents === "number", "planUsage.agents");
  const templates = await listTemplates();
  assert(
    templates.some((t) => t.id === "openclaw_browser" || t.name === "openclaw_browser"),
    "templates include openclaw_browser",
  );
  const existing = await listAgents({ externalId: "spike:lead" });
  const found = existing[0];
  if (found) {
    const view = await liveView(found.id);
    assert(
      "reason" in view || "liveViewUrl" in view,
      "liveView has reason or liveViewUrl",
    );
  }
}

console.log("computer ok");
