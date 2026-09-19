"use client";

import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { AddressForm } from "./form";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultAddresses({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const setup = useVaultSetup();
  const section = useVaultSection({
    setup: setup?.kind === "address" ? setup : undefined,
    view: setup?.kind === "address" ? "add" : "list",
  });

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Адреса"
    >
      <VaultSectionTrigger items={items} title="Адреса" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Адреса</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? "Найди нужный адрес или удали лишний."
                  : "Добавь первый адрес."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-addresses"
              title="Адреса"
            />
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
                variant="act"
              >
                Добавить адрес
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Адреса"
            />
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Добавить адрес</DialogTitle>
              <DialogDescription>
                Адрес доставки, который Bro подставит при заказе.
              </DialogDescription>
            </DialogHeader>
            <AddressForm
              initialLabel={section.setup?.label}
              onSaved={() => {
                section.setView("list");
              }}
            />
          </>
        )}
      </VaultSectionContent>
    </VaultSection>
  );
}
