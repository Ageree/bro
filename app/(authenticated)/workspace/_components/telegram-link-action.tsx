"use client";

import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

export function TelegramLinkAction({ linked }: { readonly linked: boolean }) {
  const link = api.telegram.link.useMutation();

  if (link.data) {
    return (
      <Button
        nativeButton={false}
        render={
          <a
            aria-label="Open the Telegram link"
            href={link.data.url}
            rel="noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="outline"
      >
        Open the link
      </Button>
    );
  }

  return (
    <Button
      disabled={link.isPending}
      onClick={() => {
        link.mutate();
      }}
      size="sm"
      type="button"
      variant="outline"
    >
      {linked ? "Relink Telegram" : "Link Telegram"}
    </Button>
  );
}
