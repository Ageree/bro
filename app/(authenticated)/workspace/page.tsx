import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import {
  Actions,
  Document,
  DocumentTitle,
  Flash,
  Meter,
  Row,
  Rows,
  Section,
  StatusLine,
} from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import { getAuthSession } from "@db/services/auth/session";
import { paidPeriodDays, readBillingState } from "@db/services/billing";
import { getBrowserAutonomyPolicy } from "@db/services/browser-autonomy";
import { readChannelIdentity } from "@db/services/channel-identities";
import { getWorkspaceModelId } from "@db/services/settings";
import { readUserProfile } from "@db/services/user-profile";
import { listVaultItems } from "@db/services/vault";
import { yooKassaConfigured } from "@db/services/yookassa";
import { env } from "@shared/environment";
import { hasBroadBrowserAutonomy } from "@shared/browser/autonomy";
import {
  type GoogleWorkspaceConnection,
  readGoogleWorkspaceConnection,
} from "@shared/google-workspace/connection";
import { telegramLinkConfigured } from "@shared/identity/telegram-link";
import { openRouterActive } from "@shared/model/provider";
import { photonConfigured } from "@shared/photon/credentials";
import { resolveTimeZone } from "@shared/user-profile/schema";
import { requireRequestScope } from "@web/auth/request-scope";
import { GoogleWorkspaceAction } from "./_components/google-workspace-action";
import { BrowserAutonomy } from "./_components/browser-autonomy";
import { ModelSelector } from "./_components/model-selector";
import { TelegramLinkAction } from "./_components/telegram-link-action";

export const metadata: Metadata = { title: "Кабинет" };

/** The cabinet lists this many vault rows before pointing at the vault. */
const vaultPreviewRows = 8;

const dayMs = 24 * 60 * 60 * 1000;

/**
 * Whole days of the paid period already behind, clamped to it: a month
 * bought before the current one expires is not a negative day count.
 */
function paidDaysUsed(paidUntil: Date) {
  const daysLeft = Math.ceil((paidUntil.getTime() - Date.now()) / dayMs);
  return Math.min(paidPeriodDays, Math.max(0, paidPeriodDays - daysLeft));
}

/** What the cabinet shows of a vault item: the metadata, never the secret. */
type VaultPreviewItem = Awaited<ReturnType<typeof listVaultItems>>[number];

const vaultKindLabels: Partial<Record<VaultPreviewItem["kind"], string>> = {
  address: "Адрес",
  contact: "Контакт",
  login: "Вход",
  payment: "Карта",
};

