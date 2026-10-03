"use client";

import type { readConnectedApp } from "@shared/composio/connected-apps";
import { Button } from "@web/components/ui/button";
import { api } from "@web/trpc/client";

type CabinetApp = Parameters<
  ReturnType<typeof api.connectedApps.update.useMutation>["mutate"]
>[0]["app"];

type ConnectionState = Awaited<ReturnType<typeof readConnectedApp>>["state"];

export function ConnectedAppAction({
  app,
  name,
  state,
}: {
  readonly app: CabinetApp;
  readonly name: string;
  readonly state: ConnectionState;
}) {
  const update = api.connectedApps.update.useMutation({
    onError: () => {
      // An account appeared since the page rendered, or the service did not
      // answer: show the connection as it is now.
      window.location.assign("/workspace");
    },
    onSuccess: ({ redirectTo }) => {
      window.location.assign(redirectTo);
    },
  });

  if (state === "unavailable") return <span>Нужна настройка</span>;
  // A read that failed just now is not a missing account: no link from here.
  if (state === "error") return <span>{name} не отвечает</span>;

  return (
    <Button
      disabled={update.isPending}
      onClick={() => {
        update.mutate({
          action: state === "connected" ? "disconnect" : "connect",
          app,
        });
      }}
      size="act-sm"
      type="button"
      variant="act"
    >
      {state === "connected" ? "Отключить" : "Подключить"}
    </Button>
  );
}
