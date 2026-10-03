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

  var RECEIVER_VERSION = "2.5.0";
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
  var bgEl = document.getElementById("background");
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

  // Frames per second over the last second, to spot stutter on slow TV graphics chips.
  var fps = null;
  (function measureFps() {
    var frames = 0;
    var windowStart = performance.now();
    function tick(now) {
      frames++;
      if (now - windowStart >= 1000) {
        fps = Math.round((frames * 1000) / (now - windowStart));
        frames = 0;
        windowStart = now;
      }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  })();

  /** Engine state sent with STATUS so a TV can be debugged from a phone or Mac. */
  function diagnostics() {
    var anim = slideAnimations && slideAnimations.image;
    return {
      phase: slidePhase,
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
      fps: fps,
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

  /** Load the artwork's image; if it fails and a fallback (normal-size) image exists, try that. */
  function loadArtworkImage(img, artwork, token) {
    return loadImage(img, artwork.imageUrl).catch(function (err) {
      if (!artwork.fallbackImageUrl || token !== slideToken) throw err;
      console.warn("[KULTURA] artwork " + artwork.id + ": large image failed (" + err.message + "), using the normal one");
      Telemetry.reportImageFallback(artwork.id, err.message);
      return loadImage(img, artwork.fallbackImageUrl);
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

    var incomingId = activeLayerId === "a" ? "b" : "a";
    var incoming = layers[incomingId];
    var img = incoming.querySelector(".artwork-image");
    var caption = incoming.querySelector(".metadata-overlay");

    cancelLayerAnimations(incoming);
    setPhase("loading");
    sendStatus();

    loadArtworkImage(img, artwork, token).then(
      function () {
        if (token !== slideToken) return; // the user skipped while this was loading
        consecutiveLoadFailures = 0;
        startSlide(artwork, incoming, incomingId, img, caption, token);
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

  function startSlide(artwork, incoming, incomingId, img, caption, token) {
    var outgoing = layers[activeLayerId];
    var geometry = fitImage(img);
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

    applyBackdrop(artwork);
    incoming.classList.add("active");
    outgoing.classList.remove("active");
    activeLayerId = incomingId;
    idleScreen.classList.add("hidden");
    requestWakeLock();

    preloadAhead();
  }

  /** Textured, tinted backdrop behind paintings that don't fill the screen (see backdrop.js). */
  function applyBackdrop(artwork) {
    var b = Backdrop.backdropFor(artwork.mainColor, backdropTexture, backdropMood);
    bgEl.style.backgroundColor = b.tint;
    bgEl.style.backgroundImage = b.texture ? "url(textures/" + b.texture + ".webp)" : "none";
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
          if (artworks[currentIndex]) applyBackdrop(artworks[currentIndex]);
        }
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
