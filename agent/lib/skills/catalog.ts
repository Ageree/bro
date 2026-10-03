import autonomy from "@agent/instructions/content/autonomy.md?raw";
import browserAvailable from "@agent/instructions/content/browser/available.md?raw";
import browserUnavailable from "@agent/instructions/content/browser/unavailable.md?raw";
import games from "@agent/instructions/content/creative/games.md?raw";
import imagesUnavailable from "@agent/instructions/content/creative/images-unavailable.md?raw";
import images from "@agent/instructions/content/creative/images.md?raw";
import executionSafety from "@agent/instructions/content/execution-safety.md?raw";
import followThrough from "@agent/instructions/content/follow-through.md?raw";
import hardConstraints from "@agent/instructions/content/hard-constraints.md?raw";
import messageStyle from "@agent/instructions/content/message-style.md?raw";
import meterReadings from "@agent/instructions/content/meter-readings.md?raw";
import publicServices from "@agent/instructions/content/public-services.md?raw";
import recommendations from "@agent/instructions/content/recommendations.md?raw";
import roleInteractive from "@agent/instructions/content/role/interactive.md?raw";
import taskAgentText from "@agent/instructions/content/task-agent.md?raw";
import taskFilesText from "@agent/instructions/content/task-files.md?raw";

/**
 * Bro's instructions, and the skills cut from them (docs/roadmap.md, item
 * 24). The text stays where it is, in `agent/instructions/content/**.md`;
 * lines that are a skill's are marked there, and this module renders the
 * same files two ways:
 *
 * - `full`: the text as every turn reads it outside the skills pilot, and
 *   as workers read it in the pilot. Only the marker lines and the
 *   `core-only` and `body-only` regions go, so a file with markers is byte
 *   for byte the file before them (`tests/agent/skills/flag-off.test.ts`).
 * - `core`: an interactive turn in the pilot (`SKILLS_WORKSPACES`). Skill,
 *   `full-only` and `body-only` regions go, `core-only` regions stay: the
 *   rules every turn needs, the condensed form of what a skill holds in
 *   full. Runs of blank lines the cut leaves become one.
 *
 * A skill's body is all of its `skill` and `body-only` regions, from every
 * file the setup reads; the `skills` memory slot attaches it to the
 * conversation when the turn needs it (`agent/memory/bro_skills.ts`).
 *
 * Markers are whole lines, exactly as written here, never nested:
 *
 *   <!-- skill:<name> -->        lines of skill <name>: in `full` and in its
 *   <!-- /skill -->              body, never in `core`
 *   <!-- body-only:<name> -->    lines only in the body of <name>: what the
 *   <!-- /body-only -->          body needs out of its section, such as a
 *                                pointer to another skill
 *   <!-- full-only -->           lines only in `full`: a rule the core says
 *   <!-- /full-only -->          elsewhere, or condensed
 *   <!-- core-only -->           lines only in `core`: the condensed form of
 *   <!-- /core-only -->          rules whose details moved into a skill
 *
 * <name> is one of `skillNames`. A `skill` or `body-only` marker may end in
 * a digit, its place in the body: regions sort by it (none counts as 0),
 * then in the system prompt's order, so a body reads in its own order. Any
 * line starting with `<!-- ` must be a marker: one that does not parse,
 * closes what is not open or names another skill fails the module's load,
 * and with it every turn and test that reads the instructions. Safety rules
 * stay in `core` (`tests/agent/skills/core.test.ts`).
 *
 * The task agent's text (`task-agent.md`) holds no skill and stays whole in
 * the core: its pilot reads it in the person's turns but not in a browser
 * report's, and a block must read the same in every turn of a session.
 * The rules for the person's files (`task-files.md`) are one skill instead:
 * the setup has them in every turn of a session or in none.
 *
 * Only the files below take markers: they are the interactive turn's.
 * The workers' roles (`role/scheduled-worker.md` and the rest) and
 * `agent/instructions.md`, which eve reads itself, never do.
 */

/** The skills, in the order their index lists them. */
export const skillNames = [
  "browser",
  "gov-services",
  "meter-readings",
  "recommendations",
  "google",
  "apps",
  "memory",
  "money",
  "schedules",
  "files",
  "images",
  "games",
  "about-bro",
  "first-contact",
] as const;

export type SkillName = (typeof skillNames)[number];

/**
 * What a skill is for, as the index in the core instructions names it: the
 * model calls `load_skill` by it when the block is not in the conversation.
 * First contact has no line: only the channel's marker brings it
 * (`triggers.ts`), and nothing the model reads would make it load one.
 */