export default async function Page({ searchParams }: PageProps<"/workspace">) {
  const google = (await searchParams).google;
  const requestHeaders = await headers();
  const scope = await requireRequestScope();
  const telegramConfigured = telegramLinkConfigured();
  const [
    session,
    googleWorkspace,
    workspaceModel,
    telegramIdentity,
    billing,
    profile,
    vaultItems,
    browserAutonomy,
  ] = await Promise.all([
    getAuthSession(requestHeaders),
    readGoogleWorkspaceConnection(scope.userId),
    getWorkspaceModelId(scope),
    telegramConfigured ? readChannelIdentity(scope, "telegram") : undefined,
    readBillingState(scope),
    readUserProfile(scope),
    listVaultItems(scope),
    getBrowserAutonomyPolicy(scope),
  ]);
  const openRouter = openRouterActive();
  const imageStorageReady = Boolean(
    env.BLOB_STORE_ID ?? env.BLOB_READ_WRITE_TOKEN
  );
  const browserReady = env.BROWSER_USE_API_KEY !== undefined;
  const timeZone = resolveTimeZone(profile.timezone);
  const when = new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  });
  const phoneLast4 = session?.user.phoneNumber.slice(-4);

  return (
    <Document>
      <DocumentTitle>Кабинет</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        {billing.paid ? "Полный доступ" : "Бесплатный режим"} ·{" "}
        {phoneLast4
          ? `Телефон …${phoneLast4}`
          : "Телефон ещё не привязан — напиши Bro в iMessage"}
      </p>
      <p className="type-fine text-muted-foreground">
        {billing.paidUntil
          ? `до ${when.format(billing.paidUntil)}`
          : "Оплата ещё не оформлена"}
      </p>

      <ChannelsSection
        imessageConfigured={photonConfigured()}
        imessagePhoneNumber={env.IMESSAGE_PHONE_NUMBER}
      />

      {google === "unavailable" ? (
        <Flash>
          Google Workspace недоступен: на этом деплое ещё нет рабочего
          коннектора Google OAuth.
        </Flash>
      ) : null}

      <LimitsSection paid={billing.paid} paidUntil={billing.paidUntil} />
      <PaymentsSection
        paid={billing.paid}
        paidUntil={billing.paidUntil}
        when={when}
      />
      <SiteLoginsSection
        logins={vaultItems.filter((item) => item.kind === "login")}
      />
      <VaultSection items={vaultItems} />
      <TimeZoneSection timeZone={timeZone} />

      <Section
        headingId="browser-autonomy-heading"
        state={
          hasBroadBrowserAutonomy(browserAutonomy) ? "Разрешено" : "По запросу"
        }
        title="Действия на сайтах"
      >
        <Rows>
          <Row
            side={
              <BrowserAutonomy
                broad={hasBroadBrowserAutonomy(browserAutonomy)}
              />
            }
          >
            <p>Выполнять поручения без повторных подтверждений</p>
            <p className="type-status text-muted-foreground">
              Просмотр сайтов и подготовка всегда выполняются автоматически.
              Отдельное разрешение позволяет в рамках твоих поручений покупать и
              бронировать, отправлять, менять аккаунты и удалять данные.
            </p>
            <p className="type-status text-muted-foreground">
              Это делегирование Bro, а не техническая гарантия контроля каждого
              клика на внешнем сайте. Разрешение можно отозвать переключателем.
            </p>
          </Row>
        </Rows>
      </Section>

      <Section headingId="connections-heading" title="Подключения">
        <Rows>
          <Row side={<GoogleWorkspaceAction state={googleWorkspace.state} />}>
            <p>Google Workspace</p>
            <p className="type-status text-muted-foreground">
              {googleWorkspaceDescription(googleWorkspace)}
            </p>
          </Row>
          {telegramConfigured ? (
            <Row
              side={
                <TelegramLinkAction linked={telegramIdentity !== undefined} />
              }
            >
              <p>Telegram</p>
              <p className="type-status text-muted-foreground">
                {telegramIdentity
                  ? `${telegramLinkedAs(telegramIdentity.username)}. Сообщения с этого аккаунта Telegram идут в этот кабинет.`
                  : "Не привязан. Открой одноразовую ссылку, чтобы подключить свой Telegram."}
              </p>
            </Row>
          ) : null}
        </Rows>
      </Section>

      <Section headingId="infrastructure-heading" title="Инфраструктура">
        <Rows>
          <Row side={imageStorageReady ? "Подключено" : "Нужна настройка"}>
            <p>Vercel Blob</p>
            <p className="type-status text-muted-foreground">
              {imageStorageReady
                ? "Картинки хранятся в приватном Vercel Blob."
                : "Подключи приватный Vercel Blob, чтобы делиться картинками."}
            </p>
          </Row>
          <Row side={browserReady ? "Настроен" : "Не настроен"}>
            <p>Браузер</p>
            <p className="type-status text-muted-foreground">
              {browserReady
                ? "Поручения на сайтах выполняются в облачном браузере."
                : "Задай BROWSER_USE_API_KEY, чтобы выполнять поручения на сайтах."}
            </p>
          </Row>
          <Row
            side={
              <ModelSelector modelId={workspaceModel} openRouter={openRouter} />
            }
          >
            <p>{openRouter ? "Модель (OpenRouter)" : "Модель AI Gateway"}</p>
            <p className="type-status text-muted-foreground">
              {workspaceModel}
            </p>
          </Row>
        </Rows>
      </Section>
    </Document>
  );
}

/** A Telegram account may have no public username; the link still holds. */
function telegramLinkedAs(username: string | null) {
  return username ? `Привязан как @${username}` : "Привязан";
}

