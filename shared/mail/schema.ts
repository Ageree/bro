import { z } from "zod";

export const mailProviders = ["mailru", "yandex"] as const;
export const mailProviderSchema = z.enum(mailProviders);
export type MailProvider = z.infer<typeof mailProviderSchema>;
export const mailAccessLevels = ["full", "read_only"] as const;
export const mailAccessSchema = z.enum(mailAccessLevels);
export type MailAccess = z.infer<typeof mailAccessSchema>;

export interface MailCredentials {
  readonly email: string;
  readonly accessToken: string;
  readonly access: MailAccess;
}

export const mailServerHosts = {
  mailru: { imap: "imap.mail.ru", smtp: "smtp.mail.ru" },
  yandex: { imap: "imap.yandex.com", smtp: "smtp.yandex.com" },
} satisfies Record<MailProvider, { imap: string; smtp: string }>;

export const mailProviderNames = {
  mailru: "Mail.ru",
  yandex: "Яндекс.Почта",
} satisfies Record<MailProvider, string>;
