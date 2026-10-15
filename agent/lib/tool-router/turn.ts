import type { ModelMessage } from "ai";
import { z } from "zod";
import {
  compactionOfTurn,
  type TurnCompaction,
} from "@agent/lib/compaction/record";
import { personMessages } from "@agent/lib/browser-use/said";
import { startsTurn } from "@agent/lib/delivery/turn-sends";
import {
  availableSkills,
  type SkillName,
  type SkillSetup,
} from "@agent/lib/skills/catalog";
import {
  loadedSkills,
  recordedSkills,
  skillStub,
} from "@agent/lib/skills/render";
import { firstContactMarked, skillsForTurn } from "@agent/lib/skills/triggers";
import { type StepIdentity, turnMemory } from "@agent/lib/turn-kind/step";
import { env } from "@shared/environment";
import { type RouterDecision, routerDecision } from "./decision";
import {
  routerCoreTool,
  routerGroupSkill,
  routerGroupsOfTool,
  routerGroupsUsedBy,
  sharedRouterTools,
  skillRouterGroups,
} from "./groups";
import { type RouterGroup, routerGroups } from "./questions";
import {
  orderedGroups,
  readRouterState,
  type RouterState,
  writeRouterState,
} from "./state";
import { routerTurnText } from "./state-string";
import { askRouterQuestions } from "./system-one";

/**
 * How long a person's first step waits for the decision: TypeSafe answers
 * in 0.1 s, RouterAI's Jev 1.13 in 0.5–0.7 s (p95) and 1.4–1.7 s at worst
 * (15.10, from a container). Past it the turn sees every group.
 */
const routerWaitMs = 1500;

/**
 * How long a later step waits for the decision about words the person
 * added mid-turn; past it the decision joins at the next step.
 */
const steerWaitMs = 300;

/** Why a step has the set it has. */
type RouterReason =
  | "covered"
  | "decided"
  | "failed"
  | "media-blind"
  | "pending"
  | "reused"
  | "steer"
  | "turn"
  | "unreadable";

/** What the router knows of a step, read before it decides. */
export interface RouterInputs {
  /** What eve's compaction did to the turn; undefined when unknown. */
  readonly compaction: TurnCompaction | undefined;
  /** The digest of the turn's state string (`routerTurnText`). */
  readonly digest: string;
  /** The turn's set as this instance holds it, when its state was lost. */
  readonly held: TurnRoute | undefined;
  /** A decision of this turn that came after its step asked. */
  readonly late: LateDecision | undefined;
  /**
   * The turn carries the location pilot's marker of a point, or the
   * person's words speak of where they are or of a place-bound reminder.
   */
  readonly located: boolean;
  /** A photo or a file with no words of the person's. */
  readonly mediaOnly: boolean;
  readonly now: number;
  /** Groups `open_tools` and `load_skill` opened in this turn. */
  readonly opened: readonly RouterGroup[];
  readonly recentMs: number;
  readonly state: RouterState;
  readonly step: StepIdentity;
  /** The skills the turn's words and Bro's last message want. */
  readonly triggered: readonly SkillName[];
  readonly warmMs: number;
  /** Bro wrote to the person before this turn. */
  readonly withPrev: boolean;
}

/** A turn's set on this instance. */
interface TurnRoute {
  readonly digest: string;
  readonly failedOpen: boolean;
  readonly groups: readonly RouterGroup[];
}

/** A decision the step did not wait for, and what it came to. */
interface LateDecision {
  readonly kind: "steer" | "turn";
  settled?: RouterDecision;
}

/** What a step's set came to, and the state that records it. */
interface RouterOutcome {
  readonly blockChanged: boolean;
  readonly decided: readonly RouterGroup[] | undefined;
  readonly groups: readonly RouterGroup[];
  /** Groups of the triggered skills the decision left out of the set. */
  readonly narrowed: readonly RouterGroup[];
  readonly reason: RouterReason;
  readonly recent: readonly RouterGroup[];
  readonly state: RouterState;
  readonly warm: boolean;
}

