import {
  BotIcon,
  CreditCardIcon,
  GlobeIcon,
  ImageIcon,
  MailIcon,
  MessageSquareIcon,
  SendIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { readBillingState } from "@db/services/billing";
import { readChannelIdentity } from "@db/services/channel-identities";
import { getWorkspaceModelId } from "@db/services/settings";
import { yooKassaConfigured } from "@db/services/yookassa";
import { env } from "@shared/environment";
import { photonConfigured } from "@shared/photon/credentials";
import { openRouterActive } from "@shared/model/provider";
import {
  type GoogleWorkspaceConnection,
  readGoogleWorkspaceConnection,
} from "@shared/google-workspace/connection";
import { telegramLinkConfigured } from "@shared/identity/telegram-link";
import { requireRequestScope } from "@web/auth/request-scope";
import { GoogleWorkspaceAction } from "./_components/google-workspace-action";
import { ModelSelector } from "./_components/model-selector";
import { TelegramLinkAction } from "./_components/telegram-link-action";

export default async function Page({ searchParams }: PageProps<"/workspace">) {
  const google = (await searchParams).google;
  const scope = await requireRequestScope();
  const telegramConfigured = telegramLinkConfigured();
  const [googleWorkspace, workspaceModel, telegramIdentity, billing] =
    await Promise.all([
      readGoogleWorkspaceConnection(scope.userId),
      getWorkspaceModelId(scope),
      telegramConfigured ? readChannelIdentity(scope, "telegram") : undefined,
      readBillingState(scope),
    ]);
  const openRouter = openRouterActive();
  const imageStorageReady = Boolean(
    env.BLOB_STORE_ID ?? env.BLOB_READ_WRITE_TOKEN
  );
  const browserReady = env.BROWSER_USE_API_KEY !== undefined;

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      {google === "unavailable" ? (
        <Alert>
          <MailIcon />
          <AlertTitle>Google Workspace unavailable</AlertTitle>
          <AlertDescription>
            This deployment does not have a working Google OAuth connector yet.
          </AlertDescription>
        </Alert>
      ) : null}

      <ChannelsSection
        imessageConfigured={photonConfigured()}
        imessagePhoneNumber={env.IMESSAGE_PHONE_NUMBER}
      />
      <GoogleWorkspaceSection connection={googleWorkspace} />
      <SubscriptionSection paid={billing.paid} paidUntil={billing.paidUntil} />
      {telegramConfigured ? (
        <TelegramSection username={telegramIdentity?.username ?? null} />
      ) : null}

      <WorkspaceSection headingId="connectors-heading" title="Infrastructure">
        <div className="divide-y divide-border/50 border-y border-border/50">
          <ConnectorRow
            action={
              <Badge variant={imageStorageReady ? "success" : "secondary"}>
                {imageStorageReady ? "Connected" : "Setup required"}
              </Badge>
            }
            description={
              imageStorageReady
                ? "Store image artifacts in a private Vercel Blob store."
                : "Connect a private Vercel Blob store to share image artifacts."
            }
            icon={<ImageIcon />}
            label="Vercel Blob"
          />
          <ConnectorRow
            action={
              <Badge variant={browserReady ? "success" : "secondary"}>
                {browserReady ? "Configured" : "Not configured"}
              </Badge>
            }
            description={
              browserReady
                ? "Run website errands in a hosted cloud browser."
                : "Set BROWSER_USE_API_KEY to run website errands."
            }
            icon={<GlobeIcon />}
            label="Browser"
          />
          <ConnectorRow
            action={
              <ModelSelector modelId={workspaceModel} openRouter={openRouter} />
            }
            description={workspaceModel}
            icon={<BotIcon />}
            label={openRouter ? "Model (OpenRouter)" : "AI Gateway model"}
          />
        </div>
      </WorkspaceSection>
    </div>
  );
}

