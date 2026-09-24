import { z } from "zod";
import {
  browserSubmissionSchema,
  paymentCeilingRub,
} from "@shared/browser/submission";
import { formatRub } from "@shared/spending/limit";
import type { ReplyLanguage } from "@agent/lib/delivery/language";

/**
 * eve titles every approval card «Approve tool call: browser_task», which in
 * a messenger is all the person sees: the web chat shows the call's input
 * under it, Telegram shows only the title. The card is the one place where
 * the person confirms a booking, an application or an order in their name,
 * so it says what, where, for whom, which of their details go, when and for
 * how much, in their language.
 */
const confirmedCallSchema = z.object({
  allowPayment: z.boolean().optional(),
  site: z.string().optional(),
  // The card does not show the kind, and a call parked before kinds existed
  // still deserves its details.
  submission: browserSubmissionSchema.partial({ kind: true }),
});

const cardText = {
  en: {
    amount: "Cost",
    approve: "Approve",
    cancel: "Cancel",
    card: "Pays with the saved card",
    cardUpTo: "Pays with the saved card, up to",
    guarantee: "The saved card as a guarantee only, nothing charged",
    forWhom: "In the name of",
    personalData: "Your details sent",
    site: "Site",
    title: "Confirm before I do this in your name:",
    when: "When",
    what: "What",
    where: "Where",
  },
  ru: {
    amount: "Стоимость",
    approve: "Подтвердить",
    cancel: "Отмена",
    card: "Оплата сохранённой картой",
    cardUpTo: "Оплата сохранённой картой, не больше",
    guarantee: "Сохранённая карта только в гарантию, без списания",
    forWhom: "От чьего имени",
    personalData: "Какие данные уйдут",
    site: "Сайт",
    title: "Подтверждение действия от твоего имени:",
    when: "Когда",
    what: "Что",
    where: "Где",
  },
} as const;

/**
 * Whether the card pays, and up to what: a card that names the rouble total
 * approves paying it with the small margin the tool allows, and says so.
 */
function paymentLine(
  call: z.infer<typeof confirmedCallSchema>,
  text: (typeof cardText)[keyof typeof cardText]
) {
  const { chargeRub } = call.submission;
  if (chargeRub !== undefined) {
    const ceiling = paymentCeilingRub(chargeRub);
    return ceiling === 0
      ? text.guarantee
      : `${text.cardUpTo} ${formatRub(ceiling)}`;
  }
  return call.allowPayment === true ? text.card : undefined;
}

/** The card's text for a confirmed `browser_task` call. */
function browserTaskApprovalPrompt(
  call: z.infer<typeof confirmedCallSchema>,
  language: ReplyLanguage
) {
  const text = cardText[language];
  const { submission } = call;
  return [
    text.title,
    `${text.what}: ${submission.what}`,
    `${text.where}: ${submission.where}`,
    `${text.forWhom}: ${submission.forWhom}`,
    submission.when ? `${text.when}: ${submission.when}` : undefined,
    submission.amount ? `${text.amount}: ${submission.amount}` : undefined,
    `${text.personalData}: ${submission.personalData.length > 0 ? submission.personalData.join(", ") : "—"}`,
    paymentLine(call, text),
    call.site ? `${text.site}: ${call.site}` : undefined,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * The same approval request with the card's text and buttons in the
 * person's language. Everything the answer is matched by — the request id
 * and the option ids — stays as eve made it. Any other request, and a
 * `browser_task` call without the details, is left as it was.
 */
export function withBrowserTaskApprovalCard<
  TRequest extends {
    readonly action: { readonly input: unknown; readonly toolName: string };
    readonly kind: string;
    readonly options?: readonly {
      readonly id: string;
      readonly label: string;
    }[];
    readonly prompt: string;
  },
>(request: TRequest, language: ReplyLanguage): TRequest {
  if (
    request.kind !== "tool-approval" ||
    request.action.toolName !== "browser_task"
  ) {
    return request;
  }
  const call = confirmedCallSchema.safeParse(request.action.input);
  if (!call.success) return request;
  const text = cardText[language];
  return {
    ...request,
    options: request.options?.map((option) =>
      option.id === "approve" || option.id === "cancel"
        ? { ...option, label: text[option.id] }
        : option
    ),
    prompt: browserTaskApprovalPrompt(call.data, language),
  };
}