export const skillUses: Partial<Record<SkillName, string>> = {
  "about-bro": "устройство, где данные, сейф, импорт паролей",
  apps: "Notion, Slack, Google Таблицы и другие приложения",
  browser:
    "купить, заказать, забронировать, записать на сайте; билеты, отели, такси, доставка; отчёт запуска",
  files: "присланные таблицы и документы, презентации, расчёты, графики",
  games: "викторины, квизы, игры",
  "gov-services": "Госуслуги, штрафы, налоги, документы, врачи",
  google: "почта, календарь, Диск, контакты, доступ Google",
  images: "картинки, фото со страницы или из письма",
  "meter-readings": "показания счётчиков, квитанции, ЖКХ",
  memory: "забыть, найти в памяти, долгие дела",
  money: "лимит трат, постоянные разрешения, итог покупки",
  recommendations: "подбор места, мастера, события или вещи под условия",
  schedules: "напоминания, повторы, наблюдение, шаг на потом",
};

/**
 * The heading of a body whose first region has none, so the block reads as
 * a section of its own.
 */
const skillTitles: Partial<Record<SkillName, string>> = {
  apps: "# Notion, Slack и другие приложения",
  browser: "# Браузерные поручения: подробно",
  google: "# Google: почта, календарь, Диск, контакты",
  images: "# Фото и вложения",
  memory: "# Память и долгие дела",
  schedules: "# Расписания",
};

/** The instruction files that take markers, in the system prompt's order. */
const sourceTexts = [
  ["execution-safety", executionSafety],
  ["autonomy", autonomy],
  ["follow-through", followThrough],
  ["role/interactive", roleInteractive],
  ["recommendations", recommendations],
  ["message-style", messageStyle],
  ["browser/available", browserAvailable],
  ["browser/unavailable", browserUnavailable],
  ["meter-readings", meterReadings],
  ["public-services", publicServices],
  ["creative/images", images],
  ["creative/images-unavailable", imagesUnavailable],
  ["creative/games", games],
  ["hard-constraints", hardConstraints],
  ["task-agent", taskAgentText],
  ["task-files", taskFilesText],
] as const;

export type InstructionSource = (typeof sourceTexts)[number][0];

/** Which way a turn reads the instructions. */
export type InstructionLayout = "core" | "full";

/**
 * What this deployment and turn have: the browser, drawing and the person's
 * files for the task agent change which files the interactive turn reads,
 * and so which skills exist (`skillSetup` in `pilot.ts`). The same in every
 * interactive turn of a session, so a block stays the same too. Plain JSON:
 * a dynamic tool keeps it in its closure.
 */
export interface SkillSetup {
  readonly browser: boolean;
  readonly images: boolean;
  /**
   * The person's files reach the task agent (`taskFilesOfCaller`); absent
   * is no, so a setup written before the flag reads as it did.
   */
  readonly taskFiles?: boolean;
}

/** Who reads a run of lines: every layout, one layout, or one skill. */
type Region =
  | { readonly kind: "core-only" | "full-only" | "shared" }
  | {
      readonly kind: "body-only" | "skill";
      readonly rank: number;
      readonly skill: SkillName;
    };

interface Segment {
  readonly region: Region;
  readonly text: string;
}

const markerLine =
  /^<!-- (?:(?<open>skill|body-only):(?<name>[a-z-]+)(?: (?<rank>\d))?|(?<close>\/skill|\/body-only|\/full-only|\/core-only)|(?<layout>core-only|full-only)) -->$/u;

function isSkillName(name: string): name is SkillName {
  return skillNames.some((skill) => skill === name);
}

/**
 * A file cut into runs of lines by its markers. Each line keeps its own
 * line break, so the runs joined back are the file without its marker lines.
 */
function segments(source: string, text: string) {
  const parsed: Segment[] = [];
  let region: Region = { kind: "shared" };
  let lines: string[] = [];
  const flush = () => {
    if (lines.length > 0) parsed.push({ region, text: lines.join("") });
    lines = [];
  };
  for (const [index, line] of (
    text.match(/[^\n]*\n|[^\n]+$/gu) ?? []
  ).entries()) {
    const content = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (!content.startsWith("<!-- ")) {
      lines.push(line);
      continue;
    }
    const where = `${source}.md, line ${String(index + 1)}`;
    const marker = markerLine.exec(content)?.groups;
    if (marker === undefined) {
      throw new Error(`Unreadable skill marker in ${where}: ${content}`);
    }
    if (marker.close !== undefined) {
      if (region.kind === "shared" || `/${region.kind}` !== marker.close) {
        throw new Error(`${marker.close} closes nothing open in ${where}.`);
      }
      flush();
      region = { kind: "shared" };
      continue;
    }
    if (region.kind !== "shared") {
      throw new Error(`A marker opens inside another region in ${where}.`);
    }
    flush();
    if (marker.layout === "core-only" || marker.layout === "full-only") {
      region = { kind: marker.layout };
      continue;
    }
    const name = marker.name ?? "";
    if (!isSkillName(name)) {
      throw new Error(`Unknown skill «${name}» in ${where}.`);
    }
    region = {
      kind: marker.open === "skill" ? "skill" : "body-only",
      rank: Number(marker.rank ?? 0),
      skill: name,
    };
  }
  if (region.kind !== "shared") {
    throw new Error(`${source}.md ends inside a ${region.kind} region.`);
  }
  flush();
  return parsed;
}

