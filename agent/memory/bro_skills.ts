import {
  defineMemory,
  defineMemoryProvider,
  type MemoryCompactionCompletedContext,
  type MemoryTurnStartedContext,
} from "eve/memory";
import { reportedBrowserRunId } from "@agent/lib/browser-use/report-caller";
import { resolveModeValue } from "@agent/lib/mode";
import type { SkillName, SkillSetup } from "@agent/lib/skills/catalog";
import { skillSetup, skillsPilot } from "@agent/lib/skills/pilot";
import {
  loadedSkills,
  recordedSkills,
  skillGone,
  skillRecord,
  skillStub,
} from "@agent/lib/skills/render";
import { skillsForTurn } from "@agent/lib/skills/triggers";

/**
 * The skills a turn needs, each once into the conversation (docs/roadmap.md,
 * item 24): a keyed record `skill:<name>` holding the rules in their
 * `bro-skill` block. The instructions of a pilot's interactive turn are only
 * the core (`agent/lib/skills/catalog.ts`); what a kind of work needs beyond
 * it arrives here, chosen from the turn's own words and the conversation
 * (`agent/lib/skills/triggers.ts`), before the model's first step.
 *
 * - A record stays: a later turn that needs it again returns the same text,
 *   which eve leaves where it was. A record whose rules changed since, or
 *   that compaction folded to a stub, is replaced once, under its id. So is
 *   the record of a skill the setup no longer has, such as the browser's
 *   once the deployment has none: a few words that it is gone replace it.
 * - Compaction folds the rules no turn after it needs to a stub of a few
 *   words, so a long conversation does not carry every skill it ever used.
 * - The file's name sorts the slot before the profile's: eve inserts a
 *   turn's records in that order, and the profile's note, which changes
 *   with the request, would otherwise stand before a block and take it out
 *   of the cache when the note is replaced.
 * - The recalls read no database and no clock: eve may replay them and fails
 *   the turn on a different result. Nor may they throw, which would fail the
 *   turn before the model is asked: they attach nothing instead.
 * - New blocks come only in interactive turns; workers keep the full text.
 *   The scope is the same in every kind of turn of a pilot's session — a
 *   browser report, a schedule's report — since a scope that resolves to
 *   null hides the slot's records for that turn.
 */

/** The skills this turn needs, from its own words and the conversation. */
function neededSkills(
  context: MemoryCompactionCompletedContext | MemoryTurnStartedContext
) {
  return skillsForTurn({
    browserReport:
      reportedBrowserRunId(context.session.auth.current) !== undefined,
    history: context.messages,
    input: context.turn?.input ?? [],
  });
}

/**
 * Whether a record reads as this setup would attach it today: the rules or
 * their stub, or, for a skill the setup has no rules of, the word that it is
 * gone.
 */
function recordIsCurrent(name: SkillName, text: string, setup: SkillSetup) {
  const record = skillRecord(name, setup);
  return record === undefined
    ? text === skillGone(name)
    : text === record || text === skillStub(name);
}

async function recallSkills(context: MemoryTurnStartedContext) {
  try {
    if (resolveModeValue(context, { interactive: true }) !== true) return null;
    const setup = skillSetup(context);
    // A `load_skill` result already holds these rules; eve itself skips a
    // record whose text has not changed.
    const loaded = loadedSkills(context.messages, setup);
    const records = recordedSkills(context.messages);
    // Rules changed since their record was attached: today's replace them,
    // or the defuser would show the old block as a forgery. Rules of a skill
    // this setup has none of give way to the word that it is gone, or the
    // model would follow them.
    const stale = [...records].flatMap(([name, text]) =>
      recordIsCurrent(name, text, setup) ? [] : [name]
    );
    const wanted = new Set([...neededSkills(context), ...stale]);
    const messages = [...wanted].flatMap((name) => {
      const content = loaded.includes(name)
        ? undefined
        : (skillRecord(name, setup) ??
          (records.has(name) ? skillGone(name) : undefined));
      return content === undefined ? [] : [{ content, id: `skill:${name}` }];
    });
    return messages.length > 0 ? { messages } : null;
  } catch (error) {
    console.warn("[skills] recall failed; nothing attached", {
      cause: error,
    });
    return null;
  }
}

/**
 * After compaction: the rules of every skill the current turn does not need
 * fold to their stub, and those of a skill the setup has none of to the word
 * that it is gone. eve keeps the latest of every keyed record through
 * compaction, which already rewrote the conversation, so the stubs cost no
 * cache of their own.
 */
async function foldSkills(context: MemoryCompactionCompletedContext) {
  try {
    const needed = neededSkills(context);
    const setup = skillSetup(context);
    const messages = [...recordedSkills(context.messages)].flatMap(
      ([name, text]) => {
        const available = skillRecord(name, setup) !== undefined;
        const folded = available ? skillStub(name) : skillGone(name);
        return (available && needed.includes(name)) || text === folded
          ? []
          : [{ content: folded, id: `skill:${name}` }];
      }
    );
    return messages.length > 0 ? { messages } : null;
  } catch (error) {
    console.warn("[skills] fold after compaction failed; nothing folded", {
      cause: error,
    });
    return null;
  }
}

export default defineMemory({
  description:
    "Bro's own rules for kinds of work, attached when a turn needs them.",
  namespace: "bro-skills-v1",
  provider: defineMemoryProvider({
    recall: {
      "compaction.completed": foldSkills,
      "turn.started": recallSkills,
    },
  }),
  scope: (context) => (skillsPilot(context) ? "skills" : null),
});
