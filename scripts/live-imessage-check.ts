import { readFileSync } from "node:fs";
import {
  allowlistWithTester,
  broHandleFromEnv,
  bubblesText,
  classifyLane,
  classifyListen,
  connectCommandFor,
  DEDICATED_UPGRADE_URL,
  DEFAULT_BRO_HANDLE,
  DEFAULT_TESTER_HANDLE,
  expectMatches,
  inboundText,
  isDedicatedQuotaError,
  remoteLast4,
  isE164,
  parseE164,
  parsePlay,
  pickListenRemote,
  quietSettled,
  TESTER_CLAIM_KEY,
  testerHandleFromEnv,
} from "../agent/lib/live-imessage.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isE164("+16504849720"), "us e164");
assert(isE164("+79217818876"), "ru e164");
assert(!isE164("+1555"), "too short");
assert(!isE164("79217818876"), "needs plus");
assert(!isE164("+15550001000x"), "junk");
assert(parseE164(" +16504849720 ") === "+16504849720", "parse trim");
assert(parseE164("+1555") === undefined, "parse refuse");

assert(
  connectCommandFor("bro-live-bro") === "connect @bro-live-bro",
  "connect",
);
assert(connectCommandFor("@bro-ageree") === "connect @bro-ageree", "strip at");

assert(inboundText({ content: "  фото  " }) === "фото", "inbound text");
assert(
  inboundText({
    content: null,
    media: [{ url: "https://media.example/p.jpg" }],
  }) === "https://media.example/p.jpg",
  "inbound media",
);
assert(
  inboundText({
    content: "смотри",
    media: [{ url: "https://media.example/p.jpg" }],
  }) === "смотри\nhttps://media.example/p.jpg",
  "caption+media",
);

assert(
  bubblesText([
    {
      id: "1",
      direction: "inbound",
      text: "привет",
      at: 1,
    },
  ]) === "привет",
  "bubble text",
);

assert(expectMatches("Я Bro — личный консьерж", "консьерж|купить"), "expect");
assert(!expectMatches("ок", "консьерж"), "expect miss");

const play = parsePlay({
  name: "live-help-catalog",
  broHandle: "bro-live-bro",
  turns: [{ text: "привет", expect: "консьерж|купить" }],
});
assert(play.turns.length === 1, "play turns");
assert(play.broHandle === "bro-live-bro", "play bro");

let threw = false;
try {
  parsePlay({ name: "bad", turns: [] });
} catch {
  threw = true;
}
assert(threw, "empty turns refused");

assert(
  testerHandleFromEnv({} as NodeJS.ProcessEnv) === DEFAULT_TESTER_HANDLE,
  "default tester",
);
assert(
  broHandleFromEnv({} as NodeJS.ProcessEnv) === DEFAULT_BRO_HANDLE,
  "default bro",
);
assert(
  testerHandleFromEnv({ BRO_LIVE_TESTER_HANDLE: " bro-x " } as NodeJS.ProcessEnv) ===
    "bro-x",
  "tester env",
);

const ready = classifyLane({
  apiKey: "k",
  testerExists: true,
  testerNumber: "+16500000001",
  testerHandle: DEFAULT_TESTER_HANDLE,
  broHandle: DEFAULT_BRO_HANDLE,
  routerNumber: "+16504849720",
});
assert(ready.ready, "ready when dedicated line exists");
assert(ready.connectCommand === "connect @bro-live-bro", "ready connect");

const quota = classifyLane({
  apiKey: "k",
  testerExists: false,
  quotaBlocked: true,
  testerHandle: DEFAULT_TESTER_HANDLE,
  broHandle: DEFAULT_BRO_HANDLE,
});
assert(!quota.ready && quota.blocker === "quota", "quota blocker");
assert(quota.detail?.includes(DEDICATED_UPGRADE_URL), "quota url");

const noLine = classifyLane({
  apiKey: "k",
  testerExists: true,
  testerHandle: DEFAULT_TESTER_HANDLE,
  broHandle: DEFAULT_BRO_HANDLE,
});
assert(noLine.blocker === "no_dedicated_line", "missing line");

const noKey = classifyLane({
  testerExists: false,
  testerHandle: DEFAULT_TESTER_HANDLE,
  broHandle: DEFAULT_BRO_HANDLE,
});
assert(noKey.blocker === "no_api_key", "missing key");