/** A step's choice: whether it needs the decision model, and the outcome. */
interface RouterChoice {
  readonly ask: "steer" | "turn" | undefined;
  /** The outcome with the decision, or without one (late or not asked). */
  readonly finish: (decision: RouterDecision | undefined) => RouterOutcome;
}

const everyGroup: readonly RouterGroup[] = routerGroups;

function decidedGroups(decision: RouterDecision | undefined) {
  return decision !== undefined && "groups" in decision
    ? decision.groups
    : undefined;
}

/**
 * The groups the triggered skills bring (`T`). Given the decision's groups,
 * a skill of several groups brings only those of them the decision chose
 * too, and all of them when it chose none: «что у меня в календаре» wants
 * the google skill, but not its mail and Drive. A skill of one group, and
 * the first contact, whose offers (a call, Yandex, Google) come in the
 * turns after it, always bring all of theirs.
 */
function triggerGroups(
  skills: readonly SkillName[],
  decided?: readonly RouterGroup[]
) {
  const all = skills.flatMap(
    (skill): readonly RouterGroup[] => skillRouterGroups[skill]
  );
  if (decided === undefined) return { dropped: [], groups: all };
  const groups = skills.flatMap((skill): readonly RouterGroup[] => {
    const own: readonly RouterGroup[] = skillRouterGroups[skill];
    if (own.length < 2 || skill === "first-contact") return own;
    const chosen = own.filter((group) => decided.includes(group));
    return chosen.length === 0 ? own : chosen;
  });
  return {
    dropped: all.filter((group) => !groups.includes(group)),
    groups,
  };
}

function sameSet(
  first: readonly RouterGroup[] | null | undefined,
  second: readonly RouterGroup[]
) {
  return (
    first !== null &&
    first !== undefined &&
    first.length === second.length &&
    first.every((group) => second.includes(group))
  );
}

/**
 * The groups of a person's step (docs/dev-notes.md, «Роутер инструментов»):
 *
 * - `D`, the decision model's choice; `T`, the groups of the skills the
 *   turn's words and Bro's last message want, narrowed by `D` when there is
 *   one (`triggerGroups`); `R`, the groups whose tools were called within
 *   `recentMs`; `L`, `places` for a point the person sent or for words of
 *   where they are; `O`, what `open_tools` and `load_skill` opened.
 * - A new turn within the warm window starts from the set the last decided
 *   turn had (`carried`): a set that only grows keeps the cached prefix
 *   (the tool block comes before the history). Past it, from nothing.
 * - A new turn with the same state string as the turn before (an
 *   approval's answer, a first step run again) keeps that turn's set
 *   without asking; one compacted inside, whose words cannot be read,
 *   keeps the carried set and the recent groups (every group when none);
 *   one whose signals already cover every group, or a bare photo with no
 *   message of Bro's before it, sees every group without asking.
 * - A later step of the turn keeps its set and adds `O`, and the words the
 *   person added mid-turn (only when the turn was never compacted).
 * - A failed decision opens every group for the turn, but is no base for
 *   the next: `carried` stays.
 */
