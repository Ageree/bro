"use client";

import { useEffect } from "react";
import { Button } from "@web/components/ui/button";

/**
 * The foot of the cabinet: who is signed in, set as fine print, and the one
 * way out. The layout passes the phone it already read on the server, and
 * the footer talks to the Better Auth routes with plain requests: none of its
 * client in every cabinet page.
 */
export function AuthenticatedAccountControl({
  phoneNumber,
}: {
  readonly phoneNumber: string | undefined;
}) {
  // Only an answer of the auth route itself renews the session cookie: the
  // server reads (proxy, layout, tRPC) extend the row and drop `Set-Cookie`.
  // The footer asks it as Better Auth's `useSession` did before: once the page
  // is idle, off its first paint, and again whenever the tab comes back, at
  // most every 5 s — a tab left open past a day renews on its return.
  useEffect(() => {
    let lastAsked = 0;
    const renew = () => {
      if (Date.now() - lastAsked < 5000) return;
      lastAsked = Date.now();
      fetch("/api/auth/get-session", {
        cache: "no-store",
        credentials: "same-origin",
      }).catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    const idle =
      "requestIdleCallback" in window
        ? window.requestIdleCallback(renew, { timeout: 5000 })
        : undefined;
    const timer = idle === undefined ? setTimeout(renew, 1000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (idle !== undefined) window.cancelIdleCallback(idle);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <p className="type-status text-background/70">
        {phoneNumber ?? "В системе"}
      </p>
      <Button
        className="border-background bg-transparent text-background hover:bg-background/10"
        onClick={() => {
          // A plain request, not a lazily loaded client: a tab opened before
          // a release would ask for a chunk the release removed, fail, and
          // go to /sign-in with the session still alive.
          void fetch("/api/auth/sign-out", {
            body: "{}",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            method: "POST",
          })
            .catch(() => undefined)
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
