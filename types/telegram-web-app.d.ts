// The part of Telegram's Mini App object that bro's pages use
// (https://core.telegram.org/bots/webapps), declared once for every page: two
// declarations of `Window.Telegram` would not merge. What an older client
// lacks is optional.
interface TelegramWebApp {
  readonly initData: string;
  readonly HapticFeedback?: { selectionChanged(): void };
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string): void;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