/** The files a turn reads in some of a session's turns only. */
const unevenSources = new Set<InstructionSource>(["task-agent"]);

/** A file's runs of lines, none of them a skill's where none may be. */
function checkedSegments(source: InstructionSource, text: string) {
  const parsed = segments(source, text);
  if (
    unevenSources.has(source) &&
    parsed.some(
      ({ region }) => region.kind === "skill" || region.kind === "body-only"
    )
  ) {
    throw new Error(`${source}.md may hold no skill: see the catalog.`);
  }
  return parsed;
}

// Parsed once, as the module loads: a broken marker fails at once.
const parsedSources = new Map<InstructionSource, readonly Segment[]>(
  sourceTexts.map(([source, text]) => [source, checkedSegments(source, text)])
);

function sourceSegments(source: InstructionSource) {
  return parsedSources.get(source) ?? [];
}

function readBy(region: Region, layout: InstructionLayout) {
  switch (region.kind) {
    case "shared":
      return true;
    case "skill":
    case "full-only":
      return layout === "full";
    case "core-only":
      return layout === "core";
    default:
      return false;
  }
}

/** One instruction file as a turn of this layout reads it. */
export function instructionText(
  source: InstructionSource,
  layout: InstructionLayout
) {
  const text = sourceSegments(source)
    .filter(({ region }) => readBy(region, layout))
    .map(({ text: lines }) => lines)
    .join("");
  // What the cut leaves between sections is one blank line, as in `full`.
  return layout === "core" ? text.replace(/\n{3,}/gu, "\n\n") : text;
}

/**
 * The files an interactive turn reads in this setup, in the system prompt's
 * order (as `agent/instructions/*.ts` picks them).
 */
export function interactiveSources(
  setup: SkillSetup
): readonly InstructionSource[] {
  return [
    "execution-safety",
    "autonomy",
    "follow-through",
    "role/interactive",
    "recommendations",
    "message-style",
    setup.browser ? "browser/available" : "browser/unavailable",
    "meter-readings",
    ...(setup.browser ? (["public-services"] as const) : []),
    setup.images ? "creative/images" : "creative/images-unavailable",
    "creative/games",
    "hard-constraints",
    ...(setup.taskFiles === true ? (["task-files"] as const) : []),
  ];
}

/**
 * A skill's rules: each of its regions from every file of the setup, by
 * their place in the body and then in the prompt's order, without the blank
 * lines around them, under the skill's heading when the first region has
 * none. Undefined when the setup has none, as without a browser there are
 * no errands on sites.
 */
export function skillBody(name: SkillName, setup: SkillSetup) {
  // Its lines in the autonomy and the role are about errands on a site.
  if (name === "browser" && !setup.browser) return undefined;
  const regions = interactiveSources(setup)
    .flatMap((source) =>
      sourceSegments(source).flatMap(({ region, text }) =>
        (region.kind === "skill" || region.kind === "body-only") &&
        region.skill === name
          ? [{ rank: region.rank, text: text.replace(/^\n+|\s+$/gu, "") }]
          : []
      )
    )
    .toSorted((first, second) => first.rank - second.rank)
    .map(({ text }) => text)
    .filter((text) => text.length > 0);
  const title = skillTitles[name];
  const titled =
    title !== undefined && !(regions[0] ?? "").startsWith("#")
      ? [title, ...regions]
      : regions;
  return regions.length > 0 ? titled.join("\n\n") : undefined;
}

/** The skills this setup has a body for, in the index's order. */
export function availableSkills(setup: SkillSetup) {
  return skillNames.filter((name) => skillBody(name, setup) !== undefined);
}

/** Every setup a deployment can have, for what must hold in each. */
export const skillSetups: readonly SkillSetup[] = [false, true].flatMap(
  (browser) =>
    [false, true].flatMap((drawing) =>
      [false, true].map((taskFiles) => ({
        browser,
        images: drawing,
        taskFiles,
      }))
    )
);
