"use client";

import { useEffect, useRef } from "react";

/** How often a paused, visible clip is nudged back into playing. */
const watchdogIntervalMs = 2000;

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

  const listeners = new AbortController();
  const { signal } = listeners;
  let resuming = false;
  let retried = false;
  let awaitingGesture = false;
  let gestureBound = false;

  const isPlaying = () => !video.paused && !video.ended && !video.error;

  const needsLoad = () =>
    Boolean(video.error) ||
    video.networkState === HTMLMediaElement.NETWORK_EMPTY ||
    video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;

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
    video.load();
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
    if (needsLoad()) video.load();
    void attemptPlay();
  }

  document.addEventListener("visibilitychange", resume, { signal });
  window.addEventListener("pageshow", resume, { signal });
  window.addEventListener("focus", resume, { signal });
  video.addEventListener("ended", resume, { signal });
  video.addEventListener("stalled", resume, { signal });
  video.addEventListener("suspend", resume, { signal });
  // resume() already calls load() through needsLoad() whenever the element
  // carries an error, and the watchdog bounds the retry rate, so an
  // unreachable file is not refetched in a tight loop.
  video.addEventListener("error", resume, { signal });

  const watchdog = window.setInterval(() => {
    if (!document.hidden && video.paused) resume();
  }, watchdogIntervalMs);

  resume();

  return () => {
    listeners.abort();
    window.clearInterval(watchdog);
  };
}

/**
 * The one image on the page: a figure standing on the same white as the
 * paper. `contain`, never `cover`, so it is shown whole at every viewport
 * and the letterboxing either side of a 9:16 frame is invisible. The clip
 * carries no audio track, so there is no sound control to offer.
 */
export function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    return video ? keepPlaying(video) : undefined;
  }, []);

  return (
    <video
      aria-hidden="true"
      autoPlay
      className="absolute inset-0 block size-full bg-background object-contain"
      loop
      muted
      playsInline
      preload="auto"
      ref={videoRef}
      src="/brand/hero-portrait.mp4"
    />
  );
}
