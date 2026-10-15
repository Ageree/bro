import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The foot of every page: an ink band with the page links and the wordmark
 * set as large as the page is wide. `children` carries what only some pages
 * have, like who is signed in.
 */
export function SiteFooter({ children }: { readonly children?: ReactNode }) {
  return (
    <footer className="mt-16 overflow-hidden bg-foreground px-bro-pad pt-8 pb-0 text-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
        <span className="type-wordmark">bro.</span>
        <nav
          aria-label="Служебные страницы"
          className="type-nav flex flex-wrap gap-x-8 gap-y-2"
        >
          <Link className="bro-link" href="/oferta">
            Оферта
          </Link>
          <Link className="bro-link" href="/privacy">
            Конфиденциальность
          </Link>
        </nav>
      </div>
      {children ? (
        <div className="mx-auto mt-6 max-w-6xl">{children}</div>
      ) : null}
      <p
        aria-hidden="true"
        className="mx-auto mt-10 max-w-6xl text-[clamp(7rem,30vw,22rem)] leading-[0.78] font-semibold tracking-[-0.06em] select-none"
      >
        bro.
      </p>
    </footer>
  );
}
