import { AlertCircleIcon, BrainIcon, LoaderCircleIcon } from "lucide-react";
import type { EveMessage, EveMessagePart } from "eve/react";
import { Fragment, useMemo } from "react";
import {
  imessageTimestamps,
  messageTimestamps,
  sentMessages,
} from "../../_lib/message-events";
import type { TraceView } from "../../_lib/trace-view";
import { getLatestTurnFailure } from "../../_lib/turn-failure";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@web/components/ai-elements/conversation";
import { Message, MessageContent } from "@web/components/ai-elements/message";
import { Shimmer } from "@web/components/ai-elements/shimmer";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";
import {
  backgroundNoticeText,
  isBackgroundTurnText,
} from "@shared/chat/background-turn";
import { AgentMessage } from "./message";
import type { ChatAgent } from "../chat-agent";

export function ChatConversation({
  agent,
  history,
  initial,
  sessionId,
  traceView,
}: {
  readonly agent: Pick<
    ChatAgent,
    "data" | "error" | "events" | "respond" | "status"
  >;
  readonly history?: {
    readonly hasOlder: boolean;
    readonly isLoadingOlder: boolean;
    readonly loadOlder: () => Promise<void>;
  };
  readonly initial?: false;
  readonly sessionId?: string;
  readonly traceView: TraceView;
}) {
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isRestoring =
    agent.status === "resuming" && agent.data.messages.length === 0;
  const lastMessage = agent.data.messages.at(-1);
  const pendingAssistantMessageId =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.every((part) => part.type === "step-start")
      ? lastMessage.id
      : undefined;
  const showPendingThinking =
    traceView === "trace" &&
    isBusy &&
    (agent.status === "submitted" ||
      lastMessage?.role !== "assistant" ||
      pendingAssistantMessageId !== undefined);
  const turnFailure =
    isBusy || isRestoring ? undefined : getLatestTurnFailure(agent.events);
  const errorMessage =
    (agent.error ? toErrorMessage(agent.error) : undefined) ?? turnFailure;
  const messages = agent.data.messages;
  const timestamps = useMemo(
    () =>
      traceView === "imessage"
        ? imessageTimestamps(agent.events)
        : messageTimestamps(agent.events),
    [agent.events, traceView]
  );
  const deliveredMessages = useMemo(
    () => sentMessages(agent.events),
    [agent.events]
  );

  return (
    <Conversation
      className="min-h-0 flex-1"
      initial={initial}
      resize={sessionId === undefined ? "smooth" : "instant"}
      scrollRestorationKey={
        agent.data.messages.length === 0 || sessionId === undefined
          ? undefined
          : `eve:web-chat-scroll:${sessionId}`
      }
    >
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-6 pb-36 sm:px-6">
        {history?.hasOlder ? (
          <Button
            className="self-center"
            disabled={history.isLoadingOlder}
            onClick={() => void history.loadOlder()}
            size="lg"
            type="button"
            variant="outline"
          >
            {history.isLoadingOlder ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : null}
            {history.isLoadingOlder
              ? "Загружаем…"
              : "Показать, что было раньше"}
          </Button>
        ) : null}
        {isRestoring && messages.length === 0 ? (
          <Shimmer className="type-supporting-body self-center" duration={1}>
            Loading recent messages
          </Shimmer>
        ) : null}
        {messages.map((message, index) => {
          if (showPendingThinking && message.id === pendingAssistantMessageId) {
            return null;
          }
          // A scheduled or proactive report is Bro's own prompt to itself;
          // the person sees only what Bro sent them from it. A notice code
          // wrote in Bro's name has no message of Bro's behind it: its text
          // is shown as one.
          if (traceView === "imessage" && isBackgroundTurnMessage(message)) {
            const notice = backgroundNoticeOf(message);
            return notice === undefined ? null : (
              <AgentMessage
                canRespond={false}
                isStreaming={false}
                key={message.id}
                message={notice.message}
                onInputResponses={agent.respond}
                sentMessageParts={notice.parts}
                timestamp={timestamps.get(message.id)}
                userVisibleOnly
              />
            );
          }

          const deliveries =
            traceView === "imessage"
              ? deliveredMessages.get(message.id)
              : undefined;
          if (deliveries) {
            return (
              <Fragment key={message.id}>
                {deliveries.map((delivery, deliveryIndex) => (
                  <AgentMessage
                    canRespond={!isBusy && agent.status !== "resuming"}
                    isStreaming={false}
                    key={delivery.id}
                    message={message}
                    onInputResponses={agent.respond}
                    sentMessageParts={delivery.parts}
                    showInputRequests={deliveryIndex === deliveries.length - 1}
                    timestamp={delivery.timestamp}
                    userVisibleOnly
                  />
                ))}
              </Fragment>
            );
          }

          return (
            <AgentMessage
              canRespond={!isBusy && agent.status !== "resuming"}
              isStreaming={
                agent.status === "streaming" && index === messages.length - 1
              }
              key={message.id}
              message={message}
              onInputResponses={agent.respond}
              timestamp={timestamps.get(message.id)}
              userVisibleOnly={traceView === "imessage"}
            />
          );
        })}
        {showPendingThinking ? <PendingThinking /> : null}
        {traceView === "trace" && errorMessage ? (
          <ErrorMessage message={errorMessage} />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function isBackgroundTurnMessage(message: EveMessage) {
  if (message.role !== "user") return false;
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" && isBackgroundTurnText(text.text);
}

// The row of a notice keeps its message and parts while the history grows.
const noticeByMessage = new WeakMap<
  EveMessage,
  {
    readonly message: EveMessage;
    readonly parts: readonly EveMessagePart[];
  } | null
>();

function backgroundNoticeOf(message: EveMessage) {
  const known = noticeByMessage.get(message);
  if (known !== undefined) return known ?? undefined;
  const text = message.parts.find((part) => part.type === "text");
  const notice =
    text?.type === "text" ? backgroundNoticeText(text.text) : undefined;
  const shown =
    notice === undefined
      ? null
      : {
          message: { ...message, role: "assistant" as const },
          parts: [
            { state: "done" as const, text: notice, type: "text" as const },
          ],
        };
  noticeByMessage.set(message, shown);
  return shown ?? undefined;
}

function toErrorMessage(cause: unknown): string {
  if (!(cause instanceof Error)) return "Не получилось выполнить запрос.";
  if (/<!doctype html|<html[\s>]/i.test(cause.message)) {
    return "Агент сейчас недоступен. Попробуй через минуту.";
  }
  return cause.message;
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent>
        <Alert className="rounded-2xl px-4 py-3" variant="destructive">
          <AlertCircleIcon />
          <AlertTitle>Запрос не прошёл</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      </MessageContent>
    </Message>
  );
}

function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="type-supporting-body mb-4 flex w-full items-center gap-2 text-muted-foreground">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Думает</Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}
