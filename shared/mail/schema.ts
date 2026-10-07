import { z } from "zod";

export const mailProviderSchema = z.enum(["mailru", "yandex"]);
export type MailProvider = z.infer<typeof mailProviderSchema>;
export const mailAccessSchema = z.enum(["full", "read_only"]);
export type MailAccess = z.infer<typeof mailAccessSchema>;

export const mailProviderNames = {
  mailru: "Mail.ru",
  yandex: "Яндекс.Почта",
} satisfies Record<MailProvider, string>;
