"use client";

import { useState } from "react";
import type { appRouter } from "@web/trpc/router";
import { api } from "@web/trpc/client";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import {
  formatDuration,
  formatMoment,
  formatRub,
} from "../../_components/format";

type Turn = Awaited<
  ReturnType<ReturnType<typeof appRouter.createCaller>["admin"]["turns"]>
>["turns"][number];

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
    <li className="min-w-0 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]">
      <Collapsible onOpenChange={setOpen} open={open}>
        <CollapsibleTrigger className="type-row min-h-11 w-full min-w-0 cursor-pointer text-left wrap-break-word">
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
        </CollapsibleTrigger>
        <CollapsibleContent className="type-fine my-1 min-w-0 rounded-2xl bg-muted px-4 py-3 wrap-break-word">
          {!textsOn ? (
            <p className="text-muted-foreground">Тексты выключены.</p>
          ) : transcript.isPending ? (
            <p className="text-muted-foreground">Загружаю…</p>
          ) : transcript.error ? (
            <p className="text-muted-foreground">Не удалось загрузить.</p>
          ) : transcript.data.length === 0 ? (
            <p className="text-muted-foreground">Текстов этого хода нет.</p>
          ) : (
            transcript.data.map((entry) => (
              <p className="mt-1 whitespace-pre-wrap" key={entry.id}>
                <span className="type-status text-muted-foreground">
                  {entry.role}
                  {entry.toolName ? ` ${entry.toolName}` : ""}:{" "}
                </span>
                {entry.text}
              </p>
            ))
          )}
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
