import type { MessageStreamEvent } from "eve/client";
import { ChevronRightIcon } from "lucide-react";
import {
  getSubagentTask,
  type SubagentSession,
  type SubagentStatus,
} from "@app/_lib/subagent-sessions";
import { formatChatUsage } from "@app/(authenticated)/chat/_lib/chat-usage";
import { Button } from "@web/components/ui/button";
import { Card, CardContent } from "@web/components/ui/card";
import { Field } from "@web/components/ui/field";
import { Switch } from "@web/components/ui/switch";
import type { ChatUsage } from "@shared/chat/schema";
import type { TraceView } from "../../_lib/trace-view";
import { agentLabel, StatusIndicator, statusLabel } from "./presentation";

export function ActivityCard({
  doneCount,
  eventsBySession,
  onSelect,
  onTraceViewChange,
  sessions,
  statuses,
  traceView,
  usage,
  workingCount,
}: {
  readonly doneCount: number;
  readonly eventsBySession: ReadonlyMap<string, readonly MessageStreamEvent[]>;
  readonly onSelect: (sessionId: string) => void;
  readonly onTraceViewChange: (view: TraceView) => void;
  readonly sessions: readonly SubagentSession[];
  readonly statuses: ReadonlyMap<string, SubagentStatus>;
  readonly traceView: TraceView;
  readonly usage: ChatUsage;
  readonly workingCount: number;
}) {
  return (
    <Card
      className="max-h-full w-full gap-0 overflow-hidden rounded-none ring-border"
      size="sm"
    >
      <CardContent className="min-h-0 overflow-y-auto">
        <p className="type-caption text-muted-foreground">Активность</p>
        <div className="mt-3 space-y-2">
          <Field orientation="horizontal">
            <label
              className="type-supporting-body flex-1"
              htmlFor="show-full-trace"
            >
              <span className="font-[300]">Полная трассировка</span>
            </label>
            <Switch
              checked={traceView === "trace"}
              id="show-full-trace"
              onCheckedChange={(checked) => {
                onTraceViewChange(checked ? "trace" : "imessage");
              }}
            />
          </Field>
          <div className="flex items-center gap-4">
            <span className="type-supporting-body">
              <span className="font-[300]">Расход</span>
            </span>
            <span className="ml-auto type-caption text-muted-foreground tabular-nums">
              {formatChatUsage(usage)}
            </span>
          </div>
        </div>

        <section className="mt-4 border-t pt-4">
          <h2 className="type-caption text-muted-foreground">Задачи</h2>
          {sessions.length === 0 ? (
            <p className="type-supporting-body mt-2 text-muted-foreground">
              Пока нет задач
            </p>
          ) : (
            <>
              <div className="type-supporting-body mt-2 flex items-center gap-3 pb-2 tabular-nums">
                <span>{workingCount} в работе</span>
                <span className="ml-auto text-muted-foreground">
                  {doneCount} готово
                </span>
              </div>
              <div>
                {sessions.map((session) => {
                  const status =
                    statuses.get(session.childSessionId) ?? "starting";
                  const task =
                    getSubagentTask(
                      eventsBySession.get(session.childSessionId) ?? []
                    ) ?? session.task;
                  return (
                    <Button
                      aria-label={`Задача ${agentLabel(session.name)}, ${statusLabel(status)}`}
                      className="rounded-none p-3"
                      data-task-session={session.childSessionId}
                      key={session.childSessionId}
                      onClick={() => {
                        onSelect(session.childSessionId);
                      }}
                      type="button"
                      variant="surface"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="type-supporting-body block truncate">
                          {agentLabel(session.name)}
                        </span>
                        <span className="block truncate type-caption text-muted-foreground">
                          {task ?? "Открой, чтобы увидеть задачу"}
                        </span>
                      </span>
                      <StatusIndicator status={status} />
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="text-muted-foreground"
                      />
                    </Button>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
