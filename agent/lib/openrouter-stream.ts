/** Parse OpenRouter chat SSE enough to time first reasoning vs first visible token. */

export type OpenRouterStreamProgress = {
  hasSseData: boolean;
  reasoning: boolean;
  content: boolean;
};

type StreamDelta = {
  content?: unknown;
  reasoning?: unknown;
};

export function openRouterDeltaText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function openRouterStreamProgress(buf: string): OpenRouterStreamProgress {
  if (typeof buf !== "string") {
    throw new Error("OpenRouter SSE buffer must be a string");
  }
  let reasoning = false;
  let content = false;
  let hasSseData = /(?:^|\n)data:/.test(buf);
  for (const line of buf.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    hasSseData = true;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const ev = JSON.parse(payload) as {
        choices?: Array<{ delta?: StreamDelta }>;
      };
      const delta = ev.choices?.[0]?.delta;
      if (openRouterDeltaText(delta?.reasoning)) reasoning = true;
      if (openRouterDeltaText(delta?.content)) content = true;
    } catch {
      continue;
    }
  }
  return { hasSseData, reasoning, content };
}
