import { fetch, ProxyAgent, type RequestInit } from "undici";
import { z } from "zod";

let proxy: { url: string; dispatcher: ProxyAgent } | undefined;

export async function elevenlabsFetch(
  path: string,
  options: RequestInit,
  proxyUrl?: string
) {
  try {
    if (proxyUrl && proxy?.url !== proxyUrl) {
      const dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: true },
        proxyTls: { rejectUnauthorized: true },
      });
      const previous = proxy;
      proxy = { url: proxyUrl, dispatcher };
      if (previous) await previous.dispatcher.close();
    }
    return await fetch(`https://api.elevenlabs.io${path}`, {
      ...options,
      dispatcher: proxyUrl ? proxy?.dispatcher : undefined,
    });
  } catch (error) {
    // Только имя и код сетевой ошибки (ECONNRESET, UND_ERR_CONNECT_TIMEOUT…):
    // без них сбой связи с ElevenLabs не отличить от остальных.
    const code = z
      .object({ code: z.string() })
      .safeParse(error instanceof Error ? error.cause : null);
    console.warn("[phone] ElevenLabs transport error", {
      name: error instanceof Error ? error.name : "unknown",
      code: code.success ? code.data.code : null,
    });
    throw new Error("ElevenLabs HTTP transport could not be verified.", {
      cause: error,
    });
  }
}
