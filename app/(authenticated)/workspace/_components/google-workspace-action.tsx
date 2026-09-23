"use client";

import type { GoogleWorkspaceConnection } from "@shared/google-workspace/connection";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

export function GoogleWorkspaceAction({
  state,
}: {
  readonly state?: GoogleWorkspaceConnection["state"];
}) {
  const update = api.googleWorkspace.update.useMutation({
    onError: () => {
      window.location.assign("/workspace?google=unavailable");
    },
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });

  if (!state) return <span>Загружаем…</span>;
  if (state === "unavailable") return <span>Нужна настройка</span>;
  // A read that failed just now is not a missing grant: no OAuth from here.
  if (state === "error") return <span>Google не отвечает</span>;

  if (state === "connected") {
    return (
      <Button
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ action: "disconnect" });
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
          update.mutate({ access: "full", action: "connect" });
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
          update.mutate({ access: "read_only", action: "connect" });
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