assert(remoteLast4("+79217818876") === "8876", "last4");
const listenReady = classifyListen({
  apiKey: "k",
  broExists: true,
  remotes: ["+79217818876"],
  broHandle: DEFAULT_BRO_HANDLE,
  routerNumber: "+16504849720",
});
assert(listenReady.ready, "listen ready with assignment");
assert(listenReady.remotesLast4.includes("8876"), "listen last4");
const listenWait = classifyListen({
  apiKey: "k",
  broExists: true,
  remotes: [],
  broHandle: DEFAULT_BRO_HANDLE,
  routerNumber: "+16504849720",
});
assert(listenWait.blocker === "no_assignment", "listen waits for iPhone");
assert(listenWait.detail?.includes("connect @bro-live-bro"), "listen connect hint");
const listenNoBro = classifyListen({
  apiKey: "k",
  broExists: false,
  remotes: [],
  broHandle: DEFAULT_BRO_HANDLE,
});
assert(listenNoBro.blocker === "no_bro", "listen needs QA Bro");

assert(
  pickListenRemote({ assignmentRemotes: ["+79217818876"] }) === "+79217818876",
  "pick assignment when no convo",
);
assert(
  pickListenRemote({
    assignmentRemotes: ["+79217818876"],
    conversationRemote: "+16500000001",
  }) === "+16500000001",
  "pick conversation remote first",
);
assert(
  pickListenRemote({ assignmentRemotes: [] }) === undefined,
  "pick none",
);

assert(
  allowlistWithTester("+79217818876", "+16500000001") ===
    "+79217818876,+16500000001",
  "allowlist append",
);
assert(
  allowlistWithTester("+16500000001", "+16500000001") === "+16500000001",
  "allowlist dedupe",
);

assert(
  quietSettled({ lastInboundAt: 1000, now: 9000, quietMs: 8000 }) === true,
  "quiet yes",
);
assert(
  quietSettled({ lastInboundAt: 1000, now: 5000, quietMs: 8000 }) === false,
  "quiet no",
);
assert(
  quietSettled({ lastInboundAt: undefined, now: 9000, quietMs: 8000 }) === false,
  "quiet none",
);

assert(TESTER_CLAIM_KEY.startsWith("bro-live"), "stable claim key");
const quotaErr = new Error("x");
quotaErr.name = "DedicatedIMessageNumberQuotaExceededError";
assert(isDedicatedQuotaError(quotaErr), "quota by name");
assert(
  isDedicatedQuotaError(new Error("Your current plan doesn't include dedicated outbound iMessage numbers.")),
  "quota by message",
);
assert(!isDedicatedQuotaError(new Error("identity cap")), "not every cap");

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
assert(pkg.scripts.live, "npm run live");
assert(pkg.scripts["live:check"], "npm run live:check");
assert(pkg.scripts["dev:live"], "npm run dev:live");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("npm run live"), "readme documents live");
assert(readme.includes("dedicated"), "readme names dedicated line");

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
assert(agents.includes("npm run live"), "agents.md tells cloud testers to live");
assert(agents.includes("BRO_LIVE_TESTER_HANDLE"), "agents.md names tester handle");
assert(agents.includes("provision --listen"), "agents.md documents human-first");
assert(agents.includes("wait-connect"), "agents.md wait-connect");
assert(agents.includes("real iMessage"), "agents.md is the live lane");

const envEx = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
assert(envEx.includes("BRO_LIVE_TESTER_HANDLE"), "env example tester");
assert(envEx.includes("BRO_LIVE_BRO_HANDLE"), "env example bro");

const helpPlay = parsePlay(
  JSON.parse(
    readFileSync(
      new URL("../.harness/plays/live-help.json", import.meta.url),
      "utf8",
    ),
  ),
);
assert(helpPlay.name === "live-help-catalog", "sample play");
assert(helpPlay.turns[0]?.text === "привет", "sample first turn");

const cli = readFileSync(
  new URL("./live-imessage.ts", import.meta.url),
  "utf8",
);
assert(cli.includes("sendIMessage"), "cli sends via Inkbox");
assert(cli.includes("listIMessages"), "cli polls Inkbox");
assert(cli.includes("claimIMessageNumber") || cli.includes("dedicated: true"), "cli claims line");
assert(cli.includes("provision --listen"), "human-first provision");
assert(cli.includes("wait-connect"), "wait for iPhone connect");
assert(cli.includes("as-bro"), "send as Bro");
assert(!cli.includes("/internal/sim"), "live is not the sim loopback");
assert(!cli.includes("sim:+1555"), "live does not fake +1555");

const tunnel = readFileSync(
  new URL("./dev-live.sh", import.meta.url),
  "utf8",
);
assert(tunnel.includes("INKBOX_AGENT_HANDLE"), "dev-live sets Bro handle");
assert(tunnel.includes("inkbox-tunnel"), "dev-live opens the tunnel");
assert(tunnel.includes("bro-live-bro"), "dev-live defaults to the QA handle");

console.log("live-imessage-check ok");
