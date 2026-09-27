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

  var RECEIVER_VERSION = "2.1.0";
  var NAMESPACE = "urn:x-cast:art.kultura.cast";
  var PRELOAD_AHEAD = 2;
  var IMAGE_LOAD_TIMEOUT_MS = 15000;

  var Motion = window.KulturaMotion;
  var Protocol = window.KulturaProtocol;

  // ─── DOM refs ───
  var bgEl = document.getElementById("background");
  var layers = { a: document.getElementById("layer-a"), b: document.getElementById("layer-b") };
  var idleScreen = document.getElementById("idle-screen");
  var idleSubtitle = idleScreen.querySelector(".idle-subtitle");

  // ─── State ───
  var artworks = [];
  var sourceName = "";
  var currentIndex = 0;
  var isPaused = false;
  var secondsPerArtwork = Protocol.DEFAULT_SECONDS;
  var activeLayerId = "a";
  /** Incremented for every slide change; stale image loads compare against it and give up. */
  var slideToken = 0;
  /** Animations of the slide currently on screen: { image, caption } or null. */
  var slideAnimations = null;
  var consecutiveLoadFailures = 0;
  var castContext = null;
  /** For diagnostics in STATUS: "idle" | "loading" | "playing" | "failed". */
  var slidePhase = "idle";
  var lastError = null;

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

  /** Engine state sent with STATUS so a TV can be debugged from a phone or Mac. */
  function diagnostics() {
    var anim = slideAnimations && slideAnimations.image;
    return {
      phase: slidePhase,
      visibility: document.visibilityState,
      animationState: anim ? anim.playState : null,
      animationTimeMs: anim && anim.currentTime != null ? Math.round(anim.currentTime) : null,
      timelineMs: document.timeline ? Math.round(document.timeline.currentTime || 0) : null,
      lastError: lastError,
      wakeLock: wakeLockStatus,
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
        resolve();
      };
      img.onerror = function () {
        clearTimeout(timer);
        reject(new Error("image load error"));
      };
      img.src = url;
    });
  }

  function preloadAhead() {
    for (var i = 1; i <= PRELOAD_AHEAD && i < artworks.length; i++) {
      var preload = new Image();
      preload.src = artworks[wrapIndex(currentIndex + i)].imageUrl;
    }
  }

  /** Size the image to fit the screen (upscaling small images) and return its on-screen box. */
  function fitImage(img) {
    // Fall back to the physical screen if the page reports no viewport (e.g. a hidden tab).
    var view = {
      width: window.innerWidth || window.screen.width,
      height: window.innerHeight || window.screen.height,
    };
    var fit = Math.min(view.width / img.naturalWidth, view.height / img.naturalHeight);
    var box = { width: Math.round(img.naturalWidth * fit), height: Math.round(img.naturalHeight * fit) };
    img.style.width = box.width + "px";
    img.style.height = box.height + "px";
    return { box: box, view: view };
  }

  // ─── Slides ───

  function cancelLayerAnimations(layer) {
    var animated = layer.querySelectorAll(".artwork-image, .metadata-overlay");
    for (var i = 0; i < animated.length; i++) {
      var running = animated[i].getAnimations ? animated[i].getAnimations() : [];
      for (var j = 0; j < running.length; j++) running[j].cancel();
    }
  }

  function showIdle(message) {
    idleSubtitle.textContent = message;
    idleScreen.classList.remove("hidden");
  }

  function showArtwork(index) {
    if (artworks.length === 0) return;
    currentIndex = wrapIndex(index);
    var token = ++slideToken;
    var artwork = artworks[currentIndex];

    var incomingId = activeLayerId === "a" ? "b" : "a";
    var incoming = layers[incomingId];
    var img = incoming.querySelector(".artwork-image");
    var caption = incoming.querySelector(".metadata-overlay");

    cancelLayerAnimations(incoming);
    slidePhase = "loading";
    sendStatus();

    loadImage(img, artwork.imageUrl).then(
      function () {
        if (token !== slideToken) return; // the user skipped while this was loading
        consecutiveLoadFailures = 0;
        startSlide(artwork, incoming, incomingId, img, caption, token);
      },
      function (err) {
        if (token !== slideToken) return;
        console.warn("[KULTURA] skipping artwork " + artwork.id + ": " + err.message);
        consecutiveLoadFailures++;
        lastError = "image " + artwork.id + ": " + err.message;
        if (consecutiveLoadFailures >= artworks.length) {
          slidePhase = "failed";
          showIdle("Couldn't load the artworks. Check the TV's internet connection.");
          return;
        }
        showArtwork(currentIndex + 1);
      }
    );
  }

  function startSlide(artwork, incoming, incomingId, img, caption, token) {
    var outgoing = layers[activeLayerId];
    var geometry = fitImage(img);
    slidePhase = "playing";

    caption.querySelector(".metadata-title").textContent = artwork.title;
    caption.querySelector(".metadata-artist").textContent = artwork.artist || sourceName;

    var timing = { duration: slideDurationMs(), fill: "forwards" };
    var imageAnimation = img.animate(
      Motion.buildKeyframes(artwork.focus, geometry.box, geometry.view, currentIndex, img.naturalWidth),
      timing
    );
    var captionAnimation = caption.animate(Motion.CAPTION_KEYFRAMES, timing);
    if (isPaused) {
      imageAnimation.pause();
      captionAnimation.pause();
    }
    imageAnimation.onfinish = function () {
      if (token === slideToken) showArtwork(currentIndex + 1);
    };
    slideAnimations = { image: imageAnimation, caption: captionAnimation };

    bgEl.style.backgroundColor = artwork.mainColor;
    incoming.classList.add("active");
    outgoing.classList.remove("active");
    activeLayerId = incomingId;
    idleScreen.classList.add("hidden");
    requestWakeLock();

    preloadAhead();
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
  function setSecondsPerArtwork(seconds) {
    secondsPerArtwork = seconds;
    if (slideAnimations) {
      var anims = [slideAnimations.image, slideAnimations.caption];
      for (var i = 0; i < anims.length; i++) {
        var anim = anims[i];
        var oldDuration = anim.effect.getTiming().duration;
        var progress = oldDuration > 0 ? (anim.currentTime || 0) / oldDuration : 0;
        anim.effect.updateTiming({ duration: slideDurationMs() });
        anim.currentTime = progress * slideDurationMs();
      }
    }
    sendStatus();
  }

  function handleMessage(data) {
    var command = Protocol.parseMessage(data);
    if (!command) return;

    switch (command.type) {
      case "LOAD_MANIFEST":
        artworks = command.artworks;
        sourceName = command.sourceName;
        if (command.secondsPerArtwork) secondsPerArtwork = command.secondsPerArtwork;
        isPaused = false;
        consecutiveLoadFailures = 0;
        showArtwork(0);
        break;
      case "APPEND_ARTWORKS":
        artworks = artworks.concat(command.artworks);
        sendStatus();
        break;
      case "SET_SETTINGS":
        setSecondsPerArtwork(command.secondsPerArtwork);
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
    }
  }

  // ─── Cast SDK ───

  function initCast() {
    if (typeof cast === "undefined" || !cast.framework) {
      console.log("[KULTURA] Cast SDK not available: running in dev mode");
      return;
    }
    castContext = cast.framework.CastReceiverContext.getInstance();
    castContext.addCustomMessageListener(NAMESPACE, function (event) {
      handleMessage(event.data);
    });
    castContext.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, function () {
      sendStatus();
    });

    var options = new cast.framework.CastReceiverOptions();
    options.disableIdleTimeout = true;
    castContext.start(options);
    console.log("[KULTURA] Cast receiver " + RECEIVER_VERSION + " started");
  }

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
        progress: slideAnimations ? slideAnimations.image.currentTime / slideDurationMs() : null,
      };
    },
  };

  initCast();
})();
