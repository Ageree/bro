// The part of Telegram's Mini App object that bro's pages use
// (https://core.telegram.org/bots/webapps), declared once for every page: two
// declarations of `Window.Telegram` would not merge. What an older client
// lacks is optional.
interface TelegramWebApp {
  readonly initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string): void;
  isVersionAtLeast(version: string): boolean;
  readonly BackButton?: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  /** Bot API 6.1 and later; older clients have none. */
  readonly HapticFeedback?: {
    impactOccurred(
      style: "light" | "medium" | "heavy" | "rigid" | "soft"
    ): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
