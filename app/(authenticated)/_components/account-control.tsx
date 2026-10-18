"use client";

import { Button } from "@web/components/ui/button";

/**
 * The foot of the cabinet: who is signed in, set as fine print, and the one
 * way out. The layout passes the phone it already read on the server, and
 * the Better Auth client loads only when «Выйти» is pressed: no session
 * request after hydration, and none of its code in every cabinet page.
 */
export function AuthenticatedAccountControl({
  phoneNumber,
}: {
  readonly phoneNumber: string | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="type-status text-background/70">
        {phoneNumber ?? "В системе"}
      </p>
      <Button
        className="border-background bg-transparent text-background hover:bg-background/10"
        onClick={() => {
          void import("@web/auth/client")
            .then(async ({ authClient }) => authClient.signOut())
            .finally(() => {
              window.location.assign("/sign-in");
            });
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        Выйти
      </Button>
    </div>
  );
}
