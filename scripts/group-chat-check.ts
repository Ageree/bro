/** Fails if group-chat policy, channel wiring, or isolation regress. */
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

import { assert, src } from "./lib/check.ts";

assert(isGroupMessage({ is_group: true }), "snake group");
assert(isGroupMessage({ isGroup: true }), "camel group");
assert(!isGroupMessage({ is_group: false }), "not group");
assert(!isGroupMessage({}), "missing is_group is 1:1");
assert(
  isGroupMessage({ sender_number: "+79001112233" }),
  "sender_number is a group signal",
);
assert(
  !isGroupMessage({ remote_number: "+79001112233" }),
  "remote_number alone is 1:1",
);
assert(
  isGroupMessage({ participants: ["+79001110001", "+79001110002"] }),
  "two participants is a group",
);

assert(normalizeE164("+79001112233") === "+79001112233", "e164 passthrough");
assert(normalizeE164("79001112233") === "+79001112233", "bare digits");
assert(normalizeE164("8 (900) 111-22-33") === "+79001112233", "national 8 → +7");
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
  { type: "text" as const, text: "фото" },
  { type: "file" as const, mediaType: "image/jpeg", data: "x" },
]);
assert(Array.isArray(taggedParts), "parts stay array");
const firstPart = taggedParts[0];
assert(
  firstPart?.type === "text" && firstPart.text === "[group +7900] фото",
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
const withOwner = parseGroupCreatePhones(
  ["+79001110001", "+79001110009"],
  ["+15551212"],
);
assert(
  withOwner.ok && withOwner.to.includes("+79001110009"),
  "owner stays in create to",
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

const channel = src("agent/channels/imessage.ts");
assert(channel.includes("/webhooks/photon"), "Photon inbound is the chat path");
assert(channel.includes("if (msg.is_group)"), "Inkbox groups are dropped");
assert(!channel.includes("bindGroupInbound"), "no new Inkbox group binds");
assert(!channel.includes("sendGroupWelcome"), "no group welcome on Pro");

const bind = src("convex/groupChats.ts");
assert(!bind.includes("inkboxConversationId"), "group bind never touches 1:1 conv");
assert(bind.includes("firstGroup"), "first group flag");
assert(bind.includes("existing.ownerPhoneE164"), "keep first owner on later speakers");
assert(bind.includes("normalizeE164(args.senderPhone)"), "normalize last sender");
assert(bind.includes("missing handle"), "refuse empty handle on insert");

const tenants = src("convex/tenants.ts");
assert(
  tenants.includes("inkboxConversationId") &&
    tenants.includes("bindInbound"),
  "1:1 bind still exists",
);
assert(
  tenants.includes("oneToOneConversationIdOrUndefined") &&
    tenants.includes("groupChats"),
  "1:1 bind refuses group conversation ids",
);

const tools = [
  "browser_task.ts",
  "vault_setup.ts",
  "profile_setup.ts",
  "composio.ts",
  "bro_mail.ts",
  "otp_lookup.ts",
  "watch_app.ts",
  "job_open.ts",
  "job_wait.ts",
  "job_done.ts",
  "schedule_wakeup.ts",
  "cancel_wakeup.ts",
];
for (const file of tools) {
  const toolSrc = src(`agent/tools/${file}`);
  assert(toolSrc.includes("groupPersonalBlock"), `${file} refuses group personal work`);
}
for (const file of ["web_search.ts", "web_fetch.ts"]) {
  const toolSrc = src(`agent/tools/${file}`);
  assert(!toolSrc.includes("groupPersonalBlock"), `${file} is public web, ok in groups`);
}

const createTool = src("agent/tools/group_chat.ts");
assert(createTool.includes("PHOTON_GROUPS_PAUSED"), "create is refused on Pro");
assert(createTool.includes("groupHowtoText"), "howto still explains groups");
assert(!createTool.includes("sendBlueIMessageGroup"), "tool does not open a group");

const inkbox = src("agent/lib/inkbox.ts");
assert(inkbox.includes("sendBlueIMessageGroup"), "inkbox group send");
assert(inkbox.includes("to: opts.to"), "create uses to[]");

const schema = src("convex/schema.ts");
assert(schema.includes("groupChats: defineTable"), "schema table");
assert(schema.includes('index("by_conversation"'), "group conversation index");

const readme = src("README.md");
assert(/group|групп/i.test(readme), "readme documents groups");
assert(readme.includes("Photon"), "readme Photon chat");

const jobs = src("agent/instructions/jobs.ts");
assert(jobs.includes("isGroupTurn"), "jobs skip group turns");

const workerScope = src("agent/subagents/worker/lib/scope.ts");
assert(workerScope.includes("groupPersonalBlock"), "worker refuses group personal work");

for (const file of ["lookup.ts", "inbox.ts", "archive_search.ts"]) {
  const toolSrc = src(`agent/subagents/otp/tools/${file}`);
  assert(toolSrc.includes("groupPersonalBlock"), `otp ${file} refuses group personal work`);
}

const otpAgent = src("agent/subagents/otp/agent.ts");
assert(otpAgent.includes("isGroupTurn"), "otp subagent hidden on group turns");

const instructions = src("agent/instructions.md");
assert(instructions.includes("[group"), "instructions group prefix");
assert(instructions.includes("group_chat"), "instructions tool");

const pkg = src("package.json");
assert(pkg.includes("group:check"), "npm script");

console.log("group-chat-check ok");
