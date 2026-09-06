/** Fails if group-chat policy, channel wiring, or isolation regress. */
import { readFileSync } from "node:fs";
import {
  foldGroupAsk,
  groupAuthAttributes,
  groupHowtoText,
  groupMemoryScope,
  groupParticipantPhones,
  groupPrivateOnlyText,
  groupSenderPhone,
  groupTaggedText,
  groupWelcomeText,
  isGroupAuthFlag,
  isGroupMemoryScope,
  isGroupMessage,
  normalizeE164,
  parseGroupCreatePhones,
  resolveGroupOwner,
  shouldReplyInGroup,
  tagGroupUserContent,
} from "../convex/lib/groupChatPolicy.ts";
import { isGroupTurn, groupPersonalBlock } from "../agent/lib/group-guard.ts";
import { resolveMemoryScope } from "../agent/lib/memory-policy.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

assert(isGroupMessage({ is_group: true }), "snake group");
assert(isGroupMessage({ isGroup: true }), "camel group");
assert(!isGroupMessage({ is_group: false }), "not group");
assert(!isGroupMessage({}), "missing is_group is 1:1");

assert(normalizeE164("+79001112233") === "+79001112233", "e164 passthrough");
assert(normalizeE164("79001112233") === "+79001112233", "bare digits");
assert(normalizeE164("8 (900) 111-22-33") === undefined, "national 8 dropped");
assert(normalizeE164("not-a-phone") === undefined, "garbage");

assert(
  groupSenderPhone({
    sender_number: "+79001110001",
    remote_number: "+79001110002",
  }) === "+79001110001",
  "sender wins",
);
assert(
  groupSenderPhone({ remote_number: "+79001110002" }) === "+79001110002",
  "remote fallback",
);
assert(
  groupParticipantPhones({
    participants: ["+79001110001", "+79001110001", "nope", "+79001110002"],
  }).join(",") === "+79001110001,+79001110002",
  "dedupe participants",
);

assert(
  resolveGroupOwner({
    tenantPhone: "+79001110009",
    senderPhone: "+79001110001",
  }) === "+79001110009",
  "owner is the identity tenant, not the latest speaker",
);
assert(
  resolveGroupOwner({ senderPhone: "+79001110001" }) === "+79001110001",
  "sender fallback when no tenant",
);

assert(shouldReplyInGroup("бро купи пиццу"), "бро mention");
assert(shouldReplyInGroup("Bro, where?"), "bro mention");
assert(shouldReplyInGroup("@bro go"), "at bro");
assert(shouldReplyInGroup("эй, бро"), "mid-sentence бро");
assert(shouldReplyInGroup("[voice] бро привет"), "voice mention");
assert(shouldReplyInGroup("[group +1] бро"), "already tagged");
assert(!shouldReplyInGroup("брони столик на двоих"), "брони is not бро");
assert(!shouldReplyInGroup("browser_task later"), "browser is not bro");
assert(!shouldReplyInGroup("поехали в бар"), "side chatter silent");
assert(!shouldReplyInGroup(""), "empty silent");
assert(foldGroupAsk("[group +7] БРО") === "бро", "fold strips tag");

assert(groupMemoryScope("abc") === "group:abc", "memory scope");
assert(isGroupMemoryScope("group:abc"), "group scope detect");
assert(!isGroupMemoryScope("+7900"), "phone is not group scope");
assert(groupMemoryScope("  ") === null, "blank conversation");

assert(isGroupAuthFlag({ isGroup: "1" }), "flag string");
assert(isGroupAuthFlag({ isGroup: ["1"] }), "flag array");
assert(!isGroupAuthFlag({ isGroup: "0" }), "flag off");
assert(!isGroupAuthFlag({}), "no flag");

const attrs = groupAuthAttributes({
  conversationId: "g1",
  inkboxHandle: "bro-a1b2c3d4",
  origin: "human",
  senderPhone: "+79001110001",
  ownerPhone: "+79001110009",
});
assert(attrs.isGroup === "1", "wire flag");
assert(attrs.senderPhone === "+79001110001", "sender attr");
assert(attrs.ownerPhone === "+79001110009", "owner attr");
assert(!("messageId" in attrs), "omit empty message id");

assert(
  groupTaggedText("+7900", "hi") === "[group +7900] hi",
  "text tag",
);
const taggedParts = tagGroupUserContent("+7900", [
  { type: "text", text: "фото" },
  { type: "file" },
]);
assert(Array.isArray(taggedParts), "parts stay array");
assert(
  Array.isArray(taggedParts) &&
    taggedParts[0] &&
    taggedParts[0].type === "text" &&
    taggedParts[0].text === "[group +7900] фото",
  "text part tagged",
);

const created = parseGroupCreatePhones(
  ["+79001110001", "+79001110002", "+79001110001"],
  ["+79001119999"],
);
assert(created.ok && created.to.length === 2, "create dedupes");
assert(
  !parseGroupCreatePhones(["+79001110001"]).ok,
  "one number is not a group",
);
assert(
  !parseGroupCreatePhones(
    [
      "+79001110001",
      "+79001110002",
      "+79001110003",
      "+79001110004",
      "+79001110005",
      "+79001110006",
      "+79001110007",
      "+79001110008",
      "+79001110009",
    ],
  ).ok,
  "over 8 rejected",
);
assert(
  parseGroupCreatePhones(["+79001110001", "+79001119999"], ["+79001119999"]).ok ===
    false,
  "exclude Bro's own line",
);

