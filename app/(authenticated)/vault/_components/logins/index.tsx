"use client";

import { useSearchParams } from "next/navigation";
import type { VaultItem } from "@shared/vault/schema";
import { Button } from "@web/components/ui/button";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@web/components/ui/dialog";
import { LoginForm } from "./form";
import { ChromeImportPanel } from "./import";
import {
  useVaultSection,
  VaultItemBrowser,
  VaultSection,
  VaultSectionBackButton,
  VaultSectionContent,
  VaultSectionTrigger,
} from "../section";
import { useVaultSetup } from "../setup";

export function VaultLogins({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  const searchParams = useSearchParams();
  const setup = useVaultSetup();
  const requestedSetup = setup?.kind === "login" ? setup : undefined;
  const requestedChromeImport = searchParams.get("import") === "chrome";
  const requestedAdd =
    requestedSetup !== undefined || searchParams.get("add") === "login";
  const section = useVaultSection({
    setup: requestedSetup,
    view: requestedChromeImport ? "import" : requestedAdd ? "add" : "list",
  });
  const initialSetup = section.setup;

  return (
    <VaultSection
      onOpenChange={section.onOpenChange}
      open={section.open}
      title="Входы"
    >
      <VaultSectionTrigger items={items} title="Входы" />
      <VaultSectionContent view={section.view}>
        {section.view === "list" ? (
          <>
            <DialogHeader className="pr-10 sm:pr-6">
              <DialogTitle>Входы</DialogTitle>
              <DialogDescription>
                {items.length > 0
                  ? "Найди нужный вход или удали лишний."
                  : "Добавь первый вход на сайт."}
              </DialogDescription>
            </DialogHeader>
            <VaultItemBrowser
              items={items}
              searchId="vault-search-logins"
              title="Входы"
            />
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <Button
                onClick={() => {
                  section.setView("add");
                }}
                type="button"
                variant="act"
              >
                Добавить вход
              </Button>
              <Button
                onClick={() => {
                  section.setView("import");
                }}
                type="button"
                variant="act"
              >
                Импортировать из Chrome
              </Button>
            </div>
          </>
        ) : (
          <>
            <VaultSectionBackButton
              onClick={() => {
                section.setView("list");
              }}
              title="Входы"
            />
            {section.view === "import" ? (
              <ChromeImportPanel
                onDone={() => {
                  section.setView("list");
                }}
              />
            ) : (
              <>
                <DialogHeader className="pr-10 sm:pr-6">
                  <DialogTitle>
                    {initialSetup
                      ? `Добавить вход: ${initialSetup.label}`
                      : "Добавить вход"}
                  </DialogTitle>
                  <DialogDescription>
                    Введи данные, с которыми ты заходишь на сайт.
                  </DialogDescription>
                </DialogHeader>
                <LoginForm
                  initialIdentifierType={initialSetup?.identifierType}
                  initialLabel={initialSetup?.label}
                  initialOrigin={initialSetup?.origin}
                  onSaved={() => {
                    section.setView("list");
                  }}
                />
              </>
            )}
          </>
        )}
      </VaultSectionContent>
    </VaultSection>
  );
}
