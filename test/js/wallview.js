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
  var Render = root.KulturaWallRender;

  /** After the wall is built, wait at most this long for the first views' wall images before the tour starts. */
  var WALL_READY_WAIT_MS = 6000;
  /**
   * Work that re-rasters (layer and frame-level changes, placing the detail image, fetching the next one) waits this
   * long after the camera comes to rest: right at a move's end it would drop frames while the camera still eases in;
   * a moment later nothing moves, so a slower frame shows nothing.
   */
  var STILL_WORK_DELAY_MS = 450;
  /** A will-change painting layer is re-rastered (while still) once its raster is this much larger than the view. */
  var WILL_CHANGE_RESET_RATIO = 1.3;
  /** The stage fades in over the start screen, and out when the wall mode ends. */
  var STAGE_FADE_MS = 900;
  /** A detail image that arrives after its fade-in time fades in on its own this fast. */
  var LATE_DETAIL_FADE_MS = 600;
  /**
   * Covering texture tile, in wall points. The website draws 520 px (900 px wallpapers) and 627 px (1254 px plain
   * walls) on a wall ~1280 px wide; the TV's wall is 1000 points wide, so x 0.78.
   */
  var COVERING_ORIGINAL_TILE_PT = { damask: 406, plum: 406, navy: 490, teal: 490, limewash: 490, graphite: 490 };
  /**
   * The seamless tiles (wall/tiles/, scripts/make_wall_tiles.py): the patterns keep their 900 px repeat; the plain
   * walls are 1024 px crops of the 1254 px textures at the same sharpness (490 x 1024 / 1254 points).
   */
  var COVERING_TILE_PT = { damask: 406, plum: 406, navy: 400.13, teal: 400.13, limewash: 400.13, graphite: 400.13 };
  /** The faint macro variation over the tile (wall/tiles/macro-a.webp), a size no tile divides: hides the repeat. */
  var COVERING_MACRO_PT = 1733;
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
    var anims = null; // { clock, caption, title, light, detail, move, spotFade, spotMove, timer }
    var pieceEls = []; // per piece index: { node, frame, img, src (url while loaded), lod, layer }
    var imagePlan = { pieceIndexes: [], estimatedBytes: 0, wanted: 0 };
    /** Detail images by tour position: { position, img, state, natural, url, fallbackUsed, wrapper }. */
    var details = {};
    /** The detail image of the stop just left, while it fades out (NEXT / PREVIOUS). */
    var fadingSlot = null;
    var readyTimer = null;
    /** The segment whose views the wall images were last planned for. */
    var plannedSegment = null;
    /** The segment the layers, frame levels and detail placement were last updated for. */
    var renderSegment = null;
    var stillWorkTimer = null;
    /** The next stop as planned during this one's release (upcomingViews), reused by startStop when it matches. */
    var nextPlan = null;
    var lastError = null;
    /** Test-only render switches (protocol.js RENDER_FLAG_SPEC; {} = the normal look). */
    var renderFlags = {};
    /** Shadow images made for this wall (wallrender.js), by kind and size: { url }. */
    var shadowImages = {};
    /** Shadows fell back to live CSS blurs for this wall (no 2D canvas). */
    var shadowsLive = false;
    /** Moulding textures of every level for this wall's frames, held so a level switch never draws an empty band. */
    var lodPreload = [];
    /** The still view the layers and frame levels were last planned for (diagnostics). */
    var renderPlan = { layers: 0, lods: {}, plannedAtMs: null, views: 0 };
    /**
     * Spotlight overlays (walltour.js "Spotlight") by tour position, at most two (the stop on screen and the next):
     * { position, img, plan, strength }. Each is one small mask image in front of the wall, its own layer, shown only
     * from the camera's arrival on (never during a glide), faded by opacity and moved with the close-up.
     */
    var spots = {};

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
      var original = renderFlags.coveringTile === "original";
      stage.classList.toggle("rf-covering-original", original);
      var tile = ((original ? COVERING_ORIGINAL_TILE_PT : COVERING_TILE_PT)[wall.skin] || 406) * L;
      var macro = COVERING_MACRO_PT * L;
      var res = renderFlags.coveringRes || 1;
      // Both patterns are anchored at wall point 0,0 whatever the overscan (sizes x res: see coveringRes below).
      var layerCss = function (size) {
        var s = size * res;
        return {
          size: px(s) + " " + px(s),
          position: px(((overscan - b.minX) * L * res) % s) + " " + px(((overscan - b.minY) * L * res) % s),
        };
      };
      var t = layerCss(tile);
      var m = layerCss(macro);
      covering.style.backgroundSize = original ? t.size : m.size + ", " + t.size;
      covering.style.backgroundPosition = original ? t.position : m.position + ", " + t.position;
      if (res !== 1) {
        // Test-only (coveringRes): the same covering laid out res times larger, scaled back by its own transform.
        covering.style.width = px((b.maxX - b.minX + 2 * overscan) * L * res);
        covering.style.height = px((b.maxY - b.minY + 2 * overscan) * L * res);
        covering.style.transformOrigin = "0 0";
        covering.style.transform = "scale(" + (1 / res).toFixed(5) + ")" + (renderFlags.coveringLayer === false ? "" : " translateZ(0)");
      } else {
        // Its own layer (default): a painting layer re-rastering never re-rasters the wallpaper under it.
        covering.style.transform = renderFlags.coveringLayer === false ? "" : "translateZ(0)";
      }
      piecesLayer.textContent = "";
      var uPx = L * WEBSITE_PX_PT;
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
        var shadow = el("div", "wp-shadow", node);
        applyShadow(shadow, p.frame === "canvas" ? "canvas" : "frame", p.w / WEBSITE_PX_PT, p.h / WEBSITE_PX_PT, uPx);
        var canvas = el("div", "wp-canvas", node);
        canvas.style.left = px((p.inner.x - p.x) * L);
        canvas.style.top = px((p.inner.y - p.y) * L);
        canvas.style.width = px(p.inner.w * L);
        canvas.style.height = px(p.inner.h * L);
        canvas.style.backgroundColor = p.mainColor;
        var img = el("img", null, canvas);
        img.alt = "";
        img.decoding = "async";
        var lip = el("div", "wp-lip", canvas);
        applyShadow(lip, Render.lipKind(p.frame), p.inner.w / WEBSITE_PX_PT, p.inner.h / WEBSITE_PX_PT, uPx);
        var frame = el("div", "wp-frame", node);
        frame.setAttribute("data-frame", p.frame);
        if (p.frame === "canvas") {
          var side = mix(p.mainColor, "#0b0a09", CANVAS_EDGE_SHARE);
          frame.style.borderColor = side + " " + side + " " + mix(p.mainColor, "#0b0a09", CANVAS_EDGE_SHARE * 0.67);
        }
        pieceEls[p.index] = { node: node, frame: frame, img: img, src: null, lod: null, layer: false, hold: false, rasterZoom: 0 };
        img.onerror = function () {
          // Main colour stays; the tour goes on.
          img.removeAttribute("src");
          lastError = "wall image " + p.id + " failed";
        };
      });
    }

    /** A data URL of shadow `kind` for a box of boxW x boxH u at pxPerU (made once per wall and size). */
    function shadowUrl(kind, boxW, boxH, pxPerU) {
      var key = kind + ":" + boxW + "x" + boxH + "@" + pxPerU;
      if (shadowImages[key]) return shadowImages[key].url;
      var url = alphaImageUrl(Render.shadowImage(kind, boxW, boxH, pxPerU));
      if (!url) return null; // no 2D canvas: applyShadow falls back to the CSS blurs
      shadowImages[key] = { url: url };
      return url;
    }

    /** A PNG data URL of black with alpha `image.alpha` ({ width, height, alpha }), or null without a 2D canvas. */
    function alphaImageUrl(image) {
      var canvasEl = document.createElement("canvas");
      canvasEl.width = image.width;
      canvasEl.height = image.height;
      var ctx = null;
      try {
        ctx = canvasEl.getContext("2d");
      } catch (e) {
        ctx = null;
      }
      if (!ctx) return null;
      var data = ctx.createImageData(image.width, image.height);
      for (var i = 0; i < image.alpha.length; i++) data.data[i * 4 + 3] = image.alpha[i];
      ctx.putImageData(data, 0, 0);
      var url = canvasEl.toDataURL("image/png");
      canvasEl.width = 0; // let the canvas memory go now
      return url;
    }

    /**
     * Draw shadow `kind` (wallrender.js SHADOW_SPECS) on `node`, whose box is boxW x boxH u (one u = uPx CSS px):
     * the element grows by the shadow's outset and draws the image in its border (nine slices of one shared image)
     * or as its background (an image of this size, for boxes too small for nine slices). Lips have no outset.
     */
    function applyShadow(node, kind, boxW, boxH, uPx) {
      if (shadowsLive) return;
      var o = Render.shadowOutset(kind);
      var inset = Render.SHADOW_SPECS[kind].inset;
      node.style.boxSizing = "border-box";
      node.style.left = px(-o.left * uPx);
      node.style.top = px(-o.top * uPx);
      node.style.width = px((boxW + o.left + o.right) * uPx);
      node.style.height = px((boxH + o.top + o.bottom) * uPx);
      var plan = Render.shadowPlan(kind, boxW, boxH);
      if (plan.mode === "nine") {
        var ppu = inset ? Render.PX_PER_U.inset : Render.PX_PER_U.outer;
        var sides = [o.top, o.right, o.bottom, o.left].map(function (v) { return v + plan.corner; });
        var nine = shadowUrl(kind, plan.refBox, plan.refBox, ppu);
        if (!nine) return useLiveShadows(node);
        node.style.borderWidth = sides.map(function (v) { return px(v * uPx); }).join(" ");
        node.style.borderImage = "url(" + nine + ") " +
          sides.map(function (v) { return v * ppu; }).join(" ") + " stretch";
      } else {
        // One image of this size (boxes rounded to whole u: shared by same-sized pieces, error under half a u).
        var each = inset ? Render.PX_PER_U.inset : Render.PX_PER_U.outerPerPiece;
        var own = shadowUrl(kind, Math.max(1, Math.round(boxW)), Math.max(1, Math.round(boxH)), each);
        if (!own) return useLiveShadows(node);
        node.style.backgroundImage = "url(" + own + ")";
        node.style.backgroundSize = "100% 100%";
      }
    }

    /** No 2D canvas on this device: the whole wall keeps the CSS blurs (the element back to its box). */
    function useLiveShadows(node) {
      shadowsLive = true;
      stage.classList.add("rf-css-shadows");
      node.removeAttribute("style");
    }

    /** Load every level of the moulding textures this wall uses (a switch then never shows an empty band). */
    function preloadFrameLevels() {
      lodPreload = [];
      var seen = {};
      var probe = el("div", "wp-frame");
      probe.style.display = "none";
      piecesLayer.appendChild(probe);
      tour.pieces.forEach(function (p) {
        if (seen[p.frame] || !Render.FRAME_SLICE_PCT[p.frame]) return;
        seen[p.frame] = true;
        probe.setAttribute("data-frame", p.frame);
        Render.FRAME_LOD_LEVELS.forEach(function (level) {
          if (level === 900) probe.removeAttribute("data-lod");
          else probe.setAttribute("data-lod", String(level));
          var m = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(probe).borderImageSource || "");
          if (!m) return;
          var img = new Image();
          img.src = m[1];
          if (img.decode) img.decode().catch(function () {});
          lodPreload.push(img);
        });
      });
      piecesLayer.removeChild(probe);
    }

    // ─── Layers and frame levels (planned while the camera is still) ───

    /**
     * The camera views from stop time `t` to the end of the next move: { now, next (where the camera will rest
     * next), path (cameras along that move) }. After the stop's last move, the next stop's first move (planned as
     * the tour will plan it when this stop ends).
     */
    function upcomingViews(t) {
      var now = Tour.cameraAt(stop, tour, t);
      var move = null;
      for (var i = 0; i < stop.segments.length; i++) {
        var seg = stop.segments[i];
        if (seg.move && seg.endMs > t + 1) {
          move = seg;
          break;
        }
      }
      if (!move && tour.order.length > 1) {
        var nextIndex = (stopIndex + 1) % tour.order.length;
        var slot = details[nextIndex];
        var request = {
          from: tour.stops[stopIndex], flow: "auto", seconds: settings.seconds, motion: settings.motion,
          natural: slot && slot.state === "ready" ? slot.natural : null,
        };
        var next = Tour.planStop(tour, nextIndex, request);
        // Kept for startStop: planning there costs main-thread time just as the next glide starts.
        nextPlan = { index: nextIndex, request: request, stop: next };
        for (var j = 0; j < next.segments.length; j++) {
          if (next.segments[j].move) {
            move = next.segments[j];
            break;
          }
        }
      }
      return { now: now, next: move ? move.to : now, path: move ? move.path || [] : [] };
    }

    /**
     * Give the paintings near the camera's coming path their own layer (and take it from the others), and pick
     * each visible frame's moulding level. Called while the camera is still (layer and texture changes re-raster).
     */
    function planRender(t) {
      if (!tour || !stop) return;
      var views = upcomingViews(t);
      var mode = renderFlags.pieceLayers || "near";
      var want = {};
      if (mode === "all") {
        tour.pieces.forEach(function (p) { want[p.index] = true; });
      } else if (mode === "near") {
        var list = [views.now, views.next].concat(views.path);
        var cap = renderFlags.maxPieceLayers != null ? renderFlags.maxPieceLayers : Render.MAX_PIECE_LAYERS;
        Render.pieceLayerPlan(tour.pieces, list, tour.screen, tour.layoutScale, cap).forEach(function (i) { want[i] = true; });
      }
      var layers = 0;
      var hold = renderFlags.layerHint !== "translateZ";
      tour.pieces.forEach(function (p) {
        var entry = pieceEls[p.index];
        var on = !!want[p.index];
        if (on !== entry.layer) {
          entry.layer = on;
          entry.node.classList.toggle("wp-layer", on);
        }
        if (on) layers++;
        // will-change layers keep the largest raster they had (rasterZoom: the closest camera they were seen at).
        // One shown now at a camera much further out than that is re-rastered now, while the camera rests
        // (will-change off for one plan), so its mouldings are not shrunk on screen; it holds again from the next.
        var seenNow = Render.viewShows(views.now, p, tour.screen, 0.1);
        var seenNext = Render.viewShows(views.next, p, tour.screen, 0.1);
        var wantHold = on && hold;
        if (wantHold && entry.hold && seenNow && entry.rasterZoom > views.now.zoom * WILL_CHANGE_RESET_RATIO) wantHold = false;
        if (wantHold !== entry.hold) {
          entry.hold = wantHold;
          entry.node.classList.toggle("wp-hold", wantHold);
          entry.rasterZoom = 0;
        }
        if (on) {
          if (seenNow) entry.rasterZoom = Math.max(entry.rasterZoom || 0, views.now.zoom);
          if (seenNext) entry.rasterZoom = Math.max(entry.rasterZoom || 0, views.next.zoom);
        }
      });
      var fixed = renderFlags.frameTex && renderFlags.frameTex !== "auto" ? Number(renderFlags.frameTex) : null;
      var counts = {};
      tour.pieces.forEach(function (p) {
        var entry = pieceEls[p.index];
        var level = entry.lod;
        if (fixed) {
          level = fixed;
        } else {
          var seenNow = Render.viewShows(views.now, p, tour.screen, 0.1);
          var seenNext = Render.viewShows(views.next, p, tour.screen, 0.1);
          if (seenNow || seenNext) {
            var band = p.drawnBand * tour.dpr;
            var bandNow = band * (seenNow ? views.now.zoom : views.next.zoom);
            var bandNext = seenNext ? band * views.next.zoom : 0;
            level = Render.frameLod(p.frame, bandNow, bandNext, entry.lod);
          }
        }
        if (level && level !== entry.lod) {
          entry.lod = level;
          if (level === 900) entry.frame.removeAttribute("data-lod");
          else entry.frame.setAttribute("data-lod", String(level));
        }
        if (entry.lod) counts[entry.lod] = (counts[entry.lod] || 0) + 1;
      });
      renderPlan = { layers: layers, lods: counts, plannedAtMs: Math.round(t), views: 2 + views.path.length };
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
          entry.sharp = null;
          entry.img.removeAttribute("src");
        }
      });
    }

    // ─── Detail images (at most two decoded: the stop on screen and the next) ───

    function detailFor(position) {
      var kept = details[position];
      if (kept && kept.retiring) {
        kept.retiring = false; // wanted again (PREVIOUS)
        if (kept.wrapper) kept.wrapper.style.visibility = "";
      }
      if (kept) return kept;
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

    /** Hide a detail image without freeing it yet (stillWork frees it). */
    function retireDetail(slot) {
      slot.retiring = true;
      if (slot.wrapper) slot.wrapper.style.visibility = "hidden";
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
        // Only the image just left may still be fading; any other goes now. The stop just finished's image (faded
        // out during its release) goes once the camera rests again (stillWork): freeing it right as the glide starts
        // costs a frame. It counts as one of the two until then: the next one is asked for at the hold.
        if (details[k].fading && details[k] === fadingSlot) fadingOther = true;
        else if (renderFlags.detailTiming !== "early" && k === (position - 1 + tour.order.length) % tour.order.length && !details[k].retiring) retireDetail(details[k]);
        else releaseDetail(details[k]);
      });
      var current = detailFor(position);
      // Default: the next stop's image is fetched and decoded during this stop's hold (sync), never while the
      // camera moves. detailTiming "early" (test-only): at once, as before 2.9.0's rendering fixes.
      if (!fadingOther && (renderFlags.detailTiming === "early" || details[next])) detailFor(next);
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
      // Laid out at the image's own pixel size and scaled down to the painting, so the layer is rastered at the
      // image's resolution while the camera moves (Chrome caps an animated layer's raster at ~1920 x 1920 of its
      // own layout pixels). RENDER_FLAGS detailRes false: at the painting's size, as before.
      var res = renderFlags.detailRes !== false && slot.natural ? Math.max(1, slot.natural.width / (piece.inner.w * L)) : 1;
      box.style.width = px(piece.inner.w * L * res);
      box.style.height = px(piece.inner.h * L * res);
      box.style.transformOrigin = "0 0";
      box.style.transform = res > 1 ? "scale(" + (1 / res).toFixed(6) + ")" : "";
      if (slot.img.parentNode !== box) box.appendChild(slot.img);
      if (box.parentNode !== detailLayer) detailLayer.appendChild(box);
    }

    function detailShown(slot) {
      return !!slot && slot.state === "ready" && !!slot.wrapper && slot.wrapper.parentNode === detailLayer;
    }

    /**
     * Place the detail image only once the camera rests at its painting (default): placing it earlier rasters and
     * uploads the large image while the camera glides (a stutter at the move's start). detailTiming "early" places it
     * at once, as before.
     */
    function mayPlaceDetail(t) {
      if (renderFlags.detailTiming === "early") return true;
      if (!stop || t < stop.arrivalMs - 1) return false;
      var seg = Tour.segmentAt(stop, t);
      return !seg.move && t >= Math.min(seg.startMs + STILL_WORK_DELAY_MS, seg.endMs) - 5;
    }

    /** A detail image finished loading: show it if its stop is on screen (re-planning the close-up if needed). */
    function detailArrived(slot) {
      if (!stop || slot.position !== stopIndex) return;
      var t = clockTime();
      if (!mayPlaceDetail(t)) return; // sync places it when the camera rests
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

    // ─── Spotlight (walltour.js "Spotlight") ───

    function spotlightOn() {
      return renderFlags.spotlight !== false;
    }

    function spotlightStrength() {
      return renderFlags.spotlightStrength != null ? renderFlags.spotlightStrength : Tour.SPOTLIGHT_STRENGTH;
    }

    /** The spotlight overlay of tour position `position`, made now if needed (a small image: a few ms). */
    function spotFor(position) {
      var strength = spotlightStrength();
      var kept = spots[position];
      if (kept && kept.strength === strength) return kept;
      if (kept) releaseSpot(kept);
      var plan = Tour.spotlightPlan(tour, position);
      var url = alphaImageUrl(Render.spotlightMask(plan.rect, plan.overlay, plan.feather, strength));
      if (!url) return null;
      var img = el("img", "wall-spot");
      img.alt = "";
      img.style.width = px(plan.overlay.w);
      img.style.height = px(plan.overlay.h);
      img.style.transform = Tour.transformString(Tour.spotlightTransform(tour.stops[position], tour.stops[position], tour, plan.overlay));
      img.src = url;
      stage.insertBefore(img, light);
      var slot = { position: position, img: img, plan: plan, strength: strength };
      spots[position] = slot;
      return slot;
    }

    function releaseSpot(slot) {
      if (slot.img.parentNode) slot.img.parentNode.removeChild(slot.img);
      slot.img.removeAttribute("src");
      if (spots[slot.position] === slot) delete spots[slot.position];
    }

    /** Hide every overlay and keep only those of `position` and the next stop. */
    function manageSpots(position) {
      var next = (position + 1) % tour.order.length;
      Object.keys(spots).forEach(function (key) {
        var slot = spots[key];
        slot.img.style.visibility = "";
        if (slot.position !== position && slot.position !== next) releaseSpot(slot);
      });
    }

    /** The stop on screen's overlay, if it is showing. */
    function shownSpot() {
      var slot = spots[stopIndex];
      return slot && anims && anims.spotFade && anims.spotFade.spot === slot ? slot : null;
    }

    /** From the camera's arrival on: show the stop's overlay (fade from the stop's clock, placed for time `t`). */
    function attachSpot(t) {
      if (!anims || !stop || shownSpot() || !spotlightOn() || t < stop.arrivalMs - 1) return;
      var slot = spotFor(stopIndex);
      if (!slot) return;
      if (anims.spotFade) anims.spotFade.cancel();
      var fade = slot.img.animate(Tour.windowKeyframes(stop, stop.windows.spotlight, 0, 1), { duration: stop.durationMs, fill: "forwards" });
      fade.spot = slot;
      fade.currentTime = t;
      if (frozen()) fade.pause();
      anims.spotFade = fade;
      slot.img.style.visibility = "visible";
      placeSpot(t);
    }

    /** Keep the shown overlay on the painting: static during holds, moving with the camera during the close-up. */
    function placeSpot(t) {
      var slot = shownSpot();
      if (!slot) return;
      var seg = Tour.segmentAt(stop, t);
      var stopCam = tour.stops[stopIndex];
      var overlay = slot.plan.overlay;
      if (!seg.move) {
        slot.img.style.transform = Tour.transformString(Tour.spotlightTransform(seg.from, stopCam, tour, overlay));
        if (anims.spotMove) {
          anims.spotMove.cancel();
          anims.spotMove = null;
        }
        return;
      }
      if (!anims.spotMove || anims.spotMove.segment !== seg) {
        if (anims.spotMove) anims.spotMove.cancel();
        var move = slot.img.animate(Tour.spotlightKeyframes(seg, stopCam, tour, overlay), { duration: seg.endMs - seg.startMs, easing: seg.easing, fill: "forwards" });
        move.segment = seg;
        anims.spotMove = move;
      }
      anims.spotMove.currentTime = t - seg.startMs;
      if (frozen()) anims.spotMove.pause();
      else anims.spotMove.play();
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
      clearTimeout(stillWorkTimer);
      if (!anims) return;
      clearTimeout(anims.timer);
      cancelAll([anims.clock, anims.caption, anims.title, anims.light, anims.detail, anims.move, anims.spotFade, anims.spotMove]);
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
        // The next stop's image waited for this one to go (manageDetails; by default sync asks at the hold).
        if (renderFlags.detailTiming === "early") detailFor((stopIndex + 1) % tour.order.length);
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
      manageSpots(position);
      stopRequest = { from: from, flow: flow, leadInMs: leadIn, seconds: settings.seconds, motion: settings.motion, natural: slot.state === "ready" ? slot.natural : null };
      closeUpDropped = false;
      var cached = nextPlan;
      nextPlan = null;
      var same = cached && cached.index === position && flow === "auto" && cached.request.from === from &&
        cached.request.seconds === stopRequest.seconds && cached.request.motion === stopRequest.motion &&
        JSON.stringify(cached.request.natural) === JSON.stringify(stopRequest.natural) && !leadIn;
      stop = same ? cached.stop : Tour.planStop(tour, position, stopRequest);
      applyImagePlan(stop, 0);
      plannedSegment = stop.segments[0];

      var piece = tour.pieces[stop.pieceIndex];
      captionTitle.textContent = cleanTitle(piece.title);
      captionByline.textContent = [piece.artist, piece.date].filter(Boolean).join(" · ");
      caption.classList.toggle("label-right", position % 2 === 1);
      caption.style.marginBottom = ((position * 7) % 5) * 0.3 + "vh";
      titleText.textContent = (wall.sourceName || "My wall") + " · " + tour.order.length + (tour.order.length === 1 ? " artwork" : " artworks");

      var timing = { duration: stop.durationMs, fill: "forwards" };
      anims = { timer: null, move: null, detail: null, spotFade: null, spotMove: null };
      anims.clock = clockEl.animate([{ visibility: "visible" }, { visibility: "visible" }], timing);
      anims.clock.onfinish = function () {
        if (token === stopToken) advance();
      };
      pauseAtArrival = paused && flow === "jump";
      rebuildWindows(0);
      if (slot.state === "ready" && mayPlaceDetail(0)) attachDetailToStop(slot, 0);
      if (frozen()) pauseAll();
      renderSegment = null;
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
      var spot = shownSpot();
      if (spot) {
        anims.spotFade.cancel();
        anims.spotFade = null;
        spot.img.style.visibility = "";
        attachSpot(t);
      }
    }

    function windowAnimations() {
      return [anims.clock, anims.caption, anims.title, anims.light, anims.detail, anims.spotFade];
    }

    function pauseAll() {
      windowAnimations().forEach(function (a) {
        if (a) a.pause();
      });
      if (anims.move) anims.move.pause();
      if (anims.spotMove) anims.spotMove.pause();
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
      if (seg !== renderSegment) {
        renderSegment = seg;
        clearTimeout(stillWorkTimer);
        // Layers and frame levels change only while the camera rests (or as a stop starts: a NEXT / PREVIOUS jump,
        // the first stop; for the tour moving on, the plan made during the last stop's release still holds).
        if (seg.move && seg.startMs === 0) planRender(t);
        if (!seg.move) {
          var due = Math.min(seg.startMs + STILL_WORK_DELAY_MS, seg.endMs - 1) - t;
          if (due <= 0 || frozen()) stillWork(seg);
          else stillWorkTimer = setTimeout(function () { stillWork(seg); }, due);
        }
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
      // The spotlight from the arrival on: shown by stillWork once the camera rests (or at once when paused, e.g. a
      // SEEK), then kept on the painting here.
      if (t >= stop.arrivalMs - 1) {
        if (still) attachSpot(t);
        placeSpot(t);
      }
      if (!still) {
        var next = pauseAtArrival && t < stop.arrivalMs ? Math.min(seg.endMs, stop.arrivalMs) : seg.endMs;
        anims.timer = setTimeout(sync, Math.max(0, next - t) + 5);
      }
    }

    /** While the camera rests in `seg`: layers and frame levels, the detail image, the next stop's image. */
    function stillWork(seg) {
      if (!anims || !stop || renderSegment !== seg) return;
      var t = Math.max(clockTime(), seg.startMs);
      Object.keys(details).forEach(function (k) {
        if (details[k].retiring) releaseDetail(details[k]);
      });
      planRender(t);
      if (t < stop.arrivalMs - 1) return;
      var here = details[stopIndex];
      if (here && here.state === "ready" && !detailShown(here) && renderFlags.detailTiming !== "early") attachDetailToStop(here, clockTime());
      attachSpot(clockTime());
      // The next stop's image: fetched and decoded while the camera holds still (the 2-image cap holds).
      if ((seg.name === "hold" || seg.name === "release") && tour.order.length > 1) {
        var nextPos = (stopIndex + 1) % tour.order.length;
        if (!details[nextPos] && !fadingSlot) detailFor(nextPos);
        if (spotlightOn() && !spots[nextPos]) spotFor(nextPos);
        if (renderFlags.glideImage !== "wall") sharpenForGlide(tour.order[nextPos]);
      }
    }

    /**
     * The painting the camera glides to next shows its display image (~1320 px) instead of the small wall tier
     * (~660 px, about 2x upscaled at a stop) for the glide, until its own detail image fades in: sharp while moving.
     * Swapped while the camera rests, after decoding; the one before goes back to its wall tier (memory: two).
     */
    function sharpenForGlide(pieceIndex) {
      var keepIndex = tour.order[stopIndex];
      pieceEls.forEach(function (entry, i) {
        if (entry.sharp && i !== pieceIndex && i !== keepIndex) {
          entry.sharp = null;
          if (entry.src) entry.img.src = entry.src;
        }
      });
      var entry = pieceEls[pieceIndex];
      var url = tour.pieces[pieceIndex].fallbackImageUrl;
      if (!entry || !url || entry.sharp || !entry.src) return;
      var probe = new Image();
      entry.sharp = { url: url, img: probe };
      options.loadImage(probe, url).then(function () {
        if (entry.sharp && entry.sharp.img === probe && entry.src) entry.img.src = url;
      }, function () {
        if (entry.sharp && entry.sharp.img === probe) entry.sharp = null;
      });
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
        "rf-no-spotlight": renderFlags.spotlight === false,
        "rf-no-glass": renderFlags.glass === false,
        "rf-css-shadows": renderFlags.shadowStyle === "css" || shadowsLive,
      };
      for (var name in classes) stage.classList.toggle(name, classes[name]);
      camera.style.willChange = renderFlags.willChange ? "transform" : "";
      // Layer and frame-level switches apply at once (A/B stills on the TV at the same view).
      if (tour && stop && anims) planRender(clockTime());
      // The spotlight too: off, or remade at its new strength.
      var spot = shownSpot();
      if (spot && (!spotlightOn() || spot.strength !== spotlightStrength())) {
        cancelAll([anims.spotFade, anims.spotMove]);
        anims.spotFade = anims.spotMove = null;
      }
      Object.keys(spots).forEach(function (key) {
        if (!spotlightOn() || spots[key].strength !== spotlightStrength()) releaseSpot(spots[key]);
      });
      if (tour && stop && anims) attachSpot(clockTime());
    }

    // ─── Public ───

    function load(validatedWall, view, dpr, initialSettings) {
      destroyContent();
      wall = validatedWall;
      settings = { seconds: initialSettings.seconds, motion: initialSettings.motion };
      tour = Tour.planTour(wall, view, dpr);
      buildWall();
      preloadFrameLevels();
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
      Object.keys(spots).forEach(function (k) { releaseSpot(spots[k]); });
      spots = {};
      pieceEls.forEach(function (entry) {
        entry.img.onerror = null;
        entry.img.removeAttribute("src");
      });
      pieceEls = [];
      piecesLayer.textContent = "";
      detailLayer.textContent = "";
      shadowImages = {};
      nextPlan = null;
      shadowsLive = false;
      stage.classList.toggle("rf-css-shadows", renderFlags.shadowStyle === "css");
      lodPreload = [];
      renderSegment = null;
      renderPlan = { layers: 0, lods: {}, plannedAtMs: null, views: 0 };
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
        // Paintings with their own layer now, and how many frames use each moulding level (wallrender.js).
        render: renderPlan,
        spotlight: {
          on: spotlightOn(),
          strength: spotlightStrength(),
          shown: !!shownSpot(),
          opacity: stop && stop.windows.spotlight ? round(Tour.windowOpacityAt(stop.windows.spotlight, t, 0, 1), 3) : 0,
          rect: shownSpot()
            ? { x0: round(shownSpot().plan.rect.x0, 1), y0: round(shownSpot().plan.rect.y0, 1), x1: round(shownSpot().plan.rect.x1, 1), y1: round(shownSpot().plan.rect.y1, 1) }
            : null,
          held: Object.keys(spots).length,
        },
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
