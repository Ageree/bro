import { env } from "@shared/environment";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import type { MailAccess, MailProvider } from "./schema";

export function mailEnabled(scope: Pick<AccessScope, "workspaceId">) {
  return (
    env.MAIL_WORKSPACES?.includes("*") === true ||
    env.MAIL_WORKSPACES?.includes(scope.workspaceId) === true
  );
}

export function mailProviderConfigured(provider: MailProvider) {
  return provider === "mailru"
    ? Boolean(env.MAILRU_MAIL_CLIENT_ID && env.MAILRU_MAIL_CLIENT_SECRET)
    : Boolean(env.YANDEX_MAIL_CLIENT_ID && env.YANDEX_MAIL_CLIENT_SECRET);
}

const mailEndpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname.endsWith(".mail.ru") &&
    !url.username &&
    !url.password &&
    !url.port
  );
});
const mailDiscoverySchema = z.object({
  authorization_endpoint: mailEndpointSchema,
  token_endpoint: mailEndpointSchema,
  userinfo_endpoint: mailEndpointSchema,
});
let mailDiscovery: Promise<z.infer<typeof mailDiscoverySchema>> | undefined;

async function discoverMailru() {
  mailDiscovery ??= fetch(
    "https://account.mail.ru/.well-known/openid-configuration",
    {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
      cache: "no-store",
    }
  )
    .then(async (response) => {
      if (!response.ok) throw new Error("Mail.ru сейчас не отвечает.");
      return mailDiscoverySchema.parse(await response.json());
    })
    .catch(() => {
      mailDiscovery = undefined;
      throw new Error("Mail.ru сейчас не отвечает.");
    });
  return mailDiscovery;
}

export async function mailProviderConfig(
  provider: MailProvider,
  access: MailAccess
) {
  const clientId =
    provider === "mailru"
      ? env.MAILRU_MAIL_CLIENT_ID
      : env.YANDEX_MAIL_CLIENT_ID;
  const clientSecret =
    provider === "mailru"
      ? env.MAILRU_MAIL_CLIENT_SECRET
      : env.YANDEX_MAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Подключение этой почты на сервере не настроено.");
  }
  const discovery = provider === "mailru" ? await discoverMailru() : undefined;
  return discovery
    ? {
        authorizeUrl: discovery.authorization_endpoint,
        clientId,
        clientSecret,
        scope: "openid email mail.imap offline_access",
        tokenUrl: discovery.token_endpoint,
        userinfoUrl: discovery.userinfo_endpoint,
      }
    : {
        authorizeUrl: "https://oauth.yandex.ru/authorize",
        clientId,
        clientSecret,
        scope: `login:email ${access === "read_only" ? "mail:imap_ro" : "mail:imap_full mail:smtp"}`,
        tokenUrl: "https://oauth.yandex.ru/token",
        userinfoUrl: "https://login.yandex.ru/info",
      };
}
