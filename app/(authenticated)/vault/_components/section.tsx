"use client";

import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@web/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTrigger,
} from "@web/components/ui/dialog";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@web/components/ui/input-group";
import { Label } from "@web/components/ui/label";
import type { VaultItem } from "@shared/vault/schema";
import { api } from "@web/trpc/client";

const VAULT_DIALOG_PAGE_SIZE = 50;

type VaultSectionView = "add" | "import" | "list";

/** What a section reads from the query on every render: its own sheet, if named. */
interface VaultSectionRequest<Setup> {
  readonly setup?: Setup;
  readonly view: VaultSectionView;
}

/**
 * The state a section takes on from a query it has not answered yet, or
 * `undefined` to keep what it has. A query that names this section's sheet
 * opens it; one that names another section's closes this one, so two sheets
 * never stand open at once. The empty query is the sheet's own cleanup of
 * the URL, and it says nothing about the sheet.
 */
export function answerVaultSectionQuery<Setup>(
  query: string,
  requested: VaultSectionRequest<Setup>
) {
  if (requested.view !== "list") {
    return { open: true, setup: requested.setup, view: requested.view };
  }
  if (query === "") return undefined;
  return { open: false, setup: undefined, view: "list" as const };
}

/**
 * A section's sheet, and the request that opened it. A link from the
 * cabinet, or from the foot of the vault, names the sheet in the query:
 * `requested` is what this section reads from it on every render.
 */
export function useVaultSection<Setup>(requested: VaultSectionRequest<Setup>) {
  const query = useSearchParams().toString();
  const [open, setOpen] = useState(requested.view !== "list");
  const [view, setView] = useState(requested.view);
  const [setup, setSetup] = useState(requested.setup);
  const [answeredQuery, setAnsweredQuery] = useState(query);

  // Each new query is answered once, as state that follows a prop: the
  // sheet opens on the view the link asked for, keeping what the link said
  // about the item even after the query is gone from the URL.
  if (query !== answeredQuery) {
    setAnsweredQuery(query);
    const answer = answerVaultSectionQuery(query, requested);
    if (answer) {
      setOpen(answer.open);
      setView(answer.view);
      setSetup(answer.setup);
    }
  }

  // Once the sheet is open the query has done its job, so it comes off the
  // URL without a round trip. The same link then reads as a new query the
  // next time, even after the sheet was closed, and a refresh after a save
  // renders the plain page instead of asking for the sheet again.
  useEffect(() => {
    if (query === "" || requested.view === "list") return;
    window.history.replaceState(null, "", window.location.pathname);
  }, [query, requested.view]);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setView("list");
  };

  return { onOpenChange, open, setView, setup, view };
}

/** One row of the vault's saved list; its sheet opens from the row itself. */
export function VaultSection({
  children,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}) {
  return (
    <li
      aria-label={title}
      className="border-t border-border first:border-t-0 first:[&>button]:pt-[0.2rem]"
    >
      <Dialog onOpenChange={onOpenChange} open={open}>
        {children}
      </Dialog>
    </li>
  );
}

export function VaultSectionTrigger({
  items,
  title,
}: {
  readonly items: readonly VaultItem[];
  readonly title: string;
}) {
  return (
    <DialogTrigger
      render={
        <Button
          className="flex w-full items-baseline justify-between gap-4 py-[0.6rem]"
          size="none"
          type="button"
          variant="act"
        />
      }
    >
      <span className="type-row min-w-0 flex-1">{title}</span>
      <span className="type-status shrink-0 text-muted-foreground">
        {items.length > 0 ? savedCount(items.length) : "Пока пусто"}
      </span>
    </DialogTrigger>
  );
}

function savedCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const noun =
    mod10 === 1 && mod100 !== 11
      ? "запись"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "записи"
        : "записей";
  return `${count.toLocaleString("ru-RU")} ${noun}`;
}

export function VaultSectionContent({
  children,
  view,
}: {
  readonly children: ReactNode;
  readonly view: VaultSectionView;
}) {
  return (
    <DialogContent
      animated={false}
      className={
        view === "list"
          ? "grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-none sm:rounded-none"
          : "no-scrollbar overflow-y-auto rounded-none sm:rounded-none"
      }
      variant="responsive"
    >
      {children}
    </DialogContent>
  );
}

export function VaultSectionBackButton({
  onClick,
  title,
}: {
  readonly onClick: () => void;
  readonly title: string;
}) {
  return (
    <Button onClick={onClick} size="act-sm" type="button" variant="act">
      <ArrowLeftIcon />
      {title}
    </Button>
  );
}

export function VaultItemBrowser({
  items,
  searchId,
  title,
}: {
  readonly items: readonly VaultItem[];
  readonly searchId: string;
  readonly title: string;
}) {
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(VAULT_DIALOG_PAGE_SIZE);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter((item) =>
        `${item.label}\n${item.account}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      )
    : items;
  const visibleItems = filteredItems.slice(0, visibleCount);

  return (
    <>
      {items.length > 0 ? (
        <div>
          <Label className="sr-only" htmlFor={searchId}>
            Поиск: {title.toLocaleLowerCase()}
          </Label>
          <InputGroup className="rounded-none border-foreground">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              id={searchId}
              onChange={(event) => {
                setQuery(event.target.value);
                setVisibleCount(VAULT_DIALOG_PAGE_SIZE);
              }}
              placeholder="Поиск по метке или аккаунту"
              type="search"
              value={query}
            />
          </InputGroup>
        </div>
      ) : (
        <div />
      )}

      <section
        aria-label={`${title}: список`}
        className="-mx-4 no-scrollbar min-h-0 overflow-y-auto px-4"
        onScroll={(event) => {
          const list = event.currentTarget;
          const nearEnd =
            list.scrollHeight - list.scrollTop - list.clientHeight < 96;
          if (nearEnd && visibleCount < filteredItems.length) {
            setVisibleCount((count) =>
              Math.min(count + VAULT_DIALOG_PAGE_SIZE, filteredItems.length)
            );
          }
        }}
      >
        {visibleItems.length > 0 ? (
          <VaultItemList items={visibleItems} />
        ) : query.trim() ? (
          <p className="type-fine py-10 text-center text-muted-foreground">
            Ничего не нашлось по «{query.trim()}»
          </p>
        ) : (
          <p className="type-fine py-10 text-center text-muted-foreground">
            Пока пусто.
          </p>
        )}
      </section>
    </>
  );
}

export function VaultItemList({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  return (
    <ul className="list-none">
      {items.map((item) => (
        <VaultItemRow item={item} key={item.id} />
      ))}
    </ul>
  );
}

function VaultItemRow({ item }: { readonly item: VaultItem }) {
  const router = useRouter();
  const remove = api.vault.remove.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  return (
    <li className="flex min-w-0 items-baseline justify-between gap-4 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]">
      <div className="type-row min-w-0 flex-1">
        <p className="truncate">{item.label}</p>
        {item.account ? (
          <p className="type-status truncate text-muted-foreground">
            {item.account}
          </p>
        ) : null}
      </div>
      <Button
        aria-label={`Удалить ${item.label}`}
        className="shrink-0"
        disabled={remove.isPending}
        onClick={() => {
          remove.mutate({ id: item.id });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Удалить
      </Button>
    </li>
  );
}
