import type { EveEvalTurn } from "eve/evals";

const deliveryTools = new Set(["send_message", "react_to_message"]);

/** Every tool result of the turns but the deliveries, as one searchable text. */
export function toolOutputs(...turns: EveEvalTurn[]) {
  return turns
    .flatMap((turn) => turn.toolCalls)
    .filter((call) => !deliveryTools.has(call.name))
    .map((call) => JSON.stringify(call.output ?? null))
    .join("\n");
}

/**
 * The URLs in a text, trailing punctuation trimmed and normalized, so a cited
 * link is matched whole: a prefix of a longer tool URL is not a citation.
 * A backslash ends a URL inside a JSON string (`\n`, `\"`).
 */
export function urlsIn(text: string) {
  return (text.match(/https?:\/\/[^\s<>"'`\\]+/gu) ?? []).map((url) => {
    const trimmed = url.replace(/[.,;:!?)\]]+$/u, "");
    return URL.parse(trimmed)?.href ?? trimmed;
  });
}
