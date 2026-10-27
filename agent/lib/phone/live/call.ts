import { z } from "zod";
import { silenceByte, rms, toLinear, transcode, type Law } from "./g711";
import { openLiveSession, type LiveEvent } from "./gpt-live";
import { frameBytes, openRtp } from "./rtp";
import { sdpAnswer, sdpOffer } from "./sdp";
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
} from "./sip";

// One outbound call in GPT-Live: Exolve's SIP leg (TCP signalling, G.711 over RTP) from this process, the
// voice in a GPT-Live WebSocket in `audio/pcma` 8 kHz. `dialLive` readies the line and the voice; nothing
// reaches the carrier until `dial()`, so a failure before it may go the ElevenLabs way.

/** Nothing was dialled: the SIP line, the media address or GPT-Live was not ready. */
export class LiveCallUnavailableError extends Error {}

export interface LiveCallOutcome {
  /** The far side picked up. */
  answered: boolean;
  /** The final SIP answer to the INVITE, when there was one. */
  sipStatus: number | null;
  ending:
    | "hung_up"
    | "silence"
    | "talk_limit"
    | "media_lost"
    | "line_closed"
    | "voice_closed"
    | "not_connected";
  talkSeconds: number;
  /** «Бро: …» and «Собеседник: …» lines, as GPT-Live heard and said them. */
  transcript: string;
  /** Billed GPT-Live seconds, when the session reported them. */
  usageSeconds: number | null;
}

// Telephone noise sits well below speech at these levels (16-bit linear).
const voiced = 500;
// The far side's audio stops coming: the carrier dropped the leg without a BYE.
const mediaLostMs = 30_000;

const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([
    promise,
    new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, ms);
    }),
  ]);

function say(event: string, extra: Record<string, string | number> = {}) {
  console.info(`[phone-live] ${event}`, extra);
}

const textDelta = z.object({ delta: z.string() });
const transcriptDelta = z.object({
  delta: z.string(),
  start_ms: z.number().nullish(),
});
const delegation = z.object({ delegation: z.object({ id: z.string() }) });
const usage = z.object({ usage: z.object({ seconds: z.number() }) });

