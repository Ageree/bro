"use client";

import { Client, isCurrentTurnBoundaryEvent } from "eve/client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as z from "zod";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { voiceTalkMarker } from "@shared/voice/marker";
import { Hearing } from "../_lib/hearing";
import {
  failedCommentary,
  replyCommentary,
  unheardCommentary,
  unsentCommentary,
} from "../_lib/retell";

const client = new Client({ host: "" });
type BroSession = ReturnType<typeof client.sessions.attach>;
/** Bro's chat for this page, and how far its stream has been read. */
interface BroChat {
  readonly session: BroSession;
  next: number;
}

export type TalkState =
  | { readonly kind: "starting" }
  | { readonly kind: "live" }
  | { readonly kind: "ended"; readonly reason: "person" | "idle" | "hidden" }
  | { readonly kind: "denied" }
  | { readonly kind: "failed"; readonly detail: string };

const liveEvent = z
  .string()
  .transform((text, context) => {
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch {
      context.addIssue({ code: "custom", message: "Not JSON" });
      return z.NEVER;
    }
  })
  .pipe(z.looseObject({ type: z.string() }));
const transcriptDelta = z.object({
  delta: z.string(),
  start_ms: z.number().optional(),
  end_ms: z.number().optional(),
});
const delegationCreated = z.object({
  delegation: z.object({ id: z.string() }),
});
const liveError = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
});

/** How long the person's transcript may still arrive after a delegation. */
const settleMs = 700;
const settleLimitMs = 2500;
/** A conversation with nothing said and nothing in work ends by itself. */
const idleLimitMs = 90_000;
const connectLimitMs = 15_000;
/** The voice is speaking while its transcript keeps coming. */
const speakingHoldMs = 700;

/**
 * The voice conversation: GPT-Live over WebRTC for the voice, and Bro in a
 * web chat session for everything it delegates. Each delegation sends the
 * person's words to Bro; each message Bro delivers goes back to the voice
 * as commentary to retell.
 */
export function useVoiceTalk() {
  const [state, setState] = useState<TalkState>({ kind: "starting" });
  const [speaking, setSpeaking] = useState(false);
  const [working, setWorking] = useState(false);
  const [silentAudio, setSilentAudio] = useState(false);
  const [lastRequest, setLastRequest] = useState<string>();
  const [chatId, setChatId] = useState<string>();
  const call = useRef<ReturnType<typeof openCall> | undefined>(undefined);
  const bro = useRef<BroChat>(undefined);
  // Every start and end moves it on: a start still waiting for the microphone
  // or the voice drops what it gets once a newer one or an end has come.
  const attempt = useRef(0);

  const end = useCallback((reason: "person" | "idle" | "hidden") => {
    attempt.current += 1;
    call.current?.close();
    call.current = undefined;
    setSpeaking(false);
    setWorking(false);
    setState({ kind: "ended", reason });
  }, []);

  const begin = useCallback(
    async (mine: number, microphone: MediaStream) => {
      if (attempt.current !== mine) {
        for (const track of microphone.getTracks()) track.stop();
        return;
      }
      const fail = (detail: string) => {
        if (attempt.current !== mine) return;
        attempt.current += 1;
        call.current?.close();
        call.current = undefined;
        setSpeaking(false);
        setWorking(false);
        setState({ kind: "failed", detail });
      };
      const opened = openCall({
        microphone,
        bro,
        onChat: setChatId,
        onRequest: setLastRequest,
        onSilentAudio: () => {
          setSilentAudio(true);
        },
        onSpeaking: setSpeaking,
        onWorking: setWorking,
        onIdle: () => {
          end("idle");
        },
        onFailure: fail,
      });
      call.current = opened;
      try {
        await opened.connected;
        if (attempt.current === mine) setState({ kind: "live" });
      } catch (error) {
        fail(error instanceof Error ? error.message : "Неизвестная ошибка");
      }
    },
    [end]
  );

  const connect = useCallback(() => {
    attempt.current += 1;
    const mine = attempt.current;
    call.current?.close();
    call.current = undefined;
    void navigator.mediaDevices
      .getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      .then(
        (microphone) => begin(mine, microphone),
        () => {
          if (attempt.current === mine) setState({ kind: "denied" });
        }
      );
  }, [begin]);

  useEffect(() => {
    connect();
    const hidden = () => {
      if (document.hidden) end("hidden");
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      attempt.current += 1;
      call.current?.close();
      call.current = undefined;
    };
  }, [connect, end]);

  return {
    chatId,
    end: () => {
      end("person");
    },
    lastRequest,
    silentAudio,
    speaking,
    start: () => {
      setState({ kind: "starting" });
      setSilentAudio(false);
      connect();
    },
    state,
    unmute: () => {
      void call.current?.audio
        .play()
        .then(() => {
          setSilentAudio(false);
          return undefined;
        })
        .catch(() => undefined);
    },
    working,
  };
}

