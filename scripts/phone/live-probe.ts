import { parseArgs } from "node:util";
import { ProxyAgent, fetch as fetchThrough } from "undici";
import { z } from "zod";
import { registerApplicationModuleResolution } from "../lib/module-resolution.ts";
import {
  rms,
  silenceByte,
  toLinear,
  transcode,
  type Law,
} from "./live/g711.ts";
import { openLiveSession, type LiveEvent } from "./live/gpt-live.ts";
import { frameBytes, frameMs, openRtp } from "./live/rtp.ts";
import { sdpAnswer, sdpOffer } from "./live/sdp.ts";
import {
  digest,
  header,
  openSip,
  render,
  status,
  tagOf,
  token,
  uriOf,
  type SipMessage,
} from "./live/sip.ts";

// One test call through the bridge: Exolve's SIP leg (TCP signalling, G.711 over RTP) on this VM, the voice
// in GPT-Live over a WebSocket. Prints the gaps between the far side's speech and Bro's, both transcripts,
// and PUTs a stereo WAV (left: the far side, right: Bro) to the signed URL it is given.
//   ops/phone-live-probe.sh +7DESTINATION +7BRO_NUMBER [s3put:KEY] [MAX_TALK_SECONDS]

registerApplicationModuleResolution();

const phone = z.string().regex(/^\+7\d{10}$/u);
const { positionals } = parseArgs({ allowPositionals: true });
const destination = phone.parse(positionals[0]);
const callerNumber = phone.parse(positionals[1]);
const recordUrl = positionals[2]?.startsWith("https://")
  ? positionals[2]
  : undefined;
const maxTalkSeconds = Math.min(600, Number(positionals[3] ?? "180") || 180);
const maxRingSeconds = 60;
// Telephone noise sits well below speech at these levels (16-bit linear).
const voiced = 500;
const hangover = 400;

const t0 = performance.now();
const at = () => (performance.now() - t0) / 1000;
const log = (line: string) => {
  console.log(`${at().toFixed(2)} ${line}`);
};
// Whatever hangs (a request no one answers), the job ends: deployd would wait 6 hours.
setTimeout(
  () => {
    log("hard deadline: exiting");
    process.exit(1);
  },
  (maxRingSeconds + maxTalkSeconds + 90) * 1000
);
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, ms);
    }),
  ]);

const { env } = await import("@shared/environment");
const { findSip, readSipCredentials } = await import("@shared/phone/exolve");
const { hangupRules, voiceStyle } = await import("@shared/phone/persona");
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set.");

const sipId = (await findSip(callerNumber.slice(1)))?.sipId;
if (!sipId) throw new Error("No Exolve SIP ID carries the caller number.");
const credentials = await readSipCredentials(sipId);
if (credentials.publicNumber !== callerNumber)
  throw new Error("The SIP ID's caller number differs.");

const instructions = [
  "Ты Бро, голосовой помощник пользователя. Говори только по-русски.",
  voiceStyle,
  "Ты звонишь самому пользователю, с ним на «ты». Это пробный звонок на новой голосовой модели.",
  "Пока идут гудки, ты слышишь тишину: молчи, пока собеседник не заговорит первым. На его «Алло» скажи:",
  "«Привет! Это Бро, проверяю новый голос. Как меня слышно?»",
  // 18.10, the same lines without a phone: the median pause before Bro's answer 1.00 s, with these two 0.85 s.
  "Отвечай сразу, как только собеседник договорил фразу: не выжидай паузу и не переспрашивай себя.",
  "Начинай ответ с короткой фразы из двух-трёх слов, потом продолжай.",
  "Дальше поддерживай живой разговор. Если он спросит дату, время или то, чего ты не знаешь, передай вопрос",
  "системе через делегирование, коротко скажи, что сейчас посмотришь, и перескажи ответ своими словами.",
  hangupRules,
].join(" ");

