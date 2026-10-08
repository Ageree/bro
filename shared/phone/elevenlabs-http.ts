import { fetch, ProxyAgent, type RequestInit } from "undici";

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
  } catch {
    throw new Error("ElevenLabs HTTP transport could not be verified.");
  }
}
