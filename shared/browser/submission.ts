import { z } from "zod";

/**
 * What a browser errand may submit in the person's name, as the person saw
 * it on the approval card. The card is the permission: a run is held to what
 * it names, and the errand's follow-ups and background retries carry it, but
 * a new errand never inherits it.
 */
export const browserSubmissionSchema = z.object({
  what: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      "Exactly what will be submitted in the user's name, in the user's language: «запись к терапевту», «заявление на справку об отсутствии судимости», «отклики на 3 вакансии Python-разработчика», «чек в „Мой налог“ на 15 000 ₽», «заказ такси до Шереметьево»."
    ),
  where: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Who receives it and on which site: «Госуслуги (gosuslugi.ru)», «поликлиника по прикреплению через ЕМИАС (emias.info)», «hh.ru»."
    ),
  forWhom: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe(
      "Whose name it is in: the user, or the family member it is for, by name when known."
    ),
  personalData: z
    .array(z.string().trim().min(1).max(60))
    .max(12)
    .describe(
      "Which of the person's details the site will receive, in the user's language: «имя», «телефон», «почта», «адрес», «дата рождения», «паспорт», «СНИЛС», «полис ОМС», «резюме». Empty only when nothing personal is sent."
    ),
  when: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "The date, time or slot, or the window the run may pick one from: «ближайший свободный слот 29.09–03.10, до обеда». Leave out when there is none."
    ),
  amount: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "What it costs the person, fees included: «бесплатно», «госпошлина 0 ₽», «около 900 ₽ по тарифу „Комфорт“»."
    ),
});

export type BrowserSubmission = z.infer<typeof browserSubmissionSchema>;
