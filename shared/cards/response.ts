import * as z from "zod";
import type { Card } from "./schema";

/**
 * The person's answer to an interactive card (`docs/cards.md`, «Интерактивные
 * карточки»): which submit button they pressed and what they chose and typed.
 * The same checks run on the page, before the button sends anything, and on
 * the server, which keeps only what passes them.
 */

type Block = Card["blocks"][number];
type Question = Extract<Block, { type: "choice" | "field" }>;
type Field = Extract<Block, { type: "field" }>;

/** The longest text a field takes, by its kind. */
const fieldLimits = {
  count: 32,
  date: 10,
  longtext: 1000,
  number: 32,
  slider: 32,
  text: 200,
  time: 5,
} as const satisfies Record<Field["input"], number>;

/**
 * What the page sends and keeps as a draft: a choice's value or values, a
 * field's text as typed. Anything else is not an answer at all.
 */
export const cardDraftSchema = z.record(
  z.string(),
  z.union([z.string().max(2000), z.array(z.string().max(64)).max(8)])
);

/** An answer as it is kept: a field's number is a number, empty ones are left out. */
export const cardAnswerSchema = z.object({
  action: z.string(),
  values: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.array(z.string())])
  ),
});

export type CardAnswer = z.infer<typeof cardAnswerSchema>;

/** The choices and fields of a card, in their order on it. */
export function cardQuestions(card: Card) {
  return card.blocks.filter(
    (block): block is Question =>
      block.type === "choice" || block.type === "field"
  );
}

/** The card's buttons that send the answer, in their order on it. */
export function submitActions(card: Card) {
  return card.actions.flatMap((action) => ("submit" in action ? [action] : []));
}

/**
 * The button whose press needs every required choice and field: the
 * primary submit button, or the first one when none is. Another submit
 * button («Показать другие», «Ни один не подходит») sends what is filled in.
 */
export function mainSubmit(card: Card) {
  const submits = submitActions(card);
  return submits.find((action) => action.primary === true) ?? submits[0];
}

const numberPattern = /^-?\d{1,12}(?:\.\d{1,4})?$/u;
const datePattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

