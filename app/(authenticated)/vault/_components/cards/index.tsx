"use client";

import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { CardForm } from "./form";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultCards({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const setup = useVaultSetup();
  const initialAdd = setup?.kind === "payment";
  const section = useVaultSection(initialAdd ? "add" : "list");

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Карты"
    >
      <VaultSectionTrigger items={items} title="Карты" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Карты</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? "Найди нужную карту или удали лишнюю."
                  : "Добавь первую карту."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-cards"
              title="Карты"
            />
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
                variant="act"
              >
                Добавить карту
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Карты"
            />
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Добавить карту</DialogTitle>
              <DialogDescription>
                Номер и CVV шифруются до записи в базу и после сохранения не
                показываются.
              </DialogDescription>
            </DialogHeader>
            <CardForm
              initialLabel={initialAdd ? setup.label : undefined}
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
