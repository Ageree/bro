"use client";

import Script from "next/script";
import { createContext, type ReactNode, use, useState } from "react";
import { Button } from "@web/components/ui/button";

const paper = "#F1F2EE";

const InTelegram = createContext(false);

/**
 * The page opened by the button under a card's message in Telegram is a Mini
 * App: Telegram's script says it is ready, opens it to the full height, and
 * paints its header and background as the paper the card lies on. Outside
 * Telegram the script finds no launch data and the page is a plain one.
 */
export function TelegramScope({ children }: { readonly children: ReactNode }) {
  const [inTelegram, setInTelegram] = useState(false);
  return (
    <InTelegram value={inTelegram}>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        onReady={() => {
          const app = window.Telegram?.WebApp;
          if (!app) return;
          app.ready();
          app.expand();
          app.setHeaderColor(paper);
          app.setBackgroundColor(paper);
          setInTelegram(app.initData !== "");
        }}
      />
      {children}
    </InTelegram>
  );
}

/** Back to the chat: the Mini App closes onto it. Only inside Telegram. */
export function BackToBro() {
  if (!use(InTelegram)) return null;
  return (
    <Button
      className="w-full"
      onClick={() => {
        window.Telegram?.WebApp?.close();
      }}
      variant="paper"
    >
      Вернуться к Бро
    </Button>
  );
}
