/**
 * KULTURA Cast Receiver — the wall tour on screen (DOM + Web Animations). Receiver 2.9.0.
 *
 * walltour.js plans (pure, tested); this module draws and plays the plan. receiver.js owns the messages and
 * switches between the slideshow and this view (one at a time).
 *
 * Like the slideshow, every stop has one CLOCK animation (no visible effect, the stop's length): its time drives
 * the camera, SEEK, pause/resume and the change to the next stop when it finishes. Beside it, opacity animations
 * of the same length (label, title, detail image, room light) pause and seek with it. The camera is ONE transform
 * on .wall-camera: a static transform during holds, and a Web Animation only while a move runs (the TV draws a
 * transform softer while it is animated: motion.js, 2.6.1). Cast notes: docs/design/2026-10-12-wall-on-tv.md.
 *
 * Memory: wall images only for paintings near the camera (walltour.wallImagePlan); detail images (up to 3200 px,
 * ~31 MB decoded) for the stop on screen and the next one only, each decoded (capped wait) before it shows.
 */
(function (root) {
  "use strict";

  var Tour = root.KulturaWallTour;

  /** After the wall is built, wait at most this long for the first views' wall images before the tour starts. */
  var WALL_READY_WAIT_MS = 6000;
  /** The stage fades in over the start screen, and out when the wall mode ends. */
  var STAGE_FADE_MS = 900;
  /** A detail image that arrives after its fade-in time fades in on its own this fast. */
  var LATE_DETAIL_FADE_MS = 600;
  /**
   * Covering texture tile, in wall points. The website draws 520 px (900 px wallpapers) and 627 px (1254 px plain
   * walls) on a wall ~1280 px wide; the TV's wall is 1000 points wide, so x 0.78.
   */
  var COVERING_TILE_PT = { damask: 406, plum: 406, navy: 490, teal: 490, limewash: 490, graphite: 490 };
  /** One website px in wall points (for the website's shadow and lip numbers, --u in receiver.css). */
  var WEBSITE_PX_PT = 0.78;
  /**
   * The covering runs on beyond the paintings by this many wall points, or this many times the wall's longer
   * side when more (the whole of a tall wall is a narrow strip with wide margins), so it fills every view.
   */
  var COVERING_OVERSCAN_PT = 3000;
  var COVERING_OVERSCAN_WALLS = 1.2;
  /** The canvas edge colour: this share of the painting's main colour in near-black (website: 30 %). */
  var CANVAS_EDGE_SHARE = 0.3;

  function el(tag, className, parent) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  function px(value) {
    return value.toFixed(2) + "px";
  }

  /** Mix `share` of colour "#rrggbb" into `base` "#rrggbb" (the website's color-mix for the canvas edge). */
  function mix(colour, base, share) {
    var a = /^#([0-9a-f]{6})$/i.exec(colour) ? colour : "#2a2622";
    var out = "#";
    for (var i = 1; i < 7; i += 2) {
      var v = Math.round(parseInt(a.substr(i, 2), 16) * share + parseInt(base.substr(i, 2), 16) * (1 - share));
      out += ("0" + v.toString(16)).slice(-2);
    }
    return out;
  }

  function cleanTitle(title) {
    return String(title || "").replace(/([^.])\.$/, "$1");
  }

  function cancelAll(list) {
    list.forEach(function (a) {
      if (a) a.cancel();
    });
  }

  /**
   * Create the wall view. Options: { parent: element the stage goes into, before: element it goes before,
   * loadImage(img, url) -> Promise (receiver.js: load + capped decode), onStop(), onStarted(), now() }.
   */
  function create(options) {
    var stage = el("div", "hidden");
    stage.id = "wall-stage";
    options.parent.insertBefore(stage, options.before || null);
    var camera = el("div", "wall-camera", stage);
    var covering = el("div", "wall-covering", camera);
    var piecesLayer = el("div", "wall-pieces", camera);
    var detailLayer = el("div", "wall-detail", camera);
    var light = el("div", "wall-light", stage);
    var caption = el("div", "metadata-overlay wall-caption", stage);
    var captionTitle = el("div", "metadata-title", caption);
    var captionByline = el("div", "metadata-artist", caption);
    var title = el("div", "metadata-overlay wall-title", stage);
    var titleText = el("div", "metadata-title", title);
    var clockEl = el("div", "wall-clock", stage);

    var tour = null;
    var wall = null;
    var started = false;
    var paused = false;
    /** Pause again once the arrival is done (NEXT / PREVIOUS while paused glides there, then waits). */
    var pauseAtArrival = false;
    var settings = { seconds: 45, motion: "gentle" };
    var stopToken = 0;
    var stop = null;
    /** What the stop on screen was planned with (walltour.planStop options), to re-plan it in place. */
    var stopRequest = null;
    /** The stop on screen lost its close-up (its detail image was late or failed): never re-plan it back. */
    var closeUpDropped = false;
    var stopIndex = 0;
    var anims = null; // { clock, caption, title, light, detail, move, timer }
    var pieceEls = []; // per piece index: { img, src (url while loaded) }
    var imagePlan = { pieceIndexes: [], estimatedBytes: 0, wanted: 0 };
    /** Detail images by tour position: { position, img, state, natural, url, fallbackUsed, wrapper }. */
    var details = {};
    /** The detail image of the stop just left, while it fades out (NEXT / PREVIOUS). */
    var fadingSlot = null;
    var readyTimer = null;
    /** The segment whose views the wall images were last planned for. */
    var plannedSegment = null;
    var lastError = null;
    /** Test-only render switches (protocol.js RENDER_FLAG_SPEC; {} = the normal look). */
    var renderFlags = {};

    // ─── Building the wall ───

    function buildWall() {
      var L = tour.layoutScale;
      stage.setAttribute("data-skin", wall.skin);
      stage.setAttribute("data-room", wall.room);
      camera.style.setProperty("--u", px(L * WEBSITE_PX_PT));
      var b = tour.bounds;
      var overscan = renderFlags.overscanPt != null
        ? renderFlags.overscanPt
        : Math.max(COVERING_OVERSCAN_PT, COVERING_OVERSCAN_WALLS * Math.max(b.maxX - b.minX, b.maxY - b.minY));
      covering.style.left = px((b.minX - overscan) * L);
      covering.style.top = px((b.minY - overscan) * L);
      covering.style.width = px((b.maxX - b.minX + 2 * overscan) * L);
      covering.style.height = px((b.maxY - b.minY + 2 * overscan) * L);
      var tile = (COVERING_TILE_PT[wall.skin] || 406) * L;
      covering.style.backgroundSize = px(tile) + " " + px(tile);
      // The pattern is anchored at wall point 0,0 whatever the overscan.
      covering.style.backgroundPosition = px((overscan - b.minX) * L % tile) + " " + px((overscan - b.minY) * L % tile);
      var res = renderFlags.coveringRes || 1;
      if (res !== 1) {
        // Test-only (coveringRes): the same covering laid out res times larger, scaled back by its own transform.
        covering.style.width = px((b.maxX - b.minX + 2 * overscan) * L * res);
        covering.style.height = px((b.maxY - b.minY + 2 * overscan) * L * res);
        covering.style.backgroundSize = px(tile * res) + " " + px(tile * res);
        covering.style.backgroundPosition = px(((overscan - b.minX) * L % tile) * res) + " " + px(((overscan - b.minY) * L % tile) * res);
        covering.style.transformOrigin = "0 0";
        covering.style.transform = "scale(" + (1 / res).toFixed(5) + ")";
      } else {
        covering.style.transform = "";
      }
      piecesLayer.textContent = "";
      // The phone draws by artwork id, later on top: same here for overlapping Free-wall pieces.
      var byId = tour.pieces.slice().sort(function (a, c) { return a.id - c.id; });
      pieceEls = [];
      byId.forEach(function (p) {
        var node = el("div", "wp", piecesLayer);
        node.setAttribute("data-frame", p.frame);
        node.style.left = px(p.x * L);
        node.style.top = px(p.y * L);
        node.style.width = px(p.w * L);
        node.style.height = px(p.h * L);
        node.style.setProperty("--band", px(p.drawnBand * L));
        el("div", "wp-shadow", node);
        var canvas = el("div", "wp-canvas", node);
        canvas.style.left = px((p.inner.x - p.x) * L);
        canvas.style.top = px((p.inner.y - p.y) * L);
        canvas.style.width = px(p.inner.w * L);
        canvas.style.height = px(p.inner.h * L);
        canvas.style.backgroundColor = p.mainColor;
        var img = el("img", null, canvas);
        img.alt = "";
        img.decoding = "async";
        el("div", "wp-lip", canvas);
        var frame = el("div", "wp-frame", node);
        frame.setAttribute("data-frame", p.frame);
        if (p.frame === "canvas") {
          var side = mix(p.mainColor, "#0b0a09", CANVAS_EDGE_SHARE);
          frame.style.borderColor = side + " " + side + " " + mix(p.mainColor, "#0b0a09", CANVAS_EDGE_SHARE * 0.67);
        }
        pieceEls[p.index] = { img: img, src: null };
        img.onerror = function () {
          // Main colour stays; the tour goes on.
          img.removeAttribute("src");
          lastError = "wall image " + p.id + " failed";
        };
      });
    }

    /**
     * Give the paintings near the views still ahead in this stop their wall image; take it from the others
     * (memory). Called at the stop's start and at every segment start (`plannedSegment`).
     */
    function applyImagePlan(forStop, fromMs) {
      imagePlan = Tour.wallImagePlan(tour, forStop, null, fromMs || 0);
      var keep = {};
      imagePlan.pieceIndexes.forEach(function (i) { keep[i] = true; });
      // Further out than the opening (the whole-wall rest of a loop), paintings on screen keep the image they
      // have: dropping them there would turn half the wall into colour blocks in view. They go at the opening.
      // (This is the one moment the wall images may exceed WALL_IMAGE_BUDGET_BYTES; diagnostics show the count.)
      var cam = Tour.cameraAt(forStop, tour, fromMs || 0);
      if (cam.zoom < tour.opening.zoom * 0.999) {
        var halfW = tour.screen.width / 2 / cam.zoom;
        var halfH = tour.screen.height / 2 / cam.zoom;
        tour.pieces.forEach(function (p) {
          if (pieceEls[p.index].src && p.x < cam.cx + halfW && p.x + p.w > cam.cx - halfW && p.y < cam.cy + halfH && p.y + p.h > cam.cy - halfH) {
            keep[p.index] = true;
          }
        });
      }
      pieceEls.forEach(function (entry, i) {
        if (keep[i] && !entry.src) {
          entry.src = tour.pieces[i].wallImageUrl;
          entry.img.src = entry.src;
        } else if (!keep[i] && entry.src) {
          entry.src = null;
          entry.img.removeAttribute("src");
        }
      });
    }

    // ─── Detail images (at most two decoded: the stop on screen and the next) ───

    function detailFor(position) {
      if (details[position]) return details[position];
      var piece = tour.pieces[tour.order[position]];
      var slot = { position: position, img: new Image(), state: "loading", natural: null, url: null, fallbackUsed: false, wrapper: null };
      slot.img.alt = "";
      details[position] = slot;
      var urls = [piece.detailUrl, piece.fallbackImageUrl].filter(Boolean);
      var attempt = function (k) {
        if (k >= urls.length) {
          slot.state = "failed";
          return;
        }
        options.loadImage(slot.img, urls[k]).then(
          function () {
            if (details[position] !== slot) return;
            slot.state = "ready";
            slot.url = urls[k];
            slot.fallbackUsed = k > 0 && urls[0] === piece.detailUrl;
            slot.natural = { width: slot.img.naturalWidth, height: slot.img.naturalHeight };
            detailArrived(slot);
          },
          function () {
            if (details[position] !== slot) return;
            attempt(k + 1);
          }
        );
      };
      if (urls.length) attempt(0);
      else slot.state = "failed";
      return slot;
    }

    function releaseDetail(slot) {
      if (slot.fadeAnim) {
        var fade = slot.fadeAnim;
        slot.fadeAnim = null;
        fade.onfinish = null;
        fade.cancel();
      }
      slot.fading = false;
      if (fadingSlot === slot) fadingSlot = null;
      if (slot.wrapper && slot.wrapper.parentNode) slot.wrapper.parentNode.removeChild(slot.wrapper);
      slot.img.onload = null;
      slot.img.onerror = null;
      slot.img.removeAttribute("src");
      if (details[slot.position] === slot) delete details[slot.position];
    }

    /**
     * Keep only the details of `position` and the next stop; start loading both. An outgoing image still fading
     * out (NEXT / PREVIOUS) counts as one of the two: the next stop's image then waits until it is released
     * (fadeOutgoingDetail).
     */
    function manageDetails(position) {
      var next = (position + 1) % tour.order.length;
      var fadingOther = false;
      Object.keys(details).forEach(function (key) {
        var k = Number(key);
        if (k === position || k === next) return;
        // Only the image just left may still be fading; any other goes now.
        if (details[k].fading && details[k] === fadingSlot) fadingOther = true;
        else releaseDetail(details[k]);
      });
      var current = detailFor(position);
      if (!fadingOther) detailFor(next);
      return current;
    }

    /** Put a ready detail image in the detail layer over its painting (inside this stop's wrapper). */
    function placeDetail(slot) {
      var piece = tour.pieces[tour.order[slot.position]];
      var L = tour.layoutScale;
      if (!slot.wrapper) slot.wrapper = el("div", "wall-detail-stop");
      var box = slot.wrapper;
      box.style.left = px(piece.inner.x * L);
      box.style.top = px(piece.inner.y * L);
      box.style.width = px(piece.inner.w * L);
      box.style.height = px(piece.inner.h * L);
      if (slot.img.parentNode !== box) box.appendChild(slot.img);
      if (box.parentNode !== detailLayer) detailLayer.appendChild(box);
    }

    function detailShown(slot) {
      return !!slot && slot.state === "ready" && !!slot.wrapper && slot.wrapper.parentNode === detailLayer;
    }

    /** A detail image finished loading: show it if its stop is on screen (re-planning the close-up if needed). */
    function detailArrived(slot) {
      if (!stop || slot.position !== stopIndex) return;
      var t = clockTime();
      var approach = segmentNamed("approach");
      var planned = stop.natural;
      var differs = !planned || planned.width !== slot.natural.width || planned.height !== slot.natural.height;
      if (differs && (!approach || t < approach.startMs) && !closeUpDropped) {
        // The loaded image is not the size the plan assumed (fallback used): re-plan its depth (sharpness).
        stopRequest.natural = slot.natural;
        stop = Tour.planStop(tour, stopIndex, stopRequest);
        rebuildWindows(t);
      }
      attachDetailToStop(slot, t);
      sync();
    }

    function attachDetailToStop(slot, t) {
      placeDetail(slot);
      if (anims.detail) anims.detail.cancel();
      anims.detail = slot.wrapper.animate(Tour.windowKeyframes(stop, stop.windows.detail, 0, 1), { duration: stop.durationMs, fill: "forwards" });
      anims.detail.currentTime = t;
      if (frozen()) anims.detail.pause();
      // Late (after its fade-in time): the image fades in on its own instead of popping.
      if (t > stop.windows.detail.inMs + 50 && t < stop.windows.detail.outMs) {
        slot.img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LATE_DETAIL_FADE_MS, easing: "ease-out" });
      }
    }

    // ─── Stops ───

    /** Paused and not finishing a NEXT / PREVIOUS glide. */
    function frozen() {
      return paused && !pauseAtArrival;
    }

    function clockTime() {
      var c = anims && anims.clock;
      return c && c.currentTime != null ? c.currentTime : 0;
    }

    function segmentNamed(name) {
      if (!stop) return null;
      for (var i = 0; i < stop.segments.length; i++) {
        if (stop.segments[i].name === name) return stop.segments[i];
      }
      return null;
    }

    function stopAnimations() {
      if (!anims) return;
      clearTimeout(anims.timer);
      cancelAll([anims.clock, anims.caption, anims.title, anims.light, anims.detail, anims.move]);
      anims = null;
    }

    /** The current detail wrapper fades out from where it is (NEXT / PREVIOUS), then is released. */
    function fadeOutgoingDetail() {
      var slot = details[stopIndex];
      if (!slot || !slot.wrapper || !anims) return;
      var opacity = Tour.windowOpacityAt(stop.windows.detail, clockTime(), 0, 1);
      if (anims.detail) anims.detail.cancel();
      anims.detail = null;
      slot.wrapper.style.opacity = String(opacity);
      if (opacity <= 0.01) return;
      slot.fading = true;
      fadingSlot = slot;
      var fade = slot.wrapper.animate([{ opacity: opacity }, { opacity: 0 }], { duration: Math.round(Tour.JUMP_FADE_MS * opacity), fill: "forwards" });
      slot.fadeAnim = fade;
      fade.onfinish = function () {
        slot.fadeAnim = null;
        slot.fading = false;
        if (fadingSlot === slot) fadingSlot = null;
        if (slot.position !== stopIndex && slot.position !== (stopIndex + 1) % tour.order.length) releaseDetail(slot);
        else if (slot.wrapper) slot.wrapper.style.opacity = "";
        fade.cancel();
        // The next stop's image waited for this one to go (manageDetails).
        detailFor((stopIndex + 1) % tour.order.length);
      };
      return opacity;
    }

    /**
     * Start stop `position`: flow "auto" (the tour moving on) or "jump" (NEXT / PREVIOUS from wherever the
     * camera is).
     */
    function startStop(position, flow) {
      var token = ++stopToken;
      var from = null;
      var leadIn = 0;
      if (stop) {
        from = flow === "jump" ? Tour.cameraAt(stop, tour, clockTime()) : tour.stops[stopIndex];
        if (flow === "jump") {
          var shown = fadeOutgoingDetail();
          leadIn = shown > 0.01 ? Math.round(Tour.JUMP_FADE_MS * shown) : 0;
        }
      }
      stopAnimations();
      if (from) camera.style.transform = Tour.cameraTransform(from, tour);
      stopIndex = position;
      var slot = manageDetails(position);
      stopRequest = { from: from, flow: flow, leadInMs: leadIn, seconds: settings.seconds, motion: settings.motion, natural: slot.state === "ready" ? slot.natural : null };
      closeUpDropped = false;
      stop = Tour.planStop(tour, position, stopRequest);
      applyImagePlan(stop, 0);
      plannedSegment = stop.segments[0];

      var piece = tour.pieces[stop.pieceIndex];
      captionTitle.textContent = cleanTitle(piece.title);
      captionByline.textContent = [piece.artist, piece.date].filter(Boolean).join(" · ");
      caption.classList.toggle("label-right", position % 2 === 1);
      caption.style.marginBottom = ((position * 7) % 5) * 0.3 + "vh";
      titleText.textContent = (wall.sourceName || "My wall") + " · " + tour.order.length + (tour.order.length === 1 ? " artwork" : " artworks");

      var timing = { duration: stop.durationMs, fill: "forwards" };
      anims = { timer: null, move: null, detail: null };
      anims.clock = clockEl.animate([{ visibility: "visible" }, { visibility: "visible" }], timing);
      anims.clock.onfinish = function () {
        if (token === stopToken) advance();
      };
      pauseAtArrival = paused && flow === "jump";
      rebuildWindows(0);
      if (slot.state === "ready") attachDetailToStop(slot, 0);
      if (frozen()) pauseAll();
      sync();
      options.onStop();
    }

    /** Label, title and light animations for the current plan, at stop time `t`. */
    function rebuildWindows(t) {
      cancelAll([anims.caption, anims.title, anims.light]);
      var timing = { duration: stop.durationMs, fill: "forwards" };
      anims.caption = caption.animate(Tour.windowKeyframes(stop, stop.windows.caption, 0, 1), timing);
      anims.title = title.animate(Tour.windowKeyframes(stop, stop.windows.title, 0, 1), timing);
      anims.light = light.animate(Tour.lightKeyframes(stop), timing);
      [anims.caption, anims.title, anims.light].forEach(function (a) {
        a.currentTime = t;
        if (frozen()) a.pause();
      });
    }

    function windowAnimations() {
      return [anims.clock, anims.caption, anims.title, anims.light, anims.detail];
    }

    function pauseAll() {
      windowAnimations().forEach(function (a) {
        if (a) a.pause();
      });
      if (anims.move) anims.move.pause();
      clearTimeout(anims.timer);
    }

    function advance() {
      startStop((stopIndex + 1) % tour.order.length, "auto");
    }

    /**
     * Keep the camera in step with the clock: a static transform during holds, a move animation only while a
     * move runs. Called at stop start, at every segment boundary (timer), on pause/resume and after a SEEK.
     */
    function sync() {
      if (!anims || !stop) return;
      clearTimeout(anims.timer);
      anims.timer = null;
      var t = clockTime();
      if (pauseAtArrival && t >= stop.arrivalMs) {
        pauseAtArrival = false;
        windowAnimations().forEach(function (a) {
          if (a) a.currentTime = stop.arrivalMs;
        });
        t = stop.arrivalMs;
        pauseAll();
      }
      if (t >= stop.durationMs - 1 && !paused) {
        advance(); // backup for a lost finish event
        return;
      }
      var seg = Tour.segmentAt(stop, t);
      if (seg.name === "approach" && stop.closeUp.plan === "gentle" && !detailShown(details[stopIndex])) {
        // The detail image is not here in time: no close-up on the soft wall image; the times stay.
        stop = Tour.withoutCloseUp(stop, details[stopIndex] && details[stopIndex].state === "failed" ? "detail-failed" : "detail-late");
        closeUpDropped = true;
        rebuildWindows(t);
        seg = Tour.segmentAt(stop, t);
      }
      if (seg !== plannedSegment && seg.startMs > 0) {
        plannedSegment = seg;
        applyImagePlan(stop, seg.startMs);
      }
      var still = frozen();
      if (!seg.move) {
        if (anims.move) {
          anims.move.cancel();
          anims.move = null;
        }
        camera.style.transform = Tour.cameraTransform(seg.from, tour);
      } else {
        if (!anims.move || anims.move.segment !== seg) {
          if (anims.move) anims.move.cancel();
          var move = camera.animate(Tour.moveKeyframes(seg, tour), { duration: seg.endMs - seg.startMs, easing: seg.easing, fill: "forwards" });
          move.segment = seg;
          move.onfinish = function () {
            if (!anims || anims.move !== move) return;
            // Pin the end pose as a static transform BEFORE dropping the animation: no frame shows neither.
            camera.style.transform = Tour.cameraTransform(seg.to, tour);
            move.cancel();
            anims.move = null;
            sync();
          };
          anims.move = move;
        }
        anims.move.currentTime = t - seg.startMs;
        if (still) anims.move.pause();
        else anims.move.play();
      }
      if (!still) {
        var next = pauseAtArrival && t < stop.arrivalMs ? Math.min(seg.endMs, stop.arrivalMs) : seg.endMs;
        anims.timer = setTimeout(sync, Math.max(0, next - t) + 5);
      }
    }

    /**
     * Test-only (RENDER_FLAGS): switch costly parts of the look off one at a time to measure their share of the
     * frame. Classes on the stage (receiver.css "Render flags"); overscanPt applies when the next wall is built.
     */
    function setRenderFlags(flags) {
      renderFlags = flags || {};
      var classes = {
        "rf-no-shadows": renderFlags.shadows === false,
        "rf-no-lips": renderFlags.lips === false,
        "rf-frames-flat": renderFlags.frames === "flat",
        "rf-frames-none": renderFlags.frames === "none",
        "rf-covering-flat": renderFlags.covering === "flat",
        "rf-covering-none": renderFlags.covering === "none",
        "rf-no-detail": renderFlags.detail === false,
        "rf-no-wall-images": renderFlags.wallImages === false,
        "rf-no-light": renderFlags.light === false,
        "rf-no-glass": renderFlags.glass === false,
        "rf-piece-layers": renderFlags.pieceLayers === true,
      };
      for (var name in classes) stage.classList.toggle(name, classes[name]);
      camera.style.willChange = renderFlags.willChange ? "transform" : "";
    }

    // ─── Public ───

    function load(validatedWall, view, dpr, initialSettings) {
      destroyContent();
      wall = validatedWall;
      settings = { seconds: initialSettings.seconds, motion: initialSettings.motion };
      tour = Tour.planTour(wall, view, dpr);
      buildWall();
      stopIndex = 0;
      stop = null;
      camera.style.transform = Tour.cameraTransform(tour.opening, tour);
      // The first views' images, before the tour starts (capped: a slow image never holds the tour).
      var first = Tour.planStop(tour, 0, { from: null, flow: "auto", seconds: settings.seconds, motion: settings.motion });
      applyImagePlan(first);
      manageDetails(0);
      var pending = imagePlan.pieceIndexes.map(function (i) {
        var img = pieceEls[i].img;
        return new Promise(function (resolve) {
          if (img.complete && img.naturalWidth) resolve();
          img.addEventListener("load", resolve);
          img.addEventListener("error", resolve);
        });
      });
      var begin = function () {
        if (started || !tour) return;
        clearTimeout(readyTimer);
        started = true;
        stage.classList.remove("hidden");
        stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: STAGE_FADE_MS, easing: "ease-out" });
        startStop(0, "auto");
        options.onStarted();
      };
      readyTimer = setTimeout(begin, WALL_READY_WAIT_MS);
      Promise.all(pending).then(begin);
    }

    function destroyContent() {
      clearTimeout(readyTimer);
      stopToken++;
      stopAnimations();
      Object.keys(details).forEach(function (k) { releaseDetail(details[k]); });
      details = {};
      fadingSlot = null;
      pieceEls.forEach(function (entry) {
        entry.img.onerror = null;
        entry.img.removeAttribute("src");
      });
      pieceEls = [];
      piecesLayer.textContent = "";
      detailLayer.textContent = "";
      stage.classList.add("hidden");
      tour = null;
      stop = null;
      started = false;
      paused = false;
      pauseAtArrival = false;
    }

    function setPaused(value) {
      paused = value;
      if (!anims) return;
      if (value) {
        pauseAtArrival = false;
        pauseAll();
      } else {
        pauseAtArrival = false;
        windowAnimations().forEach(function (a) {
          if (a) a.play();
        });
      }
      sync();
    }

    function jump(delta) {
      if (!started || !tour) return;
      var n = tour.order.length;
      startStop((((stopIndex + delta) % n) + n) % n, "jump");
    }

    function seek(timeMs) {
      if (!anims || !stop) return;
      var t = Math.max(0, Math.min(stop.durationMs - 2, timeMs));
      pauseAtArrival = false;
      windowAnimations().forEach(function (a) {
        if (a) a.currentTime = t;
      });
      sync();
    }

    function diagnostics() {
      if (!tour) return { started: false };
      var t = clockTime();
      var seg = stop ? Tour.segmentAt(stop, t) : null;
      var cam = stop ? Tour.cameraAt(stop, tour, t) : tour.opening;
      var piece = stop ? tour.pieces[stop.pieceIndex] : null;
      var slot = details[stopIndex];
      var shown = detailShown(slot);
      var round = function (v, d) {
        var f = Math.pow(10, d);
        return v == null ? null : Math.round(v * f) / f;
      };
      return {
        started: started,
        paused: paused,
        stopIndex: stopIndex,
        count: tour.order.length,
        pieceId: piece ? piece.id : null,
        timeMs: Math.round(t),
        durationMs: stop ? stop.durationMs : null,
        arrivalMs: stop ? stop.arrivalMs : null,
        segment: seg ? seg.name : null,
        segments: stop ? stop.segments.map(function (s) { return { name: s.name, startMs: s.startMs, endMs: s.endMs }; }) : [],
        camera: { cx: round(cam.cx, 1), cy: round(cam.cy, 1), zoom: round(cam.zoom, 4), transform: Tour.cameraTransform(cam, tour) },
        layoutScale: tour.layoutScale,
        opening: tour.opening.kind,
        closeUp: stop ? { plan: stop.closeUp.plan, reason: stop.closeUp.reason, relativeZoom: round(stop.closeUp.relativeZoom, 3), upscaleAtHold: round(stop.closeUp.upscale, 3) } : null,
        detail: slot
          ? {
            state: slot.state,
            file: slot.url ? String(slot.url).split("/").pop().slice(0, 120) : null,
            naturalWidth: slot.natural ? slot.natural.width : null,
            naturalHeight: slot.natural ? slot.natural.height : null,
            fallbackUsed: slot.fallbackUsed,
            shown: shown,
            opacity: stop ? round(Tour.windowOpacityAt(stop.windows.detail, t, 0, 1), 3) : 0,
            // Device px drawn per image px right now (above 1.1 = visibly soft: tv_capture flags it).
            devicePxPerImagePx: shown ? round(Tour.imageUpscale(piece, slot.natural, cam.zoom, tour.dpr), 3) : null,
          }
          : null,
        detailImagesHeld: Object.keys(details).length,
        wallImages: {
          loaded: pieceEls.filter(function (e) { return !!e.src; }).length,
          wanted: imagePlan.wanted,
          total: tour.pieces.length,
          // Decoded size of the wall images given out now (RGBA, from their file names).
          estimatedMB: Math.round(pieceEls.reduce(function (sum, e, i) {
            return e.src ? sum + Tour.wallImageBytes(tour.pieces[i]) : sum;
          }, 0) / 1048576),
        },
        lastError: lastError,
        renderFlags: renderFlags,
      };
    }

    return {
      load: load,
      destroy: destroyContent,
      setPaused: setPaused,
      next: function () { jump(1); },
      previous: function () { jump(-1); },
      seek: seek,
      setSettings: function (s) {
        if (s.seconds) settings.seconds = s.seconds;
        if (s.motion) settings.motion = s.motion;
      },
      isStarted: function () { return started; },
      /** { index, count, pieceId, title } of the stop on screen (index/count count painting stops). */
      position: function () {
        if (!tour) return null;
        var p = tour.pieces[tour.order[stopIndex]];
        return { index: stopIndex, count: tour.order.length, pieceId: p.id, title: p.title };
      },
      captionOnRight: function () { return caption.classList.contains("label-right"); },
      diagnostics: diagnostics,
      setRenderFlags: setRenderFlags,
      renderFlags: function () { return renderFlags; },
    };
  }

  root.KulturaWallView = { create: create, WALL_READY_WAIT_MS: WALL_READY_WAIT_MS };
})(typeof window !== "undefined" ? window : this);
