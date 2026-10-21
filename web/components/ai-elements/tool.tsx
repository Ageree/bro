"use client";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@web/components/ui/collapsible";
import { cn } from "@web/components/class-names";
import type { DynamicToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { z } from "zod";

type ToolStatus = DynamicToolUIPart["state"];

const statusPresentation = {
  "approval-requested": {
    icon: <ClockIcon className="size-4" />,
    label: "Ждёт подтверждения",
  },
  "approval-responded": {
    icon: <CheckCircleIcon className="size-4" />,
    label: "Ответ получен",
  },
  "input-available": {
    icon: <CircleIcon className="size-4 animate-pulse" />,
    label: "Выполняется",
  },
  "input-streaming": {
    icon: <CircleIcon className="size-4" />,
    label: "Ожидает",
  },
  "output-available": {
    icon: <CheckCircleIcon className="size-4" />,
    label: "Готово",
  },
  "output-denied": {
    icon: <XIcon className="size-4" />,
    label: "Отклонено",
  },
  "output-error": {
    icon: <CircleAlertIcon className="size-4" />,
    label: "Ошибка",
  },
} satisfies Record<ToolStatus, { icon: ReactNode; label: string }>;

type ToolProps = ComponentProps<typeof Collapsible>;

function Tool({ className, ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn(
        "group not-prose w-full rounded-2xl border border-border bg-card px-4",
        className
      )}
      data-slot="chat-tool"
      {...props}
    />
  );
}

interface ToolHeaderProps extends Omit<
  ComponentProps<typeof CollapsibleTrigger>,
  "children" | "title"
> {
  icon?: ReactNode;
  meta?: ReactNode;
  status?: ToolStatus;
  statusIcon?: ReactNode;
  statusLabel?: ReactNode;
  title: ReactNode;
}

function ToolHeader({
  className,
  icon,
  meta,
  status,
  statusIcon,
  statusLabel,
  title,
  ...props
}: ToolHeaderProps) {
  const presentation = status ? statusPresentation[status] : undefined;

  return (
    <CollapsibleTrigger
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-xl text-left text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      data-slot="chat-tool-trigger"
      {...props}
    >
      {icon ?? <WrenchIcon className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate type-label">{title}</span>
      {meta ? (
        <span
          className="flex shrink-0 items-center gap-1"
          data-slot="chat-tool-meta"
        >
          {meta}
        </span>
      ) : null}
      {presentation ? (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 type-caption",
            status === "output-error" && "text-destructive"
          )}
          data-status={status}
        >
          {statusIcon === undefined ? presentation.icon : statusIcon}
          {statusLabel === undefined ? presentation.label : statusLabel}
        </span>
      ) : null}
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
  );
}

type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

function ToolContent({ className, ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        "-mx-4 space-y-4 border-t border-border px-4 pt-3 pb-4 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
        className
      )}
      data-slot="chat-tool-content"
      {...props}
    />
  );
}

interface ToolInputProps extends ComponentProps<"div"> {
  input: unknown;
}

function ToolInput({ className, input, ...props }: ToolInputProps) {
  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <p className="type-label text-muted-foreground">Параметры</p>
      <pre className="type-code overflow-x-auto rounded-xl bg-muted/60 p-3">
        <code>{JSON.stringify(input, null, 2)}</code>
      </pre>
    </div>
  );
}

interface ToolOutputProps extends ComponentProps<"div"> {
  errorText?: string;
  output?: unknown;
}

function ToolOutput({
  className,
  errorText,
  output,
  ...props
}: ToolOutputProps) {
  if (output === undefined && !errorText) return null;

  const text = z.string().safeParse(output);
  const content = isValidElement(output)
    ? output
    : text.success
      ? text.data
      : JSON.stringify(output, null, 2);

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <p className="type-label text-muted-foreground">
        {errorText ? "Ошибка" : "Результат"}
      </p>
      <div
        className={cn(
          "overflow-x-auto rounded-xl bg-muted/60 p-3 type-supporting-body whitespace-pre-wrap",
          errorText && "bg-destructive/10 text-destructive"
        )}
      >
        {errorText ?? content}
      </div>
    </div>
  );
}

export { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput };
export type {
  ToolContentProps,
  ToolHeaderProps,
  ToolInputProps,
  ToolOutputProps,
  ToolProps,
  ToolStatus,
};
