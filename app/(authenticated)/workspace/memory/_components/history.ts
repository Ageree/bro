import type { listMemoryTimeline } from "@db/services/memory/revisions";

type HistoryEntry = Awaited<ReturnType<typeof listMemoryTimeline>>[number];

const actions: Record<HistoryEntry["action"], string> = {
  correct: "исправлено сводкой",
  expire: "истёк срок",
  forget: "забыто",
  import: "перенесено",
  merge: "объединено сводкой",
  one_off: "убрано сводкой как разовое",
  purge: "вычищен код",
  restore: "возвращено",
  save: "сохранено",
  update: "изменено",
};

const actors: Record<HistoryEntry["actor"], string> = {
  digest: "сводка",
  model: "Бро",
  person: "ты",
  system: "Бро",
};

/** «02.10, 14:05 · изменено · ты» on the person's own clock. */
export function historyLine(entry: HistoryEntry, timeZone: string) {
  const at = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    timeZone,
  }).format(new Date(entry.at));
  const who =
    entry.action === "merge" ||
    entry.action === "correct" ||
    entry.action === "one_off" ||
    entry.action === "purge"
      ? ""
      : ` · ${actors[entry.actor]}`;
  return `${at} · ${actions[entry.action]}${who}`;
}

/** Removals leave no text of their own: the revision before keeps it. */
const removals = new Set<HistoryEntry["action"]>([
  "correct",
  "expire",
  "forget",
  "merge",
  "one_off",
  "purge",
]);

/** What a revision said, or why it says nothing. */
export function historyText(entry: HistoryEntry) {
  if (entry.text !== null) return entry.text;
  return removals.has(entry.action) ? null : "Текст стёрт.";
}
