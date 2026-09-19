import type { ReactNode } from "react";

import { cn } from "@web/components/class-names";

/**
 * Paper — the cabinet, the vault and the offer.
 *
 * The landing is one screen with a figure standing in it; these pages are
 * paper. Same white, same serif, same rule that chrome is text. A page is a
 * single column of sections divided by hairlines: no cards, no radius, no
 * shadow, nothing floating over a photograph.
 */
export function Document({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[42rem] px-bro-pad pt-[0.6rem] pb-20",
        className
      )}
    >
      {children}
    </div>
  );
}

/** The title of the page — there is no other h1. */
export function DocumentTitle({ children }: { readonly children: ReactNode }) {
  return <h1 className="type-doc-title mb-[0.55rem]">{children}</h1>;
}

/**
 * Every section is the same shape: a serif heading with the current state
 * set small and grey on the same line, then whatever the section has to
 * say. No card, no border but the hairline above it.
 */
export function Section({
  children,
  headingId,
  state,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly state?: ReactNode;
  readonly title: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="mt-8 border-t border-border pt-[1.6rem]"
    >
      <div className="mb-[0.55rem] flex items-baseline justify-between gap-4">
        <h2 className="type-sec-title" id={headingId}>
          {title}
        </h2>
        {state ? (
          <span className="type-status shrink-0 text-right text-muted-foreground">
            {state}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Rows: memories, vault items, payments. */
export function Rows({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <ul className={cn("mt-[0.6rem] list-none", className)}>{children}</ul>;
}

export function Row({
  children,
  className,
  side,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly side?: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-baseline justify-between gap-4 border-t border-border py-[0.6rem] first:border-t-0 first:pt-[0.2rem]",
        className
      )}
    >
      <div className="type-row min-w-0 flex-1 wrap-break-word [&>p+p]:mt-[0.1rem]">
        {children}
      </div>
      {side !== undefined ? (
        <div className="type-status shrink-0 text-muted-foreground [&_[data-slot=button]]:text-foreground">
          {side}
        </div>
      ) : null}
    </li>
  );
}

/**
 * A quota reads as a rule that is partly inked in — square ends. It only
 * illustrates the line of text above it, which carries the numbers.
 */
export function Meter({
  allowance,
  used,
}: {
  readonly allowance: number;
  readonly used: number;
}) {
  const percent =
    allowance > 0
      ? Math.max(0, Math.min(100, Math.round((used / allowance) * 100)))
      : 0;
  return (
    <div
      aria-hidden="true"
      className="mt-[0.45rem] mb-[1.1rem] h-0.5 bg-border last:mb-[0.2rem]"
    >
      <div
        className="h-full bg-foreground"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}

/** Actions: text, like the call to action on the landing. */
export function Actions({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2",
        className
      )}
    >
      {children}
    </div>
  );
}

export function StatusLine({
  children,
  className,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "type-status text-muted-foreground empty:hidden",
        className
      )}
    >
      {children}
    </p>
  );
}

/** The one line that sits between two ink rules: a notice that must be read. */
export function Flash({ children }: { readonly children: ReactNode }) {
  return (
    <p className="type-row mt-[1.6rem] border-y border-foreground py-[0.9rem]">
      {children}
    </p>
  );
}
