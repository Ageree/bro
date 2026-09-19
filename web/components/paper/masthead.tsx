import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The masthead of every public page: the wordmark in the middle, whatever
 * the page needs at either side. Both sides take the same share of the
 * width, so the wordmark stays centred whether a side is empty or a nav.
 */
export function Masthead({
  end,
  start,
}: {
  readonly end?: ReactNode;
  readonly start?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-4 p-bro-pad">
      <div className="flex flex-1 basis-0 gap-[0.9rem]">{start}</div>
      <Link className="type-wordmark bro-link" href="/">
        bro.
      </Link>
      <div className="flex flex-1 basis-0 justify-end gap-[0.9rem]">{end}</div>
    </header>
  );
}

export function OfferLink() {
  return (
    <Link className="type-nav bro-link" href="/oferta">
      Оферта
    </Link>
  );
}
