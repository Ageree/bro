import { readFileSync } from "node:fs";
import {
  DEFAULT_SIM_PHONE,
  isSimConversation,
  isSimMessageId,
  isSimPhone,
  parseSimConversation,
  parseSimPhone,
  peekSimBubbles,
  recordSimBubble,
  rememberSimMessage,
  resetSimState,
  settleSimTurn,
  simConversationId,
  takeSimBubbles,
  waitSimTurnSettled,
} from "../agent/lib/sim.ts";
import {
  sendBlueIMessage,
  sendBlueIMessageGroup,
  sendBlueIMessageMedia,
  sendIMessageTapback,
} from "../agent/lib/inkbox.ts";
import { expectMatches, parsePlay } from "./sim-play.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
resetSimState();

assert(isSimConversation("sim:+15550001000"), "sim convo");
assert(!isSimConversation("chat-real"), "real convo");
assert(isSimPhone(DEFAULT_SIM_PHONE), "default phone");
assert(isSimPhone("+15551234567"), "555 range");
assert(!isSimPhone("+79001112233"), "real RU phone refused");
assert(!isSimPhone("+1555123456"), "too short");
assert(parseSimPhone("+15550001000") === "+15550001000", "parse phone");
assert(parseSimPhone("+79001112233") === undefined, "refuse real parse");
assert(
  parseSimConversation(undefined, DEFAULT_SIM_PHONE) ===
    simConversationId(DEFAULT_SIM_PHONE),
  "default convo from phone",
);
assert(
  parseSimConversation("sim:custom", DEFAULT_SIM_PHONE) === "sim:custom",
  "explicit convo",
);
assert(
  parseSimConversation("not-sim", DEFAULT_SIM_PHONE) ===
    simConversationId(DEFAULT_SIM_PHONE),
  "non-sim convo ignored",
);
assert(isSimMessageId("sim-abc"), "sim message id");
assert(!isSimMessageId("mid_real"), "real message id");

recordSimBubble("sim:t", { kind: "text", text: "привет" });
assert(peekSimBubbles("sim:t").length === 1, "peek");
assert(takeSimBubbles("sim:t")[0]?.text === "привет", "take");
assert(takeSimBubbles("sim:t").length === 0, "empty after take");

const settled = waitSimTurnSettled("sim:wait", 200);
settleSimTurn("sim:wait");
assert(await settled === true, "settle unblocks");
assert(await waitSimTurnSettled("sim:timeout", 20) === false, "timeout");

const sent = await sendBlueIMessage({
  conversationId: "sim:+15550001000",
  text: "без Inkbox",
});
assert(sent.service === "imessage", "fake is blue");
assert(sent.wasDowngraded === false, "fake not downgraded");
assert(takeSimBubbles("sim:+15550001000")[0]?.text === "без Inkbox", "text sink");

const media = await sendBlueIMessageMedia({
  conversationId: "sim:media",
  mediaUrls: ["sim:Bro.vcf"],
});
assert(isSimMessageId(media.id), "media id");
assert(takeSimBubbles("sim:media")[0]?.kind === "media", "media sink");

const group = await sendBlueIMessageGroup({
  to: ["+15550001000", "+15550001001"],
  text: "группа",
});
assert(isSimConversation(group.conversationId), "group sim convo");
assert(
  takeSimBubbles(group.conversationId ?? "")[0]?.kind === "group",
  "group sink",
);

rememberSimMessage("sim-in-1", "sim:react");
const tap = await sendIMessageTapback({
  messageId: "sim-in-1",
  reaction: "like",
});
assert(tap.reaction === "like", "tapback reaction");
assert(takeSimBubbles("sim:react")[0]?.kind === "tapback", "tapback sink");

const play = parsePlay({
  name: "help-catalog",
  phone: "+15550001000",
  turns: [{ text: "привет", expect: "консьерж|купить" }],
});
assert(play.turns.length === 1, "play turns");
assert(expectMatches("Я Bro — личный консьерж", play.turns[0]?.expect ?? ""), "expect hit");
assert(!expectMatches("ок", "консьерж"), "expect miss");

let threw = false;
try {
  parsePlay({ name: "bad", phone: "+79001112233", turns: [{ text: "x" }] });
} catch {
  threw = true;
}
assert(threw, "play refuses a real phone");

const channel = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(channel.includes('POST("/internal/sim"'), "sim POST route");
assert(channel.includes('GET("/internal/sim"'), "sim GET drain");
assert(channel.includes("BRO_INTERNAL_SECRET"), "sim is secret-gated");
assert(channel.includes("waitSimTurnSettled"), "sim waits for the turn");
assert(channel.includes("settleSimTurn"), "events settle the sim waiter");
assert(channel.includes("parseSimPhone"), "sim refuses non-+1555 phones");

const inkbox = readFileSync(
  new URL("../agent/lib/inkbox.ts", import.meta.url),
  "utf8",
);
assert(inkbox.includes("shouldSimOutbound"), "outbound short-circuits sim");
assert(inkbox.includes("to: opts.to"), "group create still uses to[]");

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
assert(pkg.scripts.sim, "npm run sim");
assert(pkg.scripts["sim:check"], "npm run sim:check");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("npm run sim"), "readme documents sim");
assert(readme.includes("/internal/sim"), "readme names the route");

const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
assert(agents.includes("npm run sim"), "agents.md tells cloud testers to sim");

const helpPlay = parsePlay(
  JSON.parse(
    readFileSync(new URL("../.harness/plays/help.json", import.meta.url), "utf8"),
  ),
);
assert(helpPlay.name === "help-catalog", "sample play");
assert(helpPlay.turns[0]?.text === "привет", "sample first turn");

console.log("sim-check ok");
}

await main();
