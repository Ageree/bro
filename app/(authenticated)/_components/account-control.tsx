"use client";

import { authClient } from "@web/auth/client";
import { Button } from "@web/components/ui/button";

/**
 * The foot of the rail: who is signed in, set as fine print, and the one
 * way out — text, like every other action on this paper.
 */
export function AuthenticatedAccountControl() {
  const { data: session } = authClient.useSession();
  if (!session?.user) return null;

  return (
    <div className="px-bro-rail pb-bro-rail">
      <p className="type-status text-muted-foreground">
        {session.user.phoneNumber ?? "В системе"}
      </p>
      <Button
        className="mb-[-0.5rem] py-[0.5rem]"
        onClick={() => {
          void authClient.signOut().finally(() => {
            window.location.assign("/sign-in");
          });
        }}
        size="act-sm"
        type="button"
        variant="act"
      >
        Выйти
      </Button>
    </div>
  );
}
