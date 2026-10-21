import type { EveAuthorizationPart } from "eve/react";
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";

export function AuthorizationPrompt({
  part,
}: {
  readonly part: EveAuthorizationPart;
}) {
  const isAuthorized =
    part.state === "completed" && part.outcome === "authorized";
  const isCompleted = part.state === "completed";
  const Icon = isAuthorized
    ? CheckCircleIcon
    : isCompleted
      ? XCircleIcon
      : KeyRoundIcon;
  const instructions = part.authorization?.instructions;
  const shouldShowInstructions =
    instructions !== undefined && instructions !== part.description;
  const alertVariant = isAuthorized
    ? "success"
    : isCompleted
      ? "destructive"
      : "information";

  return (
    <Alert className="rounded-2xl px-4 py-3" variant={alertVariant}>
      <Icon />
      <AlertTitle>{authorizationTitle(part)}</AlertTitle>
      <AlertDescription>
        <p>{authorizationDescription(part)}</p>
        {shouldShowInstructions ? <p>{instructions}</p> : null}
        {part.state === "required" && part.authorization?.userCode ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Код</span>
            <Badge variant="outline">
              <code className="type-compact-code">
                {part.authorization.userCode}
              </code>
            </Badge>
          </div>
        ) : null}
        {part.state === "required" && part.authorization?.url ? (
          <Button
            render={
              <a
                aria-label={`Войти через ${part.displayName}`}
                href={part.authorization.url}
                rel="noreferrer"
                target="_blank"
              />
            }
            size="lg"
            variant="paper"
          >
            <ExternalLinkIcon />
            Войти через {part.displayName}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function authorizationTitle(part: EveAuthorizationPart): string {
  if (part.state === "required") return `Подключи ${part.displayName}`;
  if (part.outcome === "authorized") return `${part.displayName} подключён`;
  return `${part.displayName} не подключён`;
}

function authorizationDescription(part: EveAuthorizationPart): string {
  if (part.state === "required") return part.description;
  if (part.outcome === "authorized") return `${part.displayName} подключён.`;
  const tail = part.reason !== undefined ? ` (${part.reason})` : "";
  return `Вход в ${part.displayName}: ${formatAuthorizationOutcome(part.outcome)}${tail}.`;
}

function formatAuthorizationOutcome(
  outcome: NonNullable<EveAuthorizationPart["outcome"]>
): string {
  switch (outcome) {
    case "authorized":
      return "выполнен";
    case "declined":
      return "отклонён";
    case "failed":
      return "не удался";
    case "timed-out":
      return "время вышло";
  }
  throw new Error("Unsupported authorization outcome.");
}
