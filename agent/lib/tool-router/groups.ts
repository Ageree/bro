import type { SkillName } from "@agent/lib/skills/catalog";
import { type RouterGroup, routerGroups } from "./questions";

/**
 * The tools of the tool router (`TOOL_ROUTER_WORKSPACES`): a person's step
 * sees the core and the groups the router chose for the turn. Hiding a tool
 * is no guard: a call by its name still runs through its own approval and
 * execute, so the router fails open on what runs, though not on how well
 * the model calls a tool whose schema it has not seen.
 *
 * The core is wider than the evaluation needed, on purpose:
 * - `privacy` for good: called in 4 of the owner's 82 real turns, without
 *   arguments, and only reads; «кто видит мои данные» must not hang on the
 *   router.
 * - `browser_task` (its short description) and `calendar-list-events`, as
 *   in the skills pilot's core: the core instructions name them, and a miss
 *   is «не могу». They move to their groups only on the shadow's data.
 * - The stop tools: «не пиши ночью», «забудь всё», «отмени» must never meet
 *   «не могу». Each has its own approval, and the set is small and always
 *   the same, which costs the cache nothing.
 * - The signing tools (their own pilot, `SIGN_WORKSPACES`), as in the skills
 *   pilot's core: the person's «да» to Bro's signing question must reach
 *   `sign_document` whatever groups the router chose for that turn.
 */
const alwaysTools = [
  "send_message",
  "react_to_message",
  "ask_question",
  "load_skill",
  "open_tools",
  "calculate",
  "web_search",
  "web_fetch",
  "profile__find",
  "profile__read",
  "profile__semantic_find",
  "profile__save_memory",
  "profile__update",
  "workstreams__find",
  "workstreams__read",
  "workstreams__save",
  "personal_info__update",
  "schedules-list",
  "schedules-answer",
  "privacy",
  "browser_task",
  "calendar-list-events",
  "sign_document",
  "signature",
] as const;

/** The stop tools of the core (above). */
const alwaysStopTools = [
  "proactive_messages",
  "agency_control",
  "profile__remove_memory",
  "profile__forget_all",
  "workstreams__forget",
  "workstreams__forget_all",
  "schedules-update",
  "phone-disable",
  "contact-delete",
] as const;

/**
 * The tools of each group. A tool in several groups is shown when any of
 * them is open. `places` holds the location tools of their own pilot
 * (`LOCATION_WORKSPACES`): outside it the catalog lacks them, and a name
 * the catalog lacks costs nothing.
 */
const groupTools = {
  browser: ["browser_files", "site-login-link", "site_sign_ins", "list_orders"],
  calendar: [
    "calendar-check-availability",
    "calendar-create-event",
    "calendar-update-event",
    "calendar-delete-event",
    "connect_google",
  ],
  chat_apps: [
    "slack-search",
    "slack-read",
    "slack-send-message",
    "apps",
    "connect_app",
  ],
  docs: [
    "drive-search",
    "drive-read",
    "notion-search",
    "notion-read",
    "notion-add-task",
    "apps",
    "connect_app",
  ],
  events: ["timepad_events"],
  files: ["task"],
  mail: [
    "gmail-search",
    "gmail-read-thread",
    "gmail-attachment",
    "gmail-send",
    "gmail-draft",
    "gmail-update",
    "gmail-delete-draft",
    "mail-read",
    "mail-search",
    "mail-draft",
    "mail-send",
    "mail-update",
    "connect_mail",
    "connect_google",
    "agent-mail-inbox",
    "agent-mail-list",
    "agent-mail-read",
    "agent-mail-send",
    "contacts-search",
  ],
  media: ["generate_image", "generate_video", "find_images"],
  money: ["spend_limit", "standing_permission"],
  phone: [
    "phone-quote",
    "phone-activate",
    "phone-call",
    "phone-status",
    "phone-enable",
    "phone-release",
    "contact-find",
    "contact-save",
    "contacts-search",
  ],
  places: [
    "route_time",
    "location_now",
    "location_history",
    "location_edit",
    "place_reminder",
  ],
  schedules: ["schedules-create", "watch-create"],
  settings: ["form_of_address", "link_telegram", "request_vault_setup"],
  yandex: ["yandex", "yandex_purchase"],
} as const satisfies Readonly<Record<RouterGroup, readonly string[]>>;