export function chooseRouterGroups(inputs: RouterInputs): RouterChoice {
  const { now, state, step } = inputs;
  const usedRecently = (time: string | undefined) => {
    if (time === undefined) return false;
    const at = Date.parse(time);
    return Number.isFinite(at) && now - at <= inputs.recentMs;
  };
  const recent = routerGroups.filter((group) =>
    usedRecently(state.usedAt[group])
  );
  const lastStep =
    state.lastStepAt === null ? Number.NaN : Date.parse(state.lastStepAt);
  const warm = Number.isFinite(lastStep) && now - lastStep < inputs.warmMs;
  // The signals but `T`, which the decision narrows.
  const untriggered = [
    ...recent,
    ...(inputs.located ? (["places"] as const) : []),
    ...inputs.opened,
  ];
  const signals = [...triggerGroups(inputs.triggered).groups, ...untriggered];
  const turnSet =
    inputs.held?.groups ??
    (state.turnId !== null && state.turnId === step.turnId
      ? state.turnGroups
      : null);
  const previousBlock = turnSet ?? state.turnGroups;

  const outcome = (
    groups: Iterable<RouterGroup>,
    details: {
      readonly carried?: readonly RouterGroup[];
      readonly decided?: readonly RouterGroup[];
      readonly dropped?: readonly RouterGroup[];
      readonly failedOpen: boolean;
      readonly reason: RouterReason;
      readonly newTurn: boolean;
    }
  ): RouterOutcome => {
    const ordered = orderedGroups(groups);
    return {
      blockChanged: !sameSet(previousBlock, ordered),
      decided: details.decided,
      groups: ordered,
      narrowed: orderedGroups(details.dropped ?? []).filter(
        (group) => !ordered.includes(group)
      ),
      reason: details.reason,
      recent,
      state: {
        ...state,
        called: details.newTurn ? [] : state.called,
        carried: details.carried
          ? orderedGroups(details.carried)
          : state.carried,
        failedOpen: details.failedOpen,
        lastStepAt: new Date(now).toISOString(),
        turnDigest: inputs.digest,
        turnGroups: ordered,
        turnId: step.turnId ?? null,
      },
      warm,
    };
  };

  if (step.stepIndex !== undefined && step.stepIndex > 0 && turnSet !== null) {
    let failedOpen = inputs.held?.failedOpen ?? state.failedOpen;
    let groups = [...turnSet, ...inputs.opened];
    let decided: readonly RouterGroup[] | undefined;
    const late = inputs.late?.settled;
    if (late !== undefined) {
      const lateGroups = decidedGroups(late);
      if (lateGroups !== undefined) {
        groups = [...groups, ...lateGroups];
        decided = lateGroups;
        if (inputs.late?.kind === "turn") failedOpen = false;
      } else if (inputs.late?.kind === "turn") {
        groups = [...everyGroup];
        failedOpen = true;
      }
    }
    const turnDigest = inputs.held?.digest ?? state.turnDigest;
    // The person wrote again mid-turn: their new words join at once, and
    // the decision about them when it comes. After a compaction the words
    // of the turn are not to be trusted to be new.
    const steer = inputs.compaction === "none" && turnDigest !== inputs.digest;
    const finish = (decision: RouterDecision | undefined) => {
      const steered = decidedGroups(decision);
      const triggers = steer
        ? triggerGroups(inputs.triggered, steered)
        : { dropped: [], groups: [] };
      const all = [
        ...groups,
        ...(steer ? [...triggers.groups, ...untriggered] : []),
        ...(steered ?? []),
      ];
      return outcome(all, {
        carried: failedOpen ? undefined : all,
        decided: steered ?? decided,
        dropped: triggers.dropped,
        failedOpen,
        newTurn: false,
        reason: steer ? "steer" : "turn",
      });
    };
    return { ask: steer ? "steer" : undefined, finish };
  }

  const settledWithout = (
    groups: Iterable<RouterGroup>,
    reason: RouterReason,
    options: {
      readonly carried?: readonly RouterGroup[];
      readonly failedOpen: boolean;
    }
  ): RouterChoice => ({
    ask: undefined,
    finish: () =>
      outcome(groups, {
        carried: options.carried,
        failedOpen: options.failedOpen,
        newTurn: true,
        reason,
      }),
  });

  if (state.turnDigest === inputs.digest && state.turnGroups !== null) {
    return settledWithout(
      [...state.turnGroups, ...recent, ...inputs.opened],
      "reused",
      { failedOpen: state.failedOpen }
    );
  }
  if (inputs.compaction === "inside") {
    const kept = orderedGroups([...state.carried, ...recent, ...inputs.opened]);
    return kept.length === 0
      ? settledWithout(everyGroup, "unreadable", { failedOpen: true })
      : settledWithout(kept, "unreadable", { failedOpen: false });
  }
  const base = warm ? state.carried : [];
  const known = orderedGroups([...base, ...signals]);
  if (known.length === everyGroup.length) {
    return settledWithout(known, "covered", {
      carried: known,
      failedOpen: false,
    });
  }
  if (inputs.mediaOnly && !inputs.withPrev) {
    return settledWithout(everyGroup, "media-blind", { failedOpen: false });
  }
  const media = inputs.mediaOnly ? (["files"] as const) : [];
  return {
    ask: "turn",
    finish: (decision) => {
      if (decision === undefined) {
        return outcome([...known, ...media], {
          failedOpen: false,
          newTurn: true,
          reason: "pending",
        });
      }
      const groups = decidedGroups(decision);
      if (groups === undefined) {
        return outcome(everyGroup, {
          failedOpen: true,
          newTurn: true,
          reason: "failed",
        });
      }
      const triggers = triggerGroups(inputs.triggered, groups);
      const all = [
        ...base,
        ...triggers.groups,
        ...untriggered,
        ...groups,
        ...media,
      ];
      return outcome(all, {
        carried: all,
        decided: groups,
        dropped: triggers.dropped,
        failedOpen: false,
        newTurn: true,
        reason: "decided",
      });
    },
  };
}