/** A day that is on the calendar: no 31 November, no 29 February of 2026. */
function calendarDay(text: string) {
  const parts = datePattern.exec(text)?.groups;
  if (!parts) return false;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const missing = {
  choice: "Выберите вариант.",
  field: "Заполните поле.",
} as const;

/**
 * A field's answer: its text, trimmed, of its kind and length — a number
 * typed as people write it («30 000», «2,5») becomes a number. Empty is no
 * answer, which a field the press needs (`needed`) does not take.
 */
function fieldSchema(field: Field, needed: boolean) {
  const limit = fieldLimits[field.input];
  return z
    .string()
    .optional()
    .transform((given, context) => {
      const text = given?.trim() ?? "";
      const fail = (message: string) => {
        context.issues.push({ code: "custom", input: given, message });
        return z.NEVER;
      };
      if (text === "") return needed ? fail(missing.field) : undefined;
      if (text.length > limit) {
        return fail(`Слишком длинно: не больше ${String(limit)} знаков.`);
      }
      if (
        field.input === "number" ||
        field.input === "count" ||
        field.input === "slider"
      ) {
        const plain = text.replaceAll(/\s/gu, "").replace(",", ".");
        if (!numberPattern.test(plain))
          return fail("Введите число, например 12 или 2,5.");
        const value = Number(plain);
        if (field.input !== "number") {
          const offset = (value - (field.min ?? 0)) / (field.step ?? 1);
          if (
            (field.min !== undefined && value < field.min) ||
            (field.max !== undefined && value > field.max) ||
            Math.abs(offset - Math.round(offset)) > 1e-6 ||
            (field.input === "count" && !Number.isInteger(value))
          )
            return fail("Выберите значение в пределах шкалы.");
        }
        return value;
      }
      if (field.input === "date") {
        return calendarDay(text) ? text : fail("Выберите дату.");
      }
      if (field.input === "time") {
        return timePattern.test(text)
          ? text
          : fail("Введите время, например 18:30.");
      }
      return text;
    });
}

const unknownOption = "Такого варианта в карточке нет.";

/**
 * A choice's answer: one of its options' values, or several of them, none
 * twice, in the card's order. None is no answer, which a choice the press
 * needs (`needed`) does not take.
 */
function choiceSchema(
  choice: Extract<Block, { type: "choice" }>,
  needed: boolean
) {
  const values = new Set(choice.options.map((option) => option.value));
  return z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((given, context) => {
      const picked = [given ?? []].flat().filter((value) => value !== "");
      const fail = (message: string) => {
        context.issues.push({ code: "custom", input: given, message });
        return z.NEVER;
      };
      if (picked.length === 0) return needed ? fail(missing.choice) : undefined;
      if (Array.isArray(given) !== choice.multiple) {
        return fail(unknownOption);
      }
      if (new Set(picked).size !== picked.length) {
        return fail("Один вариант отмечен дважды.");
      }
      if (!picked.every((value) => values.has(value))) {
        return fail(unknownOption);
      }
      return choice.multiple
        ? choice.options
            .map((option) => option.value)
            .filter((value) => picked.includes(value))
        : picked[0];
    });
}

/**
 * What a press of one of the card's submit buttons may send, at the card's
 * current revision: the button's id, and for each choice and field of the
 * card an answer of its kind — a choice's value from its options (several,
 * none repeated, for a multiple one), a number, a date, a time or a text
 * within its length. A key the card does not ask, an answer to the card as
 * it was before an update and, for the main button (`mainSubmit`), a
 * required question left empty fail, each by its own key. The output is
 * the answer as it is kept.
 */
export function cardResponseSchema(card: Card, revision: number) {
  const questions = cardQuestions(card);
  const main = mainSubmit(card)?.submit;
  const actions = card.actions.flatMap((action) => {
    if ("submit" in action)
      return [{ id: action.submit, required: action.submit === main }];
    if ("intent" in action) return [{ id: action.intent, required: false }];
    return [];
  });
  const [first, ...rest] = actions.map((action) =>
    z.strictObject({
      action: z.literal(action.id),
      revision: z.literal(revision),
      values: z.strictObject(
        Object.fromEntries(
          questions.map((question) => {
            const needed = question.required && action.required;
            return [
              question.id,
              question.type === "choice"
                ? choiceSchema(question, needed)
                : fieldSchema(question, needed),
            ];
          })
        )
      ),
    })
  );
  if (first === undefined) return z.never();
  return z
    .discriminatedUnion("action", [first, ...rest])
    .transform(({ action, values }) => ({
      action,
      values: Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== undefined)
      ),
    }))
    .pipe(cardAnswerSchema);
}

function shown(
  question: Question,
  value: CardAnswer["values"][string] | undefined
) {
  if (question.type === "choice") {
    const picked = new Set([value ?? []].flat());
    const titles = question.options
      .filter((option) => picked.has(option.value))
      .map((option) => option.title);
    return titles.length > 0 ? titles.join(", ") : "ничего не выбрано";
  }
  if (value === undefined) return "не заполнено";
  if (
    (question.input === "number" ||
      question.input === "count" ||
      question.input === "slider") &&
    question.unit !== undefined
  ) {
    return `${String(value)} ${question.unit}`;
  }
  return question.input === "text" || question.input === "longtext"
    ? JSON.stringify(value)
    : String(value);
}

/**
 * The answer as Bro reads it: a line per choice and field with its label
 * and what the person chose or typed — the option's title, the number with
 * its unit, a typed text as one quoted string, so no line break or quote
 * mark in it passes for a line of the note — and the button they pressed;
 * with the same answer by its stable keys, to act on.
 */
export function describeCardAnswer(card: Card, answer: CardAnswer) {
  const pressed =
    card.actions.find(
      (action) =>
        ("submit" in action && action.submit === answer.action) ||
        ("intent" in action && action.intent === answer.action)
    )?.label ?? answer.action;
  const lines = cardQuestions(card).map(
    (question) =>
      `${question.label}: ${shown(question, answer.values[question.id])}`
  );
  return {
    keys: { action: answer.action, values: answer.values },
    text: [...lines, `Нажал: «${pressed}»`].join("\n"),
  };
}
