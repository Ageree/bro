import type { Law } from "./g711.ts";

// RFC 4566/3264 for one audio stream: we offer A-law first (GPT-Live takes it as is), μ-law second, and
// DTMF events, whose packets the bridge drops.
const lawOf = new Map<number, Law>([
  [8, "pcma"],
  [0, "pcmu"],
]);

export function sdpOffer(input: {
  address: string;
  port: number;
  sessionId: number;
}) {
  return [
    "v=0",
    `o=bro ${String(input.sessionId)} ${String(input.sessionId)} IN IP4 ${input.address}`,
    "s=bro",
    `c=IN IP4 ${input.address}`,
    "t=0 0",
    `m=audio ${String(input.port)} RTP/AVP 8 0 101`,
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:0 PCMU/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-15",
    "a=ptime:20",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

/** Where the far side takes our audio and in which law; null when the answer has no G.711 we offered. */
export function sdpAnswer(body: string) {
  const lines = body.split(/\r?\n/u);
  const media = lines.findIndex((line) => line.startsWith("m=audio "));
  if (media === -1) return null;
  const [, portText, , ...formats] = (lines[media] ?? "").slice(2).split(" ");
  // A media-level c= wins over the session-level one.
  const connection =
    lines.slice(media).find((line) => line.startsWith("c=IN IP4 ")) ??
    lines.slice(0, media).find((line) => line.startsWith("c=IN IP4 "));
  const port = Number(portText);
  const payloadType = formats.map(Number).find((format) => lawOf.has(format));
  if (
    !connection ||
    !Number.isInteger(port) ||
    port <= 0 ||
    payloadType === undefined
  )
    return null;
  const law = lawOf.get(payloadType);
  if (!law) return null;
  return {
    address: connection.slice("c=IN IP4 ".length).trim(),
    port,
    payloadType,
    law,
  };
}
