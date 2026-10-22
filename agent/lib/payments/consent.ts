import { generateText, Output } from "ai";
import { z } from "zod";
import { directModelSelection } from "@agent/lib/model/direct";
import { getWorkspaceModelId } from "@db/services/settings";
import type { AccessScope } from "@shared/identity/access-scope";
import { directModelActive } from "@shared/model/provider";

/**
 * The person's yes to one payment: the question Bro asked before it names
 * the payment's exact total, and either is the stored question itself or,
 * in Bro's own words, the same payment by a judge's reading. Shared by the
 * purchases that pay without a browser (`yandex_purchase`, `yoomoney_pay`).
 */

/**
 * The question as the person read it: Bro's message style may swap the
 * quotes or the spaces, and that does not change what was asked.
 */
export const plainQuestion = (text: string) =>
  text
    .replaceAll(/["«»“”„]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();

/** The question names the exact total: «444 ₽», «1 234,50 ₽». */
export function namesTotal(question: string, amountMinor: number) {
  return [
    ...question
      .replaceAll(/(?<=\d)[\s  ](?=\d{3}(?!\d))/gu, "")
      .matchAll(/\d+(?:[.,]\d{1,2})?/gu),
  ].some(
    ([number]) =>
      Math.round(Number(number.replace(",", ".")) * 100) === amountMinor
  );
}

/**
 * Whether Bro's question, in its own words, asks to pay for exactly these
 * terms (the judge reads them beside the question, by their keys): it names
 * the exact total, and a judge finds the rest the instructions name in it.
 * Any failure of the judge is a no.
 */
export async function askedToPay(
  scope: AccessScope,
  question: string,
  {
    amountMinor,
    instructions,
    terms,
  }: {
    readonly amountMinor: number;
    readonly instructions: string;
    readonly terms: Readonly<
      Record<string, z.infer<ReturnType<typeof z.json>>>
    >;
  }
) {
  if (!namesTotal(question, amountMinor)) return false;
  try {
    const modelId = await getWorkspaceModelId(scope);
    // Without reasoning, which used up the verdict's tokens and refused a
    // yes (`paymentUnanswered` in `browser_task`, RU 22.10).
    const selection = directModelActive()
      ? directModelSelection(modelId, {
          reasoningOff: true,
          toolChoice: "none",
        })
      : null;
    const { output } = await generateText({
      abortSignal: AbortSignal.timeout(20_000),
      model: selection?.model ?? modelId,
      providerOptions: selection?.modelOptions.providerOptions,
      maxOutputTokens: 256,
      output: Output.object({ schema: z.object({ matches: z.boolean() }) }),
      prompt: JSON.stringify({ question, ...terms }),
      instructions,
    });
    return output.matches;
  } catch {
    return false;
  }
}
