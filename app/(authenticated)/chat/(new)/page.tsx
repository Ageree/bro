import type { Metadata } from "next";
import { NewChat } from "./_components/new-chat";

export const metadata: Metadata = { title: "Чат" };

/** The empty chat is paper too: the page's title, then the line you write on. */
export default function NewChatPage() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-bro-pad pb-[10vh]">
      <div className="flex w-full max-w-xl flex-col gap-4">
        <div>
          <h1 className="type-doc-title">Чат</h1>
          <p className="type-fine text-muted-foreground">
            Тот же Bro, что в iMessage — с той же памятью.
          </p>
        </div>
        <NewChat />
      </div>
    </div>
  );
}
