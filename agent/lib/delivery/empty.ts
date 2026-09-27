/**
 * eve's marker for a turn that deliberately says nothing: a final text equal
 * to it, trimmed, ends the turn with `message: null`
 * (`eve/dist/src/shared/empty-delivery.js`, not exported). Anywhere else eve
 * delivers the text around it as is, marker included.
 */
export const emptyDeliveryMarker = "<eve-empty-delivery/>";

// HTML-escaped too, and in the backticks a model quotes it in.
const markerMentions =
  /`?(?:<eve-empty-delivery\/>|&lt;eve-empty-delivery\/&gt;)`?/gu;
const trailingMarker =
  /`?(?:<eve-empty-delivery\/>|&lt;eve-empty-delivery\/&gt;)`?\s*$/u;

/**
 * Whether the text ends on the marker. A model that writes its reasoning
 * first and the marker last has decided to say nothing.
 */
export function endsWithEmptyDeliveryMarker(text: string) {
  return trailingMarker.test(text);
}

/**
 * The text with every mention of the marker taken out: «не использую
 * <eve-empty-delivery/>» in a real reply is not for the person to read.
 */
export function withoutEmptyDeliveryMarker(text: string) {
  return text
    .replace(markerMentions, "")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
