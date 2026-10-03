import { z } from "zod";

/**
 * What kind of thing a submission is. The person's standing permissions
 * («бронируй столики сам», «записывай к врачам без вопросов») are granted per
 * kind, so this is what the tool matches them on; `other` is never covered by
 * a permission for a kind, only by one for the whole site.
 */
export const browserSubmissionKinds = [
  "appointment",
  "table",
  "taxi",
  "order",
  "booking",
  "application",
  "job_application",
  "message",
  "other",
] as const;

/**
 * One line of the approval card. Each field is its own line on the card and
 * in the run's instructions, so a value with a line break in it could pass
 * for a field of its own — another «Сумма», another rule for the run — and
 * is refused rather than drawn. The check is a refinement, not `.regex()`:
 * a `\p{Cc}` pattern in the tool schema made OpenAI reject every request.
 */
function cardLine(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (line) => !/[\p{Cc}\u2028\u2029]/u.test(line),
      "One line of plain text, without line breaks or control characters."
    );
}

/** The words of a submission's fields, in full or short. */
type SubmissionWords = Readonly<
  Record<
    | "kind"
    | "what"
    | "items"
    | "where"
    | "forWhom"
    | "personalData"
    | "when"
    | "amount"
    | "chargeRub",
    string
  >
>;

const fullSubmissionWords: SubmissionWords = {
  kind: "What kind of action it is: appointment (a doctor, a salon, any service slot), table (a restaurant table), taxi, order (goods, food, groceries), booking (a stay, tickets, a rental), application (an application or request to an agency, Gosuslugi included), job_application, message (a message, contact form or request to a business or a tradesperson), other. The user's standing permissions are matched on it.",
  what: "Exactly what will be submitted in the user's name, in the user's language: «запись к терапевту», «заявление на справку об отсутствии судимости», «отклики на 3 вакансии Python-разработчика», «чек в „Мой налог“ на 15 000 ₽», «заказ такси до Шереметьево».",
  items:
    "For an order or a basket, one line per position exactly as the run staged it — the item with its variant, weight or size, the quantity and the price: «Корм Whiskas с кроликом 1,9 кг × 2 — 1 298 ₽». The card lists them and the run submits exactly these. Leave out for anything that is not a basket.",
  where:
    "Who receives it and on which site: «Госуслуги (gosuslugi.ru)», «поликлиника по прикреплению через ЕМИАС (emias.info)», «hh.ru».",
  forWhom:
    "Whose name it is in: the user, or the family member it is for, by name when known.",
  personalData:
    "Which of the person's details the site will receive, in the user's language: «имя», «телефон», «почта», «адрес», «дата рождения», «паспорт», «СНИЛС», «полис ОМС», «резюме». Empty only when nothing personal is sent.",
  when: "The date, time or slot, or the window the run may pick one from: «ближайший свободный слот 29.09–03.10, до обеда». Leave out when there is none.",
  amount:
    "What it costs the person, fees included: «бесплатно», «госпошлина 0 ₽», «около 900 ₽ по тарифу „Комфорт“».",
  chargeRub:
    "The total in roubles the user pays on this errand, every fee included, as the site or the tariff shows it now or your honest estimate. Set it whenever the errand costs money: the tool then pays only after the user's plain yes to your one question naming this exact total, with no extra margin. A higher total needs a new question and yes. 0, together with allowPayment, for a card guarantee that charges nothing today; ask about binding the card first too. Leave it out when the errand is free or not priced in roubles.",
};

/** The same in a line each, for the skills pilot's `browser_task`. */
const shortSubmissionWords: SubmissionWords = {
  kind: "What kind of action: appointment (a doctor, a salon, any service slot), table, taxi, order, booking (a stay, tickets, a rental), application (Gosuslugi included), job_application, message (a contact form too), other. Standing permissions are matched on it.",
  what: "Exactly what is submitted in the user's name, in their language: «запись к терапевту», «заказ такси до Шереметьево».",
  items:
    "For an order or a basket: one line per position as the run staged it — item, variant, quantity, price.",
  where: "Who receives it and on which site.",
  forWhom: "Whose name it is in.",
  personalData:
    "Which of the person's details the site receives («имя», «телефон», «адрес»); empty only when none.",
  when: "The date, time or slot, or the window the run may pick from; leave out when none.",
  amount: "What it costs the person, fees included, in words.",
  chargeRub:
    "The total in roubles with every fee, as the site shows it; set it whenever the errand costs money: paid only after the user's plain yes to this exact total. 0 with allowPayment for a card guarantee. Leave out when free.",
};

function submissionSchemaWith(words: SubmissionWords) {
  return z.object({
    kind: z.enum(browserSubmissionKinds).describe(words.kind),
    what: cardLine(300).describe(words.what),
    // A basket's lines, each its own line of the card: «корзина на 1 337 ₽»
    // alone did not say what the person was paying for.
    items: z
      .array(cardLine(160))
      .min(1)
      .max(30)
      .optional()
      .describe(words.items),
    where: cardLine(200).describe(words.where),
    forWhom: cardLine(120).describe(words.forWhom),
    personalData: z.array(cardLine(60)).max(12).describe(words.personalData),
    when: cardLine(200).optional().describe(words.when),
    amount: cardLine(120).optional().describe(words.amount),
    chargeRub: z
      .number()
      .nonnegative()
      .max(10_000_000)
      .optional()
      .describe(words.chargeRub),
  });
}

export const browserSubmissionSchema =
  submissionSchemaWith(fullSubmissionWords);

/** `browserSubmissionSchema` with its fields in a line each. */
export const shortBrowserSubmissionSchema =
  submissionSchemaWith(shortSubmissionWords);

export type BrowserSubmission = z.infer<typeof browserSubmissionSchema>;

/**
 * What an errand keeps as the person's consent: the submission, and the most
 * its runs may pay for it when paying was part of what they allowed. Its
 * follow-ups, anti-bot retries and a start from the queue pay within it
 * without asking again. An errand confirmed before kinds existed has none.
 */
export type ConfirmedSubmission = Omit<BrowserSubmission, "kind"> &
  Partial<Pick<BrowserSubmission, "kind">> & {
    /**
     * The one host, with its subdomains, the errand may submit on, when a
     * standing permission rather than a card allowed it: nobody saw a card
     * naming the place, so the run is held to the site the permission is
     * for, or the errand's own site for a permission by kind alone.
     */
    readonly boundHost?: string;
    readonly paymentCapRub?: number;
  };

/**
 * The most a run may pay on a card that named `chargeRub`. The card names
 * what the page or the tariff shows before the order, and the order itself
 * rarely lands on exactly that: a taxi estimate moves with demand by a few
 * to about ten percent before the car is ordered, and a shop adds a service
 * or delivery fee of 50–100 ₽ the basket did not show. Asking again for that
 * is the friction the person asked to be spared, so the margin is 10%, at
 * least 100 ₽ for the fixed fees of a small order and at most 1 000 ₽: past
 * that a difference is no longer small, and the run stops for a new card
 * with the real total. A card guarantee that charges nothing stays at zero.
 */
export function paymentCeilingRub(chargeRub: number) {
  const total = Math.max(0, Math.ceil(chargeRub - 1e-9));
  if (total === 0) return 0;
  return total + Math.min(Math.max(Math.ceil(total * 0.1), 100), 1_000);
}
