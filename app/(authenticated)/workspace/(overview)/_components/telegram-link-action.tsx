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
            aria-label="Открыть ссылку Telegram"
            href={link.data.url}
            rel="noreferrer"
            target="_blank"
          />
        }
        size="sm"
        variant="outline"
      >
        Открыть ссылку
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
      {linked ? "Перепривязать" : "Привязать"}
    </Button>
  );
}
