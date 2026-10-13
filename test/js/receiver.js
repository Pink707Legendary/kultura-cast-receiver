/**
 * KULTURA Cast Receiver — Ambient Gallery engine.
 *
 * The phone sends a list of artworks (in batches) over the Google Cast custom channel; the TV
 * then plays them on its own, so the slideshow keeps going when the phone sleeps or leaves.
 *
 * Each artwork is one "slide": the image cross-fades in, then a single Web Animation moves the
 * camera (gentle breath -> glide into the AI-crop detail -> linger -> pull back) while a second
 * animation fades the caption in near the end. Both animations share the slide duration
 * (secondsPerArtwork), so:
 *   - Pause/Resume is animation.pause()/play(): motion freezes exactly and resumes in place.
 *   - Changing the speed rescales the running slide without a jump.
 *   - The slide advances when its animation finishes (no separate timers to get out of sync).
 *
 * Geometry lives in motion.js, message validation in protocol.js; both are unit-tested.
 * The message protocol is defined on the phone side in types/cast.ts.
 *
 * Wall mode (2.9.0, docs/design/2026-10-12-wall-on-tv.md): LOAD_WALL (+ APPEND_WALL_PIECES) leaves the
 * slideshow and plays a camera tour of the person's wall (planned in walltour.js, drawn by wallview.js);
 * LOAD_MANIFEST leaves the wall for the slideshow. The remote commands, settings, auto-stop and the test-only
 * SEEK work in both modes; in wall mode STATUS counts painting stops.
 */
