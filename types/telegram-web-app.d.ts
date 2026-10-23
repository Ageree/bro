// The part of Telegram's Mini App object that bro's pages use
// (https://core.telegram.org/bots/webapps), declared once for every page: two
// declarations of `Window.Telegram` would not merge.
interface TelegramWebApp {
  readonly initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openLink(url: string): void;
}

interface Window {
  Telegram?: { WebApp?: TelegramWebApp };
}