function openCall(input: {
  microphone: MediaStream;
  bro: { current: BroChat | undefined };
  onChat: (sessionId: string) => void;
  onRequest: (words: string) => void;
  onSilentAudio: () => void;
  onSpeaking: (speaking: boolean) => void;
  onWorking: (working: boolean) => void;
  onIdle: () => void;
  onFailure: (detail: string) => void;
}) {
  const peer = new RTCPeerConnection();
  const channel = peer.createDataChannel("oai-events");
  const hearing = new Hearing();
  const startedAt = performance.now();
  const clock = () => performance.now() - startedAt;
  let lastHeardAt = 0;
  let lastActivityAt = 0;
  let speakingUntil = 0;
  let latestDelegation: string | undefined;
  let commentaryCount = 0;
  // Bro's turns since the last boundary: a turn the person's words opened
  // that ends without a message is a failure the voice should say.
  let sentSinceBoundary = 0;
  let deliveredSinceBoundary = 0;

  for (const track of input.microphone.getAudioTracks())
    peer.addTrack(track, input.microphone);
  // GPT-Live's voice comes as a remote track; the element plays it without
  // being on the page, as in OpenAI's WebRTC examples.
  const audio = new Audio();
  audio.autoplay = true;
  peer.addEventListener("track", (event) => {
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    // iOS lets a page that records play sound without a tap, as a rule;
    // where it does not, the page offers a button.
    void audio.play().catch(() => {
      input.onSilentAudio();
    });
  });

  const comment = (delegationId: string | undefined, content: string) => {
    if (delegationId === undefined || channel.readyState !== "open") return;
    commentaryCount += 1;
    channel.send(
      JSON.stringify({
        type: "session.commentary.append",
        event_id: `bro_${String(commentaryCount)}`,
        delegation_id: delegationId,
        content,
      })
    );
  };

  // Each conversation reads Bro's chat on from where the previous one
  // stopped: what came while none was open stays in the chat, unspoken.
  const following = new AbortController();
  const follow = async (chat: BroChat) => {
    for await (const event of chat.session.stream({
      signal: following.signal,
      startIndex: chat.next,
    })) {
      chat.next += 1;
      if (event.type === "action.result" && event.data.status === "completed") {
        const result = sendMessageToolResultSchema.safeParse(event.data.result);
        if (!result.success) continue;
        const output = result.data.output;
        const text =
          output.kind === "link"
            ? "Прислал ссылку в чат."
            : (output.text ?? "Прислал файл в чат.");
        deliveredSinceBoundary += 1;
        lastActivityAt = clock();
        comment(latestDelegation, replyCommentary(text));
      }
      if (isCurrentTurnBoundaryEvent(event)) {
        if (sentSinceBoundary > 0 && deliveredSinceBoundary === 0)
          comment(latestDelegation, failedCommentary);
        sentSinceBoundary = 0;
        deliveredSinceBoundary = 0;
        input.onWorking(false);
      }
    }
  };

  let followed: BroChat | undefined;
  const followChat = (chat: BroChat) => {
    if (followed === chat) return;
    followed = chat;
    void follow(chat).catch(() => {
      if (following.signal.aborted) return;
      console.warn("[voice] Bro's stream stopped");
      if (followed === chat) followed = undefined;
    });
  };
  // Before the first delegation, so what came between conversations is read
  // past while there is nothing to retell it as.
  if (input.bro.current !== undefined) followChat(input.bro.current);

  // Two quick delegations share one new chat.
  let creating: Promise<BroChat> | undefined;
  const broSession = async () => {
    let chat = input.bro.current;
    if (chat === undefined) {
      creating ??= client.sessions.create().then(({ session }) => {
        const created = { session, next: 0 };
        input.bro.current = created;
        input.onChat(session.state.sessionId);
        return created;
      });
      try {
        chat = await creating;
      } catch (error) {
        creating = undefined;
        throw error;
      }
    }
    followChat(chat);
    return chat.session;
  };

  // The person's last words may still be on their way when the voice
  // delegates: wait for their transcript to go quiet, within a limit.
  const settled = () =>
    new Promise<void>((resolve) => {
      const from = clock();
      const timer = setInterval(() => {
        const now = clock();
        if (now - lastHeardAt < settleMs && now - from < settleLimitMs) return;
        clearInterval(timer);
        resolve();
      }, 100);
    });

  const delegate = async (delegationId: string) => {
    await settled();
    const words = hearing.takeRequest();
    if (words === undefined) {
      comment(delegationId, unheardCommentary);
      return;
    }
    input.onRequest(words);
    input.onWorking(true);
    try {
      const session = await broSession();
      await session.send(`${voiceTalkMarker} ${words}`, {
        turnPolicy: "steer",
      });
      sentSinceBoundary += 1;
    } catch {
      console.warn("[voice] the request did not reach Bro");
      input.onWorking(false);
      comment(delegationId, unsentCommentary);
    }
  };

  channel.addEventListener("message", (message) => {
    const parsed = liveEvent.safeParse(message.data);
    if (!parsed.success) return;
    const event = parsed.data;
    const now = clock();
    if (event.type === "session.input_transcript.delta") {
      const delta = transcriptDelta.safeParse(event);
      if (!delta.success) return;
      lastHeardAt = now;
      lastActivityAt = now;
      hearing.hear({
        text: delta.data.delta,
        startMs: delta.data.start_ms ?? now,
        endMs: delta.data.end_ms ?? now,
      });
    } else if (event.type === "session.output_transcript.delta") {
      const delta = transcriptDelta.safeParse(event);
      if (!delta.success) return;
      lastActivityAt = now;
      speakingUntil = now + speakingHoldMs;
      input.onSpeaking(true);
      hearing.speak({
        text: delta.data.delta,
        startMs: delta.data.start_ms ?? now,
        endMs: delta.data.end_ms ?? now,
      });
    } else if (event.type === "session.delegation.created") {
      const created = delegationCreated.safeParse(event);
      if (!created.success) return;
      latestDelegation = created.data.delegation.id;
      lastActivityAt = now;
      void delegate(created.data.delegation.id);
    } else if (event.type === "session.closed") {
      input.onFailure("Голос закрыл разговор.");
    } else if (event.type === "error") {
      console.warn("[voice] GPT-Live error", liveError.safeParse(event).data);
    }
  });

  const ticker = setInterval(() => {
    const now = clock();
    if (now > speakingUntil) input.onSpeaking(false);
    if (
      now - lastActivityAt > idleLimitMs &&
      sentSinceBoundary === 0 &&
      peer.connectionState === "connected"
    )
      input.onIdle();
  }, 250);

  const connected = (async () => {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch("/api/voice/session", {
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp" },
      method: "POST",
    });
    if (!response.ok)
      throw new Error(
        `Сервер не открыл голосовую сессию (${String(response.status)}).`
      );
    await peer.setRemoteDescription({
      sdp: await response.text(),
      type: "answer",
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Сессия открыта, но звук не дошёл за ${String(connectLimitMs / 1000)} с (ICE: ${peer.iceConnectionState}).`
          )
        );
      }, connectLimitMs);
      const check = () => {
        if (peer.connectionState === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (peer.connectionState === "failed") {
          clearTimeout(timer);
          reject(
            new Error(
              `Звук не прошёл до голоса (ICE: ${peer.iceConnectionState}).`
            )
          );
        }
      };
      peer.addEventListener("connectionstatechange", check);
      check();
    });
    lastActivityAt = clock();
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed")
        input.onFailure("Связь со звуком оборвалась.");
    });
  })();

  return {
    audio,
    connected,
    close() {
      following.abort();
      clearInterval(ticker);
      channel.close();
      peer.close();
      for (const track of input.microphone.getTracks()) track.stop();
      audio.srcObject = null;
    },
  };
}