const welcome = groupWelcomeText();
const howto = groupHowtoText();
assert(/бро/i.test(welcome), "welcome mention rule");
assert(/личк/i.test(welcome), "welcome private");
assert(/контакт/i.test(howto), "howto contact");
assert(/бро/i.test(howto), "howto mention");
assert(!welcome.includes("**"), "welcome plain");
assert(!howto.includes("**"), "howto plain");
assert(groupPrivateOnlyText().includes("личк"), "private-only copy");

const groupCtx = {
  session: {
    auth: { current: { attributes: { isGroup: "1", conversationId: "g1" } } },
  },
};
const dmCtx = {
  session: { auth: { current: { attributes: { conversationId: "c1" } } } },
};
assert(isGroupTurn(groupCtx), "guard group");
assert(!isGroupTurn(dmCtx), "guard dm");
assert(groupPersonalBlock(groupCtx) === groupPrivateOnlyText(), "block group");
assert(groupPersonalBlock(dmCtx) === undefined, "allow dm");

assert(
  resolveMemoryScope(
    { current: { principalId: "+7900", attributes: { isGroup: "1", conversationId: "g1" } } },
    true,
  ) === "group:g1",
  "group memory isolated",
);

const channel = readFileSync(
  new URL("../agent/channels/imessage.ts", import.meta.url),
  "utf8",
);
assert(channel.includes("isGroupMessage"), "channel detects groups");
assert(channel.includes("bindGroupInbound"), "channel binds groups");
assert(channel.includes("shouldReplyInGroup"), "channel mention gate");
assert(channel.includes("sendGroupWelcome"), "channel group welcome");
assert(channel.includes("tagGroupUserContent"), "channel tags group text");
assert(channel.includes("groupAuthAttributes"), "channel group auth");
assert(channel.includes("replyTenant"), "outbound uses group owner");
assert(
  /if\s*\(\s*!group\s*\)/.test(channel) &&
    channel.includes("sendIMessageTyping"),
  "groups skip typing/read",
);
assert(channel.includes("else if (handle)"), "1:1 bind is not the group branch");
assert(
  channel.indexOf("bindGroupInbound") < channel.indexOf("bindInbound(handle, remote"),
  "group bind runs before 1:1 bind",
);
assert(
  channel.includes("upsertTenant(candidate)") ||
    channel.includes("upsertTenant(candidate);"),
  "shared group upsert has no conversation id",
);

const bind = readFileSync(new URL("../convex/groupChats.ts", import.meta.url), "utf8");
assert(!bind.includes("inkboxConversationId"), "group bind never touches 1:1 conv");
assert(bind.includes("firstGroup"), "first group flag");
assert(bind.includes("wrong owner"), "owner cannot be stolen");

const tenants = readFileSync(new URL("../convex/tenants.ts", import.meta.url), "utf8");
assert(
  tenants.includes("inkboxConversationId") &&
    tenants.includes("bindInbound"),
  "1:1 bind still exists",
);

const tools = [
  "browser_task.ts",
  "vault_setup.ts",
  "profile_setup.ts",
  "composio.ts",
  "bro_mail.ts",
  "watch_app.ts",
  "job_open.ts",
  "job_wait.ts",
  "job_done.ts",
];
for (const file of tools) {
  const src = readFileSync(
    new URL(`../agent/tools/${file}`, import.meta.url),
    "utf8",
  );
  assert(src.includes("groupPersonalBlock"), `${file} refuses group personal work`);
}

const createTool = readFileSync(
  new URL("../agent/tools/group_chat.ts", import.meta.url),
  "utf8",
);
assert(createTool.includes("sendBlueIMessageGroup"), "can open a group");
assert(createTool.includes("dedicatedIMessageNumber"), "create needs a number");

const inkbox = readFileSync(new URL("../agent/lib/inkbox.ts", import.meta.url), "utf8");
assert(inkbox.includes("sendBlueIMessageGroup"), "inkbox group send");
assert(inkbox.includes("to: opts.to"), "create uses to[]");

const schema = readFileSync(new URL("../convex/schema.ts", import.meta.url), "utf8");
assert(schema.includes("groupChats: defineTable"), "schema table");
assert(schema.includes('index("by_conversation"'), "group conversation index");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert(readme.includes("Group chats"), "readme documents groups");
assert(readme.includes("BRO_DEDICATED_LINE"), "readme dedicated line");

const instructions = readFileSync(
  new URL("../agent/instructions.md", import.meta.url),
  "utf8",
);
assert(instructions.includes("[group"), "instructions group prefix");
assert(instructions.includes("group_chat"), "instructions tool");

const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
assert(pkg.includes("group:check"), "npm script");

console.log("group-chat-check ok");
