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
  Row,
  Rows,
  Section,
} from "@web/components/paper/document";
import { listChats } from "@db/services/chats";
import { requireRequestScope } from "@web/auth/request-scope";

export const metadata: Metadata = { title: "Все чаты" };

export const dynamic = "force-dynamic";

/**
 * Paper: the chats are a list of rows under a hairline, each one a line of
 * text with its date set small and grey on the side. No cards, no badges —
 * the thread Bro is actually talking in says so in words.
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
          Расход — {formatChatUsage(totalUsage)}
        </p>
      ) : null}
      <Actions>
        <Link className="type-act-lead bro-link" href="/chat">
          Новый чат
        </Link>
      </Actions>

      <Section
        headingId="chats-heading"
        state={chats.length > 0 ? chatCount(chats.length) : undefined}
        title="История"
      >
        {chats.length > 0 ? (
          <Rows>
            {chats.map((chat) => {
              const channel = mainThreads.get(chat.sessionId);
              return (
                <Row
                  key={chat.sessionId}
                  side={
                    <time dateTime={chat.updatedAt}>
                      {formatChatDate(chat.updatedAt)}
                    </time>
                  }
                >
                  <p className="truncate">
                    <Link
                      className="bro-link"
                      href={`/chat/${encodeURIComponent(chat.sessionId)}`}
                    >
                      {channel ?? chat.title}
                    </Link>
                  </p>
                  <p className="type-status text-muted-foreground">
                    {channel ? "Главная ветка · " : ""}
                    {formatChatUsage(chat.usage)}
                  </p>
                </Row>
              );
            })}
          </Rows>
        ) : (
          <p className="type-fine mt-[0.6rem] text-muted-foreground">
            Пока ни одного чата — начни новый.
          </p>
        )}
      </Section>
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
