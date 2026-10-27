"use client";

import { Client, isCurrentTurnBoundaryEvent } from "eve/client";
import { useCallback, useEffect, useRef, useState } from "react";
import * as z from "zod";
import { sendMessageToolResultSchema } from "@shared/chat/message-delivery";
import { voiceTalkMarker } from "@shared/voice/marker";
import {
  voiceCalendarPath,
  voicePaceHeader,
  voiceSessionPath,
} from "@shared/voice/routes";
import { Hearing } from "../_lib/hearing";
import {
  alreadySentCommentary,
  asksPerson,
  failedCommentary,
  notePieces,
  progressCommentary,
  replyCommentary,
  spokenText,
  unheardCommentary,
  unsentCommentary,
  waitingCommentary,
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
  start_ms: z.number().nullish(),
  end_ms: z.number().nullish(),
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
/** Words sent this recently answer a second delegation for them too. */
const recentSendMs = 8000;
/** Quiet after the person's answer to Bro's question before it goes to Bro. */
const answerSettleMs = 1500;
/** A conversation with nothing said and nothing in work ends by itself. */
const idleLimitMs = 90_000;
const connectLimitMs = 15_000;
/** The voice is speaking while its transcript keeps coming. */
const speakingHoldMs = 700;

/** What the page did with the person's words, for the server's journal. */
type PageEvent =
  | "already_sent"
  | "answer_sent"
  | "closed"
  | "delegated"
  | "failed"
  | "sent"
  | "unheard"
  | "unsent";

/** A line in the server's journal (`app/api/voice/event`); never their words. */
function report(kind: PageEvent) {
  try {
    navigator.sendBeacon(
      "/api/voice/event",
      new Blob([JSON.stringify({ kind })], { type: "application/json" })
    );
  } catch {
    // The journal is no reason to stop the conversation.
  }
}

/**
 * The voice conversation: GPT-Live over WebRTC for the voice, and Bro in a
 * web chat session for everything it delegates. Each delegation sends the
 * person's words to Bro; each message Bro delivers goes back to the voice
 * as commentary to retell. When that message asks the person something,
 * their answer goes to Bro too, delegated or not.
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
      let opened: ReturnType<typeof openCall>;
      try {
        opened = openCall({
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
      } catch {
        // No WebRTC in this browser (iOS Lockdown Mode turns it off).
        for (const track of microphone.getTracks()) track.stop();
        fail("Этот браузер не умеет голосовую связь (WebRTC).");
        return;
      }
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
  // VOICE_FAST_WORKSPACES, as the session's answer says: the page tells the
  // voice what to say while Bro works, and Bro's messages go over bare.
  let pagePaced = false;
  // Bro's question the person has not answered yet: GPT-Live may take their
  // reply for part of the task under way and delegate nothing (20.10 the
  // owner's choice after «Что берём?» never reached Bro), and its docs leave
  // a reply to the app.
  let answerOwed: { delegationId: string; since: number } | undefined;
  let commentaryCount = 0;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  // Bro's turns since the last boundary: a turn the person's words opened
  // that failed, or ended with no message and no card waiting in the chat,
  // is a failure the voice should say.
  let sentSinceBoundary = 0;
  let deliveredSinceBoundary = 0;
  let turnFailed = false;
  let waitsOnChat = false;

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

  // The person's calendar for the voice's context (VOICE_FAST_WORKSPACES;
  // elsewhere the route is missing): Google takes a second or two, so the
  // line does not wait for it, and it arrives as a silent note.
  const calendar = fetch(voiceCalendarPath, { cache: "no-store" })
    .then(async (response) =>
      response.status === 200 ? await response.text() : undefined
    )
    .catch(() => undefined);
  const noteCalendar = (text: string | undefined) => {
    if (text === undefined || channel.readyState !== "open") return;
    for (const [index, content] of notePieces(text).entries()) {
      channel.send(
        JSON.stringify({
          type: "session.thinking.append",
          event_id: `calendar_${String(index)}`,
          delegation_id: null,
          content,
        })
      );
    }
  };
  channel.addEventListener("open", () => {
    void calendar.then(noteCalendar);
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
        // The fast voice gets the bare text: wrapped as «сообщение уже ушло
        // человеку в чат», it opened with «Я уже ему написал:» in 21 of 45
        // answers (probe 27.10), and the bare text never.
        comment(
          latestDelegation,
          pagePaced ? spokenText(text) : replyCommentary(text)
        );
        answerOwed =
          asksPerson(text) && latestDelegation !== undefined
            ? { delegationId: latestDelegation, since: clock() }
            : undefined;
      }
      if (
        event.type === "input.requested" ||
        event.type === "authorization.required"
      ) {
        waitsOnChat = true;
        comment(latestDelegation, waitingCommentary);
      }
      // A heads-up may have gone out before the turn failed.
      if (event.type === "turn.failed" || event.type === "session.failed")
        turnFailed = true;
      if (isCurrentTurnBoundaryEvent(event)) {
        if (
          sentSinceBoundary > 0 &&
          (turnFailed || (deliveredSinceBoundary === 0 && !waitsOnChat))
        ) {
          comment(latestDelegation, failedCommentary);
          report("failed");
        }
        sentSinceBoundary = 0;
        deliveredSinceBoundary = 0;
        turnFailed = false;
        waitsOnChat = false;
        input.onWorking(false);
      }
    }
  };

  // A stream eve's client gives up on (Safari's «Load failed» on a network
  // switch, a long restart of eve) is followed again from its cursor.
  let followed: BroChat | undefined;
  const followChat = (chat: BroChat, retry = 0) => {
    if (followed === chat && retry === 0) return;
    followed = chat;
    const again = () => {
      if (following.signal.aborted || followed !== chat) return;
      console.warn("[voice] Bro's stream stopped; following it again");
      setTimeout(
        () => {
          if (!following.signal.aborted && followed === chat)
            followChat(chat, retry + 1);
        },
        Math.min(30_000, 1000 * 2 ** retry)
      );
    };
    void follow(chat).then(again, again);
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

  const sendToBro = async (
    delegationId: string,
    words: string,
    kind: "answer_sent" | "sent"
  ) => {
    input.onRequest(words);
    input.onWorking(true);
    // Before the send: a delegation for these words while it is on its way
    // finds them sent, not unheard.
    lastSentAt = clock();
    try {
      const session = await broSession();
      await session.send(`${voiceTalkMarker} ${words}`, {
        turnPolicy: "steer",
      });
      sentSinceBoundary += 1;
      report(kind);
    } catch {
      console.warn("[voice] the request did not reach Bro");
      input.onWorking(false);
      comment(delegationId, unsentCommentary);
      report("unsent");
    }
  };

  const delegate = async (delegationId: string) => {
    // The first delegation's new chat is opened while the words settle, not
    // after, when there are words to send: a failure here is retried by the
    // send.
    if (input.bro.current === undefined && hearing.hasRequest())
      void broSession().catch(() => null);
    await settled();
    if (following.signal.aborted) return;
    const words = hearing.takeRequest();
    if (words === undefined) {
      const sent = clock() - lastSentAt < recentSendMs;
      comment(delegationId, sent ? alreadySentCommentary : unheardCommentary);
      report(sent ? "already_sent" : "unheard");
      return;
    }
    await sendToBro(delegationId, words, "sent");
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
      answerOwed = undefined;
      report("delegated");
      // Within GPT-Live's 800 ms, before its own «Секунду, смотрю».
      if (pagePaced) comment(created.data.delegation.id, progressCommentary);
      void delegate(created.data.delegation.id);
    } else if (event.type === "session.closed") {
      report("closed");
      input.onFailure("Голос закрыл разговор.");
    } else if (event.type === "error") {
      console.warn("[voice] GPT-Live error", liveError.safeParse(event).data);
    }
  });

  const ticker = setInterval(() => {
    const now = clock();
    if (now > speakingUntil) input.onSpeaking(false);
    // The person answered Bro's question and has gone quiet, and the voice
    // delegated nothing for it: the answer goes to Bro all the same.
    if (
      answerOwed !== undefined &&
      lastHeardAt > answerOwed.since &&
      now - lastHeardAt >= answerSettleMs
    ) {
      const { delegationId } = answerOwed;
      answerOwed = undefined;
      const words = hearing.takeRequest();
      if (words !== undefined)
        void sendToBro(delegationId, words, "answer_sent");
    }
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
    const response = await fetch(voiceSessionPath, {
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp" },
      method: "POST",
    });
    if (!response.ok)
      throw new Error(
        `Сервер не открыл голосовую сессию (${String(response.status)}).`
      );
    pagePaced = response.headers.get(voicePaceHeader) === "page";
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
