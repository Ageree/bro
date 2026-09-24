import { withApprovalCard } from "@shared/chat/approval-card";
import type { ReplyLanguage } from "@agent/lib/delivery/language";

/** What an iMessage needs of an eve input request to put it into words. */
interface InputRequestText {
  readonly action: { readonly input: unknown; readonly toolName: string };
  readonly allowFreeform?: boolean;
  readonly kind: string;
  readonly options?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly prompt: string;
}

const answerHint = {
  en: {
    choose: (count: number) =>
      `Reply with the number: ${Array.from({ length: count }, (_, index) => String(index + 1)).join(" or ")}.`,
    freeform: "Or reply in your own words.",
    open: "Reply with your answer.",
  },
  // Neutral: the person may have chosen «вы» or «ты».
  ru: {
    choose: (count: number) =>
      `Ответ — цифрой: ${Array.from({ length: count }, (_, index) => String(index + 1)).join(" или ")}.`,
    freeform: "Можно ответить и своими словами.",
    open: "Ответ — сообщением.",
  },
} as const;

/**
 * One request as an iMessage. The chat has no buttons, so each option is
 * numbered: eve resolves a reply that is an option's number (as well as its
 * own id or English label), and a number is the one answer that works in any
 * language. An approval says what it lets through — a submission in the
 * person's name, a standing permission, a spend limit — as the Telegram card
 * does.
 */
function requestText(request: InputRequestText, language: ReplyLanguage) {
  const shown = withApprovalCard(request, language);
  const hint = answerHint[language];
  const options = shown.options ?? [];
  if (options.length === 0) return [shown.prompt, hint.open].join("\n\n");
  return [
    shown.prompt,
    options
      .map((option, index) => `${String(index + 1)} — ${option.label}`)
      .join("\n"),
    [
      hint.choose(options.length),
      shown.allowFreeform === true ? hint.freeform : undefined,
    ]
      .filter((line) => line !== undefined)
      .join(" "),
  ].join("\n\n");
}

/**
 * The text of eve's input requests for an iMessage chat, in the person's
 * language: eve's default card falls back to its bare title there, which for
 * a booking in the person's name says only «Approve tool call: browser_task».
 */
export function iMessageInputRequestsText(
  requests: readonly InputRequestText[],
  language: ReplyLanguage
) {
  return requests.map((request) => requestText(request, language)).join("\n\n");
}