// ── the far side's audio and Bro's, both on the call's 20 ms clock ──
let answeredAt: number | null = null;
let leg: {
  address: string;
  port: number;
  payloadType: number;
  law: Law;
} | null = null;
const toBro: Buffer[] = [];
let queued = 0;
let deepestQueueMs = 0;
const farFrames = new Map<number, Int16Array>();
const broFrames = new Map<number, Int16Array>();
const gaps: number[] = [];
let farVoicedAt = -Infinity;
let farTurnEnd: number | null = null;
let broVoicedAt = -Infinity;
const heard: string[] = [];
const said: string[] = [];
let delegations = 0;

let live: Awaited<ReturnType<typeof openLiveSession>> | null = null;

const frameIndex = () =>
  answeredAt === null
    ? 0
    : Math.round((performance.now() - answeredAt) / frameMs);

function nextFrame() {
  const law = leg?.law ?? "pcma";
  let frame = new Uint8Array(frameBytes).fill(silenceByte("pcma"));
  // Before the answer the line carries the carrier's ringback: Bro's audio waits for the person.
  if (answeredAt !== null && queued >= frameBytes) {
    const joined = Buffer.concat(toBro);
    frame = joined.subarray(0, frameBytes);
    toBro.length = 0;
    toBro.push(joined.subarray(frameBytes));
    queued -= frameBytes;
  }
  if (answeredAt !== null) {
    const samples = toLinear(frame, "pcma");
    broFrames.set(frameIndex(), samples);
    const now = performance.now();
    if (rms(samples) > voiced) {
      if (now - broVoicedAt > hangover && farTurnEnd !== null) {
        gaps.push((now - farTurnEnd) / 1000);
        log(
          `turn: Bro answered ${((now - farTurnEnd) / 1000).toFixed(2)} s after the far side stopped`
        );
        farTurnEnd = null;
      }
      broVoicedAt = now;
    }
  }
  return transcode(frame, "pcma", law);
}

const rtp = await openRtp({
  nextFrame,
  onFrame(payload, payloadType) {
    if (!leg || answeredAt === null || payloadType !== leg.payloadType) return;
    const alaw = transcode(payload, leg.law, "pcma");
    live?.send({
      type: "session.input_audio.append",
      audio: Buffer.from(alaw).toString("base64"),
    });
    const samples = toLinear(payload, leg.law);
    farFrames.set(frameIndex(), samples);
    const now = performance.now();
    if (rms(samples) > voiced) {
      farVoicedAt = now;
      farTurnEnd = null;
    } else if (
      farTurnEnd === null &&
      now - farVoicedAt > hangover &&
      farVoicedAt > broVoicedAt
    ) {
      farTurnEnd = farVoicedAt;
    }
  },
});

