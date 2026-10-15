import Link from "next/link";
import { Actions, Rows, Section } from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import type { VaultItem } from "@shared/vault/schema";
import { VaultAddresses } from "./addresses";
import { VaultCards } from "./cards";
import { VaultContacts } from "./contacts";
import { VaultOtherItems } from "./other";

const addLinks = [
  { href: "/workspace?setup=vault&kind=payment", label: "Добавить карту" },
  { href: "/workspace?setup=vault&kind=address", label: "Добавить адрес" },
  { href: "/workspace?setup=vault&kind=contact", label: "Добавить контакт" },
] as const;

/**
 * The vault as a section of the cabinet: the saved cards, addresses and
 * contacts, each list opening its own sheet, and the links that open the
 * sheet to add one. The same links come from the agent as `?setup=vault`.
 */
export function CabinetVault({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const itemsByKind = Object.groupBy(items, (item) => item.kind);
  const otherItems = items.filter(
    (item) =>
      item.kind === "identity" || item.kind === "phone" || item.kind === "token"
  );
  const saved =
    (itemsByKind.payment?.length ?? 0) +
    (itemsByKind.address?.length ?? 0) +
    (itemsByKind.contact?.length ?? 0);

  return (
    <Section
      headingId="vault-heading"
      state={saved > 0 ? `Записей: ${String(saved)}` : "Пусто"}
      title="Сейф"
    >
      <p className="type-fine text-muted-foreground">
        Карты, адреса и контакты, которые Bro использует в поручениях. Номер и
        CVV он не видит, а пароль в чат не пиши.
      </p>
      <Rows>
        <VaultCards items={itemsByKind.payment ?? []} />
        <VaultAddresses items={itemsByKind.address ?? []} />
        <VaultContacts items={itemsByKind.contact ?? []} />
      </Rows>
      <VaultOtherItems items={otherItems} />
      <Actions className="items-center">
        {addLinks.map(({ href, label }, index) => (
          <Button
            key={href}
            nativeButton={false}
            render={<Link href={href} scroll={false} />}
            variant={index === 0 ? "paper" : "outline"}
          >
            {label}
          </Button>
        ))}
      </Actions>
    </Section>
  );
}