function GoogleWorkspaceSection({
  connection,
}: {
  readonly connection?: GoogleWorkspaceConnection;
}) {
  const state = connection?.state;
  const description =
    state === "connected"
      ? (connection?.accountLabel ?? "Gmail, Calendar, and Contacts connected.")
      : state === "unavailable"
        ? "Attach a Vercel Connect Google OAuth connector to enable this."
        : "Gmail, Calendar, and Contacts through your Google account.";

  return (
    <WorkspaceSection headingId="connections-heading" title="Connections">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={<GoogleWorkspaceAction state={state} />}
          description={description}
          icon={<MailIcon />}
          label="Google Workspace"
        />
      </div>
    </WorkspaceSection>
  );
}

function SubscriptionSection({
  paid,
  paidUntil,
}: {
  readonly paid: boolean;
  readonly paidUntil: Date | null;
}) {
  return (
    <WorkspaceSection headingId="subscription-heading" title="Подписка">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={
            yooKassaConfigured() ? (
              <Button
                nativeButton={false}
                render={<Link href="/api/pay" prefetch={false} />}
                variant="surface"
              >
                <CreditCardIcon />
                {`Оплатить ${String(env.PRICE_RUB)} ₽ в месяц`}
              </Button>
            ) : (
              <Badge variant="secondary">Оплата не подключена</Badge>
            )
          }
          description={
            paidUntil && paid
              ? `Оплачено до ${subscriptionDate.format(paidUntil)}.`
              : "Бесплатно до лимитов: дневной лимит сообщений и месячный лимит браузерных поручений."
          }
          icon={<CreditCardIcon />}
          label={paid ? "Оплачено" : "Бесплатно"}
        />
      </div>
    </WorkspaceSection>
  );
}

const subscriptionDate = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "long",
  timeZone: "Europe/Moscow",
});

function TelegramSection({ username }: { readonly username: string | null }) {
  return (
    <WorkspaceSection headingId="telegram-heading" title="Telegram">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={<TelegramLinkAction linked={username !== null} />}
          description={
            username
              ? `Linked as @${username}. Messages from that Telegram account run as this workspace.`
              : "Not linked. Open a one-time link to connect your Telegram account to this workspace."
          }
          icon={<SendIcon />}
          label="Telegram"
        />
      </div>
    </WorkspaceSection>
  );
}

export function ChannelsSection({
  imessageConfigured,
  imessagePhoneNumber,
}: {
  readonly imessageConfigured: boolean;
  readonly imessagePhoneNumber?: string;
}) {
  return (
    <WorkspaceSection headingId="channels-heading" title="Channels">
      <div className="grid gap-2 sm:grid-cols-2">
        <Button
          nativeButton={false}
          render={<Link href="/chat" />}
          variant="surface"
        >
          <MessageSquareIcon />
          WebChat
        </Button>
        {imessageConfigured && imessagePhoneNumber ? (
          <Button
            nativeButton={false}
            render={
              <a
                aria-label="Open iMessage"
                href={`sms:${imessagePhoneNumber}`}
              />
            }
            variant="surface"
          >
            <MailIcon />
            iMessage
          </Button>
        ) : (
          <Button disabled variant="surface">
            <MailIcon />
            iMessage
          </Button>
        )}
      </div>
      <p className="type-caption text-muted-foreground">
        {channelAvailabilityMessage({
          imessageConfigured,
          imessagePhoneNumber,
        })}
      </p>
    </WorkspaceSection>
  );
}

function channelAvailabilityMessage({
  imessageConfigured,
  imessagePhoneNumber,
}: {
  readonly imessageConfigured: boolean;
  readonly imessagePhoneNumber?: string;
}) {
  return [
    "WebChat is ready.",
    imessageConfigured && imessagePhoneNumber
      ? `iMessage opens ${imessagePhoneNumber}.`
      : imessageConfigured
        ? "Photon is connected. Use its iMessage line to start a conversation."
        : "Set up Photon to enable iMessage.",
  ].join(" ");
}

function WorkspaceSection({
  children,
  headingId,
  title,
}: {
  readonly children: ReactNode;
  readonly headingId: string;
  readonly title: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 className="type-section-title" id={headingId}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ConnectorRow({
  action,
  description,
  icon,
  label,
}: {
  readonly action: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="type-label">{label}</p>
        <p className="truncate type-caption text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
