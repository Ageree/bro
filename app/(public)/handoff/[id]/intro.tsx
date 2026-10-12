import { Button } from "@web/components/ui/button";
import { introText } from "./copy";

/**
 * What the person reads before the window opens: what the screen is, that
 * they drive it from here, and that the password goes to the site, not Bro.
 */
export function Intro({
  domain,
  onStart,
}: {
  readonly domain: string;
  readonly onStart: () => void;
}) {
  return (
    <div className="flex max-w-[34rem] flex-col gap-4">
      <h1 className="type-page-title wrap-break-word">Вход на {domain}</h1>
      <p className="type-body">{introText.control}</p>
      <p className="type-body">
        <strong>{introText.signIn(domain)}</strong> {introText.password}
      </p>
      <p className="type-body">{introText.remember}</p>
      <p className="type-caption text-muted-foreground">{introText.share}</p>
      <div>
        <Button className="w-full sm:w-auto" onClick={onStart} variant="paper">
          Начать
        </Button>
      </div>
    </div>
  );
}