/** Each turn's set on this instance, and a decision it did not wait for. */
const turnRoutes = turnMemory<
  TurnRoute & { readonly late: LateDecision | undefined }
>();

const toolCallSchema = z.object({
  input: z.unknown(),
  toolName: z.string(),
  type: z.literal("tool-call"),
});

const sentTextSchema = z.object({ text: z.string() });

const openedSchema = z.object({ opened: z.array(z.enum(routerGroups)) });

const openToolsOutputSchema = z.union([
  z.object({ type: z.literal("json"), value: openedSchema }),
  z.object({
    type: z.literal("text"),
    value: z.string().transform((value, context) => {
      try {
        return openedSchema.parse(JSON.parse(value));
      } catch {
        context.addIssue({ code: "custom", message: "Not JSON." });
        return z.NEVER;
      }
    }),
  }),
]);

const toolResultSchema = z.object({
  output: z.unknown(),
  toolName: z.string(),
  type: z.literal("tool-result"),
});

/** The groups of a skill, by name. */
function groupsOfSkills(skills: readonly SkillName[]) {
  return skills.flatMap((skill) => skillRouterGroups[skill]);
}

/**
 * What `open_tools` and `load_skill` opened in the current turn, and in the
 * step before it when the person wrote again after that step's results (a
 * steer, or a new turn): the step's set was recorded before its call, and
 * the tool promised the group from the next step.
 */
function openedGroups(messages: readonly ModelMessage[], setup: SkillSetup) {
  const opening = messages.findLastIndex(startsTurn);
  const lastStep = messages.findLastIndex(
    (message) => message.role === "assistant"
  );
  const turn = messages.slice(
    lastStep !== -1 && lastStep < opening ? lastStep + 1 : opening + 1
  );
  const opened = turn.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => {
          const result = toolResultSchema.safeParse(part).data;
          if (result?.toolName !== "open_tools") return [];
          return (
            openToolsOutputSchema.safeParse(result.output).data?.value.opened ??
            []
          );
        })
      : []
  );
  return orderedGroups([
    ...opened,
    ...groupsOfSkills(loadedSkills(turn, setup)),
  ]);
}

/** The tool calls of the latest assistant message: the step before. */
function lastStepCalls(messages: readonly ModelMessage[]) {
  const last = messages.findLast((message) => message.role === "assistant");
  if (last === undefined || !Array.isArray(last.content)) return [];
  return last.content.flatMap(
    (part) => toolCallSchema.safeParse(part).data ?? []
  );
}

/** What Bro tells the person when it holds no tool for the request. */
const cannotPattern =
  /не могу|нет доступа|нет (?:такого )?инструмента|не умею|не получится/iu;

/**
 * What a step of any turn of a workspace in the pilot tells the router,
 * before the step chooses its set: the tools the step before called mark
 * their groups as used (`R`), but for those shared by groups, which tell
 * nothing of which one was needed. In a turn of the router's they count
 * towards its result, and a call of a tool outside its set — the model
 * called it by name — is logged (`hidden-call`), as is a message that says
 * Bro cannot (`cannot`). At a new turn the result of the router's last turn
 * is logged: the groups it called against the set it had. Never throws.
 */
