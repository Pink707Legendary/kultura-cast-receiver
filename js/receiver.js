/**
 * KULTURA Cast Receiver — Ken Burns Ambient Gallery Engine
 *
 * Receives a manifest of artworks from the phone via Google Cast custom channel,
 * then cycles through them with cinematic Ken Burns animations:
 *   1. Cross-dissolve fade in (2s)
 *   2. Full view with gentle drift (8s)
 *   3. Zoom to AI crop region (12s)
 *   4. Hold on detail (8s)
 *   5. Pull back to full view (7s)
 *   6. Show metadata card (8s)
 *
 * Total per artwork: ~45s
 */

(function () {
  "use strict";

  // ─── Constants ───
  const NAMESPACE = "urn:x-cast:art.kultura.cast";
  const PRELOAD_AHEAD = 2;

  // Phase durations (ms)
  const PHASE = {
    FADE_IN: 2000,
    FULL_VIEW: 8000,
    ZOOM_TO_CROP: 12000,
    HOLD_DETAIL: 8000,
    PULL_BACK: 7000,
    METADATA: 8000,
  };

  // ─── DOM refs ───
  const bgEl = document.getElementById("background");
  const layerA = document.getElementById("layer-a");
  const layerB = document.getElementById("layer-b");
  const idleScreen = document.getElementById("idle-screen");

  // ─── State ───
  let manifest = [];
  let artistName = "";
  let currentIndex = 0;
  let isPaused = false;
  let activeLayer = "a"; // toggles between "a" and "b"
  let phaseTimer = null;
  let castContext = null;
  let lastSenderId = undefined;

  // ─── Helpers ───

  function getLayer(which) {
    return which === "a" ? layerA : layerB;
  }

  function getInactiveLayer() {
    return activeLayer === "a" ? "b" : "a";
  }

  /**
   * Calculate the CSS transform to zoom into the AI crop region.
   * The crop coordinates are in the original image's pixel space (usually 2048px).
   */
  function calculateCropTransform(artwork) {
    var crop = artwork.aiCrop;
    if (!crop || (crop.xmin === 0 && crop.xmax === 0 && crop.ymin === 0 && crop.ymax === 0)) {
      // No valid crop — gentle center zoom as fallback
      return "scale(1.2)";
    }

    var imgW = artwork.width || 2048;
    var imgH = artwork.height || Math.round(2048 / (artwork.ratio || 1));

    var cropW = crop.xmax - crop.xmin;
    var cropH = crop.ymax - crop.ymin;

    if (cropW <= 0 || cropH <= 0) return "scale(1.2)";

    // How much to scale: fill the viewport with the crop region (with 15% breathing room)
    var scaleX = imgW / cropW;
    var scaleY = imgH / cropH;
    var scale = Math.min(scaleX, scaleY) * 0.85;
    // Cap the zoom to avoid extreme close-ups
    scale = Math.min(scale, 4);

    // Translate so the crop center is at the image center
    var cropCenterX = (crop.xmin + crop.xmax) / 2;
    var cropCenterY = (crop.ymin + crop.ymax) / 2;
    var imgCenterX = imgW / 2;
    var imgCenterY = imgH / 2;

    // Translate in percentage of image dimensions (since transform-origin is center)
    var translateX = ((imgCenterX - cropCenterX) / imgW) * 100;
    var translateY = ((imgCenterY - cropCenterY) / imgH) * 100;

    return "translate(" + translateX + "%, " + translateY + "%) scale(" + scale + ")";
  }

  /** Preload images for upcoming artworks. */
  function preloadAhead() {
    for (var i = 1; i <= PRELOAD_AHEAD; i++) {
      var idx = (currentIndex + i) % manifest.length;
      var img = new Image();
      img.src = manifest[idx].imageUrl;
    }
  }

  /** Send status back to the phone. */
  function sendStatus() {
    if (!castContext) return;

    var artwork = manifest[currentIndex] || null;
    var status = {
      type: "STATUS",
      currentIndex: currentIndex,
      isPaused: isPaused,
      totalArtworks: manifest.length,
      currentArtwork: artwork ? { id: artwork.id, title: artwork.title } : null,
    };

    castContext.sendCustomMessage(NAMESPACE, lastSenderId, status);
  }

  // ─── Ken Burns Animation Sequence ───

  function clearPhaseTimer() {
    if (phaseTimer) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }
  }

  /**
   * Show one artwork through the full Ken Burns sequence.
   * Uses two layers (A and B) alternately for cross-dissolve transitions.
   */
  function showArtwork(index) {
    if (manifest.length === 0) return;
    currentIndex = index % manifest.length;
    var artwork = manifest[currentIndex];

    // Set background color (visible for portrait paintings on landscape TV)
    bgEl.style.backgroundColor = artwork.mainColor || "#000";

    // Prepare the incoming layer
    var incomingId = getInactiveLayer();
    var incomingLayer = getLayer(incomingId);
    var outgoingLayer = getLayer(activeLayer);
    var img = incomingLayer.querySelector(".artwork-image");
    var meta = incomingLayer.querySelector(".metadata-overlay");
    var titleEl = meta.querySelector(".metadata-title");
    var artistEl = meta.querySelector(".metadata-artist");

    // Reset the incoming layer
    meta.classList.remove("visible");
    img.style.transition = "none";
    img.style.transform = "scale(1)";
    // Force reflow so the reset takes effect before we add transitions back
    void img.offsetHeight;

    // Load image
    img.src = artwork.imageUrl;

    // Phase 1: Cross-dissolve (2s)
    incomingLayer.classList.add("active");
    outgoingLayer.classList.remove("active");
    activeLayer = incomingId;

    sendStatus();
    preloadAhead();

    // Phase 2: Full view with gentle drift toward crop (8s)
    phaseTimer = setTimeout(function () {
      if (isPaused) return waitForResume(phase3);
      img.style.transition = "transform " + (PHASE.FULL_VIEW / 1000) + "s cubic-bezier(0.25, 0.1, 0.25, 1.0)";
      // Gentle drift: very slight move toward the crop area
      img.style.transform = "scale(1.03)";

      phaseTimer = setTimeout(function () {
        if (isPaused) return waitForResume(phase3);
        phase3();
      }, PHASE.FULL_VIEW);
    }, PHASE.FADE_IN);

    function phase3() {
      // Phase 3: Zoom to AI crop (12s)
      var cropTransform = calculateCropTransform(artwork);
      img.style.transition = "transform " + (PHASE.ZOOM_TO_CROP / 1000) + "s cubic-bezier(0.25, 0.1, 0.25, 1.0)";
      img.style.transform = cropTransform;

      phaseTimer = setTimeout(function () {
        if (isPaused) return waitForResume(phase4);
        phase4();
      }, PHASE.ZOOM_TO_CROP);
    }

    function phase4() {
      // Phase 4: Hold on detail (8s) — subtle continued drift
      img.style.transition = "transform " + (PHASE.HOLD_DETAIL / 1000) + "s linear";
      // Tiny additional scale for subtle movement during hold
      var currentTransform = img.style.transform;
      // Not parsing — just add a tiny nudge by keeping the same transform
      // (the visual effect is the transition easing settling)

      phaseTimer = setTimeout(function () {
        if (isPaused) return waitForResume(phase5);
        phase5();
      }, PHASE.HOLD_DETAIL);
    }

    function phase5() {
      // Phase 5: Pull back to full view (7s)
      img.style.transition = "transform " + (PHASE.PULL_BACK / 1000) + "s cubic-bezier(0.25, 0.1, 0.25, 1.0)";
      img.style.transform = "scale(1)";

      phaseTimer = setTimeout(function () {
        if (isPaused) return waitForResume(phase6);
        phase6();
      }, PHASE.PULL_BACK);
    }

    function phase6() {
      // Phase 6: Metadata card (8s)
      titleEl.textContent = artwork.title || "";
      artistEl.textContent = artistName || "";
      meta.classList.add("visible");

      phaseTimer = setTimeout(function () {
        if (isPaused) return waitForResume(nextArtwork);
        nextArtwork();
      }, PHASE.METADATA);
    }

    function nextArtwork() {
      meta.classList.remove("visible");
      showArtwork(currentIndex + 1);
    }
  }

  /** When paused mid-phase, store the continuation and wait. */
  var resumeCallback = null;

  function waitForResume(callback) {
    resumeCallback = callback;
  }

  function resume() {
    isPaused = false;
    sendStatus();
    if (resumeCallback) {
      var cb = resumeCallback;
      resumeCallback = null;
      cb();
    }
  }

  // ─── Public Commands ───

  function handleMessage(event) {
    var data = event.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }

    switch (data.type) {
      case "LOAD_MANIFEST":
        manifest = data.artworks || [];
        artistName = data.artistName || "";
        currentIndex = 0;
        isPaused = false;
        resumeCallback = null;
        clearPhaseTimer();

        if (manifest.length > 0) {
          idleScreen.classList.add("hidden");
          showArtwork(0);
        }
        break;

      case "NEXT":
        clearPhaseTimer();
        resumeCallback = null;
        isPaused = false;
        showArtwork(currentIndex + 1);
        break;

      case "PREVIOUS":
        clearPhaseTimer();
        resumeCallback = null;
        isPaused = false;
        showArtwork(currentIndex - 1 + manifest.length);
        break;

      case "PAUSE":
        isPaused = true;
        clearPhaseTimer();
        sendStatus();
        break;

      case "RESUME":
        resume();
        break;
    }
  }

  // ─── Cast SDK Initialization ───

  function initCast() {
    if (typeof cast === "undefined" || !cast.framework) {
      console.log("[KULTURA] Cast SDK not available — running in dev mode");
      return;
    }

    castContext = cast.framework.CastReceiverContext.getInstance();

    castContext.addCustomMessageListener(NAMESPACE, function (event) {
      if (event.senderId) lastSenderId = event.senderId;
      handleMessage(event);
    });

    var options = new cast.framework.CastReceiverOptions();
    options.disableIdleTimeout = true;

    castContext.start(options);
    console.log("[KULTURA] Cast receiver started");
  }

  // ─── Expose for dev mode ───
  window.kulturaReceiver = {
    handleMessage: handleMessage,
    getState: function () {
      return { manifest: manifest, currentIndex: currentIndex, isPaused: isPaused, artistName: artistName };
    },
  };

  // ─── Boot ───
  initCast();

})();
