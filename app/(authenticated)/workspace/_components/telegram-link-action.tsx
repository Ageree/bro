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
        size="act-sm"
        variant="act"
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
      size="act-sm"
      type="button"
      variant="act"
    >
      {linked ? "Перепривязать" : "Привязать"}
    </Button>
  );
}
