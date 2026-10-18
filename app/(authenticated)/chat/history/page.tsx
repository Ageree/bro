import type { Metadata } from "next";
import Link from "next/link";
import type { AccessScope } from "@shared/identity/access-scope";
import { formatChatUsage } from "@app/(authenticated)/chat/_lib/chat-usage";
import {
  Actions,
  Document,
  DocumentTitle,
} from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import {
  listChatsPage,
  newestChatsOfChannels,
  summarizeChats,
} from "@db/services/chats";
import { requireRequestScope } from "@web/auth/request-scope";
import { ChatRow } from "./_components/chat-row";
import { MoreChats } from "./_components/more-chats";

export const metadata: Metadata = { title: "Все чаты" };

export const dynamic = "force-dynamic";

/**
 * Paper: each chat is a plate row (`ChatRow`). The page renders the first
 * page of chats and the totals the database counted; `MoreChats` loads the
 * rest by cursor. The empty state is one plate that points at the new chat.
 */
export default async function AllChatsPage() {
  const scope = await requireRequestScope();
  const [{ chats, next }, totals, mainThreads] = await Promise.all([
    listChatsPage(scope),
    summarizeChats(scope),
    mainThreadLabels(scope),
  ]);

  return (
    <Document>
      <DocumentTitle>Все чаты</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Все разговоры с Bro — в браузере, в iMessage и в Telegram.
      </p>
      {totals.count > 0 ? (
        <p className="type-fine text-muted-foreground">
          {chatCount(totals.count)} · Расход — {formatChatUsage(totals.usage)}
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
        <>
          <ul className="mt-6 flex list-none flex-col gap-3">
            {chats.map((chat) => (
              <ChatRow
                chat={chat}
                key={chat.sessionId}
                mainThread={mainThreads[chat.sessionId]}
              />
            ))}
          </ul>
          {next ? <MoreChats cursor={next} mainThreads={mainThreads} /> : null}
        </>
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

/** The person's ongoing thread of each conversation channel, by session. */
async function mainThreadLabels(scope: AccessScope) {
  const newest = await newestChatsOfChannels(scope, [
    ...conversationChannelLabels.keys(),
  ]);
  return Object.fromEntries(
    newest.flatMap(({ channel, sessionId }) => {
      const label = conversationChannelLabels.get(channel);
      return label ? [[sessionId, label]] : [];
    })
  );
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
