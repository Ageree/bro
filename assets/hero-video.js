(function () {
  function init() {
    var video = document.querySelector(".stage__video");
    if (!video) return;

    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("playsinline", "");

    var resuming = false;
    var retried = false;
    var gestureBound = false;
    var awaitingGesture = false;

    function isPlaying() {
      return !video.paused && !video.ended && !video.error;
    }

    function needsLoad() {
      return Boolean(video.error) ||
        video.networkState === HTMLMediaElement.NETWORK_EMPTY ||
        video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
    }

    function bindGestureFallback() {
      if (gestureBound) return;
      gestureBound = true;
      var onGesture = function () {
        awaitingGesture = false;
        resume();
      };
      document.addEventListener("touchstart", onGesture, { once: true, passive: true });
      document.addEventListener("click", onGesture, { once: true, passive: true });
      document.addEventListener("keydown", onGesture, { once: true, passive: true });
    }

    function finishResume() {
      resuming = false;
    }

    // Returning a promise (or undefined) here, rather than clearing
    // `resuming` inline, lets the outer .then in attemptPlay wait for the
    // retry to actually settle before releasing the re-entrancy lock.
    function onPlayRejected(err) {
      if (err && err.name === "NotAllowedError") {
        // Low Power Mode (or similar): iOS will keep rejecting play() until
        // a real user gesture happens. Don't hammer load()+play() every
        // watchdog tick - wait for a tap/click/key instead.
        awaitingGesture = true;
        bindGestureFallback();
        return;
      }
      if (retried) {
        console.debug("hero video resume failed", err);
        return;
      }
      retried = true;
      try {
        video.load();
      } catch (e) {}
      var p2 = video.play();
      if (p2 && typeof p2.catch === "function") {
        return p2.catch(onPlayRejected);
      }
    }

    function attemptPlay() {
      var p = video.play();
      if (p && typeof p.catch === "function") {
        p.catch(onPlayRejected).then(finishResume, finishResume);
      } else {
        finishResume();
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
      attemptPlay();
    }

    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    video.addEventListener("ended", resume);
    video.addEventListener("stalled", resume);
    video.addEventListener("suspend", resume);
    // resume() already calls load() via needsLoad() whenever video.error is
    // set, and the 2s watchdog bounds the retry rate - no separate load()
    // call here, so an unreachable file doesn't get refetched in a tight loop.
    video.addEventListener("error", resume);

    setInterval(function () {
      if (!document.hidden && video.paused) resume();
    }, 2000);

    resume();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