(function () {
  "use strict";

  var RECEIVER_VERSION = "2.9.0";
  var NAMESPACE = "urn:x-cast:art.kultura.cast";
  var PRELOAD_AHEAD = 2;
  /**
   * A painting that takes longer than this to load while another is on screen gets a small "Loading"
   * tag. Google's checklist ("Receiver buffering") asks for a delay so the tag doesn't flash on every
   * normal change.
   */
  var CONTENT_LOADING_INDICATOR_DELAY_MS = 2000;
  /** With no list this long after the page started, the start screen stops spinning and says what to do. */
  var WAITING_FOR_LIST_MS = 20000;
  /** The "Paused · 3 of 40 · KULTURA" text fades after this long; the pause icon stays. */
  var PAUSED_TEXT_FADE_MS = 8000;
  var IMAGE_LOAD_TIMEOUT_MS = 15000;
  /** Longest wait for img.decode() after the image has loaded. */
  var DECODE_WAIT_MAX_MS = 3000;
  /** How often the watchdog checks that the slideshow is still moving. */
  var WATCHDOG_INTERVAL_MS = 10000;
  /**
   * Longest a single artwork can legitimately spend loading: large image timeout, then fallback image
   * timeout, then the decode cap. The load path owns these timeouts; the watchdog only steps in after
   * this (plus a grace period), so it never cuts a fallback short.
   */
  var LOAD_DEADLINE_MS = window.KulturaPlaylist.worstCaseLoadMs(IMAGE_LOAD_TIMEOUT_MS, DECODE_WAIT_MAX_MS);

  var Motion = window.KulturaMotion;
  var Protocol = window.KulturaProtocol;
  var Backdrop = window.KulturaBackdrop;
  var Playlist = window.KulturaPlaylist;
  var Telemetry = window.KulturaTelemetry;
  /** When the page stops by itself (idle, paused, unattended): idle.js. */
  var Idle = window.KulturaIdle;
  var WallView = window.KulturaWallView;
  /**
   * Wall mode: the tour starts once all the pieces a LOAD_WALL announced have arrived, or after this long with
   * the ones that came (a lost APPEND_WALL_PIECES never leaves the TV waiting).
   */
  var WALL_ASSEMBLY_WAIT_MS = 10000;

  // ─── DOM refs ───
  var layers = { a: document.getElementById("layer-a"), b: document.getElementById("layer-b") };
  var idleScreen = document.getElementById("idle-screen");
  var idleSubtitle = idleScreen.querySelector(".idle-subtitle");
  var idleSource = idleScreen.querySelector(".idle-source");
  var loadingIndicator = document.getElementById("loading-indicator");
  var loadingTitle = loadingIndicator.querySelector(".loading-title");
  var pausedIndicator = document.getElementById("paused-indicator");
  var pausedPosition = pausedIndicator.querySelector(".paused-position");

  // ─── State ───
  /** The list being played; replaced by every LOAD_MANIFEST (see playlist.js for the takeover rule). */
  var playlist = Playlist.createPlaylist();
  /** Shortcuts into `playlist`, refreshed whenever it changes. */
  var artworks = playlist.artworks;
  var sourceName = playlist.sourceName;
  var currentIndex = 0;
  var isPaused = false;
  var secondsPerArtwork = Protocol.DEFAULT_SECONDS;
  var backdropTexture = Backdrop.DEFAULT_TEXTURE;
  var backdropMood = "auto";
  /** Gallery choreography (motion.js): "gentle" (default, owner decision 2026-10-03) or "still". */
  var motionMode = Protocol.DEFAULT_MOTION;
  /**
   * The artwork on screen as it is actually shown: loaded image, its plan (motion.js planSlide), the
   * layer it lives in. Reported in STATUS.debug; null before the first picture.
   */
  var currentSlide = null;
  /**
   * Test-only controls (SEEK) for scripts/tv_capture.py. Off unless the page URL has ?debug (dev.html)
   * or a DEBUG_MODE {enabled: true} message arrived in this session (the dev sender sends it). The app
   * never sends either. See protocol.js.
   */
  var debugMode = /[?&]debug\b/.test(window.location.search || "");
  /** Test-only wall render switches (RENDER_FLAGS, debug mode only; protocol.js RENDER_FLAG_SPEC). Kept for the session. */
  var renderFlags = {};
  /** Incremented per transition, so a late cleanup never hides a layer that has become active again. */
  var transitionToken = 0;
  var activeLayerId = "a";
  /** Incremented for every slide change; stale image loads compare against it and give up. */
  var slideToken = 0;
  /** Animations of the slide currently on screen: { image, caption } or null. */
  var slideAnimations = null;
  var consecutiveLoadFailures = 0;
  var castContext = null;
  /** For diagnostics in STATUS: "idle" | "loading" | "playing" | "failed". */
  var slidePhase = "idle";
  var phaseStartedAt = Date.now();
  /** True from a LOAD_MANIFEST until its first picture is on screen ("Preparing your gallery"). */
  var isPreparing = false;
  var lastError = null;
  /** Auto-stop clocks (idle.js): since when there is nothing to show / the slideshow is paused. */
  var nothingToShowSince = Date.now();
  var pausedSince = null;
  /** Why the page stopped by itself ("idle" | "paused" | "unattended"), for diagnostics and tests. */
  var autoStoppedReason = null;
  var loadingIndicatorTimer = null;
  var pausedTextTimer = null;
  /** "slideshow" (LOAD_MANIFEST) or "wall" (LOAD_WALL). */
  var mode = "slideshow";
  /**
   * The wall being received or played: { wallId, command (validated LOAD_WALL), pieces, ids, ownerSenderId,
   * started } or null. Its pieces are drawn by `wallView`.
   */
  var wallState = null;
  var wallAssemblyTimer = null;
  var wallView = null;

  function setPhase(phase) {
    slidePhase = phase;
    phaseStartedAt = Date.now();
  }

  window.addEventListener("error", function (event) {
    lastError = String(event.message || event.error || "error").slice(0, 200);
  });
  window.addEventListener("unhandledrejection", function (event) {
    lastError = ("promise: " + String(event.reason && event.reason.message || event.reason)).slice(0, 200);
  });

  // ─── Keep the screen awake ───
  // Without media playing, Google TV starts its own screensaver (Ambient mode) on top of this page,
  // which hides it and freezes the animations. Ask for a screen wake lock while artworks are showing,
  // and ask again whenever the page becomes visible (the browser drops the lock when hidden).
  var wakeLock = null;
  var wakeLockStatus = navigator.wakeLock ? "not requested" : "unsupported";

  /** Something to show: a slideshow list, or a wall (received or playing). */
  function hasContent() {
    return mode === "wall" ? wallState != null : artworks.length > 0;
  }

  function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock || !hasContent() || document.visibilityState !== "visible") return;
    navigator.wakeLock.request("screen").then(
      function (lock) {
        wakeLock = lock;
        wakeLockStatus = "held";
        lock.addEventListener("release", function () {
          wakeLock = null;
          wakeLockStatus = "released";
        });
      },
      function (err) {
        wakeLockStatus = "refused: " + String(err && err.message || err).slice(0, 120);
      }
    );
  }

  document.addEventListener("visibilitychange", function () {
    requestWakeLock();
    sendStatus();
  });

  // Frame times (ms between frames) over the last few seconds, to spot stutter on slow TV graphics
  // chips. Percentiles, not an average: an average hides the occasional long frame people notice.
  var FRAME_SAMPLES = 240;
  var frameTimes = [];
  (function measureFrames() {
    var last = null;
    function tick(now) {
      if (last != null) {
        frameTimes.push(now - last);
        if (frameTimes.length > FRAME_SAMPLES) frameTimes.shift();
      }
      last = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
  }

  function frameTimeStats() {
    var sorted = frameTimes.slice().sort(function (a, b) {
      return a - b;
    });
    return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), samples: sorted.length };
  }

  /** Current pose of the painting on screen, read from the running animation ({ scale: 1 } = whole). */
  function currentPose() {
    if (!currentSlide) return null;
    var transform = getComputedStyle(currentSlide.img).transform;
    var m = /^matrix\(([-\d.e]+), [-\d.e]+, [-\d.e]+, [-\d.e]+, ([-\d.e]+), ([-\d.e]+)\)/.exec(transform || "");
    return m ? { scale: Number(m[1]), x: Number(m[2]), y: Number(m[3]) } : { scale: 1, x: 0, y: 0 };
  }

  /**
   * Where the centre of the subject is on screen right now, in device px (null: no subject). The subject
   * is the chosen point(s) of interest when the phone sent them (2.7.0), else the AI crop.
   */
  function focusOnScreen(slide, pose) {
    var f = slide.plan.subject || slide.artwork.focus;
    if (!f || !pose) return null;
    var view = currentView();
    var box = slide.plan.box;
    var x = view.width / 2 + pose.x + pose.scale * ((f.x0 + f.x1) / 2 - 0.5) * box.width;
    var y = view.height / 2 + pose.y + pose.scale * ((f.y0 + f.y1) / 2 - 0.5) * box.height;
    return { x: Math.round(x * slide.dpr), y: Math.round(y * slide.dpr) };
  }

  /** Which image tier is on screen: "zoom" (large), "display" (fallback) or "single" (only one sent). */
  function imageTier(artwork, url) {
    if (!artwork.fallbackImageUrl) return "single";
    return url === artwork.fallbackImageUrl ? "display" : "zoom";
  }

  /** What the viewer sees right now: image tier and size, plan, zoom and sharpness. */
  function slideDiagnostics() {
    if (!currentSlide) return { image: null, motion: { mode: motionMode } };
    var s = currentSlide;
    var anim = slideAnimations && slideAnimations.clock;
    var timeMs = anim && anim.currentTime != null ? anim.currentTime : 0;
    var pose = currentPose();
    var scale = pose ? Math.round(pose.scale * 10000) / 10000 : null;
    var plan = s.plan;
    return {
      image: {
        tier: imageTier(s.artwork, s.url),
        file: String(s.url).split("/").pop().slice(0, 120),
        naturalWidth: s.natural.width,
        naturalHeight: s.natural.height,
        fallbackUsed: s.fallbackUsed,
      },
      motion: {
        mode: motionMode,
        plan: plan.plan,
        reason: plan.reason,
        zoom: Math.round(plan.zoom * 1000) / 1000,
        timeline: plan.timeline,
        slidePhase: Motion.slidePhaseAt(plan, timeMs),
        scale: scale,
        effectiveUpscale: scale == null ? null : Math.round(Motion.effectiveUpscale(scale, plan.box, s.dpr, s.natural) * 1000) / 1000,
        restUpscale: plan.restUpscale == null ? null : Math.round(plan.restUpscale * 1000) / 1000,
        insufficientResolution: plan.insufficientResolution,
        focusScreenPx: focusOnScreen(s, pose),
      },
    };
  }

  /** Engine state sent with STATUS so a TV can be debugged from a phone or Mac. */
  function diagnostics() {
    var anim = slideAnimations && slideAnimations.clock;
    var slide = slideDiagnostics();
    return {
      mode: mode,
      // Wall mode (2.9.0): the tour's stop, camera, detail layer and memory (scripts/tv_capture.py --wall).
      wall: mode === "wall" && wallView ? wallView.diagnostics() : null,
      phase: slidePhase,
      artworkId: currentSlide ? currentSlide.artwork.id : null,
      image: slide.image,
      motion: slide.motion,
      transitionMs: Motion.TRANSITION_MS,
      debugMode: debugMode,
      renderFlags: renderFlags,
      frameMs: frameTimeStats(),
      phaseMs: Date.now() - phaseStartedAt,
      preparing: isPreparing,
      currentArtworkId: artworks[currentIndex] ? artworks[currentIndex].id : null,
      totalArtworks: artworks.length,
      consecutiveLoadFailures: consecutiveLoadFailures,
      visibility: document.visibilityState,
      animationState: anim ? anim.playState : null,
      animationTimeMs: anim && anim.currentTime != null ? Math.round(anim.currentTime) : null,
      timelineMs: document.timeline ? Math.round(document.timeline.currentTime || 0) : null,
      lastError: lastError,
      wakeLock: wakeLockStatus,
      lastKey: typeof lastKey === "undefined" ? null : lastKey,
      viewport: window.innerWidth + "x" + window.innerHeight + "@" + window.devicePixelRatio,
      screen: window.screen.width + "x" + window.screen.height,
      userAgent: navigator.userAgent.slice(0, 160),
    };
  }

  function slideDurationMs() {
    return secondsPerArtwork * 1000;
  }

  function wrapIndex(index) {
    var n = artworks.length;
    return ((index % n) + n) % n;
  }

  // ─── Status back to the phone(s) ───

  /** Phones connected to this TV page right now (null outside a Cast session, e.g. dev.html). */
  function connectedSenderCount() {
    if (!castContext || typeof castContext.getSenders !== "function") return null;
    try {
      return castContext.getSenders().length;
    } catch (e) {
      return null;
    }
  }

  /**
   * Where the TV is: { index, count, current: { id, title } | null, sourceName }. In wall mode index / count
   * count painting stops (the tour's reading order), so the phone's "3 of 40" and NEXT / PREVIOUS mean the same.
   */
  function position() {
    if (mode === "wall") {
      var at = wallView && wallState && wallState.started ? wallView.position() : null;
      return {
        index: at ? at.index : 0,
        count: at ? at.count : wallState ? wallState.pieces.length : 0,
        current: at ? { id: at.pieceId, title: at.title } : null,
        sourceName: wallState ? wallState.command.sourceName : "",
      };
    }
    var artwork = artworks[currentIndex] || null;
    return {
      index: currentIndex,
      count: artworks.length,
      current: artwork ? { id: artwork.id, title: artwork.title } : null,
      sourceName: sourceName,
    };
  }

  function sendStatus() {
    if (!castContext) return;
    var at = position();
    var status = {
      type: "STATUS",
      protocol: Protocol.PROTOCOL_VERSION,
      receiverVersion: RECEIVER_VERSION,
      // 2.9.0: which mode plays, the wall's id (like manifestId), and index / count (painting stops in wall mode).
      mode: mode,
      wallId: mode === "wall" && wallState ? wallState.wallId : null,
      index: at.index,
      count: at.count,
      currentIndex: at.index,
      isPaused: isPaused,
      totalArtworks: at.count,
      currentArtwork: at.current,
      secondsPerArtwork: secondsPerArtwork,
      sourceName: at.sourceName,
      // Echo of the phone's LOAD_MANIFEST id (null for a list sent without one, e.g. an older phone).
      manifestId: mode === "slideshow" ? playlist.manifestId : null,
      backdrop: { texture: backdropTexture, mood: backdropMood },
      motion: motionMode,
      // 2.8.0: how many phones are connected, so a phone offers "Disconnect" (TV keeps playing for the
      // others) instead of "Stop casting" when it is not alone (Google Cast checklist: sender stops cast).
      connectedSenders: connectedSenderCount(),
      debug: diagnostics(),
    };
    try {
      // Undefined sender id broadcasts, so a second phone or a reconnecting phone stays in sync.
      castContext.sendCustomMessage(NAMESPACE, undefined, status);
    } catch (e) {
      console.warn("[KULTURA] status send failed", e);
    }
  }

  // ─── Images ───

  function loadImage(img, url) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("image load timeout"));
      }, IMAGE_LOAD_TIMEOUT_MS);
      img.onload = function () {
        clearTimeout(timer);
        // Decode before showing, so a large (3200 px) picture does not stutter the cross-fade.
        // Capped: browsers may hold decode() while the page is hidden (Ambient mode), and a
        // pending decode must never hold the slideshow.
        if (typeof img.decode === "function") {
          var decodeCap = setTimeout(resolve, DECODE_WAIT_MAX_MS);
          var decoded = function () {
            clearTimeout(decodeCap);
            resolve();
          };
          img.decode().then(decoded, decoded);
        } else {
          resolve();
        }
      };
      img.onerror = function () {
        clearTimeout(timer);
        reject(new Error("image load error"));
      };
      img.src = url;
    });
  }

  /**
   * Load the artwork's image; if it fails and a fallback (normal-size) image exists, try that.
   * Resolves with { url, fallbackUsed } for the image actually loaded.
   */
  function loadArtworkImage(img, artwork, token) {
    return loadImage(img, artwork.imageUrl).then(
      function () {
        return { url: artwork.imageUrl, fallbackUsed: false };
      },
      function (err) {
        if (!artwork.fallbackImageUrl || token !== slideToken) throw err;
        console.warn("[KULTURA] artwork " + artwork.id + ": large image failed (" + err.message + "), using the normal one");
        Telemetry.reportImageFallback(artwork.id, err.message);
        return loadImage(img, artwork.fallbackImageUrl).then(function () {
          return { url: artwork.fallbackImageUrl, fallbackUsed: true };
        });
      }
    );
  }

  function preloadAhead() {
    for (var i = 1; i <= PRELOAD_AHEAD && i < artworks.length; i++) {
      var preload = new Image();
      preload.src = artworks[wrapIndex(currentIndex + i)].imageUrl;
    }
  }

  /**
   * The TV viewport in CSS px (the screen if the page reports none, e.g. a hidden tab). Never larger
   * than the screen: receiver 2.5.0 on the TV reported innerWidth 2169 (screen 960) after a zoomed
   * panorama overflowed the page, and sized the next painting for that (tv_capture before-2.5.0).
   */
  function currentView() {
    var screenW = window.screen.width;
    var screenH = window.screen.height;
    var w = window.innerWidth || screenW;
    var h = window.innerHeight || screenH;
    return { width: screenW > 0 ? Math.min(w, screenW) : w, height: screenH > 0 ? Math.min(h, screenH) : h };
  }

  // ─── Slides ───

  /** Full-screen KULTURA screen; `loading` adds the animated ring (something is on its way). */
  function showIdle(message, source, loading) {
    idleSubtitle.textContent = message;
    idleSource.textContent = source || "";
    idleScreen.classList.toggle("loading", !!loading);
    idleScreen.classList.remove("hidden");
    hideLoadingIndicator();
  }

  /** Calm screen from a new list until its first picture is decoded (also covers a takeover). */
  function showPreparing() {
    isPreparing = true;
    showIdle("Preparing your gallery", sourceName, true);
  }

  /** Put a tag in the lower corner opposite the wall label on screen (labels alternate corners). */
  function placeIndicator(el) {
    var labelRight = mode === "wall" && wallView
      ? wallView.captionOnRight()
      : layers[activeLayerId].querySelector(".metadata-overlay").classList.contains("label-right");
    el.classList.toggle("on-left", labelRight);
  }

  /** Small "Loading <title>" tag, only once a painting is slow to appear (see the delay above). */
  function scheduleLoadingIndicator(artwork) {
    hideLoadingIndicator();
    if (isPreparing) return; // the full-screen ring already says it
    loadingIndicatorTimer = setTimeout(function () {
      loadingIndicatorTimer = null;
      loadingTitle.textContent = artwork.title.replace(/([^.])\.$/, "$1");
      placeIndicator(loadingIndicator);
      loadingIndicator.classList.remove("hidden");
      document.body.classList.add("content-loading");
    }, CONTENT_LOADING_INDICATOR_DELAY_MS);
  }

  function hideLoadingIndicator() {
    clearTimeout(loadingIndicatorTimer);
    loadingIndicatorTimer = null;
    loadingIndicator.classList.add("hidden");
    document.body.classList.remove("content-loading");
  }

  /** "Paused · 3 of 40 · KULTURA" while paused with a painting on screen; the text fades, the icon stays. */
  function renderPausedIndicator() {
    var onScreen = mode === "wall" ? !!(wallState && wallState.started) : currentSlide != null && artworks.length > 0;
    var show = isPaused && onScreen;
    if (!show) {
      clearTimeout(pausedTextTimer);
      pausedTextTimer = null;
      pausedIndicator.classList.add("hidden");
      return;
    }
    var at = position();
    pausedPosition.textContent = at.index + 1 + " of " + at.count;
    placeIndicator(pausedIndicator);
    if (!pausedIndicator.classList.contains("hidden")) return; // already showing: keep its fade state
    pausedIndicator.classList.remove("quiet");
    pausedIndicator.classList.remove("hidden");
    clearTimeout(pausedTextTimer);
    pausedTextTimer = setTimeout(function () {
      pausedIndicator.classList.add("quiet");
    }, PAUSED_TEXT_FADE_MS);
  }

  function showArtwork(index) {
    if (artworks.length === 0) return;
    currentIndex = wrapIndex(index);
    var token = ++slideToken;
    var artwork = artworks[currentIndex];

    // A skip during a dip: the painting that was about to appear is skipped, so cancel its reveal now
    // (fading it out from wherever it is) and keep its wall. Otherwise a slow load of the replacement
    // would let the skipped painting appear meanwhile.
    cancelPendingReveal();

    // Load into a detached image: nothing on screen changes until the picture is ready, so a skip
    // during a transition never swaps a painting that is still visible (startSlide picks the layer).
    var img = new Image();
    img.alt = "";
    setPhase("loading");
    scheduleLoadingIndicator(artwork);
    sendStatus();

    loadArtworkImage(img, artwork, token).then(
      function (loaded) {
        if (token !== slideToken) return; // the user skipped while this was loading
        consecutiveLoadFailures = 0;
        startSlide(artwork, img, token, loaded);
      },
      function (err) {
        if (token !== slideToken) return;
        artworkFailed(artwork, err.message);
      }
    );
  }

  /**
   * An artwork could not be shown (load error, timeout, or the watchdog gave up on it): count it,
   * report it, and move on, or show the failure screen once every artwork in the list has failed.
   * Bumps the slide token so a load still pending for this artwork is ignored when it ends.
   */
  function artworkFailed(artwork, reason) {
    slideToken++;
    console.warn("[KULTURA] skipping artwork " + artwork.id + ": " + reason);
    consecutiveLoadFailures++;
    lastError = "image " + artwork.id + ": " + reason;
    Telemetry.reportImageFailure(artwork.id, reason);
    if (consecutiveLoadFailures >= artworks.length) {
      setPhase("failed");
      isPreparing = false;
      nothingToShowSince = Date.now();
      showIdle("Couldn't load the artworks. Check the TV's internet connection.");
      Telemetry.reportMessage("Cast receiver: no artwork could be loaded", "error", { category: "image", totalArtworks: artworks.length }, "all-images:" + playlist.generation);
      sendStatus();
      return;
    }
    showArtwork(currentIndex + 1);
  }

  /** Current opacity of an element, including running animations. */
  function currentOpacity(el) {
    var value = Number(getComputedStyle(el).opacity);
    return isFinite(value) ? value : 1;
  }

  function cancelAnimations(el) {
    var running = el.getAnimations ? el.getAnimations() : [];
    for (var i = 0; i < running.length; i++) running[i].cancel();
  }

  /**
   * The layer the next painting goes into. Normally the one underneath (hidden by the fully opaque top
   * layer). If a skip arrives while the top layer's wall is still fading in, its painting has not
   * appeared yet, so the top layer is reused instead of the visible one underneath.
   */
  function chooseIncomingLayerId() {
    var otherId = activeLayerId === "a" ? "b" : "a";
    var top = layers[activeLayerId];
    return top.classList.contains("active") && currentOpacity(top) >= 0.999 ? otherId : activeLayerId;
  }

  /**
   * If the painting on the top layer is still being revealed (its fade-in pending or running), stop
   * the reveal and fade it out from its current opacity. A fully shown painting is left alone: it stays
   * until the next one has loaded.
   */
  function cancelPendingReveal() {
    var top = layers[activeLayerId];
    if (!top.classList.contains("active")) return;
    var art = top.querySelector(".layer-art");
    var now = currentOpacity(art);
    if (now >= 0.999) return;
    cancelAnimations(art);
    art.style.opacity = String(now);
    if (now > 0) {
      art.animate([{ opacity: now }, { opacity: 0 }], { duration: Math.round(Motion.TRANSITION_MS.out * now), fill: "forwards", easing: "ease-in" });
    }
  }

  function startSlide(artwork, loadedImg, token, loaded) {
    resetAnimationWatchdog();
    var incomingId = chooseIncomingLayerId();
    var incoming = layers[incomingId];
    var outgoing = layers[incomingId === "a" ? "b" : "a"];
    var art = incoming.querySelector(".layer-art");
    var caption = incoming.querySelector(".metadata-overlay");
    // The incoming layer is not visible: stop whatever it was doing and put the new picture in.
    var oldImg = incoming.querySelector(".artwork-image");
    var layerOpacityNow = incoming.classList.contains("active") ? currentOpacity(incoming) : 0;
    [incoming, art, oldImg, caption].forEach(cancelAnimations);
    loadedImg.className = "artwork-image";
    oldImg.parentNode.replaceChild(loadedImg, oldImg);
    var img = loadedImg;
    var view = currentView();
    var dpr = window.devicePixelRatio || 1;
    // The ACTUALLY loaded image's size (the fallback's when it was used) bounds the zoom.
    var natural = { width: img.naturalWidth, height: img.naturalHeight };
    var plan = Motion.planSlide({
      motion: motionMode,
      durationMs: slideDurationMs(),
      focus: artwork.focus,
      poi: artwork.poi,
      natural: natural,
      view: view,
      dpr: dpr,
    });
    // Whole painting, contained: no cover crop.
    img.style.width = Math.round(plan.box.width) + "px";
    img.style.height = Math.round(plan.box.height) + "px";
    currentSlide = { artwork: artwork, img: img, url: loaded.url, fallbackUsed: loaded.fallbackUsed, natural: natural, dpr: dpr, plan: plan };
    setPhase("playing");
    isPreparing = false;
    nothingToShowSince = null;
    hideLoadingIndicator();

    // Some catalogue titles end with a stray full stop ("... Water Pitcher."); labels don't.
    // Alternate corners and nudge the position a little every slide (OLED burn-in).
    caption.classList.toggle("label-right", currentIndex % 2 === 1);
    caption.style.marginBottom = ((currentIndex * 7) % 5) * 0.3 + "vh";
    caption.querySelector(".metadata-title").textContent = artwork.title.replace(/([^.])\.$/, "$1");
    var byline = artwork.artist || sourceName;
    caption.querySelector(".metadata-artist").textContent = artwork.date ? byline + ", " + artwork.date : byline;

    var timing = { duration: slideDurationMs(), fill: "forwards" };
    // The slide clock has no visible effect: its time drives the move (syncMove), the label, SEEK, the
    // watchdog, and the change to the next painting when it finishes.
    var clockAnimation = img.animate([{ visibility: "visible" }, { visibility: "visible" }], timing);
    var captionAnimation = caption.animate(Motion.captionKeyframes(slideDurationMs()), timing);
    if (isPaused) {
      clockAnimation.pause();
      captionAnimation.pause();
    }
    clockAnimation.onfinish = function () {
      if (token === slideToken) showArtwork(currentIndex + 1);
    };
    if (slideAnimations) clearTimeout(slideAnimations.moveTimer);
    slideAnimations = { clock: clockAnimation, caption: captionAnimation, img: img, plan: plan, move: null, moveTimer: null };
    syncMove();

    applyBackdrop(incoming, artwork);
    runTransition(outgoing, incoming, layerOpacityNow);
    activeLayerId = incomingId;
    idleScreen.classList.add("hidden");
    renderPausedIndicator();
    requestWakeLock();

    preloadAhead();
  }

  /**
   * Keeps the painting in step with the slide clock (2.6.1): a static transform before and after the
   * move, and a move animation only while the move runs (why: motion.js, restingTransformAt). Called at
   * slide start, when the move is due (timer), on pause/resume and after a SEEK.
   */
  function syncMove() {
    var a = slideAnimations;
    if (!a) return;
    clearTimeout(a.moveTimer);
    a.moveTimer = null;
    var t = a.plan.timeline;
    var timeMs = a.clock.currentTime || 0;
    if (!t || timeMs < t.wholeEndMs || timeMs >= t.focusStartMs) {
      a.img.style.transform = Motion.restingTransformAt(a.plan, timeMs);
      if (a.move) {
        a.move.cancel();
        a.move = null;
      }
      if (t && timeMs < t.wholeEndMs && !isPaused) a.moveTimer = setTimeout(syncMove, t.wholeEndMs - timeMs);
      return;
    }
    if (!a.move) {
      var move = a.img.animate(Motion.moveKeyframes(a.plan), { duration: t.focusStartMs - t.wholeEndMs, fill: "forwards" });
      move.onfinish = function () {
        if (slideAnimations !== a || a.move !== move) return; // an old slide: it keeps its end pose (fill)
        // Pin the end pose as a static transform BEFORE dropping the animation: no frame shows neither.
        a.img.style.transform = Motion.restingTransformAt(a.plan, t.focusStartMs);
        move.cancel();
        a.move = null;
      };
      a.move = move;
    }
    a.move.currentTime = timeMs - t.wholeEndMs;
    if (isPaused) a.move.pause();
    else {
      a.move.play();
      // Backup for a lost finish event (Fable review 2.6.1): the resting branch pins the end pose too.
      a.moveTimer = setTimeout(syncMove, t.focusStartMs - timeMs);
    }
  }

  /**
   * Dip through the wall (Fable review 2026-10-03; motion.js TRANSITION_MS): the painting on screen
   * fades out (from wherever it is, so an interrupted dip never jumps), the new wall fades in over the
   * old wall (so a texture never pops), then the new painting fades in. Two paintings are never on
   * screen together. `incomingFrom` = the incoming layer's current opacity (0 unless a skip reuses a
   * layer whose wall was still fading in).
   */
  function runTransition(outgoing, incoming, incomingFrom) {
    var token = ++transitionToken;
    var t = Motion.TRANSITION_MS;
    var outgoingArt = outgoing.querySelector(".layer-art");
    // Freeze the outgoing scene where it is now, then fade its painting out from there.
    var wallNow = currentOpacity(outgoing);
    var artNow = wallNow > 0 ? currentOpacity(outgoingArt) : 0;
    cancelAnimations(outgoing);
    cancelAnimations(outgoingArt);
    outgoing.classList.remove("active");
    outgoing.style.zIndex = "1";
    outgoing.style.opacity = String(wallNow);
    outgoingArt.style.opacity = String(artNow);
    var outMs = Math.round(t.out * artNow);
    if (outMs > 0) {
      outgoingArt.animate([{ opacity: artNow }, { opacity: 0 }], { duration: outMs, fill: "forwards", easing: "ease-in" });
    }
    incoming.style.zIndex = "2";
    incoming.style.opacity = "";
    incoming.querySelector(".layer-art").style.opacity = "";
    incoming.classList.add("active");
    var from = incomingFrom || 0;
    incoming.animate([{ opacity: from }, { opacity: 1 }], {
      duration: Math.max(1, Math.round(t.wall * (1 - from))),
      delay: outMs,
      fill: "both",
      easing: "ease-in-out",
    });
    var wallMs = Math.round(t.wall * (1 - from));
    incoming.querySelector(".layer-art").animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: t.in,
      delay: outMs + wallMs,
      fill: "both",
      easing: "ease-out",
    });
    // Once the new wall covers it, the old scene stops working (spares the TV's graphics chip).
    setTimeout(function () {
      if (token !== transitionToken || outgoing.classList.contains("active")) return;
      [outgoingArt, outgoing.querySelector(".artwork-image"), outgoing.querySelector(".metadata-overlay")].forEach(cancelAnimations);
      outgoing.style.opacity = "0";
      outgoingArt.style.opacity = "0";
    }, outMs + wallMs + 50);
  }

  /** Tinted backdrop (plain by default, texture if chosen) of one layer, from its painting (backdrop.js). */
  function applyBackdrop(layer, artwork) {
    var b = Backdrop.backdropFor(artwork.mainColor, backdropTexture);
    var el = layer.querySelector(".layer-backdrop");
    el.style.backgroundColor = b.tint;
    el.style.backgroundImage = b.texture ? "url(textures/" + b.texture + ".webp)" : "none";
  }

  // ─── Commands ───

  function setPaused(paused) {
    resetAnimationWatchdog();
    if (paused && !isPaused) pausedSince = Date.now();
    if (!paused) pausedSince = null;
    isPaused = paused;
    renderPausedIndicator();
    if (mode === "wall") {
      if (wallView) wallView.setPaused(paused);
    } else if (slideAnimations) {
      if (paused) {
        slideAnimations.clock.pause();
        slideAnimations.caption.pause();
      } else {
        slideAnimations.clock.play();
        slideAnimations.caption.play();
      }
      syncMove();
    }
    sendStatus();
  }

  /** Change the slide length, keeping the running slide at the same point of its choreography. */
  /**
   * Change the slide length. Applies from the NEXT artwork: the one on screen keeps its own plan, since
   * stretching or squeezing a planned move would break its calm-speed and hold rules (a 5 min slide
   * cut to 20 s would zoom 1.5x in under 2 s).
   */
  function setSecondsPerArtwork(seconds) {
    secondsPerArtwork = seconds;
    sendStatus();
  }

  var lastActivity = Date.now();

  /**
   * Someone is browsing the paused gallery by hand (NEXT / PREVIOUS from a phone or the TV remote):
   * the 20-minute paused stop (idle.js) counts from now. Status requests and the automatic slide
   * changes never come through here, so they never keep a forgotten paused TV awake.
   */
  function restartPausedClock() {
    if (isPaused) pausedSince = Date.now();
  }

  /**
   * One message from a phone (or the TV remote). `senderId` is the Cast sender that sent it; it only
   * matters for APPEND_ARTWORKS (see playlist.js). A LOAD_MANIFEST from any sender always replaces
   * what is playing.
   */
  function handleMessage(data, senderId) {
    var command = Protocol.parseMessage(data);
    if (!command) return;
    lastActivity = Date.now();

    switch (command.type) {
      case "LOAD_WALL":
        startWall(command, senderId);
        break;
      case "APPEND_WALL_PIECES":
        appendWallPieces(command, senderId);
        break;
      case "LOAD_MANIFEST":
      case "APPEND_ARTWORKS": {
        if (mode === "wall") {
          // A list's leftover batch never ends a wall; a new list does.
          if (command.type === "APPEND_ARTWORKS") return;
          leaveWall();
        }
        var result = Playlist.applyManifestCommand(playlist, command, senderId);
        if (!result) {
          console.log("[KULTURA] ignoring " + command.type + " from a sender whose list was replaced");
          return;
        }
        playlist = result.playlist;
        artworks = playlist.artworks;
        sourceName = playlist.sourceName;
        if (result.restart) {
          if (command.secondsPerArtwork) secondsPerArtwork = command.secondsPerArtwork;
          isPaused = false;
          pausedSince = null;
          nothingToShowSince = null;
          renderPausedIndicator();
          consecutiveLoadFailures = 0;
          showPreparing();
          showArtwork(0);
        } else {
          sendStatus();
        }
        break;
      }
      case "SET_SETTINGS":
        if (command.backdrop) {
          if (command.backdrop.texture) backdropTexture = command.backdrop.texture;
          if (command.backdrop.mood) backdropMood = command.backdrop.mood;
          if (currentSlide) applyBackdrop(layers[activeLayerId], currentSlide.artwork);
        }
        // Applies from the next artwork: the one on screen finishes its own choreography.
        if (command.motion) motionMode = command.motion;
        if (wallView) wallView.setSettings({ seconds: command.secondsPerArtwork, motion: command.motion });
        if (command.secondsPerArtwork) setSecondsPerArtwork(command.secondsPerArtwork);
        else sendStatus();
        break;
      case "NEXT":
      case "PREVIOUS":
        restartPausedClock();
        if (mode === "wall") {
          if (command.type === "NEXT") wallView.next();
          else wallView.previous();
          sendStatus();
        } else {
          showArtwork(currentIndex + (command.type === "NEXT" ? 1 : -1));
        }
        break;
      case "PAUSE":
        setPaused(true);
        break;
      case "RESUME":
        setPaused(false);
        break;
      case "GET_STATUS":
        sendStatus();
        break;
      case "DEBUG_MODE":
        debugMode = command.enabled;
        sendStatus();
        break;
      case "RENDER_FLAGS":
        // Test-only (scripts/cast_dev_sender.py render-flags, tv_motion_probe.py --render-flags).
        if (!debugMode) return;
        renderFlags = command.flags;
        ensureWallView().setRenderFlags(renderFlags);
        sendStatus();
        break;
      case "SEEK":
        // Test-only (tv_capture.py): jump the slide (wall mode: the stop) on screen to an exact time.
        if (!debugMode) return;
        if (mode === "wall") {
          if (!wallState || !wallState.started) return;
          wallView.seek(command.timeMs);
          if (command.pause !== isPaused) setPaused(command.pause);
          else sendStatus();
          return;
        }
        if (!slideAnimations) return;
        resetAnimationWatchdog();
        slideAnimations.clock.currentTime = command.timeMs;
        slideAnimations.caption.currentTime = command.timeMs;
        if (command.pause !== isPaused) setPaused(command.pause);
        else {
          syncMove();
          sendStatus();
        }
        break;
    }
  }

  // ─── Wall mode ───

  /**
   * Stop the slideshow without a trace: no pending load, animation or timer of it may touch the screen while the
   * wall plays (its layers are hidden; a later LOAD_MANIFEST starts it again from a clean list). Its two large
   * images are released (memory for the wall); the next slide swaps a freshly loaded image in (startSlide).
   */
  function leaveSlideshow() {
    slideToken++;
    transitionToken++;
    if (slideAnimations) clearTimeout(slideAnimations.moveTimer);
    slideAnimations = null;
    currentSlide = null;
    [layers.a, layers.b].forEach(function (layer) {
      var img = layer.querySelector(".artwork-image");
      [layer, layer.querySelector(".layer-art"), img, layer.querySelector(".metadata-overlay")].forEach(cancelAnimations);
      if (img) img.removeAttribute("src");
      layer.classList.remove("active");
      layer.style.opacity = "0";
    });
    hideLoadingIndicator();
    playlist = { artworks: [], sourceName: "", manifestId: null, ownerSenderId: null, generation: playlist.generation + 1 };
    artworks = playlist.artworks;
    sourceName = playlist.sourceName;
    currentIndex = 0;
    setPhase("idle");
  }

  function leaveWall() {
    clearTimeout(wallAssemblyTimer);
    wallAssemblyTimer = null;
    if (wallView) wallView.destroy();
    wallState = null;
    mode = "slideshow";
  }

  function ensureWallView() {
    if (wallView) return wallView;
    wallView = WallView.create({
      parent: document.body,
      before: idleScreen,
      loadImage: loadImage,
      onStop: function () {
        renderPausedIndicator();
        sendStatus();
      },
      onStarted: function () {
        wallState.started = true;
        isPreparing = false;
        nothingToShowSince = null;
        setPhase("playing");
        idleScreen.classList.add("hidden");
        requestWakeLock();
        renderPausedIndicator();
        sendStatus();
      },
    });
    wallView.setRenderFlags(renderFlags);
    return wallView;
  }

  /** LOAD_WALL: leave whatever plays, show "Preparing your wall", and wait for the pieces still to come. */
  function startWall(command, senderId) {
    if (mode === "wall") leaveWall();
    else leaveSlideshow();
    mode = "wall";
    ensureWallView();
    wallState = {
      wallId: command.wallId,
      command: command,
      pieces: [],
      ids: {},
      ownerSenderId: senderId == null ? null : String(senderId),
      started: false,
      built: false,
    };
    addWallPieces(command.pieces);
    isPaused = false;
    pausedSince = null;
    nothingToShowSince = null;
    renderPausedIndicator();
    isPreparing = true;
    showIdle("Preparing your wall", command.sourceName, true);
    if (wallState.pieces.length >= command.pieceCount) buildWall();
    else wallAssemblyTimer = setTimeout(buildWall, WALL_ASSEMBLY_WAIT_MS);
    sendStatus();
  }

  /** Pieces of the wall being received: duplicates and anything past MAX_WALL_PIECES are dropped. */
  function addWallPieces(pieces) {
    for (var i = 0; i < pieces.length && wallState.pieces.length < Protocol.MAX_WALL_PIECES; i++) {
      if (wallState.ids[pieces[i].id]) continue;
      wallState.ids[pieces[i].id] = true;
      wallState.pieces.push(pieces[i]);
    }
  }

  /**
   * APPEND_WALL_PIECES: only for the wall being received, from the phone that sent it (as APPEND_ARTWORKS), and
   * only before the tour is built; later batches are ignored (the tour does not re-plan under the viewer).
   */
  function appendWallPieces(command, senderId) {
    var sender = senderId == null ? null : String(senderId);
    if (mode !== "wall" || !wallState || wallState.wallId !== command.wallId || wallState.built) return;
    if (wallState.ownerSenderId != null && sender != null && wallState.ownerSenderId !== sender) return;
    addWallPieces(command.pieces);
    if (wallState.pieces.length >= wallState.command.pieceCount) buildWall();
    else sendStatus();
  }

  function buildWall() {
    clearTimeout(wallAssemblyTimer);
    wallAssemblyTimer = null;
    if (mode !== "wall" || !wallState || wallState.built) return;
    wallState.built = true;
    var wall = {};
    for (var key in wallState.command) wall[key] = wallState.command[key];
    wall.pieces = wallState.pieces;
    wallView.load(wall, currentView(), window.devicePixelRatio || 1, { seconds: secondsPerArtwork, motion: motionMode });
    // A PAUSE that came while the pieces were arriving holds the tour at its first frame.
    wallView.setPaused(isPaused);
    sendStatus();
  }

  // ─── TV remote ───
  // Left/right skip, OK/play-pause toggles pause. Whether Google TV hands these keys to a cast
  // page varies by device, so the last key seen is reported in diagnostics.
  var lastKey = null;
  var REMOTE_KEYS = {
    ArrowRight: "NEXT",
    MediaTrackNext: "NEXT",
    MediaFastForward: "NEXT",
    ArrowLeft: "PREVIOUS",
    MediaTrackPrevious: "PREVIOUS",
    MediaRewind: "PREVIOUS",
    Enter: "TOGGLE_PAUSE",
    MediaPlayPause: "TOGGLE_PAUSE",
    MediaPlay: "RESUME",
    MediaPause: "PAUSE",
  };

  document.addEventListener("keydown", function (event) {
    lastKey = event.key + "/" + event.keyCode;
    lastActivity = Date.now();
    var action = REMOTE_KEYS[event.key];
    if (!action || !hasContent()) return;
    event.preventDefault();
    if (action === "TOGGLE_PAUSE") action = isPaused ? "RESUME" : "PAUSE";
    handleMessage({ type: action });
  });

  // ─── Auto-stop (idle.js: 5 min with nothing to show, 20 min paused, 3 h unattended) ───
  setInterval(function () {
    if (autoStoppedReason) return;
    var reason = Idle.autoStopReason({
      now: Date.now(),
      nothingToShowSince: nothingToShowSince,
      pausedSince: isPaused ? pausedSince : null,
      lastActivity: lastActivity,
    });
    if (!reason) return;
    autoStoppedReason = reason;
    console.log("[KULTURA] stopping by itself (" + reason + ") so the TV can sleep");
    if (wakeLock) wakeLock.release();
    // Ends the receiver for every phone; each phone's Cast session ends and its controls go away.
    if (castContext) castContext.stop();
  }, Idle.CHECK_INTERVAL_MS);

  // ─── Watchdog ───
  // The slideshow advances on animation "finish" and image load events. If either never comes (a
  // decoder hang, a TV that drops an event), report it with the diagnostics and move on.
  var previousAnimation = null;
  var previousAnimationTimeMs = null;
  function resetAnimationWatchdog() {
    previousAnimation = null;
    previousAnimationTimeMs = null;
  }
  document.addEventListener("visibilitychange", resetAnimationWatchdog);
  setInterval(function () {
    if (artworks.length === 0) return;
    var anim = slideAnimations && slideAnimations.clock;
    var animationTimeMs = anim && anim.currentTime != null ? Math.round(anim.currentTime) : null;
    var stall = Playlist.detectEngineStall({
      phase: slidePhase,
      phaseStartedAt: phaseStartedAt,
      now: Date.now(),
      isPaused: isPaused,
      visibility: document.visibilityState,
      animation: anim,
      previousAnimation: previousAnimation,
      animationState: anim ? anim.playState : null,
      animationPending: anim ? anim.pending : false,
      animationTimeMs: animationTimeMs,
      previousAnimationTimeMs: previousAnimationTimeMs,
      loadDeadlineMs: LOAD_DEADLINE_MS,
    });
    // Paused/pending animations have a hold time, not a running clock. Loading may still point
    // at the outgoing slide. Neither is a baseline for the next uninterrupted playback interval.
    if (slidePhase === "playing" && !isPaused && document.visibilityState === "visible" &&
        anim && !anim.pending && (anim.playState === "running" || anim.playState === "finished")) {
      previousAnimation = anim;
      previousAnimationTimeMs = animationTimeMs;
    } else {
      resetAnimationWatchdog();
    }
    if (!stall) return;
    var stalledArtwork = artworks[currentIndex] || null;
    console.warn("[KULTURA] engine stalled (" + stall + "): skipping ahead");
    Telemetry.reportStall(stall, { artworkId: stalledArtwork ? stalledArtwork.id : null });
    resetAnimationWatchdog();
    if (stall === "loading-timeout" && stalledArtwork) {
      // Counts as a failed artwork, so a list where nothing loads reaches the failure screen.
      artworkFailed(stalledArtwork, "watchdog: " + stall);
    } else {
      lastError = "stall: " + stall;
      showArtwork(currentIndex + 1);
    }
  }, WATCHDOG_INTERVAL_MS);

  // ─── Cast SDK ───

  function initCast() {
    if (typeof cast === "undefined" || !cast.framework) {
      console.log("[KULTURA] Cast SDK not available: running in dev mode");
      return;
    }
    castContext = cast.framework.CastReceiverContext.getInstance();
    castContext.addCustomMessageListener(NAMESPACE, function (event) {
      handleMessage(event.data, event.senderId);
    });
    castContext.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function () {
      sendStatus();
    });
    // The phones still connected learn the new count (connectedSenders). Sent again a moment later in
    // case the framework still lists the leaving phone while this event runs.
    if (cast.framework.system.EventType.SENDER_DISCONNECTED) {
      castContext.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, function () {
        sendStatus();
        setTimeout(sendStatus, 1000);
      });
    }

    var options = new cast.framework.CastReceiverOptions();
    // The framework's idle timeout watches its media player, which this page never uses: it stays off
    // and the page stops itself instead (idle.js explains the rules and why). maxInactivity (the phone
    // connection heartbeat, 10 s) keeps its default.
    options.disableIdleTimeout = true;
    castContext.start(options);
    console.log("[KULTURA] Cast receiver " + RECEIVER_VERSION + " started");
  }

  showIdle("Preparing your gallery", "", true);
  // A phone that connects without sending a list (e.g. from the Cast button alone): say what to do.
  setTimeout(function () {
    if (artworks.length > 0 || isPreparing || slidePhase !== "idle" || mode === "wall") return;
    showIdle("Choose artworks in the KULTURA app to show them here", "", false);
  }, WAITING_FOR_LIST_MS);

  // ─── Dev mode hooks (dev.html drives the engine without a TV) ───
  window.kulturaReceiver = {
    handleMessage: handleMessage,
    getState: function () {
      return {
        receiverVersion: RECEIVER_VERSION,
        totalArtworks: artworks.length,
        currentIndex: currentIndex,
        isPaused: isPaused,
        secondsPerArtwork: secondsPerArtwork,
        sourceName: sourceName,
        phase: slidePhase,
        preparing: isPreparing,
        idleText: idleScreen.classList.contains("hidden") ? null : idleSubtitle.textContent + " | " + idleSource.textContent,
        idleSpinner: !idleScreen.classList.contains("hidden") && idleScreen.classList.contains("loading"),
        mode: mode,
        wall: mode === "wall" && wallView ? wallView.diagnostics() : null,
        loadingIndicator: loadingIndicator.classList.contains("hidden") ? null : loadingTitle.textContent,
        pausedIndicator: pausedIndicator.classList.contains("hidden") ? null : pausedIndicator.textContent.replace(/\s+/g, " ").trim(),
        pausedTextFaded: pausedIndicator.classList.contains("quiet"),
        autoStoppedReason: autoStoppedReason,
        progress: slideAnimations ? slideAnimations.clock.currentTime / slideDurationMs() : null,
      };
    },
  };

  initCast();
  // After the Cast receiver has started: error reporting must never delay casting (telemetry.js).
  Telemetry.init({ version: RECEIVER_VERSION, getDiagnostics: diagnostics });
})();
