import type { DynamicResolveContext } from "eve";
import { z } from "zod";
import { errandAutonomyPilot } from "@agent/lib/browser-use/autonomy";
import { browserUseConfigured } from "@agent/lib/browser-use/client";
import { imageGenerationScope } from "@agent/lib/image-artifact/generation";
import { resolveModeValue } from "@agent/lib/mode";
import { backgroundActionsOfCaller } from "@agent/lib/schedules/delegation/pilot";
import { eventZoneOfCaller } from "@agent/lib/schedules/event-zone";
import { taskFilesOfCaller } from "@agent/lib/sandbox/pilot";
import { signOfCaller } from "@agent/lib/signatures/pilot";
import { env } from "@shared/environment";
import { directModelActive } from "@shared/model/provider";
import type { InstructionLayout, SkillSetup } from "./catalog";

/** What every decision here reads of a turn: who is calling. */
interface SkillsContext {
  readonly session: {
    readonly auth: DynamicResolveContext["session"]["auth"];
  };
}

/** The workspace of the turn's caller, whoever opened the turn. */
function callerWorkspace(context: SkillsContext) {
  const caller = context.session.auth.current ?? context.session.auth.initiator;
  if (caller?.principalType !== "user") return undefined;
  return z.string().min(1).safeParse(caller.attributes.workspaceId).data;
}

/** Whether a list of workspace ids or `*` names this workspace. */
function listed(list: readonly string[], workspaceId: string) {
  return list.includes("*") || list.includes(workspaceId);
}

/**
 * Whether the workspace of this turn is in the skills pilot
 * (`SKILLS_WORKSPACES`, docs/roadmap.md item 24). The same answer for every
 * kind of turn of a session — a person's, a browser report's, a schedule's
 * report — so the `skills` memory slot keeps its scope through all of them.
 * A pure read of the environment: the instructions, the slot and
 * `load_skill` must agree, and the slot's recall must replay identically.
 * Only the direct model (RouterAI or OpenRouter) defuses forged skill blocks
 * (`agent/lib/model/direct.ts`), so on the Gateway nobody is in it.
 */
export function skillsPilot(context: SkillsContext) {
  const list = env.SKILLS_WORKSPACES ?? [];
  if (list.length === 0 || !directModelActive()) return false;
  const workspaceId = callerWorkspace(context);
  return workspaceId !== undefined && listed(list, workspaceId);
}

/**
 * How this turn reads the instructions: the core in the pilot's interactive
 * turns, the full text everywhere else. Workers keep the full text in the
 * first version: nothing attaches skills to their sessions.
 */
export function skillsLayout(context: SkillsContext): InstructionLayout {
  return skillsPilot(context) &&
    resolveModeValue(context, { interactive: true }) === true
    ? "core"
    : "full";
}

/**
 * Whether the turn's workspace is in the autonomy pilot
 * (ERRAND_AUTONOMY_WORKSPACES), whose instructions and skill bodies read
 * with its edits (`autonomyEdits`) in every kind of turn.
 */
export function autonomyPilot(context: SkillsContext) {
  return errandAutonomyPilot(callerWorkspace(context));
}

/**
 * What this turn can do, and so which skills exist for it: the browser,
 * drawing and the person's files as the instructions check them
 * (`40-browser.ts`, `60-creative.ts`, `66-task-files.ts`), signing with the
 * files (`67-sign.ts`), and how the autonomy pilot reads them. Without the
 * files, signing or the pilot the setup has no `taskFiles`, `sign` or
 * `autonomy` at all, so it reads as before them.
 */
export function skillSetup(context: SkillsContext): SkillSetup {
  const setup: SkillSetup = {
    browser: browserUseConfigured(),
    images: imageGenerationScope(context) !== undefined,
  };
  const files: SkillSetup = taskFilesOfCaller(context)
    ? { ...setup, taskFiles: true }
    : setup;
  // Signing only with the files (`signEnabled` requires them).
  const withFiles: SkillSetup =
    files.taskFiles === true && signOfCaller(context)
      ? { ...files, sign: true }
      : files;
  const withAutonomy: SkillSetup = autonomyPilot(context)
    ? { ...withFiles, autonomy: true }
    : withFiles;
  // Without the pilot of schedules that act the setup reads as before it.
  const withActions: SkillSetup = backgroundActionsOfCaller(context)
    ? { ...withAutonomy, backgroundActions: true }
    : withAutonomy;
  // And so without the pilot of event zones.
  return eventZoneOfCaller(context)
    ? { ...withActions, eventZone: true }
    : withActions;
}
