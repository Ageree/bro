import type { ModelMessage } from "ai";
import { z } from "zod";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import { type StepIdentity, turnMemory } from "@agent/lib/turn-kind/step";
import { type SkillName, type SkillSetup, skillNames } from "./catalog";
import { loadedSkills, recordedSkills, skillStub } from "./render";
import { skillsForTurn } from "./triggers";

/**
 * Tools that follow skills (docs/roadmap.md, item 25): in the skills pilot a
 * person's turn is offered a domain's tools only once the conversation has
 * that domain's rules — the skill's block attached by the server, loaded
 * with `load_skill`, or wanted by the turn — so a step does not carry the
 * schemas of every domain. A group, once offered, stays for the rest of the
 * session: its tools join the tool block at most once, after the core tools,
 * and every later step reads them from the cache. Compaction is the one
 * point a group may go, when it folds its block to a stub; the cache is
 * broken there anyway, and `load_skill` brings the rules and the tools back
 * together. In the pilot of compaction the group goes from the next turn
 * (`turnOfferedSkills`): eve compacts at a turn's first step, after its
 * tools were chosen from the whole history.
 *
 * Hiding a tool is no guard: a call by its name still runs through its
 * approval and execute, as with `withheldTools`. Every rule stays there.
 *
 * - google: the mail, the calendar's cards, Drive and contacts. Reading the
 *   calendar stays in the core: «что у меня завтра?», «я свободен в 5?»
 *   miss a trigger as often as not, and a missing read would be «не могу».
 *   First contact offers it too: its turn offers to connect the mail.
 * - apps: Notion, Slack and the other apps through Composio.
 * - money: the spend limit and standing permissions. Taking a permission
 *   back has a trigger of its own («спрашивай меня снова», `triggers.ts`).
 * - schedules: creating and changing one, and price watches (`watch-create`;
 *   «следи за ценой» is its trigger). The list stays in the core, and
 *   so does `schedules-answer`, which has its own gate; stopping a schedule
 *   has a trigger of its own («больше не присылай»).
 *
 * The browser's tools, memory, the vault, privacy, pictures and the rest
 * stay in the core: the core instructions name them, and an errand the
 * trigger missed would end in «не могу». `browser_task` carries a short
 * description instead (`agent/tools/browser_task.ts`).
 */
export type ToolGroup = "apps" | "google" | "money" | "schedules";

/** The skills whose block offers a group, the group's own first. */
const groupSkills: Readonly<Record<ToolGroup, readonly SkillName[]>> = {
  apps: ["apps"],
  google: ["google", "first-contact"],
  money: ["money"],
  schedules: ["schedules"],
};

/**
 * The groups in the order their tools join the block: the index's order of
 * their own skills.
 */
export const toolGroups: readonly ToolGroup[] = [
  "google",
  "apps",
  "money",
  "schedules",
];

/**
 * Every tool of a fully set-up deployment by its group, or `core` for the
 * tools every step has. A name not here is core: the table fails open, and
 * `agent/lib/skills/tests/tools.test.ts` fails on a new tool left out.
 */
const toolGroupEntries = {
  apps: "apps",
  ask_question: "core",
  browser_task: "core",
  browser_files: "core",
  calculate: "core",
  "calendar-check-availability": "google",
  "calendar-create-event": "google",
  "calendar-delete-event": "google",
  "calendar-list-events": "core",
  "calendar-update-event": "google",
  connect_app: "apps",
  connect_google: "google",
  "contacts-search": "google",
  "drive-read": "google",
  "drive-search": "google",
  find_images: "core",
  form_of_address: "core",
  generate_image: "core",
  "gmail-attachment": "google",
  "gmail-draft": "google",
  "gmail-read-thread": "google",
  "gmail-search": "google",
  "gmail-send": "google",
  "gmail-update": "google",
  link_telegram: "core",
  list_orders: "core",
  load_skill: "core",
  "notion-add-task": "apps",
  "notion-read": "apps",
  "notion-search": "apps",
  personal_info__update: "core",
  privacy: "core",
  proactive_messages: "core",
  profile__find: "core",
  profile__forget_all: "core",
  profile__read: "core",
  profile__remove_memory: "core",
  profile__save_memory: "core",
  profile__semantic_find: "core",
  profile__update: "core",
  react_to_message: "core",
  request_vault_setup: "core",
  route_time: "core",
  "schedules-answer": "core",
  "schedules-create": "schedules",
  "schedules-list": "core",
  "schedules-update": "schedules",
  send_message: "core",
  "site-login-link": "core",
  site_sign_ins: "core",
  "slack-read": "apps",
  "slack-search": "apps",
  "slack-send-message": "apps",
  spend_limit: "money",
  standing_permission: "money",
  task: "core",
  task_cancel: "core",
  "watch-create": "schedules",
  web_fetch: "core",
  web_search: "core",
  workstreams__find: "core",
  workstreams__forget: "core",
  workstreams__forget_all: "core",
  workstreams__read: "core",
  workstreams__save: "core",
  yandex: "core",
} as const satisfies Readonly<Record<string, ToolGroup | "core">>;

