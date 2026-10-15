"use client";

import { authClient } from "@web/auth/client";
import { Button } from "@web/components/ui/button";

/**
 * The foot of the cabinet: who is signed in, set as fine print, and the one
 * way out.
 */
export function AuthenticatedAccountControl() {
  const { data: session } = authClient.useSession();
  if (!session?.user) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="type-status text-background/70">
        {session.user.phoneNumber ?? "В системе"}
      </p>
      <Button
        className="border-background bg-transparent text-background hover:bg-background/10"
        onClick={() => {
          void authClient.signOut().finally(() => {
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
