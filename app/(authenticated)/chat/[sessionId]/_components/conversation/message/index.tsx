"use client";

import type { EveMessage } from "eve/react";
import { useState } from "react";
import { Message, MessageContent } from "@web/components/ai-elements/message";
import { cn } from "@web/components/class-names";
import { AgentMessagePart, partKey } from "./parts";
import type { RespondToAgentInput } from "./types";

export function AgentMessage({
  canRespond,
  isStreaming,
  message,
  onInputResponses,
  sentMessageParts,
  showInputRequests = true,
  timestamp,
  userVisibleOnly = false,
}: {
  readonly canRespond: boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onInputResponses: RespondToAgentInput;
  readonly sentMessageParts?: readonly EveMessage["parts"][number][];
  /** Whether this rendering of the turn carries its cards and questions. */
  readonly showInputRequests?: boolean;
  readonly timestamp?: string;
  readonly userVisibleOnly?: boolean;
}) {
  const [optimisticTimestamp] = useState(() => new Date().toISOString());
  const displayedTimestamp =
    timestamp ?? (message.role === "user" ? optimisticTimestamp : undefined);
  const visibleParts = userVisibleOnly
    ? userVisibleParts(message, sentMessageParts, showInputRequests)
    : message.parts;
  const lastTextIndex = visibleParts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1
  );
  const hasAssistantText =
    message.role === "assistant" &&
    visibleParts.some((part) => part.type === "text" && part.text.length > 0);

  if (visibleParts.length === 0) return null;

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {visibleParts.map((part, index) =>
          hasAssistantText && part.type === "reasoning" ? null : (
            <AgentMessagePart
              canRespond={canRespond}
              key={partKey(part, index)}
              onInputResponses={onInputResponses}
              part={part}
              showCaret={
                isStreaming &&
                message.role === "assistant" &&
                index === lastTextIndex
              }
              userVisibleOnly={userVisibleOnly}
            />
          )
        )}
      </MessageContent>
      {displayedTimestamp ? (
        <time
          className={cn(
            "text-muted-foreground",
            message.role === "user" ? "ml-auto pr-1" : "mr-auto"
          )}
          dateTime={displayedTimestamp}
          title={fullTimestampFormatter.format(new Date(displayedTimestamp))}
        >
          <span className="type-caption" suppressHydrationWarning>
            {timestampFormatter.format(new Date(displayedTimestamp))}
          </span>
        </time>
      ) : null}
    </Message>
  );
}

/**
 * What the person sees of a turn: what Bro sent them, and the cards and
 * questions waiting on their answer — an approval card is the one thing in a
 * turn that only the person can act on, as it is in Telegram and iMessage.
 * The tool calls behind them stay in the trace view.
 */
function userVisibleParts(
  message: EveMessage,
  sentMessageParts: readonly EveMessage["parts"][number][] | undefined,
  showInputRequests: boolean
) {
  if (message.role === "user") {
    return message.parts.filter(
      (part) => part.type === "text" || part.type === "file"
    );
  }

  const requests = showInputRequests
    ? message.parts.filter(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolMetadata?.eve?.inputRequest !== undefined
      )
    : [];
  return [...(sentMessageParts ?? []), ...requests];
}

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const fullTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
