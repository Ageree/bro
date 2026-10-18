"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";
import type { ChatCursor, ChatSummary } from "@shared/chat/schema";
import { ChatRow } from "./chat-row";

/**
 * The chats after the first page. The next page loads by the button or on its
 * own once the list's end comes within a screen of view, so scrolling never
 * waits on the whole history.
 */
export function MoreChats({
  cursor,
  mainThreads,
}: {
  readonly cursor: ChatCursor;
  readonly mainThreads: Readonly<Record<string, string>>;
}) {
  const utils = api.useUtils();
  const [chats, setChats] = useState<readonly ChatSummary[]>([]);
  const [next, setNext] = useState<ChatCursor | null>(cursor);
  const [failed, setFailed] = useState(false);
  const loading = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!next || loading.current) return;
    loading.current = true;
    setFailed(false);
    try {
      const page = await utils.chats.page.fetch({ cursor: next });
      setChats((shown) => [...shown, ...page.chats]);
      setNext(page.next);
    } catch {
      setFailed(true);
    } finally {
      loading.current = false;
    }
  }, [next, utils]);

  useEffect(() => {
    const target = end.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load();
      },
      { rootMargin: "0px 0px 100% 0px" }
    );
    if (target && next && !failed) observer.observe(target);
    return () => {
      observer.disconnect();
    };
  }, [failed, load, next]);

  return (
    <>
      {chats.length > 0 ? (
        <ul className="mt-3 flex list-none flex-col gap-3">
          {chats.map((chat) => (
            <ChatRow
              chat={chat}
              key={chat.sessionId}
              mainThread={mainThreads[chat.sessionId]}
            />
          ))}
        </ul>
      ) : null}
      {next ? (
        <div className="mt-6 flex flex-col items-center gap-2" ref={end}>
          {failed ? (
            <p className="type-fine text-muted-foreground">
              Не получилось загрузить. Попробуй ещё раз.
            </p>
          ) : null}
          <Button onClick={() => void load()} variant="paper">
            Показать ещё
          </Button>
        </div>
      ) : null}
    </>
  );
}
