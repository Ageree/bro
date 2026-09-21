import type { SubagentStatus } from "@app/_lib/subagent-sessions";

export function agentLabel(name: string) {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

const statusLabels: Record<SubagentStatus, string> = {
  cancelled: "отменено",
  complete: "готово",
  failed: "ошибка",
  ready: "готово",
  starting: "запускается",
  working: "в работе",
};

export function statusLabel(status: SubagentStatus) {
  return statusLabels[status];
}

/** A state is a word on paper, never a coloured pill. */
export function StatusIndicator({
  status,
}: {
  readonly status: SubagentStatus;
}) {
  return (
    <span className="type-status shrink-0 text-muted-foreground">
      {statusLabel(status)}
    </span>
  );
}
