/**
 * The composer the chat writes on is a white pill with an ink border: it
 * rounds into a plate as the text grows, and its submit is a round ink
 * button. The overrides target the input group's slot because the prompt
 * input renders the group itself.
 */
export const paperComposerClassName = [
  "[&_[data-slot=input-group]]:rounded-[1.75rem]",
  "[&_[data-slot=input-group]]:border-2",
  "[&_[data-slot=input-group]]:border-foreground",
  "[&_[data-slot=input-group]]:bg-card",
  "dark:[&_[data-slot=input-group]]:bg-card",
  "[&_[data-slot=input-group]]:shadow-[0_8px_30px_rgb(20_21_16/8%)]",
  "[&_[data-slot=input-group-control]]:px-5",
].join(" ");

/** A 40px ink circle; the pseudo-element widens the hit area to 48px. */
export const paperComposerSubmitClassName =
  "relative size-10 min-h-10 rounded-full p-0 after:absolute after:-inset-1 after:content-['']";
