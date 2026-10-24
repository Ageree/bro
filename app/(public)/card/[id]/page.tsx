import type { Metadata } from "next";
import { readCardByLink } from "@db/services/cards";
import { submitActions } from "@shared/cards/response";
import { CardAnswerScope } from "@web/components/cards/answer";
import { CardView } from "@web/components/cards/card-view";
import { BackToBro, TelegramScope } from "@web/components/cards/telegram";

export const metadata: Metadata = {
  title: { absolute: "Карточка — bro" },
  // The link is a secret; a chat app that previews it must not index it.
  robots: { follow: false, index: false },
};

/**
 * A card Bro sent to a chat (`docs/cards.md`), by the link under its
 * message: the secret in the address is the only key to read it, so the
 * page asks for no sign-in. One that expired and one that never was look
 * the same. A card that asks takes an answer only from the person it was
 * sent to, whom Telegram's launch data names (`CardAnswerScope`); the
 * answer itself is never in this page's markup. Telegram draws its own
 * header over the Mini App, so the page has none: the card starts 16 px
 * below it.
 */
export default async function Page(props: PageProps<"/card/[id]">) {
  const { id } = await props.params;
  const found = await readCardByLink(id);
  const asks = found !== undefined && submitActions(found.card).length > 0;
  return (
    <TelegramScope>
      <div className="flex min-h-svh flex-col">
        <main className="mx-auto w-full max-w-[72rem] flex-1 px-bro-pad pt-4 pb-12">
          <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-4">
            {found ? (
              <CardAnswerScope
                key={found.id}
                card={found.card}
                link={found.id}
                revision={found.revision}
              >
                <CardView card={found.card} updated={found.revision > 1} />
              </CardAnswerScope>
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
            {!asks && <BackToBro />}
          </div>
        </main>
      </div>
    </TelegramScope>
  );
}
