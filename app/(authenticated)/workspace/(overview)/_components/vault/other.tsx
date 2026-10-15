"use client";

import type { VaultItem } from "@shared/vault/schema";
import { VaultItemList } from "./section";

/** Items the agent stored itself: a phone, an identity, a token. */
export function VaultOtherItems({
  items,
}: {
  readonly items: readonly VaultItem[];
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <p className="type-fine mt-6 mb-[0.2rem] text-muted-foreground">Прочее</p>
      <VaultItemList items={items} />
    </div>
  );
}
