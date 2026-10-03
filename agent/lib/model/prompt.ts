import type { LanguageModelMiddleware } from "ai";

/** A model call's prompt, as middleware sees it. */
export type Prompt = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"]["prompt"];

/** One message of a model call's prompt. */
export type PromptMessage = Prompt[number];

/** A tool's result, JSON or text. */
export type ToolOutput = Extract<
  Extract<PromptMessage, { role: "tool" }>["content"][number],
  { type: "tool-result" }
>["output"];
