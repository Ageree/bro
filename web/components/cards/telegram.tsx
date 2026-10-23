"use client";

import Script from "next/script";
import { createContext, type ReactNode, use, useState } from "react";
import { Button } from "@web/components/ui/button";

const paper = "#F1F2EE";

/**
 * Telegram's signed launch data of the Mini App (`Telegram.WebApp.initData`):
 * null while its script loads, empty outside Telegram.
 */
const TelegramLaunch = createContext<string | null>(null);

/**
 * The page opened by the button under a card's message in Telegram is a Mini
 * App: Telegram's script says it is ready, opens it to the full height, and
 * paints its header and background as the paper the card lies on. Outside
 * Telegram the script finds no launch data and the page is a plain one; a
 * script that did not load leaves it the same.
 */
export function TelegramScope({ children }: { readonly children: ReactNode }) {
  const [launch, setLaunch] = useState<string | null>(null);
  return (
    <TelegramLaunch value={launch}>
      <Script
        onError={() => {
          setLaunch("");
        }}
        onReady={() => {
          const app = window.Telegram?.WebApp;
          if (!app) {
            setLaunch("");
            return;
          }
          app.ready();
          app.expand();
          app.setHeaderColor(paper);
          app.setBackgroundColor(paper);
          setLaunch(app.initData);
        }}
        src="https://telegram.org/js/telegram-web-app.js"
      />
      {children}
    </TelegramLaunch>
  );
}

/** The launch data the page was opened with: null while it is not known yet. */
export function useTelegramLaunch() {
  return use(TelegramLaunch);
}

/**
 * A tap the phone feels inside Telegram: a choice made, an answer sent or
 * turned away. Nothing where Telegram is older than haptics (6.1) or absent.
 */
export function haptic(kind: "error" | "selection" | "success" | "warning") {
  const app = window.Telegram?.WebApp;
  const feedback = app?.HapticFeedback;
  if (!app || !feedback || !app.isVersionAtLeast("6.1")) return;
  if (kind === "selection") {
    feedback.selectionChanged();
    return;
  }
  feedback.notificationOccurred(kind);
}

/** Back to the chat: the Mini App closes onto it. Only inside Telegram. */
export function BackToBro({
  variant = "paper",
}: {
  readonly variant?: "outline" | "paper";
}) {
  const launch = useTelegramLaunch();
  if (launch === null || launch === "") return null;
  return (
    <Button
      className="w-full"
      onClick={() => {
        window.Telegram?.WebApp?.close();
      }}
      variant={variant}
    >
      Вернуться к Бро
    </Button>
  );
}
