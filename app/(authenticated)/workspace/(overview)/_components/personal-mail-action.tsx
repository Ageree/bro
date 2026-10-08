"use client";

import type { readMailConnection } from "@db/services/mail";
import type { MailProvider } from "@shared/mail/schema";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

export function PersonalMailAction({
  provider,
  state,
}: {
  readonly provider: MailProvider;
  readonly state: Awaited<ReturnType<typeof readMailConnection>>["state"];
}) {
  const update = api.personalMail.update.useMutation({
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
    onError: () => {
      window.location.assign(`/workspace?mail=${provider}&mailStatus=failed`);
    },
  });
  if (state === "unavailable") return <span>Нужна настройка</span>;
  if (state === "connected") {
    return (
      <Button
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ action: "disconnect", provider });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Отключить
      </Button>
    );
  }
  return (
    <span className="flex flex-wrap justify-end gap-x-4 gap-y-1">
      <Button
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ action: "connect", provider, access: "full" });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Подключить
      </Button>
      <Button
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ action: "connect", provider, access: "read_only" });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Только чтение
      </Button>
    </span>
  );
}