export async function dialLive(input: {
  line: { hostname: string; username: string; password: string };
  /** Full domestic number, +7XXXXXXXXXX. */
  target: string;
  instructions: string;
  voice: string;
  maxTalkSeconds: number;
  silenceSeconds: number;
  ringSeconds: number;
  apiKey: string;
  proxyUrl?: string;
  /**
   * What the voice may ask Bro mid-call (`agent/lib/phone/ask.ts`): the last lines of the talk in, the line to
   * say out, null when there is none. Unset, the voice is told it has nothing to ask.
   */
  ask?: (heard: string) => Promise<string | null>;
  /** Questions one call may put to `ask`. */
  askLimit?: number;
  /** How long the voice waits for `ask`. */
  askTimeoutMs?: number;
}) {
  const { line } = input;
  const domain = line.hostname;

  // ── the far side's audio and Bro's, on the call's 20 ms clock ──
  let answeredAt: number | null = null;
  let leg: {
    address: string;
    port: number;
    payloadType: number;
    law: Law;
  } | null = null;
  const toBro: Buffer[] = [];
  let queued = 0;
  let farVoicedAt = 0;
  let broVoicedAt = 0;
  let farHeardAt = 0;
  // Transcript pieces with GPT-Live's own session clock: the far side's text comes later than Bro's reply
  // starts, so arrival order interleaved the lines mid-sentence (18.10).
  const fragments: { who: "Бро" | "Собеседник"; at: number; text: string }[] =
    [];
  let usageSeconds: number | null = null;
  let live: Awaited<ReturnType<typeof openLiveSession>> | null = null;

  const note = (who: "Бро" | "Собеседник", event: LiveEvent) => {
    const parsed = transcriptDelta.safeParse(event);
    if (!parsed.success) return;
    const piece = parsed.data;
    fragments.push({
      who,
      at: piece.start_ms ?? fragments.at(-1)?.at ?? 0,
      text: piece.delta,
    });
  };
  const transcript = () => {
    const lines: { who: string; text: string }[] = [];
    for (const piece of fragments.toSorted((a, b) => a.at - b.at)) {
      const last = lines.at(-1);
      if (last?.who === piece.who) last.text += piece.text;
      else lines.push({ who: piece.who, text: piece.text });
    }
    return lines
      .map(({ who, text }) => `${who}: ${text.trim()}`)
      .filter((entry) => !entry.endsWith(":"))
      .join("\n");
  };

  function nextFrame() {
    let frame = new Uint8Array(frameBytes).fill(silenceByte("pcma"));
    // Before the answer the line carries the carrier's ringback: Bro's audio waits for the person.
    if (answeredAt !== null && queued >= frameBytes) {
      const joined = Buffer.concat(toBro);
      frame = joined.subarray(0, frameBytes);
      toBro.length = 0;
      toBro.push(joined.subarray(frameBytes));
      queued -= frameBytes;
      if (rms(toLinear(frame, "pcma")) > voiced)
        broVoicedAt = performance.now();
    }
    return transcode(frame, "pcma", leg?.law ?? "pcma");
  }

  // The voice delegates a question the task does not answer. With `ask` it gets the user's own line back; with
  // nothing to give, or no `ask`, it is told so rather than left waiting on an answer that never comes.
  const noAnswer =
    "Этих сведений у тебя нет. Скажи собеседнику, что уточнишь у пользователя и передашь в отчёте.";
  let asked = 0;
  let asking = false;
  const answerDelegation = async (id: string) => {
    let content = noAnswer;
    if (input.ask && !asking && asked < (input.askLimit ?? 0)) {
      asking = true;
      asked += 1;
      try {
        // The far side's last words reach the transcript a moment after they are said.
        await new Promise((resolve) => setTimeout(resolve, 500));
        const heard = transcript().split("\n").slice(-6).join("\n");
        const said = await within(
          input.ask(heard).catch(() => null),
          input.askTimeoutMs ?? 7000
        );
        if (said)
          content = `Из данных пользователя: ${JSON.stringify(said)}. Скажи это собеседнику своими словами, коротко, и продолжай задачу.`;
        say("asked", { answered: said ? 1 : 0, n: asked });
      } finally {
        asking = false;
      }
    }
    live?.send({
      type: "session.commentary.append",
      event_id: `answer_${id}`,
      delegation_id: id,
      content,
    });
  };

  const pieces: { close: () => void }[] = [];
  const closeAll = () => {
    for (const piece of pieces) piece.close();
  };

  try {
    const rtp = await openRtp({
      nextFrame,
      onFrame(payload, payloadType) {
        if (!leg || answeredAt === null || payloadType !== leg.payloadType)
          return;
        farHeardAt = performance.now();
        live?.send({
          type: "session.input_audio.append",
          audio: Buffer.from(transcode(payload, leg.law, "pcma")).toString(
            "base64"
          ),
        });
        if (rms(toLinear(payload, leg.law)) > voiced)
          farVoicedAt = performance.now();
      },
    });
    pieces.push(rtp);

    const { promise: finished, resolve: ended } =
      Promise.withResolvers<LiveCallOutcome["ending"]>();
    let contact = "";
    let offer = "";
    const sip = await openSip({
      host: domain,
      port: 5060,
      log: () => undefined,
      onRequest(message, reply) {
        const method = message.startLine.split(" ")[0];
        if (method === "ACK") return;
        if (method === "BYE") {
          reply(200, "OK");
          ended("hung_up");
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
    pieces.push(sip);
    const via = (branch: string) =>
      `SIP/2.0/TCP ${sip.localAddress}:${String(sip.localPort)};branch=${branch};rport`;
    const fromUri = `sip:${line.username}@${domain}`;

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
    const publicAddress = /;received=([\d.]+)/u.exec(
      options ? (header(options, "via") ?? "") : ""
    )?.[1];
    if (!publicAddress)
      throw new Error("The carrier did not name our address.");
    contact = `<sip:${line.username}@${publicAddress}:${String(sip.localPort)};transport=tcp>`;
    offer = sdpOffer({
      address: publicAddress,
      port: rtp.port,
      sessionId: Date.now(),
    });

    const onLiveEvent = (event: LiveEvent) => {
      if (event.type === "session.output_audio.delta") {
        // Said into the ringing: nobody heard it, and played after the answer it would come late.
        const parsed = textDelta.safeParse(event);
        if (answeredAt === null || !parsed.success) return;
        const audio = Buffer.from(parsed.data.delta, "base64");
        toBro.push(audio);
        queued += audio.length;
      } else if (event.type === "session.output_transcript.delta") {
        if (answeredAt !== null) note("Бро", event);
      } else if (event.type === "session.input_transcript.delta") {
        if (answeredAt !== null) note("Собеседник", event);
      } else if (event.type === "session.usage.updated") {
        const parsed = usage.safeParse(event);
        if (parsed.success) usageSeconds = parsed.data.usage.seconds;
      } else if (event.type === "session.delegation.created") {
        const parsed = delegation.safeParse(event);
        if (!parsed.success) return;
        void answerDelegation(parsed.data.delegation.id);
      }
    };
    const session = await openLiveSession({
      apiKey: input.apiKey,
      proxyUrl: input.proxyUrl,
      startTimeoutMs: 12_000,
      session: {
        model: "gpt-live-1",
        instructions: input.instructions,
        audio: {
          format: { type: "audio/pcma", rate: 8000 },
          output: { voice: input.voice },
        },
        delegation: { type: "client" },
      },
      onEvent: onLiveEvent,
    });
    live = session;
    pieces.push(session);

    const talk = async (): Promise<LiveCallOutcome> => {
      // GPT-Live ends a session that hears nothing for ~30 s (`expired`, 17.10): while the call rings,
      // it hears silence, 100 ms at a time.
      const ringing = setInterval(() => {
        if (answeredAt !== null) clearInterval(ringing);
        else
          session.send({
            type: "session.input_audio.append",
            audio: Buffer.alloc(frameBytes * 5, silenceByte("pcma")).toString(
              "base64"
            ),
          });
      }, 100);
      pieces.push({
        close: () => {
          clearInterval(ringing);
        },
      });
      const callId = `${token(12)}@bro`;
      const fromTag = token(6);
      let cseq = 1;

      const authFor = (
        response: SipMessage,
        method: string,
        uri: string
      ): [string, string] | undefined => {
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
            username: line.username,
            password: line.password,
          }),
        ];
      };
      const startMedia = (message: SipMessage) => {
        const answer = sdpAnswer(message.body);
        if (!answer) return;
        leg = answer;
        rtp.start(answer);
      };

      const invite = async (number: string) => {
        let auth: [string, string] | undefined;
        for (let round = 0; round < 3; round += 1) {
          const branch = `z9hG4bK${token()}`;
          // CANCEL shares the INVITE's branch and CSeq number (RFC 3261 §9.1).
          const cancel = () => {
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
          };
          const ringDeadline = setTimeout(cancel, input.ringSeconds * 1000);
          const request = render(
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
              ["User-Agent", "bro"],
              ["Content-Type", "application/sdp"],
              ...(auth ? [auth] : []),
            ],
            offer
          );
          const pending = sip.request(request, branch, (provisional) => {
            if (provisional.body) startMedia(provisional);
          });
          // The voice gone while it rings: the person must not pick up into silence. No final answer even
          // after CANCEL (Timer B, 32 s): the attempt is over.
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each round answers the previous challenge.
          const first = await Promise.race([
            pending,
            session.closed.then(() => "voice_closed" as const),
            new Promise<"timeout">((resolve) => {
              setTimeout(
                () => {
                  resolve("timeout");
                },
                input.ringSeconds * 1000 + 32_000
              );
            }),
          ]);
          clearTimeout(ringDeadline);
          if (first === "timeout") return null;
          if (first === "voice_closed") {
            cancel();
            // oxlint-disable-next-line eslint/no-await-in-loop -- The last answer, if any, before giving up.
            await within(
              pending.catch(() => null),
              5000
            );
            return null;
          }
          const response = first;
          const code = status(response) ?? 0;
          if (code >= 200 && code < 300) return response;
          // ACK of a non-2xx final response: the INVITE's own branch and CSeq number (RFC 3261 §17.1.1.3).
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
          auth =
            code === 401 || code === 407
              ? authFor(response, "INVITE", `sip:${number}@${domain}`)
              : undefined;
          if (!auth) return response;
          cseq += 1;
        }
        return null;
      };

      // Exolve takes 7XXXXXXXXXX in the Request-URI (17.10); E.164 with + only after a final "no such
      // number" answer — a ringing or unclear attempt is never repeated.
      let number = input.target.slice(1);
      let answered = await invite(number).catch(() => null);
      if (
        answered &&
        [400, 404, 416, 484, 604].includes(status(answered) ?? 0)
      ) {
        cseq += 1;
        number = input.target;
        answered = await invite(number).catch(() => null);
      }
      const code = answered ? (status(answered) ?? 0) : null;
      if (!answered || code === null || code >= 300) {
        clearInterval(ringing);
        say("not connected", { sip: code ?? 0 });
        return {
          answered: false,
          sipStatus: code,
          ending: "not_connected",
          talkSeconds: 0,
          transcript: "",
          usageSeconds,
        };
      }

      answeredAt = performance.now();
      farHeardAt = answeredAt;
      farVoicedAt = answeredAt;
      broVoicedAt = answeredAt;
      startMedia(answered);
      say("answered");
      const remoteTag = tagOf(header(answered, "to"));
      const target = uriOf(
        header(answered, "contact") ?? `<sip:${number}@${domain}>`
      );
      const routes = [...(answered.headers.get("record-route") ?? [])]
        .flatMap((value) => value.split(/,(?=\s*<)/u))
        .toReversed();
      const dialogHeaders = (
        branch: string,
        method: string
      ): [string, string][] => [
        ["Via", via(branch)],
        ["Max-Forwards", "70"],
        ...routes.map((route): [string, string] => ["Route", route.trim()]),
        ["From", `<${fromUri}>;tag=${fromTag}`],
        ["To", `<sip:${number}@${domain}>;tag=${remoteTag ?? ""}`],
        ["Call-ID", callId],
        ["CSeq", `${String(cseq)} ${method}`],
      ];
      sip.send(
        render(
          `ACK ${target} SIP/2.0`,
          dialogHeaders(`z9hG4bK${token()}`, "ACK")
        )
      );

      // The voice cannot hang up: the call ends when the far side does, when both are silent for
      // `silenceSeconds` (as ElevenLabs' `silence_end_call_timeout`), or at the talk limit.
      const watch = setInterval(() => {
        const now = performance.now();
        if (now - farHeardAt > mediaLostMs) ended("media_lost");
        else if (
          now - Math.max(farVoicedAt, broVoicedAt) >
            input.silenceSeconds * 1000 &&
          queued < frameBytes
        )
          ended("silence");
      }, 500);
      const talkLimit = setTimeout(() => {
        ended("talk_limit");
      }, input.maxTalkSeconds * 1000);
      pieces.push({
        close: () => {
          clearInterval(watch);
          clearTimeout(talkLimit);
        },
      });
      const ending = await Promise.race([
        finished,
        sip.closed.then((): LiveCallOutcome["ending"] => "line_closed"),
        session.closed.then((): LiveCallOutcome["ending"] => "voice_closed"),
      ]);
      clearInterval(watch);
      clearTimeout(talkLimit);
      if (ending !== "hung_up" && ending !== "line_closed") {
        let auth: [string, string] | undefined;
        for (let round = 0; round < 2; round += 1) {
          cseq += 1;
          const branch = `z9hG4bK${token()}`;
          // oxlint-disable-next-line eslint/no-await-in-loop -- A challenged BYE is sent once more with credentials.
          const bye = await within(
            sip
              .request(
                render(`BYE ${target} SIP/2.0`, [
                  ...dialogHeaders(branch, "BYE"),
                  ...(auth ? [auth] : []),
                ]),
                branch
              )
              .catch(() => null),
            5000
          );
          auth =
            bye && (status(bye) === 401 || status(bye) === 407)
              ? authFor(bye, "BYE", target)
              : undefined;
          if (!auth) break;
        }
      }
      const talkSeconds = (performance.now() - answeredAt) / 1000;
      say("ended", { ending, seconds: Math.round(talkSeconds) });
      return {
        answered: true,
        sipStatus: code,
        ending,
        talkSeconds,
        transcript: transcript(),
        usageSeconds,
      };
    };

    return {
      sessionId: session.sessionId,
      /** Dials and talks; settles when the call is over, whatever ended it. */
      dial: () =>
        talk()
          .catch((): LiveCallOutcome => ({
            answered: answeredAt !== null,
            sipStatus: null,
            ending: "line_closed",
            talkSeconds:
              answeredAt === null ? 0 : (performance.now() - answeredAt) / 1000,
            transcript: transcript(),
            usageSeconds,
          }))
          .finally(closeAll),
      /** Gives the line and the voice back without dialling. */
      cancel: closeAll,
    };
  } catch (error) {
    closeAll();
    throw new LiveCallUnavailableError(
      error instanceof Error ? error.message : "The live call could not start."
    );
  }
}
