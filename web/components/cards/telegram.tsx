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

/** How many layers hold the page still, and its scrolling from before them. */
const held = { count: 0, overflow: "" };
const backLayers: (() => void)[] = [];
const back = () => backLayers.at(-1)?.();

/** Routes Telegram's back button to the topmost open card layer. */
export function holdBack(onBack: () => void) {
  const button = window.Telegram?.WebApp?.BackButton;
  if (!button) return () => undefined;
  if (backLayers.length === 0) {
    button.show();
    button.onClick(back);
  }
  backLayers.push(onBack);
  return () => {
    const index = backLayers.lastIndexOf(onBack);
    if (index >= 0) backLayers.splice(index, 1);
    if (backLayers.length === 0) {
      button.offClick(back);
      button.hide();
    }
  };
}

/**
 * Holds the page still under a layer over it — the photo viewer, a variant's
 * «Подробнее» — until the release it returns is called: the page does not
 * scroll, and inside Telegram (7.7 and later) the Mini App's own
 * pull-to-close waits, so a pull closes the layer and not the card. Layers
 * opened over each other share one hold, and the last one released lets go.
 */
export function holdScreen() {
  const page = document.documentElement;
  const app = window.Telegram?.WebApp;
  const telegram =
    app?.initData && app.isVersionAtLeast("7.7") ? app : undefined;
  if (held.count === 0) {
    held.overflow = page.style.overflow;
    page.style.overflow = "hidden";
    telegram?.disableVerticalSwipes?.();
  }
  held.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0) return;
    page.style.overflow = held.overflow;
    telegram?.enableVerticalSwipes?.();
  };
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
