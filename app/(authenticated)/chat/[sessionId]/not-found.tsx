import Link from "next/link";
import { Actions } from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";

/**
 * A link to a chat that is not this account's, or that never was: the page
 * says so instead of showing an empty chat to write into. The plate is the
 * one of the new chat (`(new)/page.tsx`), under the same capsule.
 */
export default function ChatNotFound() {
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto px-bro-pad pb-6">
      <section
        aria-labelledby="chat-not-found-heading"
        className="w-full max-w-xl bro-plate p-6 sm:p-8"
      >
        <h1 className="type-doc-title" id="chat-not-found-heading">
          Чат не найден
        </h1>
        <p className="type-fine mt-[0.55rem] text-muted-foreground">
          Такого разговора нет в твоём аккаунте. Возможно, ссылка неверная или
          устарела.
        </p>
        <Actions className="items-center">
          <Button
            nativeButton={false}
            render={<Link href="/chat" />}
            variant="paper"
          >
            Новый чат
          </Button>
          <Button
            nativeButton={false}
            render={<Link href="/chat/history" />}
            variant="outline"
          >
            Все чаты
          </Button>
        </Actions>
      </section>
    </div>
  );
}
