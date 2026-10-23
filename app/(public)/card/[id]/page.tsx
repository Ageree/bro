import type { Metadata } from "next";
import { readCardByLink } from "@db/services/cards";
import { CardView } from "@web/components/cards/card-view";
import { Capsule } from "@web/components/paper/capsule";
import { BackToBro, TelegramScope } from "./telegram";

export const metadata: Metadata = {
  title: { absolute: "Карточка — bro" },
  // The link is a secret; a chat app that previews it must not index it.
  robots: { follow: false, index: false },
};

/**
 * A card Bro sent to a chat (`docs/cards.md`), by the link under its
 * message: the secret in the address is the only key, so the page asks for
 * no sign-in. The card is read and drawn, nothing more; one that expired and
 * one that never was look the same.
 */
export default async function Page(props: PageProps<"/card/[id]">) {
  const { id } = await props.params;
  const card = await readCardByLink(id);
  return (
    <TelegramScope>
      <div className="flex min-h-svh flex-col">
        <Capsule items={[]} />
        <main className="mx-auto w-full max-w-[72rem] flex-1 px-bro-pad pt-[5.5rem] pb-12">
          <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-4">
            {card ? (
              <CardView card={card} />
            ) : (
              <div className="flex flex-col gap-3 bro-plate p-6 sm:p-8">
                <h1 className="type-doc-heading">
                  Карточка устарела или не найдена
                </h1>
                <p className="type-body">
                  Карточки живут 30 дней. Попроси Бро прислать её заново.
                </p>
              </div>
            )}
            <BackToBro />
          </div>
        </main>
      </div>
    </TelegramScope>
  );
}
