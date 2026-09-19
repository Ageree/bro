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

  const action = state === "connected" ? "disconnect" : "connect";
  return (
    <Button
      disabled={update.isPending}
      onClick={() => {
        update.mutate(action);
      }}
      size="act-sm"
      type="button"
      variant="act"
    >
      {state === "connected" ? "Отключить" : "Подключить"}
    </Button>
  );
}