export function stampRouterUse(
  messages: readonly ModelMessage[],
  step: StepIdentity,
  mode: "on" | "shadow"
) {
  try {
    const state = readRouterState();
    const now = new Date().toISOString();
    let next = state;
    const ownTurn = state.turnId !== null && state.turnId === step.turnId;
    // A step that is not the turn's own: the router's last turn is over.
    if (!ownTurn && state.called !== null && state.turnGroups !== null) {
      const missed = state.called.filter(
        (group) => !state.turnGroups?.includes(group)
      );
      console.info(
        mode === "shadow"
          ? "[tool-router] shadow-result"
          : "[tool-router] result",
        {
          called: state.called,
          groups: state.turnGroups,
          missed,
          turnId: state.turnId,
        }
      );
      next = { ...next, called: null };
    }
    const calls = lastStepCalls(messages);
    const turnSet =
      turnRoutes.get(step)?.groups ?? (ownTurn ? state.turnGroups : null);
    const usedAt = { ...next.usedAt };
    const called = new Set(next.called ?? []);
    for (const call of calls) {
      const groups = routerGroupsOfTool(call.toolName);
      if (!sharedRouterTools.has(call.toolName)) {
        for (const group of routerGroupsUsedBy(call.toolName)) {
          usedAt[group] = now;
        }
      }
      if (!ownTurn || turnSet === null) continue;
      for (const group of groups) called.add(group);
      if (
        mode === "on" &&
        groups.length > 0 &&
        !routerCoreTool(call.toolName) &&
        !groups.some((group) => turnSet.includes(group))
      ) {
        console.info("[tool-router] hidden-call", {
          groups,
          tool: call.toolName,
          turnId: step.turnId,
        });
      }
      if (
        mode === "on" &&
        call.toolName === "send_message" &&
        turnSet.length < everyGroup.length &&
        cannotPattern.test(
          sentTextSchema.safeParse(call.input).data?.text ?? ""
        )
      ) {
        console.info("[tool-router] cannot", {
          groups: turnSet,
          turnId: step.turnId,
        });
      }
    }
    next = {
      ...next,
      called:
        ownTurn && next.called !== null ? orderedGroups(called) : next.called,
      usedAt,
    };
    if (JSON.stringify(next) !== JSON.stringify(state)) writeRouterState(next);
  } catch (error) {
    console.warn("[tool-router] use not stamped", {
      cause: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** A decision that settles into `late` once it comes. */
function lateDecision(
  kind: LateDecision["kind"],
  asking: Promise<RouterDecision>
): LateDecision {
  const late: LateDecision = { kind };
  void asking.then((decision) => {
    late.settled = decision;
    return decision;
  });
  return late;
}

/** The decision, or undefined when it did not come within `ms`. */
async function within(asking: Promise<RouterDecision>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([asking, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The groups of a person's step in the pilot of the tool router, and
 * the log line of the choice. In `on` its first step waits for the
 * decision (at most `routerWaitMs`); in `shadow` nothing waits: the
 * decision joins the turn's recorded set at a later step and is logged
 * when it comes (`shadow-decision`), and the step's tools stay as they
 * were. Without a turn id (a test, the measurement script) nothing is
 * recorded.
 */
export async function routerGroupsOfStep(
  messages: readonly ModelMessage[],
  step: StepIdentity,
  setup: SkillSetup,
  mode: "on" | "shadow"
): Promise<readonly RouterGroup[]> {
  const started = Date.now();
  const state = readRouterState();
  const held = turnRoutes.get(step);
  const text = routerTurnText(messages);
  // The first contact's offers (a call, Yandex, Google) come in the turns
  // after it, whose own input has no marker: its groups stay while the
  // skill's rules do, for the person's first three messages.
  const introducing =
    firstContactMarked(messages) && personMessages(messages).length <= 3;
  const triggered = [
    ...new Set<SkillName>([
      ...skillsForTurn({
        browserReport: false,
        history: text.prevCall === undefined ? [] : [text.prevCall],
        input: [
          ...text.input,
          ...text.answers.map((answer): ModelMessage => ({
            content: answer,
            role: "user",
          })),
        ],
      }),
      ...(introducing ? (["first-contact"] as const) : []),
    ]),
  ];
  const opened = openedGroups(messages, setup);
  const late = held?.late;
  const choice = chooseRouterGroups({
    compaction: compactionOfTurn(step.turnId, messages)?.compaction,
    digest: text.digest,
    held,
    late: late?.settled === undefined ? undefined : late,
    located: text.located,
    mediaOnly: text.mediaOnly,
    now: started,
    opened,
    recentMs: env.TOOL_ROUTER_RECENT_MINUTES * 60_000,
    state,
    step,
    triggered,
    warmMs: env.TOOL_ROUTER_WARM_MINUTES * 60_000,
    withPrev: text.withPrev,
  });
  let decision: RouterDecision | undefined;
  let pending: LateDecision | undefined =
    late?.settled === undefined ? late : undefined;
  if (choice.ask !== undefined) {
    const asking = askRouterQuestions(text.state, routerWaitMs).then(
      routerDecision
    );
    if (mode === "on" && choice.ask === "turn") {
      decision = await asking;
    } else {
      decision = mode === "on" ? await within(asking, steerWaitMs) : undefined;
      if (decision === undefined) {
        pending = lateDecision(choice.ask, asking);
        if (mode === "shadow") {
          const turnId = step.turnId;
          void asking.then((settled) => {
            console.info("[tool-router] shadow-decision", {
              decided: decidedGroups(settled),
              failure: "failure" in settled ? settled.failure : undefined,
              model: "model" in settled ? settled.model : undefined,
              ms: settled.ms,
              // What `on` would have hidden of the skills' groups: the
              // shadow set keeps them all, so its `missed` cannot see it.
              narrowed: choice.finish(settled).narrowed,
              provider: "provider" in settled ? settled.provider : undefined,
              turnId,
            });
            return settled;
          });
        }
      }
    }
  }
  const outcome = choice.finish(decision);
  turnRoutes.set(step, {
    digest: text.digest,
    failedOpen: outcome.state.failedOpen,
    groups: outcome.groups,
    late: pending,
  });
  if (step.turnId !== undefined) writeRouterState(outcome.state);
  console.info("[tool-router]", {
    blockChanged: outcome.blockChanged,
    decided: outcome.decided,
    failure:
      decision !== undefined && "failure" in decision
        ? decision.failure
        : undefined,
    groups: outcome.groups,
    inputTokens:
      decision !== undefined && "groups" in decision
        ? decision.inputTokens
        : undefined,
    mode,
    model: decision?.model,
    ms: decision?.ms,
    narrowed: outcome.narrowed,
    opened,
    outputTokens:
      decision !== undefined && "groups" in decision
        ? decision.outputTokens
        : undefined,
    probabilities:
      decision !== undefined && "groups" in decision
        ? decision.probabilities
        : undefined,
    provider:
      decision !== undefined && "groups" in decision
        ? decision.provider
        : undefined,
    reason: outcome.reason,
    recent: outcome.recent,
    step: step.stepIndex,
    triggers: orderedGroups(groupsOfSkills(triggered)),
    turnId: step.turnId,
    waitMs: Date.now() - started,
    warm: outcome.warm,
  });
  return outcome.groups;
}

/**
 * The step's note when a group is open without its skill's rules: the
 * short descriptions of its tools point to a block the `skills` slot
 * attaches only by its own triggers at the turn's start. Undefined when
 * every open group has its block.
 */
export function routerSkillNote(
  groups: readonly RouterGroup[],
  messages: readonly ModelMessage[],
  setup: SkillSetup
) {
  const available = availableSkills(setup);
  const attached = new Set<SkillName>(loadedSkills(messages, setup));
  for (const [name, text] of recordedSkills(messages)) {
    if (text !== skillStub(name)) attached.add(name);
  }
  const wanting = new Map<SkillName, RouterGroup[]>();
  for (const group of groups) {
    const skill = routerGroupSkill[group];
    if (skill === undefined || attached.has(skill)) continue;
    if (!available.includes(skill)) continue;
    wanting.set(skill, [...(wanting.get(skill) ?? []), group]);
  }
  if (wanting.size === 0) return undefined;
  return [...wanting]
    .map(
      ([skill, wanted]) =>
        `Инструменты групп ${wanted.join(", ")} открыты без своих правил: перед первым вызовом — load_skill ${skill}.`
    )
    .join("\n");
}
