"use client";

import { useState } from "react";
import type { appRouter } from "@web/trpc/router";
import { api } from "@web/trpc/client";
import {
  formatDuration,
  formatMoment,
  formatRub,
} from "../../_components/format";

type Turn = Awaited<
  ReturnType<ReturnType<typeof appRouter.createCaller>["admin"]["turns"]>
>[number];

/** One turn; its text is fetched only when the row is opened. */
export function TurnRow({
  textsOn,
  turn,
}: {
  readonly textsOn: boolean;
  readonly turn: Turn;
}) {
  const [open, setOpen] = useState(false);
  const transcript = api.admin.transcript.useQuery(
    { turnLogId: turn.id },
    { enabled: open && textsOn }
  );
  const failed = turn.outcome === "failed";

  return (
    <li className="flex min-w-0 flex-col gap-1 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]">
      <button
        aria-expanded={open}
        className="type-row min-w-0 text-left wrap-break-word"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <span className="type-status text-muted-foreground">
          {formatMoment(turn.startedAt)} · {turn.channel} · {turn.kind} ·{" "}
          {formatDuration(turn.durationMs)} · {formatRub(turn.costRub)}
        </span>
        <br />
        <span className={failed ? "font-medium" : undefined}>
          {turn.outcome}
          {turn.errorCode ? ` · ${turn.errorCode}` : ""}
          {turn.tools.length > 0 ? ` · ${turn.tools.join(", ")}` : ""}
        </span>
      </button>
      {open ? (
        <div className="type-fine min-w-0 wrap-break-word">
          {!textsOn ? (
            <p className="text-muted-foreground">Тексты выключены.</p>
          ) : transcript.isPending ? (
            <p className="text-muted-foreground">Загружаю…</p>
          ) : transcript.error ? (
            <p className="text-muted-foreground">Не удалось загрузить.</p>
          ) : transcript.data.length === 0 ? (
            <p className="text-muted-foreground">Текстов этого хода нет.</p>
          ) : (
            transcript.data.map((entry, index) => (
              <p
                className="mt-1 whitespace-pre-wrap"
                key={`${entry.createdAt}:${entry.role}:${String(index)}`}
              >
                <span className="type-status text-muted-foreground">
                  {entry.role}
                  {entry.toolName ? ` ${entry.toolName}` : ""}:{" "}
                </span>
                {entry.text}
              </p>
            ))
          )}
        </div>
      ) : null}
    </li>
  );
}
