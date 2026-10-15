import type { Metadata } from "next";
import Link from "next/link";
import {
  combineChatUsage,
  formatChatUsage,
} from "@app/(authenticated)/chat/_lib/chat-usage";
import {
  Actions,
  Document,
  DocumentTitle,
} from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import { listChats } from "@db/services/chats";
import { requireRequestScope } from "@web/auth/request-scope";

export const metadata: Metadata = { title: "Все чаты" };

export const dynamic = "force-dynamic";

/**
 * Paper: each chat is a plate row — its title on the left, the date on the
 * right, the thread Bro is actually talking in named in words. The empty
 * state is one plate that points at the new chat.
 */
export default async function AllChatsPage() {
  const scope = await requireRequestScope();
  const chats = await listChats(scope);
  const totalUsage = combineChatUsage(chats.map((chat) => chat.usage));
  const mainThreads = mainThreadLabels(chats);

  return (
    <Document>
      <DocumentTitle>Все чаты</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Все разговоры с Bro — в браузере, в iMessage и в Telegram.
      </p>
      {chats.length > 0 ? (
        <p className="type-fine text-muted-foreground">
          {chatCount(chats.length)} · Расход — {formatChatUsage(totalUsage)}
        </p>
      ) : null}
      <Actions>
        <Button
          nativeButton={false}
          render={<Link href="/chat" />}
          variant="paper"
        >
          Новый чат
        </Button>
      </Actions>

      {chats.length > 0 ? (
        <ul className="mt-6 flex list-none flex-col gap-3">
          {chats.map((chat) => {
            const channel = mainThreads.get(chat.sessionId);
            return (
              <li key={chat.sessionId}>
                <Link
                  className="flex min-h-11 items-baseline justify-between gap-4 rounded-3xl border-2 border-foreground bg-card px-5 py-3.5 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                  href={`/chat/${encodeURIComponent(chat.sessionId)}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="type-row block truncate">
                      {channel ?? chat.title}
                    </span>
                    <span className="type-status block text-muted-foreground">
                      {channel ? "Главная ветка · " : ""}
                      {formatChatUsage(chat.usage)}
                    </span>
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
          })}
        </ul>
      ) : (
        <section
          aria-label="Пока пусто"
          className="mt-6 bro-plate p-6 text-center sm:p-8"
        >
          <p className="type-sec-title">Пока ни одного чата</p>
          <p className="type-fine mt-[0.55rem] text-muted-foreground">
            Начни новый — он появится здесь.
          </p>
        </section>
      )}
    </Document>
  );
}

// Conversation channels whose newest chat is the person's ongoing thread.
const conversationChannelLabels = new Map([
  ["channel:photon", "iMessage"],
  ["channel:telegram", "Telegram"],
]);

function mainThreadLabels(chats: Awaited<ReturnType<typeof listChats>>) {
  const labels = new Map<string, string>();
  const claimed = new Set<string>();
  for (const chat of chats) {
    const label = conversationChannelLabels.get(chat.channel ?? "");
    if (!label || claimed.has(label)) continue;
    claimed.add(label);
    labels.set(chat.sessionId, label);
  }
  return labels;
}

function chatCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? "разговор"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "разговора"
        : "разговоров";
  return `${count.toLocaleString("ru-RU")} ${noun}`;
}

function formatChatDate(value: string) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
