"use client";

import Script from "next/script";
import { createContext, type ReactNode, use, useState } from "react";
import { Button, buttonVariants } from "@web/components/ui/button";

/** The Mini App's signed launch data: empty outside Telegram. */
const LaunchData = createContext("");

/**
 * The page opened by Bro's button in Telegram is a Mini App: Telegram's
 * script hands it the chat user's signed data, which the page's forms carry
 * to prove it is the person's (`app/api/yoomoney/onboarding/[id]`).
 */
export function TelegramScope({
  children,
  telegram,
}: {
  readonly children: ReactNode;
  readonly telegram: boolean;
}) {
  const [launchData, setLaunchData] = useState("");
  return (
    <LaunchData value={launchData}>
      {telegram && (
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          onReady={() => {
            const app = window.Telegram?.WebApp;
            if (!app) return;
            app.ready();
            app.expand();
            setLaunchData(app.initData);
          }}
        />
      )}
      {children}
    </LaunchData>
  );
}

/** The launch data, in a form of the page. */
export function LaunchDataField() {
  return <input name="initData" type="hidden" value={use(LaunchData)} />;
}

/**
 * Back to the chat: in Telegram the Mini App closes onto it; elsewhere a
 * link, when the chat has an address to open.
 */
export function BackToChat({ href }: { readonly href?: string }) {
  const inTelegram = use(LaunchData) !== "";
  if (inTelegram) {
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
  if (href === undefined) return null;
  return (
    <a
      className={buttonVariants({
        className: "w-full",
        size: "paper",
        variant: "paper",
      })}
      href={href}
    >
      Вернуться к Бро
    </a>
  );
}
