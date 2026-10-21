import Link from "next/link";
import { formatChatUsage } from "@app/(authenticated)/chat/_lib/chat-usage";
import type { ChatSummary } from "@shared/chat/schema";

/**
 * One chat of «Все чаты»: its title on the left, the date on the right, the
 * thread Bro is actually talking in named in words. Rendered by the page for
 * the first page and by `MoreChats` for the pages after it. The chat's tokens
 * and dollars are the owner's lines (`showUsage`): to anyone else a bare
 * «0 токенов» under every title is noise.
 */
export function ChatRow({
  chat,
  mainThread,
  showUsage,
}: {
  readonly chat: ChatSummary;
  readonly mainThread: string | undefined;
  readonly showUsage: boolean;
}) {
  const details = [
    ...(mainThread ? ["Главная ветка"] : []),
    ...(showUsage ? [formatChatUsage(chat.usage)] : []),
  ].join(" · ");

  return (
    <li>
      <Link
        className="flex min-h-11 items-baseline justify-between gap-4 rounded-3xl border-2 border-foreground bg-card px-5 py-3.5 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        href={`/chat/${encodeURIComponent(chat.sessionId)}`}
      >
        <span className="min-w-0 flex-1">
          <span className="type-row block truncate">
            {mainThread ?? chat.title}
          </span>
          {details ? (
            <span className="type-status block text-muted-foreground">
              {details}
            </span>
          ) : null}
        </span>
        <time
          className="type-status shrink-0 text-muted-foreground"
          dateTime={chat.updatedAt}
        >
          {formatChatDate(chat.updatedAt)}
        </time>
      </Link>
    </li>
  );
}

function formatChatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
