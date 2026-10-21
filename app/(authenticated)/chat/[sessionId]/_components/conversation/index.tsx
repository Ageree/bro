import { AlertCircleIcon, BrainIcon, LoaderCircleIcon } from "lucide-react";
import type { EveMessage, EveMessagePart } from "eve/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
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

type ChatConversationHistory = Pick<
  ChatAgent,
  "hasOlder" | "isLoadingOlder" | "loadOlder"
>;

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
  readonly history?: ChatConversationHistory;
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
  const showPendingReply =
    traceView === "imessage" &&
    awaitsFirstReply(agent.status, messages, deliveredMessages);

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
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-3 pb-36 sm:px-6 md:pt-6">
        {history ? <OlderHistory history={history} /> : null}
        {isRestoring && messages.length === 0 ? (
          <Shimmer className="type-supporting-body self-center" duration={1}>
            Загружаем сообщения…
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
        {showPendingReply ? <PendingReply /> : null}
        {traceView === "trace" && errorMessage ? (
          <ErrorMessage message={errorMessage} />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

// How near the top the person scrolls before earlier messages start to load.
const olderPreloadPx = 800;

/**
 * Earlier messages load as the person scrolls up to them, and the button
 * stays for a click. Messages read in above leave the one at the top of the
 * view where it was, though the person scrolls on while the page loads:
 * Safari has no scroll anchoring of its own.
 */
function OlderHistory({
  history: { hasOlder, isLoadingOlder, loadOlder },
}: {
  readonly history: ChatConversationHistory;
}) {
  const { contentRef, scrollRef } = useStickToBottomContext();
  const anchor = useRef<{ readonly row: Element; readonly top: number }>(
    undefined
  );
  // A page that failed to load (offline, 5xx) is asked again only after the
  // person scrolls again or taps: the same spot would retry it at once.
  const stalled = useRef(false);
  const load = useCallback(() => {
    stalled.current = true;
    void loadOlder().then((loaded) => {
      stalled.current = !loaded;
      return undefined;
    });
  }, [loadOlder]);

  // Mounted past the last page too: that page is what takes the button away.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const kept = anchor.current;
    if (isLoadingOlder || !scroller || !kept) return;
    anchor.current = undefined;
    if (kept.row.isConnected) {
      scroller.scrollTop += kept.row.getBoundingClientRect().top - kept.top;
    }
  }, [isLoadingOlder, scrollRef]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || (!hasOlder && !isLoadingOlder)) return undefined;
    const keepTopRow = () => {
      anchor.current = topRowOf(scroller, contentRef.current);
    };
    const onScroll = (byPerson: boolean) => {
      if (isLoadingOlder) {
        keepTopRow();
        return;
      }
      if (byPerson) stalled.current = false;
      if (stalled.current) return;
      const fromBottom =
        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      // At the bottom is where a conversation opens: only a scroll up loads.
      if (
        scroller.scrollTop > olderPreloadPx ||
        fromBottom < scroller.clientHeight / 4
      ) {
        return;
      }
      keepTopRow();
      load();
    };
    const onPersonScroll = () => {
      onScroll(true);
    };
    // Still near the top once a page arrived: the next one follows.
    if (hasOlder && !isLoadingOlder) onScroll(false);
    scroller.addEventListener("scroll", onPersonScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onPersonScroll);
    };
  }, [contentRef, hasOlder, isLoadingOlder, load, scrollRef]);

  if (!hasOlder) return null;
  return (
    <Button
      className="self-center"
      data-older-history
      disabled={isLoadingOlder}
      onClick={() => {
        const scroller = scrollRef.current;
        if (scroller) anchor.current = topRowOf(scroller, contentRef.current);
        load();
      }}
      size="lg"
      type="button"
      variant="outline"
    >
      {isLoadingOlder ? <LoaderCircleIcon className="animate-spin" /> : null}
      {isLoadingOlder ? "Загружаем…" : "Показать, что было раньше"}
    </Button>
  );
}

/** The row at the top of the view, past the button, and where it stands. */
function topRowOf(scroller: HTMLElement, content: HTMLElement | null) {
  const viewTop = scroller.getBoundingClientRect().top;
  for (const row of content?.children ?? []) {
    if (row.matches("[data-older-history]")) continue;
    const { bottom, top } = row.getBoundingClientRect();
    if (bottom > viewTop) return { row, top };
  }
  return undefined;
}

function isBackgroundTurnMessage(message: EveMessage) {
  if (message.role !== "user") return false;
  const text = message.parts.find((part) => part.type === "text");
  return text?.type === "text" && isBackgroundTurnText(text.text);
}

/**
 * Whether the person's latest message has nothing of Bro's below it yet: it
 * has just left, or a turn is running and no message of Bro's (or card to
 * answer) shows. The turn's own steps stay out of this view, so without a
 * sign the chat looks idle for the seconds Bro takes to think.
 */
function awaitsFirstReply(
  status: ChatAgent["status"],
  messages: readonly EveMessage[],
  deliveries: ReturnType<typeof sentMessages>
) {
  if (status === "submitted") return true;
  if (status !== "streaming") return false;
  const last = messages.at(-1);
  if (last === undefined) return false;
  if (last.role === "user") return !isBackgroundTurnMessage(last);
  const before = messages.at(-2);
  return (
    before?.role === "user" &&
    !isBackgroundTurnMessage(before) &&
    !showsBro(last, deliveries)
  );
}

/** Whether the iMessage view draws anything of Bro's for this turn. */
function showsBro(
  message: EveMessage,
  deliveries: ReturnType<typeof sentMessages>
) {
  return (
    (deliveries.get(message.id)?.length ?? 0) > 0 ||
    message.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        part.toolMetadata?.eve?.inputRequest !== undefined
    )
  );
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

/** Bro is on the answer: in the iMessage view, the one sign of it. */
function PendingReply() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <Shimmer className="type-supporting-body" duration={1}>
          Bro печатает…
        </Shimmer>
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
