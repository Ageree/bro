"use client";

import { useEffect, useRef } from "react";

/** How often a paused or stuck, visible clip is nudged back into playing. */
const watchdogIntervalMs = 2000;

/**
 * A clip that reports itself playing but has not advanced for this many
 * watchdog ticks, with no data ahead, is treated as a stalled fetch.
 */
const stalledTicksBeforeReload = 2;

/**
 * How many times an errored or stalled clip is reloaded before it is left
 * alone. The film is decorative: an unreachable file must not be fetched
 * forever.
 */
const maxReloads = 3;

/**
 * Browsers pause an autoplaying clip for many reasons — a tab in the
 * background, a bfcache restore, Low Power Mode on iOS, a stalled fetch —
 * so this keeps resuming it and, when play() is refused outright, waits
 * for the first gesture instead of hammering load()+play(). Returns the
 * teardown.
 */
function keepPlaying(video: HTMLVideoElement) {
  // React sets `muted` as a property rather than an attribute, and iOS only
  // autoplays a clip that is muted before the first play() call.
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;

  const listeners = new AbortController();
  const { signal } = listeners;
  let resuming = false;
  let retried = false;
  let awaitingGesture = false;
  let gestureBound = false;
  let reloads = 0;
  let lastTime = video.currentTime;
  let stalledTicks = 0;

  const isPlaying = () => !video.paused && !video.ended && !video.error;

  const needsLoad = () =>
    Boolean(video.error) ||
    video.networkState === HTMLMediaElement.NETWORK_EMPTY ||
    video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;

  const watchdog = window.setInterval(() => {
    if (!document.hidden) checkProgress();
  }, watchdogIntervalMs);

  const stop = () => {
    listeners.abort();
    window.clearInterval(watchdog);
  };

  // Every reload of the source counts until the clip plays again; past the
  // cap the whole loop shuts down and the frame stays as it is.
  function reload() {
    if (reloads >= maxReloads) {
      stop();
      return false;
    }
    reloads += 1;
    video.load();
    return true;
  }

  function bindGestureFallback() {
    if (gestureBound) return;
    gestureBound = true;
    const onGesture = () => {
      awaitingGesture = false;
      resume();
    };
    const options = { once: true, passive: true, signal };
    document.addEventListener("touchstart", onGesture, options);
    document.addEventListener("click", onGesture, options);
    document.addEventListener("keydown", onGesture, options);
  }

  // A refused play() gets one reload-and-retry; a refusal that names the
  // autoplay policy waits for a gesture instead. Awaiting the retry keeps
  // the re-entrancy lock held until it settles.
  async function onPlayRejected(error: Error) {
    if (error.name === "NotAllowedError") {
      // Low Power Mode (or similar): iOS keeps rejecting play() until a real
      // user gesture happens, so wait for a tap, click or key.
      awaitingGesture = true;
      bindGestureFallback();
      return;
    }
    if (retried) return;
    retried = true;
    if (!reload()) return;
    try {
      await video.play();
    } catch (retryError) {
      await onPlayRejected(
        retryError instanceof Error ? retryError : new Error("play failed")
      );
    }
  }

  async function attemptPlay() {
    try {
      await video.play();
    } catch (error) {
      await onPlayRejected(
        error instanceof Error ? error : new Error("play failed")
      );
    } finally {
      resuming = false;
    }
  }

  function resume() {
    if (document.hidden) return;
    if (awaitingGesture) return;
    if (isPlaying()) return;
    if (resuming) return;
    resuming = true;
    retried = false;
    if (needsLoad() && !reload()) {
      resuming = false;
      return;
    }
    void attemptPlay();
  }

  // A clip whose fetch stalls after playback began still says `paused ===
  // false`, so resume() alone would never touch it: watch the play head
  // instead, and reload once it has sat still with nothing buffered ahead.
  function checkProgress() {
    if (video.paused) {
      stalledTicks = 0;
      resume();
      return;
    }
    const advanced = video.currentTime !== lastTime;
    lastTime = video.currentTime;
    if (advanced || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      stalledTicks = 0;
      return;
    }
    stalledTicks += 1;
    if (stalledTicks < stalledTicksBeforeReload) return;
    stalledTicks = 0;
    if (reload()) void video.play().catch(() => undefined);
  }

  document.addEventListener("visibilitychange", resume, { signal });
  window.addEventListener("pageshow", resume, { signal });
  window.addEventListener("focus", resume, { signal });
  video.addEventListener("ended", resume, { signal });
  video.addEventListener("suspend", resume, { signal });
  // A stall the browser reports is checked on the next tick like any other;
  // the watchdog is what decides it is real.
  video.addEventListener("stalled", resume, { signal });
  video.addEventListener("waiting", resume, { signal });
  // resume() reloads through needsLoad() whenever the element carries an
  // error, and reload() caps how often that happens.
  video.addEventListener("error", resume, { signal });
  video.addEventListener(
    "playing",
    () => {
      reloads = 0;
      stalledTicks = 0;
    },
    { signal }
  );

  resume();

  return stop;
}

/**
 * Someone who asked the system for less motion gets the figure standing
 * still: the first frame, no autoplay, no loop. Returns the teardown.
 */
function holdStill(video: HTMLVideoElement) {
  video.autoplay = false;
  video.loop = false;
  video.pause();
  // Seeking before any metadata is an InvalidStateError; a clip that has not
  // loaded yet already stands on its first frame.
  if (video.readyState > HTMLMediaElement.HAVE_NOTHING) video.currentTime = 0;
  return () => undefined;
}

/** The clip's own frame, so the element has its ratio before it loads. */
const frameWidth = 720;
const frameHeight = 1280;

/**
 * The one image on the page: a figure standing on the same white as the
 * paper. The element is sized to the clip's own 9:16 frame rather than
 * letterboxed inside a larger box — width first, height derived, both
 * clamped to the stage, which a replaced element resolves by keeping the
 * ratio. So the element's edges are the frame's edges, and `film-edge` can
 * fade exactly those: iOS composites video in its own layer and draws it a
 * shade off the page white, which turns a hard edge into a visible frame
 * around an otherwise white clip. The figure is never cropped, and the
 * clip carries no audio track, so there is no sound control to offer.
 */
export function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let teardown: () => void = () => undefined;
    const apply = () => {
      teardown();
      teardown = reducedMotion.matches ? holdStill(video) : keepPlaying(video);
    };
    apply();
    reducedMotion.addEventListener("change", apply);
    return () => {
      reducedMotion.removeEventListener("change", apply);
      teardown();
    };
  }, []);

  return (
    <video
      aria-hidden="true"
      autoPlay
      className="absolute inset-0 m-auto block size-auto max-h-full max-w-full bg-background film-edge object-contain"
      height={frameHeight}
      loop
      muted
      playsInline
      preload="auto"
      ref={videoRef}
      src="/brand/hero-portrait.mp4"
      width={frameWidth}
    />
  );
}