const coreTools: ReadonlySet<string> = new Set([
  ...alwaysTools,
  ...alwaysStopTools,
]);

/** Every grouped tool by its groups, in the groups' order. */
const toolGroupsByName: ReadonlyMap<string, readonly RouterGroup[]> = new Map(
  [...new Set(routerGroups.flatMap((group) => [...groupTools[group]]))].map(
    (name) => [
      name,
      routerGroups.filter((group) =>
        groupTools[group].some((tool) => tool === name)
      ),
    ]
  )
);

/** The names the table knows, for the test that every tool is in it. */
export const routerToolNames: readonly string[] = [
  ...coreTools,
  ...toolGroupsByName.keys(),
];

/** Whether a tool is in the router's core for good. */
export function routerCoreTool(name: string) {
  return coreTools.has(name);
}

/**
 * A tool's groups, in their order; none for a tool of the core or one the
 * table does not know, which every step has: the table fails open.
 */
export function routerGroupsOfTool(name: string): readonly RouterGroup[] {
  if (coreTools.has(name)) return [];
  return toolGroupsByName.get(name) ?? [];
}

/** Whether a step whose turn has these groups sees the tool. */
export function routerToolOffered(
  name: string,
  groups: readonly RouterGroup[]
) {
  const own = routerGroupsOfTool(name);
  return own.length === 0 || own.some((group) => groups.includes(group));
}

/**
 * The group a call of a core tool tells about: a browser errand's report
 * ends with «Оплачиваю?», and the «да» that follows needs the browser's
 * group; a calendar read is followed by «перенеси её».
 */
const coreToolUses: ReadonlyMap<string, RouterGroup> = new Map([
  ["browser_task", "browser"],
  ["calendar-list-events", "calendar"],
  ["contact-delete", "phone"],
  ["phone-disable", "phone"],
  ["schedules-update", "schedules"],
]);

/** The groups a call of a tool marks as used (`stampRouterUse`). */
export function routerGroupsUsedBy(name: string): readonly RouterGroup[] {
  const use = coreToolUses.get(name);
  return use === undefined ? routerGroupsOfTool(name) : [use];
}

/**
 * Tools shared by groups, which tell nothing of which one a call needed: a
 * call of one does not mark its groups as used.
 */
export const sharedRouterTools: ReadonlySet<string> = new Set([
  "apps",
  "connect_app",
  "connect_google",
  "contacts-search",
]);

/**
 * The groups each skill stands for: a skill the turn would get from its
 * words, or that `load_skill` brought, opens them. They hold every tool the
 * skill's body names (the test in `tests/groups.test.ts`): the first
 * contact offers a call and Yandex, the Госуслуги fallback searches mail and
 * Drive in the same turn.
 */
export const skillRouterGroups = {
  "about-bro": ["settings", "browser"],
  apps: ["docs", "chat_apps"],
  browser: ["browser", "settings"],
  files: ["files"],
  "first-contact": ["mail", "calendar", "phone", "yandex"],
  games: [],
  google: ["mail", "calendar", "docs"],
  "gov-services": ["browser", "mail", "docs"],
  images: ["media"],
  memory: [],
  "meter-readings": ["browser"],
  money: ["money"],
  recommendations: ["places", "events"],
  schedules: ["schedules"],
  // The signing tools are core; the places are marked by the task agent.
  sign: ["files"],
} as const satisfies Readonly<Record<SkillName, readonly RouterGroup[]>>;

/**
 * The skill whose rules a group's tools lean on: their short descriptions
 * point to the skill's block, which the `skills` slot attaches only at the
 * turn's start, by its own triggers. A group open without that block gets a
 * note to load it (`routerSkillNote`). Not `places`: its tools are core and
 * point to no block, and the note to load picking places sent «напомни,
 * когда приду на Тверскую» through `load_skill recommendations` first (2 of
 * 4 live turns, 15.10).
 */
export const routerGroupSkill: Readonly<
  Partial<Record<RouterGroup, SkillName>>
> = {
  calendar: "google",
  chat_apps: "apps",
  docs: "google",
  files: "files",
  mail: "google",
  media: "images",
  money: "money",
  schedules: "schedules",
};
