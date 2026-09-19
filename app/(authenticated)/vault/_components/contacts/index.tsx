"use client";

import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { ContactForm } from "./form";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultContacts({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const setup = useVaultSetup();
  const section = useVaultSection({
    setup: setup?.kind === "contact" ? setup : undefined,
    view: setup?.kind === "contact" ? "add" : "list",
  });

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Контакты"
    >
      <VaultSectionTrigger items={items} title="Контакты" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Контакты</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? "Найди нужный контакт или удали лишний."
                  : "Добавь первый контакт."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-contacts"
              title="Контакты"
            />
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
                variant="act"
              >
                Добавить контакт
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Контакты"
            />
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Добавить контакт</DialogTitle>
              <DialogDescription>
                Имя, почта и телефон, которые Bro укажет при оформлении.
              </DialogDescription>
            </DialogHeader>
            <ContactForm
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
