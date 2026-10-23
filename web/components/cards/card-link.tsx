"use client";

import type { ReactNode } from "react";

type TelegramApp = NonNullable<Window["Telegram"]>["WebApp"];

function canOpenLink(
  app: TelegramApp
): app is NonNullable<TelegramApp> & { openLink(url: string): void } {
  return app !== undefined && "openLink" in app;
}

/**
 * A link of a card. Inside a Telegram Mini App it opens through the app's
 * own `openLink`, which leaves the card open behind the browser; anywhere
 * else it is a plain anchor. Only a web link gets a new window: a phone call
 * or an email is handed to the system as it is.
 */
export function CardLink({
  children,
  className,
  href,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly href: string;
}) {
  const web = href.startsWith("https://");
  return (
    <a
      className={className}
      href={href}
      onClick={(event) => {
        const app = window.Telegram?.WebApp;
        if (!web || !canOpenLink(app)) return;
        event.preventDefault();
        app.openLink(href);
      }}
      rel="noopener noreferrer"
      target={web ? "_blank" : undefined}
    >
      {children}
    </a>
  );
}
