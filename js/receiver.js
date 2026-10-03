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
 */
(function () {
  "use strict";

  var RECEIVER_VERSION = "2.6.0";
  var NAMESPACE = "urn:x-cast:art.kultura.cast";
  var PRELOAD_AHEAD = 2;
  /**
   * Stop by itself after this long without any phone message or remote key, so the TV returns to
   * its own sleep/screensaver rules (the wake lock would otherwise keep an OLED lit all night).
   */
  var UNATTENDED_STOP_MS = 3 * 60 * 60 * 1000;
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

  // ─── DOM refs ───
  var layers = { a: document.getElementById("layer-a"), b: document.getElementById("layer-b") };
  var idleScreen = document.getElementById("idle-screen");
  var idleSubtitle = idleScreen.querySelector(".idle-subtitle");
  var idleSource = idleScreen.querySelector(".idle-source");

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

  function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock || artworks.length === 0 || document.visibilityState !== "visible") return;
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

  /** Where the centre of the AI-crop subject is on screen right now, in device px (null: no subject). */
  function focusOnScreen(slide, pose) {
    var f = slide.artwork.focus;
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
    var anim = slideAnimations && slideAnimations.image;
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
    var anim = slideAnimations && slideAnimations.image;
    var slide = slideDiagnostics();
    return {
      phase: slidePhase,
      artworkId: currentSlide ? currentSlide.artwork.id : null,
      image: slide.image,
      motion: slide.motion,
      transitionMs: Motion.TRANSITION_MS,
      debugMode: debugMode,
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

  function sendStatus() {
    if (!castContext) return;
    var artwork = artworks[currentIndex] || null;
    var status = {
      type: "STATUS",
      protocol: Protocol.PROTOCOL_VERSION,
      receiverVersion: RECEIVER_VERSION,
      currentIndex: currentIndex,
      isPaused: isPaused,
      totalArtworks: artworks.length,
      currentArtwork: artwork ? { id: artwork.id, title: artwork.title } : null,
      secondsPerArtwork: secondsPerArtwork,
      sourceName: sourceName,
      // Echo of the phone's LOAD_MANIFEST id (null for a list sent without one, e.g. an older phone).
      manifestId: playlist.manifestId,
      backdrop: { texture: backdropTexture, mood: backdropMood },
      motion: motionMode,
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

  function showIdle(message, source) {
    idleSubtitle.textContent = message;
    idleSource.textContent = source || "";
    idleScreen.classList.remove("hidden");
  }

  /** Calm screen from a new list until its first picture is decoded (also covers a takeover). */
  function showPreparing() {
    isPreparing = true;
    showIdle("Preparing your gallery", sourceName);
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

    // Some catalogue titles end with a stray full stop ("... Water Pitcher."); labels don't.
    // Alternate corners and nudge the position a little every slide (OLED burn-in).
    caption.classList.toggle("label-right", currentIndex % 2 === 1);
    caption.style.marginBottom = ((currentIndex * 7) % 5) * 0.3 + "vh";
    caption.querySelector(".metadata-title").textContent = artwork.title.replace(/([^.])\.$/, "$1");
    var byline = artwork.artist || sourceName;
    caption.querySelector(".metadata-artist").textContent = artwork.date ? byline + ", " + artwork.date : byline;

    var timing = { duration: slideDurationMs(), fill: "forwards" };
    var imageAnimation = img.animate(Motion.buildKeyframes(plan), timing);
    var captionAnimation = caption.animate(Motion.captionKeyframes(slideDurationMs()), timing);
    if (isPaused) {
      imageAnimation.pause();
      captionAnimation.pause();
    }
    imageAnimation.onfinish = function () {
      if (token === slideToken) showArtwork(currentIndex + 1);
    };
    slideAnimations = { image: imageAnimation, caption: captionAnimation };

    applyBackdrop(incoming, artwork);
    runTransition(outgoing, incoming, layerOpacityNow);
    activeLayerId = incomingId;
    idleScreen.classList.add("hidden");
    requestWakeLock();

    preloadAhead();
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
    isPaused = paused;
    if (slideAnimations) {
      if (paused) {
        slideAnimations.image.pause();
        slideAnimations.caption.pause();
      } else {
        slideAnimations.image.play();
        slideAnimations.caption.play();
      }
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
   * One message from a phone (or the TV remote). `senderId` is the Cast sender that sent it; it only
   * matters for APPEND_ARTWORKS (see playlist.js). A LOAD_MANIFEST from any sender always replaces
   * what is playing.
   */
  function handleMessage(data, senderId) {
    var command = Protocol.parseMessage(data);
    if (!command) return;
    lastActivity = Date.now();

    switch (command.type) {
      case "LOAD_MANIFEST":
      case "APPEND_ARTWORKS": {
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
        if (command.secondsPerArtwork) setSecondsPerArtwork(command.secondsPerArtwork);
        else sendStatus();
        break;
      case "NEXT":
        showArtwork(currentIndex + 1);
        break;
      case "PREVIOUS":
        showArtwork(currentIndex - 1);
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
      case "SEEK":
        // Test-only (tv_capture.py): jump the slide on screen to an exact animation time.
        if (!debugMode || !slideAnimations) return;
        slideAnimations.image.currentTime = command.timeMs;
        slideAnimations.caption.currentTime = command.timeMs;
        if (command.pause !== isPaused) setPaused(command.pause);
        else sendStatus();
        break;
    }
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
    if (!action || artworks.length === 0) return;
    event.preventDefault();
    if (action === "TOGGLE_PAUSE") action = isPaused ? "RESUME" : "PAUSE";
    handleMessage({ type: action });
  });

  setInterval(function () {
    if (artworks.length === 0 || Date.now() - lastActivity < UNATTENDED_STOP_MS) return;
    console.log("[KULTURA] no activity for a long time: stopping so the TV can sleep");
    if (wakeLock) wakeLock.release();
    if (castContext) castContext.stop();
  }, 60 * 1000);

  // ─── Watchdog ───
  // The slideshow advances on animation "finish" and image load events. If either never comes (a
  // decoder hang, a TV that drops an event), report it with the diagnostics and move on.
  var previousAnimationTimeMs = null;
  setInterval(function () {
    if (artworks.length === 0) return;
    var anim = slideAnimations && slideAnimations.image;
    var animationTimeMs = anim && anim.currentTime != null ? Math.round(anim.currentTime) : null;
    var stall = Playlist.detectEngineStall({
      phase: slidePhase,
      phaseStartedAt: phaseStartedAt,
      now: Date.now(),
      isPaused: isPaused,
      visibility: document.visibilityState,
      animationTimeMs: animationTimeMs,
      previousAnimationTimeMs: previousAnimationTimeMs,
      loadDeadlineMs: LOAD_DEADLINE_MS,
    });
    previousAnimationTimeMs = animationTimeMs;
    if (!stall) return;
    var stalledArtwork = artworks[currentIndex] || null;
    console.warn("[KULTURA] engine stalled (" + stall + "): skipping ahead");
    Telemetry.reportStall(stall, { artworkId: stalledArtwork ? stalledArtwork.id : null });
    previousAnimationTimeMs = null;
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

    var options = new cast.framework.CastReceiverOptions();
    options.disableIdleTimeout = true;
    castContext.start(options);
    console.log("[KULTURA] Cast receiver " + RECEIVER_VERSION + " started");
  }

  showIdle("Preparing your gallery", "");

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
        progress: slideAnimations ? slideAnimations.image.currentTime / slideDurationMs() : null,
      };
    },
  };

  initCast();
  // After the Cast receiver has started: error reporting must never delay casting (telemetry.js).
  Telemetry.init({ version: RECEIVER_VERSION, getDiagnostics: diagnostics });
})();
