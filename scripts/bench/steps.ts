import type { BenchCase } from "./cases.ts";
import { caseFixtures, type FixtureFile } from "./fixtures.ts";

/**
 * Turns a test's published script into messages the driver can send.
 *
 * Scripts are written for a human tester: «[голосовое] …» is a voice note,
 * «[3 фото: …]» stands for photos, «[ресторан]» asks the tester to name a
 * real one, «(отключить Google)» is something the tester does by hand, and
 * «T+7д, новый разговор» opens a fresh conversation a week later. The driver
 * keeps the order and the conversation breaks but not the waits.
 */

/** The transcript marker the messenger channels put before a voice note. */
const voiceMarker = "[голосовое]";

export interface PlannedStep {
  readonly at: string;
  readonly files: readonly FixtureFile[];
  /** Something the tester does by hand before this message. */
  readonly manual: string | undefined;
  readonly newConversation: boolean;
  /** The exact text sent, placeholders resolved. */
  readonly text: string;
}

export type CasePlan =
  | {
      readonly kind: "ready";
      /** Script lines the driver cannot act on, kept for the record. */
      readonly notes: readonly string[];
      readonly steps: readonly PlannedStep[];
    }
  | { readonly kind: "skipped"; readonly reason: string };

const placeholderPattern = /\[[^\]]+\]/gu;
const manualPattern = /^\(([^)]*)\)\s*/u;

export function planCase(
  benchCase: BenchCase,
  fills: ReadonlyMap<string, string>
): CasePlan {
  const notes: string[] = [];
  const steps: PlannedStep[] = [];
  const fixtures = caseFixtures.get(benchCase.id);
  const unresolved = new Set<string>();
  let pendingManual: string | undefined;

  for (const entry of benchCase.script) {
    if (entry.send === null) {
      notes.push(`${entry.at}: ${entry.note ?? "без сообщения"}`);
      continue;
    }
    let text = entry.send;
    const manual = manualPattern.exec(text);
    if (manual) {
      const action = manual[1]?.trim() ?? "";
      notes.push(`${entry.at}: вручную — ${action}`);
      pendingManual = pendingManual ? `${pendingManual}; ${action}` : action;
      text = text.slice(manual[0].length);
    }
    let files: readonly FixtureFile[] = [];
    text = text.replaceAll(placeholderPattern, (placeholder) => {
      if (placeholder === voiceMarker) return placeholder;
      const filled = fills.get(placeholder);
      if (filled !== undefined) return filled;
      if (fixtures?.placeholder === placeholder) {
        files = fixtures.files;
        return "";
      }
      unresolved.add(placeholder);
      return placeholder;
    });
    text = text.replaceAll(/\s{2,}/gu, " ").trim();
    if (text.length === 0 && files.length === 0) continue;
    steps.push({
      at: entry.at,
      files,
      manual: pendingManual,
      newConversation: steps.length > 0 && /новый разговор/iu.test(entry.at),
      text,
    });
    pendingManual = undefined;
  }

  if (unresolved.size > 0) {
    const names = [...unresolved];
    return {
      kind: "skipped",
      reason: `нужна подстановка ${names.join(", ")}: --fill '${names[0] ?? ""}=…'`,
    };
  }
  if (steps.length === 0) {
    return {
      kind: "skipped",
      reason: `в сценарии нет сообщений: ${notes.join("; ")}`,
    };
  }
  return { kind: "ready", notes, steps };
}

/** Parses `--fill '[ресторан]=Хачапури и вино'` values. */
export function parseFills(values: readonly string[]) {
  return new Map(
    values.map((value) => {
      const match = /^(\[[^\]]+\])=(.*)$/su.exec(value);
      if (!match?.[1]) {
        throw new Error(
          `--fill expects '[placeholder]=text', got ${JSON.stringify(value)}`
        );
      }
      return [match[1], match[2] ?? ""] as const;
    })
  );
}