const toolGroupTable = new Map(Object.entries(toolGroupEntries));

/** The names the table knows, for the test that every tool is in it. */
export const groupedToolNames = [...toolGroupTable.keys()];

/** A tool's group, or undefined for a tool every step has. */
export function toolGroup(name: string): ToolGroup | undefined {
  const group = toolGroupTable.get(name);
  return group === undefined || group === "core" ? undefined : group;
}

/**
 * Skills whose body calls a tool of another group by name, and so offer
 * that tool alone: when Госуслуги fail, the gov-services body searches the
 * mail and Drive for a document's date in the same turn.
 */
const toolSkillExtras: ReadonlyMap<string, readonly SkillName[]> = new Map([
  ["drive-search", ["gov-services"]],
  ["gmail-search", ["gov-services"]],
]);

/** The skills whose block offers a tool; none for a core tool. */
export function groupsOfTool(name: string): readonly SkillName[] {
  const group = toolGroup(name);
  if (group === undefined) return [];
  return [...groupSkills[group], ...(toolSkillExtras.get(name) ?? [])];
}

/** Whether a step offered these skills has this tool. */
export function toolOffered(name: string, skills: readonly SkillName[]) {
  const groups = groupsOfTool(name);
  return groups.length === 0 || groups.some((skill) => skills.includes(skill));
}

const taggedMessageSchema = z.object({ kind: z.string() });

/** Whether a message is eve's context of the turn (`context.*`). */
function turnContext(message: ModelMessage | undefined) {
  return (
    message?.role === "user" &&
    (taggedMessageSchema.safeParse(message).data?.kind ?? "").startsWith(
      "context."
    )
  );
}

/**
 * The current turn's own input, as eve's `turn.input` holds it — the
 * turn's context, then the message that opened it — and the conversation
 * before it.
 */
function splitTurn(messages: readonly ModelMessage[]) {
  const opening = messages.findLastIndex(startsTurn);
  if (opening === -1) return { history: [], input: messages };
  let start = opening;
  while (start > 0 && turnContext(messages[start - 1])) start -= 1;
  return {
    history: messages.slice(0, start),
    input: messages.slice(start, opening + 1),
  };
}

/**
 * The skills whose tools a person's step is offered, in the index's order:
 * every skill with a block in the conversation (a stale one too, so a
 * deploy that changed a body does not hide its tools; not a stub, whose
 * rules are folded away), every skill `load_skill` returned, and what the
 * `skills` slot chooses for this turn from its words and the conversation
 * before it (`skillsForTurn`). The slot's choice does not wait for its
 * records to show up in the step's messages, and it stays the same through
 * the turn: only a `load_skill` adds a group mid-turn, from the next step.
 */
export function offeredSkills(
  messages: readonly ModelMessage[],
  setup: SkillSetup
): SkillName[] {
  const offered = new Set<SkillName>(loadedSkills(messages, setup));
  for (const [name, text] of recordedSkills(messages)) {
    if (text !== skillStub(name)) offered.add(name);
  }
  const { history, input } = splitTurn(messages);
  for (const name of skillsForTurn({ browserReport: false, history, input })) {
    offered.add(name);
  }
  return skillNames.filter((name) => offered.has(name));
}

/**
 * The skills each turn was offered so far: a turn this instance lost works
 * them out again from its history.
 */
const turnSkills = turnMemory<readonly SkillName[]>();

/**
 * `offeredSkills` for every step of the turn `step` belongs to, in the
 * pilot of compaction: a group offered at one step stays to the turn's
 * end. eve compacts at a turn's first step after the step's tools were
 * chosen, and the summary takes away the `load_skill` results and the
 * calls the choice read; from the next step a group of the step before
 * would go mid-turn, with the follow-up its first call needs. Without a
 * turn id, the step's own.
 */
export function turnOfferedSkills(
  messages: readonly ModelMessage[],
  setup: SkillSetup,
  step: StepIdentity
): SkillName[] {
  const offered = offeredSkills(messages, setup);
  if (step.turnId === undefined) return offered;
  const held = new Set([...(turnSkills.get(step) ?? []), ...offered]);
  const skills = skillNames.filter((name) => held.has(name));
  turnSkills.set(step, skills);
  return skills;
}
