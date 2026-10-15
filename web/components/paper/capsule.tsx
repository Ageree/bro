import Link from "next/link";

import { cn } from "@web/components/class-names";

export interface CapsuleItem {
  readonly href: string;
  readonly id: string;
  readonly label: string;
}

/**
 * The navigation of every page: a white capsule with an ink border, fixed at
 * the top and centred. The wordmark leads it, the page you are on is an ink
 * pill and the rest is grey. On a narrow screen the capsule scrolls sideways
 * inside the page margin instead of wrapping.
 */
export function Capsule({
  active,
  items,
  wordmarkHref = "/",
}: {
  readonly active?: string;
  readonly items: readonly CapsuleItem[];
  readonly wordmarkHref?: string;
}) {
  return (
    <header className="pointer-events-none fixed inset-x-0 top-4 z-40 flex justify-center px-4">
      <nav
        aria-label="Основная навигация"
        className="pointer-events-auto flex max-w-full [scrollbar-width:none] items-center gap-1 overflow-x-auto bro-capsule py-1 pr-1 pl-4 [&::-webkit-scrollbar]:hidden"
      >
        <Link
          className="type-wordmark mr-2 inline-flex min-h-10 shrink-0 items-center rounded-full bro-link"
          href={wordmarkHref}
        >
          bro.
        </Link>
        {items.map((item) => (
          <Link
            aria-current={active === item.id ? "page" : undefined}
            className={cn(
              "type-nav inline-flex min-h-10 shrink-0 items-center rounded-full px-4 whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground motion-reduce:transition-none",
              active === item.id
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground"
            )}
            href={item.href}
            key={item.id}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