function googleWorkspaceDescription(connection: GoogleWorkspaceConnection) {
  const state = connection.state;
  return state === "connected"
    ? (connection.accountLabel ?? "Gmail, Календарь и Контакты подключены.")
    : state === "unavailable"
      ? "Подключи коннектор Google OAuth через Vercel Connect, чтобы включить."
      : state === "error"
        ? "Google не отвечает, попробуй позже."
        : "Gmail, Календарь и Контакты через твой аккаунт Google.";
}

/** The lead actions under the title: text, like on the landing. */
export function ChannelsSection({
  imessageConfigured,
  imessagePhoneNumber,
}: {
  readonly imessageConfigured: boolean;
  readonly imessagePhoneNumber?: string;
}) {
  const imessageHref =
    imessageConfigured && imessagePhoneNumber
      ? `sms:${imessagePhoneNumber}`
      : undefined;

  return (
    <>
      <Actions>
        {imessageHref ? (
          <Button
            nativeButton={false}
            render={
              <a aria-label="Написать Bro в iMessage" href={imessageHref} />
            }
            size="act-lead"
            variant="act"
          >
            Написать Bro
          </Button>
        ) : (
          <Button disabled size="act-lead" variant="act">
            Написать Bro
          </Button>
        )}
        <Button
          nativeButton={false}
          render={<Link href="/chat" />}
          size="act-lead"
          variant="act"
        >
          Открыть чат
        </Button>
      </Actions>
      <StatusLine className="mt-2">
        {channelAvailabilityMessage({
          imessageConfigured,
          imessagePhoneNumber,
        })}
      </StatusLine>
    </>
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
    "Чат в браузере готов.",
    imessageConfigured && imessagePhoneNumber
      ? `iMessage откроет ${imessagePhoneNumber}.`
      : imessageConfigured
        ? "Photon подключён — напиши на его линию iMessage, чтобы начать."
        : "Подключи Photon, чтобы включить iMessage.",
  ].join(" ");
}

/** Exported for its test: the day count of a paid month. */
export function LimitsSection({
  paid,
  paidUntil,
}: {
  readonly paid: boolean;
  readonly paidUntil: Date | null;
}) {
  const messages = paid ? env.PAID_MESSAGES_PER_DAY : env.FREE_MESSAGES_PER_DAY;
  const browserRuns = paid
    ? env.PAID_BROWSER_RUNS_PER_MONTH
    : env.FREE_BROWSER_RUNS_PER_MONTH;
  const daysUsed = paid && paidUntil ? paidDaysUsed(paidUntil) : undefined;

  return (
    <Section
      headingId="limits-heading"
      state={paid ? "Полный доступ" : "Бесплатный режим"}
      title="Лимиты"
    >
      <p className="type-fine text-muted-foreground">
        Сообщения в день — до {messages}
      </p>
      <p className="type-fine text-muted-foreground">
        Браузерные поручения в месяц — до {browserRuns}
      </p>
      {daysUsed === undefined ? null : (
        <>
          <p className="type-fine mt-2 text-muted-foreground">
            Оплаченный месяц — прошло {daysUsed} из {paidPeriodDays} дней
          </p>
          <Meter allowance={paidPeriodDays} used={daysUsed} />
        </>
      )}
    </Section>
  );
}

function PaymentsSection({
  paid,
  paidUntil,
  when,
}: {
  readonly paid: boolean;
  readonly paidUntil: Date | null;
  readonly when: Intl.DateTimeFormat;
}) {
  const billingOn = yooKassaConfigured();
  const price = `${String(env.PRICE_RUB)} ₽`;

  return (
    <Section
      headingId="payments-heading"
      state={paid ? "Оплачен" : undefined}
      title="Оплаты"
    >
      {paidUntil ? (
        <Rows>
          <Row side={paid ? "Оплачен" : "Истёк"}>
            <p>
              Полный доступ до {when.format(paidUntil)} · {price}
            </p>
          </Row>
        </Rows>
      ) : (
        <p className="type-fine text-muted-foreground">Пока нет оплат.</p>
      )}
      <Actions>
        {billingOn ? (
          <Button
            nativeButton={false}
            render={<Link href="/api/pay" prefetch={false} />}
            size="act-lead"
            variant="act"
          >
            Оплатить месяц
          </Button>
        ) : (
          <Button disabled size="act-lead" variant="act">
            Оплатить месяц
          </Button>
        )}
      </Actions>
      <StatusLine className="mt-2">
        {billingOn
          ? `Полный доступ — ${price} за ${String(paidPeriodDays)} календарных дней. Тариф не продлевается автоматически.`
          : "Оплата скоро"}
      </StatusLine>
    </Section>
  );
}

