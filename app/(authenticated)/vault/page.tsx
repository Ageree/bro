import type { Metadata } from "next";
import Link from "next/link";
import {
  Actions,
  Document,
  DocumentTitle,
  Rows,
  Section,
} from "@web/components/paper/document";
import { VaultAddresses } from "./_components/addresses";
import { VaultCards } from "./_components/cards";
import { VaultContacts } from "./_components/contacts";
import { VaultLogins } from "./_components/logins";
import { VaultOtherItems } from "./_components/other";
import { readVaultItems } from "@db/services/vault";
import { requireRequestScope } from "@web/auth/request-scope";

export const metadata: Metadata = { title: "Сейф" };

export default async function Page() {
  const scope = await requireRequestScope();
  const items = await readVaultItems(scope);
  const itemsByKind = Object.groupBy(items, (item) => item.kind);
  const otherItems = items.filter(
    (item) =>
      item.kind === "identity" || item.kind === "phone" || item.kind === "token"
  );
  return (
    <Document>
      <DocumentTitle>Сейф</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Пароль в чат не пиши. Bro берёт вход из сейфа сам. Добавь или измени
        логин здесь.
      </p>

      <Section headingId="saved-heading" title="Сохранённые">
        <Rows>
          <VaultLogins items={itemsByKind.login ?? []} />
          <VaultCards items={itemsByKind.payment ?? []} />
          <VaultAddresses items={itemsByKind.address ?? []} />
          <VaultContacts items={itemsByKind.contact ?? []} />
        </Rows>
        <VaultOtherItems items={otherItems} />
      </Section>

      <Section headingId="add-heading" title="Добавить или изменить">
        <p className="type-fine text-muted-foreground">
          Открой нужный список выше, чтобы найти или удалить запись. Новую —
          добавь здесь.
        </p>
        <Actions>
          <Link className="type-act bro-link" href="/vault?add=login">
            Добавить вход
          </Link>
          <Link
            className="type-act bro-link"
            href="/vault?setup=vault&kind=payment"
          >
            Добавить карту
          </Link>
          <Link
            className="type-act bro-link"
            href="/vault?setup=vault&kind=address"
          >
            Добавить адрес
          </Link>
          <Link
            className="type-act bro-link"
            href="/vault?setup=vault&kind=contact"
          >
            Добавить контакт
          </Link>
          <Link className="type-act bro-link" href="/vault?import=chrome">
            Импортировать из Chrome
          </Link>
        </Actions>
      </Section>
    </Document>
  );
}