// ── GPT-Live ──
const delegation = z.object({ delegation: z.object({ id: z.string() }) });
const textDelta = z.object({ delta: z.string() });
function onLiveEvent(event: LiveEvent) {
  if (event.type === "session.output_audio.delta") {
    // Said into the ringing: nobody heard it, and played after the answer it would come late.
    if (answeredAt === null) return;
    const audio = Buffer.from(textDelta.parse(event).delta, "base64");
    toBro.push(audio);
    queued += audio.length;
    deepestQueueMs = Math.max(deepestQueueMs, (queued / frameBytes) * frameMs);
    return;
  }
  if (event.type === "session.output_transcript.delta")
    said.push(textDelta.parse(event).delta);
  else if (event.type === "session.input_transcript.delta")
    heard.push(textDelta.parse(event).delta);
  else if (event.type !== "session.usage.updated")
    log(`live ${event.type} ${JSON.stringify(event).slice(0, 300)}`);
  if (event.type === "session.delegation.created") {
    delegations += 1;
    const id = delegation.parse(event).delegation.id;
    setTimeout(() => {
      const moscow = new Intl.DateTimeFormat("ru-RU", {
        timeZone: "Europe/Moscow",
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date());
      live?.send({
        type: "session.commentary.append",
        event_id: `result_${id}`,
        delegation_id: id,
        content: `Сейчас ${moscow} по Москве. Других сведений нет.`,
      });
      log(`tool: answered delegation ${id}`);
    }, 1000);
  }
}

// ── SIP ──
let ended: (reason: string) => void = () => undefined;
const finished = new Promise<string>((resolve) => {
  ended = resolve;
});
const sip = await openSip({
  host: credentials.hostname,
  port: 5060,
  log,
  onRequest(message, reply) {
    const method = message.startLine.split(" ")[0];
    if (method === "ACK") return;
    if (method === "BYE") {
      reply(200, "OK");
      ended("the far side hung up");
    } else if (method === "INVITE") {
      reply(
        200,
        "OK",
        [
          ["Contact", contact],
          ["Content-Type", "application/sdp"],
        ],
        offer
      );
    } else reply(200, "OK");
  },
});

const callId = `${token(12)}@bro`;
const fromTag = token(6);
const domain = credentials.hostname;
const fromUri = `sip:${credentials.username}@${domain}`;
let cseq = 1;
const via = (branch: string) =>
  `SIP/2.0/TCP ${sip.localAddress}:${String(sip.localPort)};branch=${branch};rport`;

// Our address as the carrier sees it (Via received=, RFC 3581): the SDP must name it, not the VM's private one.
const probeBranch = `z9hG4bK${token()}`;
const options = await within(
  sip.request(
    render(`OPTIONS sip:${domain} SIP/2.0`, [
      ["Via", via(probeBranch)],
      ["Max-Forwards", "70"],
      ["From", `<${fromUri}>;tag=${token(6)}`],
      ["To", `<sip:${domain}>`],
      ["Call-ID", `${token(12)}@bro`],
      ["CSeq", "1 OPTIONS"],
    ]),
    probeBranch
  ),
  5000
);
const publicAddress =
  /;received=([\d.]+)/u.exec(
    options ? (header(options, "via") ?? "") : ""
  )?.[1] ?? (await (await fetch("https://api.ipify.org")).text()).trim();
log(`media address ${publicAddress}:${String(rtp.port)}`);
const contact = `<sip:${credentials.username}@${publicAddress}:${String(sip.localPort)};transport=tcp>`;
const offer = sdpOffer({
  address: publicAddress,
  port: rtp.port,
  sessionId: Date.now(),
});

// 18.10 the session did not start twice in a row, with no error: which hop hangs, the proxy or OpenAI
// behind it, one plain request tells. The repeats on its open connection are the round trip every turn
// of the call pays twice (the far side's audio up, Bro's down).
const openAiKey = env.OPENAI_API_KEY;
const openAiProxy = env.OPENAI_PROXY_URL
  ? new ProxyAgent(env.OPENAI_PROXY_URL)
  : undefined;
const askOpenAi = async () => {
  const init: NonNullable<Parameters<typeof fetchThrough>[1]> = {
    headers: { Authorization: `Bearer ${openAiKey}` },
    signal: AbortSignal.timeout(15_000),
  };
  if (openAiProxy) init.dispatcher = openAiProxy;
  const asked = performance.now();
  const answer = await fetchThrough(
    "https://api.openai.com/v1/models/gpt-live-1",
    init
  );
  await answer.arrayBuffer();
  return {
    status: answer.status,
    ms: Math.round(performance.now() - asked),
  };
};
try {
  const first = await askOpenAi();
  const again = [await askOpenAi(), await askOpenAi(), await askOpenAi()];
  log(
    `OpenAI answers ${String(first.status)} in ${String(first.ms)} ms; again on that connection ${again.map((request) => String(request.ms)).join("/")} ms`
  );
} catch (error) {
  log(
    `OpenAI did not answer: ${error instanceof Error ? `${error.message} (${String(error.cause)})` : "?"}`
  );
}

live = await openLiveSession({
  apiKey: env.OPENAI_API_KEY,
  proxyUrl: env.OPENAI_PROXY_URL,
  session: {
    model: "gpt-live-1",
    instructions,
    audio: {
      format: { type: "audio/pcma", rate: 8000 },
      output: { voice: "marin" },
    },
    delegation: { type: "client" },
  },
  onEvent: onLiveEvent,
});
log(`GPT-Live session ${live.sessionId}`);
// GPT-Live ends a session that hears nothing for ~30 s ("expired", 17.10: the phone rang 31 s): while the
// call rings, it hears silence, 100 ms at a time.
const ringing = setInterval(() => {
  if (answeredAt !== null) {
    clearInterval(ringing);
    return;
  }
  live.send({
    type: "session.input_audio.append",
    audio: Buffer.alloc(frameBytes * 5, silenceByte("pcma")).toString("base64"),
  });
}, 100);

function inviteRequest(
  number: string,
  branch: string,
  auth?: [string, string]
) {
  return render(
    `INVITE sip:${number}@${domain} SIP/2.0`,
    [
      ["Via", via(branch)],
      ["Max-Forwards", "70"],
      ["From", `<${fromUri}>;tag=${fromTag}`],
      ["To", `<sip:${number}@${domain}>`],
      ["Call-ID", callId],
      ["CSeq", `${String(cseq)} INVITE`],
      ["Contact", contact],
      ["Allow", "INVITE, ACK, CANCEL, BYE, OPTIONS"],
      ["User-Agent", "bro-live-probe"],
      ["Content-Type", "application/sdp"],
      ...(auth ? [auth] : []),
    ],
    offer
  );
}

// ACK of a non-2xx final response: the INVITE's own branch and CSeq number (RFC 3261 §17.1.1.3).
function ackFailure(number: string, branch: string, response: SipMessage) {
  sip.send(
    render(`ACK sip:${number}@${domain} SIP/2.0`, [
      ["Via", via(branch)],
      ["Max-Forwards", "70"],
      ["From", `<${fromUri}>;tag=${fromTag}`],
      ["To", header(response, "to") ?? ""],
      ["Call-ID", callId],
      ["CSeq", `${String(cseq)} ACK`],
    ])
  );
}

function authFor(
  response: SipMessage,
  method: string,
  uri: string
): [string, string] | undefined {
  const proxy = status(response) === 407;
  const challenge = header(
    response,
    proxy ? "proxy-authenticate" : "www-authenticate"
  );
  if (!challenge) return undefined;
  return [
    proxy ? "Proxy-Authorization" : "Authorization",
    digest({
      challenge,
      method,
      uri,
      username: credentials.username,
      password: credentials.password,
    }),
  ];
}

function startMedia(message: SipMessage) {
  const answer = sdpAnswer(message.body);
  if (!answer) return;
  leg = answer;
  log(`media to ${answer.address}:${String(answer.port)} ${answer.law}`);
  rtp.start(answer);
}

async function invite(number: string) {
  let auth: [string, string] | undefined;
  for (let round = 0; round < 3; round += 1) {
    const branch = `z9hG4bK${token()}`;
    const ringDeadline = setTimeout(() => {
      // No answer in time: CANCEL shares the INVITE's branch and CSeq number (RFC 3261 §9.1).
      log("no answer: CANCEL");
      sip.send(
        render(`CANCEL sip:${number}@${domain} SIP/2.0`, [
          ["Via", via(branch)],
          ["Max-Forwards", "70"],
          ["From", `<${fromUri}>;tag=${fromTag}`],
          ["To", `<sip:${number}@${domain}>`],
          ["Call-ID", callId],
          ["CSeq", `${String(cseq)} CANCEL`],
        ])
      );
    }, maxRingSeconds * 1000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each round answers the previous challenge.
    const response = await sip.request(
      inviteRequest(number, branch, auth),
      branch,
      (provisional) => {
        if (provisional.body) startMedia(provisional);
      }
    );
    clearTimeout(ringDeadline);
    const code = status(response) ?? 0;
    if (code >= 200 && code < 300) return { response, number };
    ackFailure(number, branch, response);
    const uri = `sip:${number}@${domain}`;
    auth =
      code === 401 || code === 407
        ? authFor(response, "INVITE", uri)
        : undefined;
    if (!auth) return { response, number };
    cseq += 1;
  }
  throw new Error("The carrier kept asking for credentials.");
}

// Exolve's number format is not documented: digits first, then E.164 with +, and only after a final
// "no such number" answer — a ringing or unclear attempt is never repeated.
let outcome: Awaited<ReturnType<typeof invite>> | null = null;
for (const number of [destination.slice(1), destination]) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- A second format only after the first was refused.
  outcome = await invite(number);
  const code = status(outcome.response) ?? 0;
  if (![400, 404, 416, 484, 604].includes(code)) break;
  cseq += 1;
}
if (!outcome || (status(outcome.response) ?? 0) >= 300) {
  log(`call not connected: ${outcome?.response.startLine ?? "no response"}`);
  live.close();
  rtp.close();
  sip.close();
  process.exit(0);
}

const answered = outcome.response;
answeredAt = performance.now();
startMedia(answered);
const remoteTag = tagOf(header(answered, "to"));
const target = uriOf(
  header(answered, "contact") ?? `<sip:${outcome.number}@${domain}>`
);
const routes = [...(answered.headers.get("record-route") ?? [])]
  .flatMap((value) => value.split(/,(?=\s*<)/u))
  .toReversed();
const dialogHeaders = (branch: string, method: string): [string, string][] => [
  ["Via", via(branch)],
  ["Max-Forwards", "70"],
  ...routes.map((route): [string, string] => ["Route", route.trim()]),
  ["From", `<${fromUri}>;tag=${fromTag}`],
  ["To", `<sip:${outcome.number}@${domain}>;tag=${remoteTag ?? ""}`],
  ["Call-ID", callId],
  ["CSeq", `${String(cseq)} ${method}`],
];
sip.send(
  render(`ACK ${target} SIP/2.0`, dialogHeaders(`z9hG4bK${token()}`, "ACK"))
);
log(`answered: ${answered.startLine}`);

const talkLimit = setTimeout(() => {
  ended("the talk limit");
}, maxTalkSeconds * 1000);
const reason = await Promise.race([
  finished,
  sip.closed.then(() => "the SIP connection closed"),
  live.closed.then(() => "GPT-Live closed the session"),
]);
clearTimeout(talkLimit);
log(`ending: ${reason}`);
if (
  reason !== "the far side hung up" &&
  reason !== "the SIP connection closed"
) {
  let auth: [string, string] | undefined;
  for (let round = 0; round < 2; round += 1) {
    cseq += 1;
    const branch = `z9hG4bK${token()}`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- A challenged BYE is sent once more with credentials.
    const bye = await within(
      sip.request(
        render(`BYE ${target} SIP/2.0`, [
          ...dialogHeaders(branch, "BYE"),
          ...(auth ? [auth] : []),
        ]),
        branch
      ),
      5000
    );
    auth =
      bye && (status(bye) === 401 || status(bye) === 407)
        ? authFor(bye, "BYE", target)
        : undefined;
    if (!auth) break;
  }
}
live.close();
rtp.close();
sip.close();

// ── the report ──
const talked = (performance.now() - answeredAt) / 1000;
const sorted = gaps.toSorted((a, b) => a - b);
log(
  `talked ${talked.toFixed(1)} s; turns ${String(gaps.length)}; gap median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(2)} s, ` +
    `min ${(sorted[0] ?? 0).toFixed(2)} s, max ${(sorted.at(-1) ?? 0).toFixed(2)} s; delegations ${String(delegations)}; ` +
    `deepest Bro queue ${String(Math.round(deepestQueueMs))} ms; far frames ${String(farFrames.size)}, Bro frames ${String(broFrames.size)}`
);
// deployd keeps 1000 characters of a line: the transcripts go in pieces.
for (const [who, text] of [
  ["far side (as GPT-Live heard it)", heard.join("")],
  ["Bro said", said.join("")],
] as const) {
  for (let start = 0; start < Math.max(1, text.length); start += 600)
    log(`${who}: ${text.slice(start, start + 600)}`);
}

if (recordUrl) {
  const frames = Math.max(0, ...farFrames.keys(), ...broFrames.keys()) + 1;
  const samples = frames * frameBytes;
  const wav = Buffer.alloc(44 + samples * 4);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 4, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 4, 40);
  for (const [channel, source] of [farFrames, broFrames].entries()) {
    for (const [index, frame] of source) {
      frame.forEach((sample, offset) => {
        wav.writeInt16LE(
          sample,
          44 + ((index * frameBytes + offset) * 2 + channel) * 2
        );
      });
    }
  }
  const put = await fetch(recordUrl, { method: "PUT", body: wav });
  log(`recording: ${String(put.status)} (${String(wav.length)} bytes)`);
}
process.exit(0);