function SiteLoginsSection({
  logins,
}: {
  readonly logins: readonly VaultPreviewItem[];
}) {
  const domains = [
    ...new Set(
      logins
        .map((item) => item.account.split(" · ", 1)[0]?.trim() ?? "")
        .filter((domain) => domain !== "")
    ),
  ];

  return (
    <Section headingId="site-logins-heading" title="Входы в сайты">
      <p className="type-fine text-muted-foreground">
        Сначала Bro берёт вход из сейфа или уже сохранённые куки. Если входа нет
        — откроет страницу входа и пришлёт ссылку в чат. Открой, войди один раз
        — пароль в чат не пиши. Повторно ссылку не пришлёт. Добавить или
        изменить вход можно в сейфе.
      </p>
      <p className="type-fine mt-[0.6rem]">
        {domains.length > 0
          ? `Сохранены входы: ${domains.join(", ")}`
          : "Пока нет сохранённых входов — Bro возьмёт вход из сейфа или пришлёт ссылку, когда понадобится."}
      </p>
      <Actions>
        <Link className="type-act bro-link" href="/vault?add=login">
          Добавить вход
        </Link>
        <Link className="type-act bro-link" href="/vault?import=chrome">
          Импортировать из Chrome
        </Link>
      </Actions>
    </Section>
  );
}

function VaultSection({
  items,
}: {
  readonly items: readonly VaultPreviewItem[];
}) {
  const shown = items.slice(0, vaultPreviewRows);
  const rest = items.length - shown.length;

  return (
    <Section headingId="vault-heading" title="Сейф">
      <p className="type-fine text-muted-foreground">
        Карта, адреса и входы на сайты. Номер и CVV он не видит — пароль в чат
        тоже не пиши.
      </p>
      {items.length > 0 ? (
        <Rows>
          {shown.map((item) => {
            const kind = vaultKindLabels[item.kind] ?? item.kind;
            const line =
              item.account && item.account !== item.label
                ? `${item.label} · ${item.account}`
                : item.label;
            return (
              <Row key={item.id} side={kind}>
                <p>{line}</p>
              </Row>
            );
          })}
          {rest > 0 ? (
            <Row>
              <p className="type-status text-muted-foreground">
                и ещё {rest} — в сейфе
              </p>
            </Row>
          ) : null}
        </Rows>
      ) : (
        <p className="type-fine mt-[0.6rem] text-muted-foreground">
          Пока пусто — добавь карту или вход, и Bro сможет покупать и заходить
          на сайты.
        </p>
      )}
      <Actions>
        <Link
          className="type-act bro-link"
          href="/vault?setup=vault&kind=payment"
        >
          Добавить карту
        </Link>
        <Link className="type-act bro-link" href="/vault?add=login">
          Добавить вход
        </Link>
        <Link className="type-act bro-link" href="/vault">
          перейти в сейф
        </Link>
      </Actions>
    </Section>
  );
}

function TimeZoneSection({ timeZone }: { readonly timeZone: string }) {
  return (
    <Section headingId="timezone-heading" state={timeZone} title="Часовой пояс">
      <p className="type-fine text-muted-foreground">
        По этому времени Bro считает дневные лимиты и ставит напоминания.
      </p>
      <Actions>
        <Link className="type-act bro-link" href="/personal-info">
          Изменить
        </Link>
      </Actions>
    </Section>
  );
}
