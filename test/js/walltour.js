/**
 * KULTURA Cast Receiver — the wall tour planner (pure functions, no DOM). Receiver 2.9.0.
 *
 * Loaded by the TV page as a plain script (window.KulturaWallTour, after motion.js) and by Jest through
 * module.exports. wallview.js draws what this plans; docs/design/2026-10-12-wall-on-tv.md is the design.
 *
 * The tour (wall mode): it opens on the whole wall, then visits the paintings in reading order (rows top to
 * bottom, left to right). Each visit is one STOP: the camera glides to the painting until it takes most of the
 * screen, composed so that each neighbour shows only as a hint (its frame and a strip of its painting about twice
 * the frame's thickness) or not at all, never as a sliver (composeStopCamera), the large (detail) image cross-fades in
 * over it, then (motion "gentle") one slow move into its detail (the slideshow's choice of subject and its
 * sharpness limits, motion.js; deeper and a little quicker than the slideshow, see CLOSE_UP_COMPOSITION_CAP), a hold with the label, a pull back, and the detail image fades out
 * before the camera leaves. At a change of row the camera first pulls back to show that stretch of wall; after
 * the last painting it returns to the whole wall and the tour loops.
 *
 * Coordinates:
 *  - wall points: the phone's wall layout, 1000 wide (LOAD_WALL). Pieces are outer boxes (frame included),
 *    top-left corner.
 *  - camera { cx, cy, zoom }: the wall point at the screen centre, and CSS px per wall point.
 *  - the page lays the wall out at `layoutScale` CSS px per wall point and moves it with ONE transform,
 *    `translate(tx px, ty px) scale(k)` with transform-origin 0 0 (transformOf).
 *  - a move between two cameras follows the smooth zoom-and-pan path of van Wijk & Nuij (2003): long jumps
 *    rise (zoom out) mid-flight and land again, short ones barely do; zoom changes feel even (logarithmic).
 *
 * A stop's clock: the arrival (glide, or the opening / row pull-back sequence) then the dwell at the painting.
 * A plain stop lasts exactly secondsPerArtwork (at least MIN_WALL_STOP_MS): the dwell is that minus
 * GLIDE_NOMINAL_MS. Longer arrivals (the opening, row pull-backs, long jumps) lengthen their stop.
 */
(function (root) {
  "use strict";

  var Motion = typeof module !== "undefined" && module.exports ? require("./motion.js") : root.KulturaMotion;

  // ─── Stop composition (Yarden, 2026-10-13, M3.1: "the painting takes most of the screen, the others only hints") ───
  // At a stop the painting DOMINATES: as large as its frame allows (fully inside the screen with a small margin), and
  // never smaller than STOP_SHARE_MIN of the binding screen side. Each neighbour (left and right in its row; above and
  // below: in the row above / below, the painting overlapping it horizontally whose centre is nearest) shows only as a
  // HINT: its frame plus a strip of its painting about twice the frame's thickness ("5 cm frame + 10 cm of painting"),
  // i.e. the view reaches HINT_BAND_MULTIPLE frame bands past the neighbour's near edge, measured across the shared
  // edge (sides: horizontally; above / below: vertically). A neighbour that cannot be shown as a hint is left out of
  // shot, never a sliver; neither is any other painting. composeStopCamera searches a bounded grid of zooms and offsets
  // for the camera of least cost (the costs below). Replaces the 52-70 % range and its "10-20 % glimpses" (too far out
  // on the Sony: a small painting in the middle with a third of a neighbour beside it).
  /**
   * The painting's frame keeps at least this share of each screen side clear of the screen's edge (~14 / 24 px;
   * judging round 2: tall paintings read as small, 3.5 % gave away dominance).
   */
  var STOP_FRAME_MARGIN_SHARE = 0.025;
  /** So the painting fills at most this share of the binding screen side (the plain stop shot, stopCamera)... */
  var STOP_SHARE_MAX = 1 - 2 * STOP_FRAME_MARGIN_SHARE;
  /** ...and the camera never zooms out beyond this share to catch a hint: the painting keeps most of the screen. */
  var STOP_SHARE_MIN = 0.72;
  /**
   * The painting may sit off centre by up to this share of the screen (per axis), to turn a neighbour into a hint or
   * put it out of shot (an end-of-row painting beside a close neighbour).
   */
  var STOP_MAX_OFFSET_SHARE = 0.07;
  /** A hint reaches this many of the neighbour's frame bands past its near edge: the frame plus twice its thickness. */
  var HINT_BAND_MULTIPLE = 3;
  /**
   * Frameless canvases (their band is the ~1 cm side edge) and thin frames: a hint is at least this share of the screen
   * side, a small fixed strip (~62 px across, ~35 px up and down on the 960 x 540 page; judging round 1: 4.5 % read
   * as a thread).
   */
  var HINT_MIN_SCREEN_SHARE = 0.065;
  /**
   * A hint may be this much shallower or deeper than its target and still read as one (2.55-4.2 bands for a frame;
   * judging round 1: at 2 bands a dark painting's strip read as frame only, a sliver).
   */
  var HINT_MIN_RATIO = 0.85;
  var HINT_MAX_RATIO = 1.4;
  /** Costs (the search minimises their sum). A neighbour left out of shot costs this much... */
  var HINT_MISSING_COST = 1;
  /** ...less than a hint (part of its frame, or frame and a thread of painting) far more: it reads as an accident. */
  var HINT_SLIVER_COST = 5;
  /** Inside the hint range: this much per (relative distance from the target)^2 (at most ~0.13). */
  var HINT_DEVIATION_COST = 0.5;
  /**
   * More than a hint (a portrait painting on a wide screen often must): this much, plus HINT_WIDE_LINEAR_COST per
   * screen share beyond the hint range, plus HINT_WIDE_SQUARE_COST times its square. Nearly flat on purpose (judging
   * round 1): shifting the painting off centre to show a neighbour that stays too big a little less only made the
   * shot lopsided (empty wall on one side, a big neighbour on the other); the painting stays centred instead.
   */
  var HINT_WIDE_COST = 0.5;
  var HINT_WIDE_LINEAR_COST = 0.5;
  var HINT_WIDE_SQUARE_COST = 1;
  /** Any painting (not the stop's own) that shows as a sliver on either axis while in view costs this much. */
  var OTHER_SLIVER_COST = 3;
  /**
   * Any painting that is not a neighbour and shows cut (a strip, not whole) costs this much (judging round 2: frame
   * bands of the rows above and below peeking in at the top or bottom read as clutter); a little, so the search
   * keeps them out when the composition allows.
   */
  var OTHER_FRAGMENT_COST = 0.25;
  /** Zooming out from STOP_SHARE_MAX to STOP_SHARE_MIN costs this much (linear in log zoom): dominance first. */
  var STOP_ZOOM_COST = 1;
  /** Leaving the centre costs this much per (offset / STOP_MAX_OFFSET_SHARE)^2. */
  var STOP_OFFSET_COST = 0.3;
  /**
   * Search grid: zoom steps from STOP_SHARE_MAX down to STOP_SHARE_MIN (log spaced, ~2 % apart), offset steps across
   * the allowed range per axis, plus the exact centres that put each neighbour at its target hint or just out of shot.
   */
  var STOP_ZOOM_STEPS = 16;
  var STOP_OFFSET_STEPS = 21;
  /** Opening shot: the paintings' bounding box plus this share of its size on every side fits the screen. */
  var OVERVIEW_MARGIN = 0.06;
  /**
   * Real walls are tall (the phone's 12-painting wall is ~4.4x taller than wide): the whole wall on a 16:9 screen
   * is a thin strip of stamps. When the typical painting (median longer side) would be drawn smaller than this
   * many CSS px (13 % of the 540 px screen height), the tour opens instead on the TOP of the wall, as close as
   * this size needs (never closer than the wall's width), and the loop ends by pulling back on the last rows.
   */
  var OPENING_MIN_PAINTING_PX = 72;
  /** Row pull-back: the two rows (the one just seen and the next) plus this margin fit the screen. */
  var ROW_VIEW_MARGIN = 0.08;
  /** A row pull-back that would barely step back (its zoom above this share of the stops' zoom) is skipped. */
  var ROW_PULLBACK_MIN_RATIO = 0.8;
  /**
   * ...and so is one after a row of fewer paintings than this: on walls of one big painting per row (the phone's
   * 12-painting test wall has 9 rows) a pull-back at every stop would be a tic, not a pause.
   */
  var ROW_PULLBACK_MIN_PIECES = 2;
  /** Two boxes belong to the same row when they overlap vertically by at least this share of the shorter one. */
  var ROW_OVERLAP_SHARE = 0.5;
  /**
   * Frames stay visible at the opening: a moulding is drawn at least this many device px thick at the opening
   * zoom (thin walls of many rows shrink everything; the website keeps 2 px too).
   */
  var MIN_BAND_DEVICE_PX = 2;

  // ─── Timing (ms) ───
  /** One stop never lasts less than this in wall mode (a glide, a still look and the label need time). */
  var MIN_WALL_STOP_MS = 16000;
  /** The glide a plain stop is budgeted for; a stop's dwell is its length minus this. */
  var GLIDE_NOMINAL_MS = 3500;
  /**
   * Glide length from the path length S (van Wijk units: about one per screen of travel or per e-fold of zoom):
   * a neighbour ~3.3 s, overview to painting ~3.8 s, the far end of a long row ~5 s. Never a whip-pan.
   */
  var GLIDE_BASE_MS = 2600;
  var GLIDE_MS_PER_UNIT = 900;
  var GLIDE_MIN_MS = 3000;
  var GLIDE_MAX_MS = 5500;
  /** The return from the bottom of a tall wall to its top may take longer (it travels the whole wall). */
  var LONG_GLIDE_MAX_MS = 8000;
  /** Glides ease in and out symmetrically (a camera on a dolly). */
  var GLIDE_EASING = "cubic-bezier(0.45, 0, 0.55, 1)";
  /** How much a path rises (zooms out) mid-flight; van Wijk recommends ~1.4, a little flatter reads calmer on a wall. */
  var PATH_RHO = 1.3;
  /** The opening shot holds this long (title "<name> · N artworks"). */
  var OPENING_HOLD_MS = 7000;
  /** The row pull-back holds this long before gliding into the next row. */
  var ROW_HOLD_MS = 3000;
  /**
   * Tall walls: the loop's way back to the top rises to the whole wall and rests there this long, so the
   * viewer sees the whole wall once per loop and the middle of the wall never flies past close enough to show
   * that its far paintings carry only their colour (memory budget).
   */
  var WHOLE_WALL_HOLD_MS = 2500;
  /** NEXT / PREVIOUS while the detail image shows: it fades out this fast before the camera leaves. */
  var JUMP_FADE_MS = 400;
  /** At the stop, before the move into the detail: the detail image cross-fades in, the painting rests. */
  var SETTLE_MIN_MS = 1500;
  var DETAIL_FADE_IN_MS = 900;
  /** Back at the stop shot after the pull back: the detail image fades out, then the camera may leave. */
  var RELEASE_MS = 1200;
  var DETAIL_FADE_OUT_MS = 800;
  /** The hold on the detail: this share of the spare time, within these bounds (motion.js uses 8-30 s). */
  var MIN_DETAIL_HOLD_MS = 6000;
  var MAX_DETAIL_HOLD_MS = 30000;
  var DETAIL_HOLD_SHARE = 0.5;
  /** The move into the detail must zoom at least this much beyond the stop shot to be worth making. */
  var MIN_CLOSE_UP_ZOOM = 1.2;
  /**
   * The wall tour's close-up goes deeper and a little quicker than the ambient slideshow (motion.js: 1.5x the
   * whole painting, 5 %/s), because here it is the point: "zoom into parts of paintings" (Yarden, 2026-10-12).
   * At most this many times the whole painting contained on screen; the slideshow's sharpness limits still
   * apply (motion.js sharpZoomWithin), so a small detail image stops the move earlier.
   */
  var CLOSE_UP_COMPOSITION_CAP = 2.5;
  /** Fastest zoom speed of the close-up (ln(scale) per second at the easing's fastest point): a slow push-in. */
  var CLOSE_UP_MAX_ZOOM_RATE_PER_S = 0.12;
  /** The close-up eases in and out like the glides (a dolly push-in); that curve peaks at 1.82x its average speed. */
  var CLOSE_UP_EASING = GLIDE_EASING;
  var CLOSE_UP_EASING_PEAK_SPEED = 1.82;
  /**
   * The move in takes at most this share of the time at the painting, so the whole painting (sharp, before the
   * move) and the detail (after it) both get a real look, as the slideshow keeps 40 % for the whole painting.
   */
  var MAX_APPROACH_SHARE = 0.4;
  /**
   * The move in keeps the slideshow's calm speed limit (motion.js MAX_ZOOM_RATE_PER_S, 5 %/s at the fastest
   * point). The pull back may go this many times faster: it returns to a view already seen.
   */
  var PULL_BACK_RATE_FACTOR = 2;
  /** The label appears this long after the camera arrives, and fades in and out over CAPTION_FADE_MS. */
  var CAPTION_DELAY_MS = 1000;
  var CAPTION_FADE_MS = 800;
  /** The room light's vignette steps back to this opacity while the camera is close to a painting. */
  var LIGHT_CLOSE_OPACITY = 0.35;
  /** One keyframe per this many ms of a move (at least 8, at most 60): a smooth curve, a small message. */
  var KEYFRAME_STEP_MS = 100;

  // ─── Memory ───
  /**
   * Wall images (the small tier: 660 px portrait, 1320 px for wide paintings) are given only to paintings near
   * the camera: within this share of a screen around every view the current stop passes through (so ~1.5
   * screens across at a hold). The rest show their main colour until the tour comes near.
   */
  var IMAGE_REGION_MARGIN = 0.5;
  /** Paintings drawn smaller than this (CSS px, longer side) in a view do not need their image there. */
  var MIN_IMAGE_SCREEN_PX = 24;
  /**
   * And never more than this decoded (RGBA, 4 bytes per pixel), nearest first. The detail layer adds at most two
   * large images (~31 MB each at 3200 px).
   */
  var WALL_IMAGE_BUDGET_BYTES = 96 * 1024 * 1024;
  /** Assumed size of a wall image whose URL does not say (`{uuid}_{h}_{w}_80.webp`). */
  var DEFAULT_WALL_IMAGE_PX = 820;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /** { width, height } from a KULTURA resize file name `{uuid}_{h}_{w}_80.webp`, or null. */
  function imageSizeFromUrl(url) {
    var m = /_(\d+)_(\d+)_\d+\.(?:webp|jpe?g|png)(?:$|[?#])/.exec(String(url || ""));
    if (!m) return null;
    var h = Number(m[1]);
    var w = Number(m[2]);
    return w > 0 && h > 0 ? { width: w, height: h } : null;
  }

  // ─── Reading order ───

  /**
   * Rows top to bottom, left to right within a row. Boxes join a row when they overlap it vertically by at least
   * ROW_OVERLAP_SHARE of the shorter height (Snap walls are clean rows; Free walls get the nearest reading).
   * Returns { order: piece indices in tour order, rowOf: row number per tour position }.
   */
  function readingOrder(pieces) {
    var byTop = pieces.map(function (p, i) { return i; });
    byTop.sort(function (a, b) {
      return pieces[a].y - pieces[b].y || pieces[a].x - pieces[b].x;
    });
    var rows = [];
    byTop.forEach(function (i) {
      var p = pieces[i];
      var best = null;
      var bestShare = ROW_OVERLAP_SHARE;
      rows.forEach(function (row) {
        var overlap = Math.min(p.y + p.h, row.bottom) - Math.max(p.y, row.top);
        var share = overlap / Math.min(p.h, row.bottom - row.top);
        if (share >= bestShare) {
          best = row;
          bestShare = share;
        }
      });
      if (best) {
        best.members.push(i);
        best.top = Math.min(best.top, p.y);
        best.bottom = Math.max(best.bottom, p.y + p.h);
      } else {
        rows.push({ top: p.y, bottom: p.y + p.h, members: [i] });
      }
    });
    var centreY = function (row) {
      var sum = 0;
      row.members.forEach(function (i) { sum += pieces[i].y + pieces[i].h / 2; });
      return sum / row.members.length;
    };
    rows.sort(function (a, b) { return centreY(a) - centreY(b); });
    var order = [];
    var rowOf = [];
    rows.forEach(function (row, r) {
      row.members.sort(function (a, b) {
        return pieces[a].x + pieces[a].w / 2 - (pieces[b].x + pieces[b].w / 2);
      });
      row.members.forEach(function (i) {
        order.push(i);
        rowOf.push(r);
      });
    });
    return { order: order, rowOf: rowOf, rowCount: rows.length };
  }

  // ─── Cameras ───

  /** Camera that fits box { minX, minY, maxX, maxY } plus `margin` (share of its size per side). */
  function fitCamera(box, screen, margin) {
    var w = (box.maxX - box.minX) * (1 + 2 * margin);
    var h = (box.maxY - box.minY) * (1 + 2 * margin);
    return {
      cx: (box.minX + box.maxX) / 2,
      cy: (box.minY + box.maxY) / 2,
      zoom: Math.min(screen.width / Math.max(w, 1e-6), screen.height / Math.max(h, 1e-6)),
    };
  }

  function boxOf(pieces) {
    var box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    pieces.forEach(function (p) {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x + p.w);
      box.maxY = Math.max(box.maxY, p.y + p.h);
    });
    return box;
  }

  /**
   * The opening shot: the whole wall when its paintings stay legible there, else the top of the wall (its
   * whole width, as close as OPENING_MIN_PAINTING_PX needs). Never closer than the wall's whole width, so a
   * small cluster still opens on the wall, not on the cluster. `kind` is "whole" or "top".
   */
  function openingCamera(pieces, all, wallWidth, screen) {
    var whole = fitCamera(all, screen, OVERVIEW_MARGIN);
    var widthFit = screen.width / (wallWidth * (1 + 2 * OVERVIEW_MARGIN));
    whole.zoom = Math.min(whole.zoom, widthFit);
    var sizes = pieces.map(function (p) { return Math.max(p.w, p.h); }).sort(function (a, b) { return a - b; });
    var typical = sizes[Math.floor(sizes.length / 2)];
    whole.kind = "whole";
    if (typical * whole.zoom >= OPENING_MIN_PAINTING_PX) return whole;
    var zoom = clamp(OPENING_MIN_PAINTING_PX / typical, whole.zoom, widthFit);
    var visibleH = screen.height / zoom;
    return {
      cx: (all.minX + all.maxX) / 2,
      cy: all.minY - OVERVIEW_MARGIN * visibleH + visibleH / 2,
      zoom: zoom,
      kind: "top",
      whole: whole,
    };
  }

  /**
   * The plain stop shot: the painting centred, as large as its frame allows (STOP_SHARE_MAX of the binding screen
   * side). Without neighbours, composeStopCamera returns exactly this.
   */
  function stopCamera(piece, screen) {
    return {
      cx: piece.x + piece.w / 2,
      cy: piece.y + piece.h / 2,
      zoom: STOP_SHARE_MAX * Math.min(screen.width / piece.w, screen.height / piece.h),
    };
  }

  /** The painting's box inside its frame: the piece's `inner` when planTour made one, else from its band. */
  function paintingBox(p) {
    return p.inner || innerBox(p, bandOf(p));
  }

  /** A piece's frame band (wall points): the band planTour draws, else the one the phone sent. */
  function bandOf(p) {
    return p.drawnBand != null ? p.drawnBand : p.band || 0;
  }

  /**
   * How deep (wall points, across the shared edge) a hint of piece `q` should reach along `axis` ("x" | "y") at
   * camera `zoom`: HINT_BAND_MULTIPLE bands, at least HINT_MIN_SCREEN_SHARE of that screen side.
   */
  function hintTarget(q, axis, zoom, screen) {
    var side = axis === "x" ? screen.width : screen.height;
    return Math.max(HINT_BAND_MULTIPLE * bandOf(q), (HINT_MIN_SCREEN_SHARE * side) / zoom);
  }

  /**
   * How much of piece `q` a view spanning lo..hi (wall points along `axis`) shows, from the edge it enters by:
   * { kind, depth, target } where depth is the part of its outer box in view (wall points) and kind "none" (out of
   * view), "sliver" (in view, but under HINT_MIN_RATIO of its target hint), "hint" (within the hint range), "wide"
   * (deeper), or "whole" (all of it along this axis).
   */
  function extentOf(q, axis, lo, hi, zoom, screen) {
    var o0 = axis === "x" ? q.x : q.y;
    var size = axis === "x" ? q.w : q.h;
    var o1 = o0 + size;
    var target = hintTarget(q, axis, zoom, screen);
    var depth = Math.min(hi, o1) - Math.max(lo, o0);
    if (depth <= 1e-9) return { kind: "none", depth: 0, target: target };
    if (depth >= size - 1e-9) return { kind: "whole", depth: size, target: target };
    if (depth < HINT_MIN_RATIO * target) return { kind: "sliver", depth: depth, target: target };
    if (depth <= HINT_MAX_RATIO * target) return { kind: "hint", depth: depth, target: target };
    return { kind: "wide", depth: depth, target: target };
  }

  /**
   * How neighbour `n` on `side` ("left" | "right" | "above" | "below") of the stop camera `cam` shows, across the
   * shared edge: { kind, depth, target, px } (see extentOf; px is the depth in CSS px). A whole neighbour small enough
   * to fit in the hint range counts as a hint.
   */
  function hintOf(cam, n, side, screen) {
    var axis = side === "left" || side === "right" ? "x" : "y";
    var half = (axis === "x" ? screen.width : screen.height) / 2 / cam.zoom;
    var c = axis === "x" ? cam.cx : cam.cy;
    var e = extentOf(n, axis, c - half, c + half, cam.zoom, screen);
    if (e.kind === "whole") e.kind = e.depth <= HINT_MAX_RATIO * e.target ? "hint" : "wide";
    e.px = e.depth * cam.zoom;
    return e;
  }

  /** Cost of how one neighbour shows (0 on target; see the HINT_* costs). */
  function hintCost(h, zoom, screenSide) {
    if (h.kind === "none") return HINT_MISSING_COST;
    if (h.kind === "sliver") return HINT_SLIVER_COST;
    if (h.kind === "hint") {
      var deviation = (h.depth - h.target) / h.target;
      return HINT_DEVIATION_COST * deviation * deviation;
    }
    var excess = ((h.depth - HINT_MAX_RATIO * h.target) * zoom) / screenSide;
    return HINT_WIDE_COST + HINT_WIDE_LINEAR_COST * excess + HINT_WIDE_SQUARE_COST * excess * excess;
  }

  /**
   * Neighbours of every piece: { left, right, above, below } (piece indices or null). Left and right: the next
   * painting in its row; above and below: in the row above / below, the painting overlapping it horizontally
   * whose centre is nearest its centre (none overlapping: none).
   */
  function stopNeighbours(pieces, reading) {
    var rows = [];
    reading.order.forEach(function (pieceIndex, position) {
      var r = reading.rowOf[position];
      (rows[r] = rows[r] || []).push(pieceIndex);
    });
    var result = [];
    function nearestOverlapping(p, row) {
      if (!row) return null;
      var best = null;
      var bestDistance = Infinity;
      var centre = p.x + p.w / 2;
      row.forEach(function (j) {
        var q = pieces[j];
        if (Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) <= 0) return;
        var d = Math.abs(q.x + q.w / 2 - centre);
        if (d < bestDistance) {
          best = j;
          bestDistance = d;
        }
      });
      return best;
    }
    rows.forEach(function (row, r) {
      row.forEach(function (pieceIndex, k) {
        var p = pieces[pieceIndex];
        result[pieceIndex] = {
          left: k > 0 ? row[k - 1] : null,
          right: k < row.length - 1 ? row[k + 1] : null,
          above: nearestOverlapping(p, rows[r - 1]),
          below: nearestOverlapping(p, rows[r + 1]),
        };
      });
    });
    return result;
  }

  /**
   * The composed stop shot (Yarden, 2026-10-13, M3.1; see "Stop composition" above): the painting dominant (STOP_SHARE_MIN
   * ..STOP_SHARE_MAX of the binding screen side, its frame STOP_FRAME_MARGIN_SHARE clear of every edge, off centre by
   * at most STOP_MAX_OFFSET_SHARE per axis), each neighbour in `neighbours` ({ left, right, above, below }: pieces or
   * null) shown as a hint or out of shot, and no other painting in `others` (the wall's pieces; the stop's own is
   * skipped) cut to a sliver. Bounded search, deterministic, fast: per zoom (largest first) each axis is scored once
   * (a neighbour's hint depends on one axis only) and the axes' options are combined cheapest first, with only the
   * other paintings' slivers needing both; it stops as soon as the zoom cost alone exceeds the best found.
   */
  function composeStopCamera(piece, neighbours, screen, others) {
    var nb = neighbours || {};
    var zoomMax = STOP_SHARE_MAX * Math.min(screen.width / piece.w, screen.height / piece.h);
    var zoomMin = (zoomMax * STOP_SHARE_MIN) / STOP_SHARE_MAX;
    var pcx = piece.x + piece.w / 2;
    var pcy = piece.y + piece.h / 2;
    // Paintings that the widest view (least zoom, largest offset) can reach.
    var reachW = (screen.width * (0.5 + STOP_MAX_OFFSET_SHARE)) / zoomMin;
    var reachH = (screen.height * (0.5 + STOP_MAX_OFFSET_SHARE)) / zoomMin;
    var near = (others || []).filter(function (q) {
      return q !== piece && q.x < pcx + reachW && q.x + q.w > pcx - reachW && q.y < pcy + reachH && q.y + q.h > pcy - reachH;
    });
    // How each nearby painting shows is kept as bit sets (32 paintings per word): in view, a sliver, cut (a strip),
    // and which are the stop's neighbours (their strips are the hints).
    var words = Math.ceil(near.length / 32);
    var others = [];
    for (var w0 = 0; w0 < words; w0++) others.push(0);
    near.forEach(function (q, m) {
      if (q !== nb.left && q !== nb.right && q !== nb.above && q !== nb.below) others[m >> 5] |= 1 << (m & 31);
    });
    var best = null;
    for (var i = 0; i < STOP_ZOOM_STEPS; i++) {
      var step = i / (STOP_ZOOM_STEPS - 1);
      var zoom = zoomMax * Math.pow(zoomMin / zoomMax, step);
      var zoomCost = STOP_ZOOM_COST * step;
      if (best && zoomCost >= best.cost - 1e-9) break;
      var xs = axisOptions(zoom, "x", nb.left, "left", nb.right, "right");
      var ys = axisOptions(zoom, "y", nb.above, "above", nb.below, "below");
      for (var j = 0; j < xs.length; j++) {
        if (best && zoomCost + xs[j].cost + ys[0].cost >= best.cost - 1e-9) break;
        for (var k = 0; k < ys.length; k++) {
          var cost = zoomCost + xs[j].cost + ys[k].cost;
          if (best && cost >= best.cost - 1e-9) break;
          // Paintings in view on both axes and a sliver on either: accidental strips of frame or painting.
          for (var word = 0; word < words; word++) {
            var slivers = (xs[j].sliver[word] & ys[k].inView[word]) | (ys[k].sliver[word] & xs[j].inView[word]);
            var cut = ((xs[j].cut[word] & ys[k].inView[word]) | (ys[k].cut[word] & xs[j].inView[word])) & ~slivers & others[word];
            cost += OTHER_SLIVER_COST * bitCount(slivers) + OTHER_FRAGMENT_COST * bitCount(cut);
          }
          if (!best || cost < best.cost - 1e-9) best = { cost: cost, cam: { cx: xs[j].centre, cy: ys[k].centre, zoom: zoom } };
        }
      }
    }
    return best ? best.cam : stopCamera(piece, screen);

    // One axis at one zoom: the allowed camera centres (wall points), each with the cost of its offset and of the
    // neighbours before and after the painting, and how each nearby painting shows along this axis; cheapest first.
    function axisOptions(zoom, axis, before, beforeSide, after, afterSide) {
      var screenSide = axis === "x" ? screen.width : screen.height;
      var p0 = axis === "x" ? piece.x : piece.y;
      var size = axis === "x" ? piece.w : piece.h;
      var centre = p0 + size / 2;
      var half = screenSide / 2 / zoom;
      var margin = (STOP_FRAME_MARGIN_SHARE * screenSide) / zoom;
      var maxShift = (STOP_MAX_OFFSET_SHARE * screenSide) / zoom;
      // The frame stays `margin` inside both screen edges, the painting within maxShift of the centre.
      var lo = Math.max(p0 + size - half + margin, centre - maxShift);
      var hi = Math.min(p0 + half - margin, centre + maxShift);
      if (lo > hi) lo = hi = centre;
      var candidates = [centre];
      for (var s = 0; s < STOP_OFFSET_STEPS; s++) candidates.push(lo + ((hi - lo) * s) / (STOP_OFFSET_STEPS - 1));
      var axisScreen = { width: screen.width, height: screen.height };
      // The exact centres that put a neighbour at its target hint, or its near edge just at the screen's edge.
      if (before) {
        var beforeEdge = axis === "x" ? before.x + before.w : before.y + before.h;
        candidates.push(beforeEdge - hintTarget(before, axis, zoom, axisScreen) + half, beforeEdge + half);
      }
      if (after) {
        var afterEdge = axis === "x" ? after.x : after.y;
        candidates.push(afterEdge + hintTarget(after, axis, zoom, axisScreen) - half, afterEdge - half);
      }
      var options = [];
      var taken = {};
      candidates.forEach(function (raw) {
        var c = clamp(raw, lo, hi);
        var key = Math.round(c * 1e4);
        if (taken[key]) return;
        taken[key] = true;
        var offset = ((centre - c) * zoom) / screenSide;
        var cost = STOP_OFFSET_COST * Math.pow(offset / STOP_MAX_OFFSET_SHARE, 2);
        var cam = axis === "x" ? { cx: c, cy: 0, zoom: zoom } : { cx: 0, cy: c, zoom: zoom };
        if (before) cost += hintCost(hintOf(cam, before, beforeSide, screen), zoom, screenSide);
        if (after) cost += hintCost(hintOf(cam, after, afterSide, screen), zoom, screenSide);
        var inView = [];
        var sliver = [];
        var cut = [];
        for (var w = 0; w < words; w++) {
          inView.push(0);
          sliver.push(0);
          cut.push(0);
        }
        near.forEach(function (q, m) {
          var kind = extentOf(q, axis, c - half, c + half, zoom, screen).kind;
          if (kind !== "none") inView[m >> 5] |= 1 << (m & 31);
          if (kind === "sliver") sliver[m >> 5] |= 1 << (m & 31);
          if (kind === "hint" || kind === "wide") cut[m >> 5] |= 1 << (m & 31);
        });
        options.push({ cost: cost, centre: c, inView: inView, sliver: sliver, cut: cut });
      });
      options.sort(function (a, b) { return a.cost - b.cost || a.centre - b.centre; });
      return options;
    }
  }

  /** The number of set bits in a 32-bit word. */
  function bitCount(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  /** Where the painting itself (inside the moulding) sits: a canvas has its side edge right and below instead. */
  function innerBox(p, band) {
    if (p.frame === "canvas") return { x: p.x, y: p.y, w: p.w - 2 * band, h: p.h - 2 * band };
    return { x: p.x + band, y: p.y + band, w: p.w - 2 * band, h: p.h - 2 * band };
  }

  /** The image drawn to cover the inner box (object-fit: cover), centred on it, in wall points. */
  function imageRect(inner, natural) {
    var aspect = natural.width / natural.height;
    var w = Math.max(inner.w, inner.h * aspect);
    var h = Math.max(inner.h, inner.w / aspect);
    return { cx: inner.x + inner.w / 2, cy: inner.y + inner.h / 2, w: w, h: h };
  }

  /** Device px drawn per image px for a painting's image at camera `zoom` (above 1 the TV invents pixels). */
  function imageUpscale(piece, natural, zoom, dpr) {
    var rect = imageRect(piece.inner, natural);
    return (zoom * dpr * rect.w) / natural.width;
  }

  /**
   * Lay out the tour for a validated LOAD_WALL (protocol.js) on a screen { width, height } (CSS px) at `dpr`.
   * Returns the pieces (with drawn band and inner box), the tour order, the opening camera, one stop camera per
   * tour position, and the scale the page lays the wall out at.
   */
  function planTour(wall, screen, dpr) {
    var raw = wall.pieces;
    var reading = readingOrder(raw);
    var all = boxOf(raw);
    var surfaceW = wall.surface && wall.surface.w > 0 ? wall.surface.w : all.maxX - all.minX;
    var opening = openingCamera(raw, all, Math.max(surfaceW, all.maxX - all.minX), screen);
    var minBand = MIN_BAND_DEVICE_PX / (dpr * opening.zoom);
    var pieces = raw.map(function (p, i) {
      var band = Math.min(Math.max(p.band, minBand), Math.min(p.w, p.h) / 4);
      var piece = {};
      for (var key in p) {
        if (Object.prototype.hasOwnProperty.call(p, key)) piece[key] = p[key];
      }
      piece.index = i;
      piece.drawnBand = band;
      piece.inner = innerBox(p, band);
      return piece;
    });
    var neighbours = stopNeighbours(pieces, reading);
    var stops = reading.order.map(function (i) {
      var n = neighbours[i];
      var pick = function (j) { return j == null ? null : pieces[j]; };
      var around = { left: pick(n.left), right: pick(n.right), above: pick(n.above), below: pick(n.below) };
      return composeStopCamera(pieces[i], around, screen, pieces);
    });
    var zooms = stops.map(function (c) { return c.zoom; }).sort(function (a, b) { return a - b; });
    // Laid out at the typical stop zoom: the views the eye rests on most render at transform scale ~1.
    var layoutScale = Math.round(zooms[Math.floor(zooms.length / 2)] * 100) / 100 || 1;
    return {
      screen: { width: screen.width, height: screen.height },
      dpr: dpr,
      pieces: pieces,
      order: reading.order,
      rowOf: reading.rowOf,
      rowCount: reading.rowCount,
      opening: opening,
      stops: stops,
      layoutScale: layoutScale,
      bounds: all,
      neighbours: neighbours,
    };
  }

  /** The row pull-back between the row of tour position `index - 1` and that of `index`, or null to skip it. */
  function rowCamera(tour, index) {
    var finished = tour.rowOf[index - 1];
    var count = tour.rowOf.filter(function (r) { return r === finished; }).length;
    if (count < ROW_PULLBACK_MIN_PIECES) return null;
    var cam = rowsCamera(tour, tour.rowOf[index - 1], tour.rowOf[index]);
    var closest = Math.min(tour.stops[index - 1].zoom, tour.stops[index].zoom);
    return cam.zoom > ROW_PULLBACK_MIN_RATIO * closest ? null : cam;
  }

  /** The end of the loop on a tall wall: the last two rows, before the camera returns to the top. */
  function lastRowsCamera(tour) {
    var last = tour.rowCount - 1;
    return rowsCamera(tour, Math.max(0, last - 1), last);
  }

  /** A camera on rows `before` and `after` (row numbers) and nothing else. */
  function rowsCamera(tour, before, after) {
    var members = [];
    tour.order.forEach(function (pieceIndex, position) {
      var row = tour.rowOf[position];
      if (row === before || row === after) members.push(tour.pieces[pieceIndex]);
    });
    var cam = fitCamera(boxOf(members), tour.screen, ROW_VIEW_MARGIN);
    cam.zoom = Math.max(cam.zoom, tour.opening.zoom);
    return cam;
  }

  // ─── Paths ───

  /**
   * Smooth zoom-and-pan path between two cameras (van Wijk & Nuij 2003, as d3-interpolate's interpolateZoom).
   * Returns { length: S, at(f) } where f in 0..1 runs along the path at an even perceived speed.
   */
  function zoomPath(c0, c1, screenWidth) {
    var w0 = screenWidth / c0.zoom;
    var w1 = screenWidth / c1.zoom;
    var dx = c1.cx - c0.cx;
    var dy = c1.cy - c0.cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var rho = PATH_RHO;
    var rho2 = rho * rho;
    var at;
    var S;
    if (d < 1e-9 * Math.max(w0, w1) + 1e-9) {
      S = Math.abs(Math.log(w1 / w0)) / rho;
      at = function (f) {
        return { cx: c0.cx + dx * f, cy: c0.cy + dy * f, zoom: screenWidth / (w0 * Math.pow(w1 / w0, f)) };
      };
    } else {
      var b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d * d) / (2 * w0 * rho2 * d);
      var b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d * d) / (2 * w1 * rho2 * d);
      var r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
      var r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
      S = (r1 - r0) / rho;
      var coshR0 = Math.cosh(r0);
      var sinhR0 = Math.sinh(r0);
      at = function (f) {
        var s = f * S;
        var u = (w0 / (rho2 * d)) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0);
        var w = (w0 * coshR0) / Math.cosh(rho * s + r0);
        return { cx: c0.cx + u * dx, cy: c0.cy + u * dy, zoom: screenWidth / w };
      };
    }
    return {
      length: S,
      at: function (f) {
        if (f <= 0) return { cx: c0.cx, cy: c0.cy, zoom: c0.zoom };
        if (f >= 1) return { cx: c1.cx, cy: c1.cy, zoom: c1.zoom };
        return at(f);
      },
    };
  }

  /** How long a glide along a path of length S takes (at most `maxMs`, GLIDE_MAX_MS by default). */
  function glideMs(S, maxMs) {
    return Math.round(clamp(GLIDE_BASE_MS + GLIDE_MS_PER_UNIT * S, GLIDE_MIN_MS, maxMs || GLIDE_MAX_MS));
  }

  function sameCamera(a, b) {
    return Math.abs(a.cx - b.cx) < 1e-6 && Math.abs(a.cy - b.cy) < 1e-6 && Math.abs(a.zoom - b.zoom) < 1e-9;
  }

  // ─── Close-up (the move into the detail) ───

  /**
   * Where the close-up goes and how deep, for one painting whose detail image is `natural` px. Same subject
   * choice and sharpness limit as the slideshow (motion.js: points of interest, else the AI crop; at most 1.0,
   * or 1.1 when needed, device px per image px), never faster than its zoom speed limit in the time the stop has.
   * Returns { plan: "gentle" | "still", reason, zoom (camera zoom at the hold), relativeZoom (vs the stop shot),
   * camera, approachMs, returnMs, upscale (device px per image px at the hold) }.
   */
  function planCloseUp(tour, piece, stopCam, natural, motion, dwellMs) {
    var result = { plan: "still", reason: null, zoom: stopCam.zoom, relativeZoom: 1, camera: stopCam, approachMs: 0, returnMs: 0, upscale: null };
    var known = !!natural && natural.width > 0 && natural.height > 0;
    if (known) result.upscale = imageUpscale(piece, natural, stopCam.zoom, tour.dpr);
    if (motion === "still") return withReason(result, "setting");
    if (!piece.detailUrl && !piece.fallbackImageUrl) return withReason(result, "no-detail-image");
    if (!known) return withReason(result, "unknown-size");
    var view = tour.screen;
    var dpr = tour.dpr;
    var box = Motion.fitBox(natural, view);
    var rect = imageRect(piece.inner, natural);
    // Camera zoom at which the image is contained in the screen: motion.js's scale 1.
    var containZoom = box.width / rect.w;
    var cap;
    var poseAt;
    if (piece.poi && piece.poi.moveWorthy === false) return withReason(result, "not-move-worthy");
    if (piece.poi && piece.poi.points && piece.poi.points.length) {
      var chosen = Motion.choosePoiSubject(piece.poi.points, box, view, dpr, natural);
      var f = chosen.focus;
      cap = chosen.zoom;
      poseAt = function (scale) {
        return Motion.poseAtScreenY((f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2, Motion.POI_SCREEN_Y, scale, box, view);
      };
    } else if (Motion.isUsableFocus(piece.focus)) {
      var focus = piece.focus;
      var target = Motion.focusTarget(focus);
      cap = Motion.sharpZoomWithin(
        Math.min(CLOSE_UP_COMPOSITION_CAP, Motion.subjectZoomLimit(focus, box, view)), box, dpr, natural);
      poseAt = function (scale) {
        return Motion.keepStripHeadroom(focus, Motion.poseAt(target.x, target.y, scale, box, view), box, view);
      };
    } else {
      return withReason(result, "no-focus");
    }
    var deepest = cap * containZoom;
    // Time: the move in (calm speed) and back (PULL_BACK_RATE_FACTOR faster) fit between the shortest settle and
    // hold. (10 ms margin: minMoveMs rounds up.)
    var spare = dwellMs - RELEASE_MS - SETTLE_MIN_MS - MIN_DETAIL_HOLD_MS - 10;
    var approachMax = Math.min(spare / (1 + 1 / PULL_BACK_RATE_FACTOR), MAX_APPROACH_SHARE * dwellMs);
    var timeZoom = approachMax > 0
      ? stopCam.zoom * Math.exp((CLOSE_UP_MAX_ZOOM_RATE_PER_S * approachMax) / 1000 / CLOSE_UP_EASING_PEAK_SPEED)
      : stopCam.zoom;
    var zoom = Math.min(deepest, timeZoom);
    if (zoom / stopCam.zoom < MIN_CLOSE_UP_ZOOM) {
      result.relativeZoom = zoom / stopCam.zoom;
      return withReason(result, deepest / stopCam.zoom < MIN_CLOSE_UP_ZOOM ? "zoom-too-small" : "short-stop");
    }
    var pose = poseAt(zoom / containZoom);
    var approachMs = closeUpMoveMs(zoom / stopCam.zoom);
    result.plan = "gentle";
    result.reason = "ok";
    result.zoom = zoom;
    result.relativeZoom = zoom / stopCam.zoom;
    result.camera = { cx: rect.cx - pose.x / zoom, cy: rect.cy - pose.y / zoom, zoom: zoom };
    result.approachMs = approachMs;
    result.returnMs = Math.ceil(approachMs / PULL_BACK_RATE_FACTOR);
    result.upscale = imageUpscale(piece, natural, zoom, dpr);
    return result;
  }

  /** Shortest close-up move to `relativeZoom` that keeps its fastest point under CLOSE_UP_MAX_ZOOM_RATE_PER_S. */
  function closeUpMoveMs(relativeZoom) {
    return Math.ceil((CLOSE_UP_EASING_PEAK_SPEED * Math.log(relativeZoom) * 1000) / CLOSE_UP_MAX_ZOOM_RATE_PER_S);
  }

  function withReason(result, reason) {
    result.reason = reason;
    return result;
  }

  // ─── Stops ───

  /**
   * Plan stop `index` (tour position). Options:
   *   from:     camera the stop starts from (null: the page has just started, the camera is on the opening shot)
   *   flow:     "auto" (the tour moving on by itself: opening at index 0, row pull-backs) or "jump" (NEXT /
   *             PREVIOUS: straight there)
   *   leadInMs: hold before leaving (a jump waits for the detail image on screen to fade out)
   *   seconds:  secondsPerArtwork;  motion: "gentle" | "still";  natural: detail image size if known
   * Returns { index, pieceIndex, durationMs, segments, arrivalMs, closeUp, windows: { detail, caption, title, light } }.
   * Each segment: { name, startMs, endMs, from, to, move, easing, path } (path: cameras at even path steps).
   */
  function planStop(tour, index, o) {
    var pieceIndex = tour.order[index];
    var piece = tour.pieces[pieceIndex];
    var stopCam = tour.stops[index];
    var segments = [];
    var t = 0;
    var current = o.from || tour.opening;

    function hold(name, ms) {
      if (ms <= 0) return;
      segments.push({ name: name, startMs: t, endMs: t + ms, from: current, to: current, move: false });
      t += ms;
    }
    function glide(name, to, durationMs, easing, maxMs) {
      if (sameCamera(current, to)) return;
      var path = zoomPath(current, to, tour.screen.width);
      var ms = durationMs || glideMs(path.length, maxMs);
      segments.push({
        name: name,
        startMs: t,
        endMs: t + ms,
        from: current,
        to: to,
        move: true,
        easing: easing || GLIDE_EASING,
        path: samplePath(path, ms),
      });
      t += ms;
      current = to;
    }

    var titleWindow = null;
    if (o.flow === "jump") {
      hold("lead-in", o.leadInMs || 0);
      glide("glide", stopCam);
    } else if (index === 0) {
      if (o.from && tour.opening.kind === "top" && tour.rowCount > 1) {
        glide("row-out", lastRowsCamera(tour));
        hold("row", ROW_HOLD_MS);
        glide("to-whole", tour.opening.whole, 0, null, LONG_GLIDE_MAX_MS);
        hold("whole", WHOLE_WALL_HOLD_MS);
      }
      if (o.from) glide("to-overview", tour.opening, 0, null, LONG_GLIDE_MAX_MS);
      var openingStart = t;
      hold("opening", OPENING_HOLD_MS);
      titleWindow = { inMs: openingStart + 600, outMs: t - CAPTION_FADE_MS };
      glide("glide", stopCam);
    } else {
      var row = tour.rowOf[index] !== tour.rowOf[index - 1] ? rowCamera(tour, index) : null;
      if (row) {
        glide("row-out", row);
        hold("row", ROW_HOLD_MS);
      }
      glide("glide", stopCam);
    }
    var arrivalMs = t;

    var stopMs = Math.max(MIN_WALL_STOP_MS, (o.seconds || 0) * 1000);
    var dwellMs = stopMs - GLIDE_NOMINAL_MS;
    var natural = o.natural || imageSizeFromUrl(piece.detailUrl) || imageSizeFromUrl(piece.fallbackImageUrl);
    var closeUp = planCloseUp(tour, piece, stopCam, natural, o.motion, dwellMs);
    var captionOut;
    var lightDim = null;
    if (closeUp.plan === "gentle") {
      var rest = dwellMs - closeUp.approachMs - closeUp.returnMs - RELEASE_MS;
      var holdMs = Math.round(clamp(rest * DETAIL_HOLD_SHARE, MIN_DETAIL_HOLD_MS, MAX_DETAIL_HOLD_MS));
      hold("settle", rest - holdMs);
      var approachStart = t;
      glide("approach", closeUp.camera, closeUp.approachMs, CLOSE_UP_EASING);
      hold("hold", holdMs);
      var returnStart = t;
      glide("return", stopCam, closeUp.returnMs, CLOSE_UP_EASING);
      lightDim = { inMs: approachStart, inDurationMs: closeUp.approachMs, outMs: returnStart, outDurationMs: closeUp.returnMs };
      captionOut = returnStart - CAPTION_FADE_MS;
    } else {
      hold("settle", SETTLE_MIN_MS);
      hold("hold", dwellMs - SETTLE_MIN_MS - RELEASE_MS);
      captionOut = t - CAPTION_FADE_MS;
    }
    var releaseStart = t;
    hold("release", RELEASE_MS);
    return {
      index: index,
      pieceIndex: pieceIndex,
      pieceId: piece.id,
      durationMs: t,
      arrivalMs: arrivalMs,
      segments: segments,
      closeUp: closeUp,
      natural: natural || null,
      windows: {
        detail: { inMs: arrivalMs, inDurationMs: DETAIL_FADE_IN_MS, outMs: releaseStart, outDurationMs: DETAIL_FADE_OUT_MS },
        caption: { inMs: arrivalMs + CAPTION_DELAY_MS, inDurationMs: CAPTION_FADE_MS, outMs: captionOut, outDurationMs: CAPTION_FADE_MS },
        title: titleWindow && { inMs: titleWindow.inMs, inDurationMs: CAPTION_FADE_MS, outMs: titleWindow.outMs, outDurationMs: CAPTION_FADE_MS },
        light: lightDim,
      },
    };
  }

  /**
   * The same stop without the close-up (its detail image did not arrive in time, or failed): the camera stays
   * on the stop shot where it would have moved; every time stays as planned, so the clock does not jump.
   */
  function withoutCloseUp(stop, reason) {
    if (stop.closeUp.plan !== "gentle") return stop;
    var arrivalCam = stop.segments.filter(function (s) { return s.name === "settle"; })[0].from;
    var copy = {};
    for (var key in stop) {
      if (Object.prototype.hasOwnProperty.call(stop, key)) copy[key] = stop[key];
    }
    copy.segments = stop.segments.map(function (s) {
      if (s.startMs < stop.arrivalMs) return s;
      return { name: s.name, startMs: s.startMs, endMs: s.endMs, from: arrivalCam, to: arrivalCam, move: false };
    });
    copy.closeUp = { plan: "still", reason: reason, zoom: arrivalCam.zoom, relativeZoom: 1, camera: arrivalCam, approachMs: 0, returnMs: 0, upscale: stop.closeUp.upscale };
    copy.windows = {
      detail: stop.windows.detail,
      caption: stop.windows.caption,
      title: stop.windows.title,
      light: null,
    };
    return copy;
  }

  // ─── Transforms and keyframes ───

  /** The camera as the layer's transform: screen = (tx, ty) + k * layout px, k = zoom / layoutScale. */
  function transformOf(camera, tour) {
    return {
      tx: tour.screen.width / 2 - camera.zoom * camera.cx,
      ty: tour.screen.height / 2 - camera.zoom * camera.cy,
      k: camera.zoom / tour.layoutScale,
    };
  }

  function transformString(t) {
    return "translate(" + t.tx.toFixed(2) + "px, " + t.ty.toFixed(2) + "px) scale(" + t.k.toFixed(5) + ")";
  }

  function cameraTransform(camera, tour) {
    return transformString(transformOf(camera, tour));
  }

  function samplePath(path, durationMs) {
    var n = clamp(Math.round(durationMs / KEYFRAME_STEP_MS), 8, 60);
    var cams = [];
    for (var j = 0; j <= n; j++) cams.push(path.at(j / n));
    return cams;
  }

  /** Web Animation keyframes of a move segment (its easing goes on the animation, see segmentTiming). */
  function moveKeyframes(segment, tour) {
    var n = segment.path.length - 1;
    return segment.path.map(function (cam, j) {
      return { offset: j / n, transform: cameraTransform(cam, tour) };
    });
  }

  /** Parse "cubic-bezier(a, b, c, d)" into a function of progress (0..1), as the browser evaluates it. */
  function bezierEasing(easing) {
    var m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(easing || "");
    if (!m) return function (x) { return x; };
    var x1 = Number(m[1]);
    var y1 = Number(m[2]);
    var x2 = Number(m[3]);
    var y2 = Number(m[4]);
    var bez = function (a, b, u) {
      return 3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
    };
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var lo = 0;
      var hi = 1;
      for (var i = 0; i < 40; i++) {
        var mid = (lo + hi) / 2;
        if (bez(x1, x2, mid) < x) lo = mid;
        else hi = mid;
      }
      return bez(y1, y2, (lo + hi) / 2);
    };
  }

  function segmentAt(stop, timeMs) {
    var segs = stop.segments;
    for (var i = 0; i < segs.length; i++) {
      if (timeMs < segs[i].endMs) return segs[i];
    }
    return segs[segs.length - 1];
  }

  /**
   * The layer's transform at stop time `timeMs`, exactly as the browser draws it: eased progress, then straight
   * interpolation of translate and scale between neighbouring keyframes.
   */
  function transformAt(stop, tour, timeMs) {
    var seg = segmentAt(stop, timeMs);
    if (!seg.move) return transformOf(seg.from, tour);
    var x = clamp((timeMs - seg.startMs) / (seg.endMs - seg.startMs), 0, 1);
    var p = bezierEasing(seg.easing)(x);
    var n = seg.path.length - 1;
    var j = Math.min(n - 1, Math.floor(p * n));
    var local = p * n - j;
    var a = transformOf(seg.path[j], tour);
    var b = transformOf(seg.path[j + 1], tour);
    return { tx: a.tx + (b.tx - a.tx) * local, ty: a.ty + (b.ty - a.ty) * local, k: a.k + (b.k - a.k) * local };
  }

  /** The camera at stop time `timeMs` (inverse of transformOf). */
  function cameraAt(stop, tour, timeMs) {
    var t = transformAt(stop, tour, timeMs);
    var zoom = t.k * tour.layoutScale;
    return { cx: (tour.screen.width / 2 - t.tx) / zoom, cy: (tour.screen.height / 2 - t.ty) / zoom, zoom: zoom };
  }

  /**
   * Opacity keyframes over the whole stop for a window { inMs, inDurationMs, outMs, outDurationMs }: `low`
   * outside, `high` inside (null window: `low` throughout).
   */
  function windowKeyframes(stop, window, low, high) {
    var d = stop.durationMs;
    if (!window) return [{ offset: 0, opacity: low }, { offset: 1, opacity: low }];
    var at = function (ms) { return clamp(ms / d, 0, 1); };
    var a = at(window.inMs);
    var b = Math.max(a, at(window.inMs + window.inDurationMs));
    var c = Math.max(b, at(window.outMs));
    var e = Math.max(c, at(window.outMs + window.outDurationMs));
    return [
      { offset: 0, opacity: low },
      { offset: a, opacity: low },
      { offset: b, opacity: high },
      { offset: c, opacity: high },
      { offset: e, opacity: low },
      { offset: 1, opacity: low },
    ];
  }

  /** Opacity of a window at stop time `timeMs` (linear fades, as the keyframes). */
  function windowOpacityAt(window, timeMs, low, high) {
    if (!window) return low;
    if (timeMs < window.inMs || timeMs >= window.outMs + window.outDurationMs) return low;
    if (timeMs < window.inMs + window.inDurationMs) return low + ((high - low) * (timeMs - window.inMs)) / window.inDurationMs;
    if (timeMs < window.outMs) return high;
    return high - ((high - low) * (timeMs - window.outMs)) / window.outDurationMs;
  }

  function lightKeyframes(stop) {
    return windowKeyframes(stop, stop.windows.light, 1, LIGHT_CLOSE_OPACITY);
  }

  // ─── Wall images within the memory budget ───

  /** Decoded bytes of a wall image (RGBA), from its file name, else the default tier. */
  function wallImageBytes(piece) {
    var size = imageSizeFromUrl(piece.wallImageUrl) || { width: DEFAULT_WALL_IMAGE_PX, height: DEFAULT_WALL_IMAGE_PX };
    return size.width * size.height * 4;
  }

  /** The wall area a camera shows, grown by `margin` screens on every side. */
  function viewRect(cam, screen, margin) {
    var w = screen.width / cam.zoom;
    var h = screen.height / cam.zoom;
    return { minX: cam.cx - w * (0.5 + margin), maxX: cam.cx + w * (0.5 + margin), minY: cam.cy - h * (0.5 + margin), maxY: cam.cy + h * (0.5 + margin) };
  }

  /**
   * Which pieces get their wall image during `stop` from stop time `fromMs` on (0 by default; wallview.js asks
   * again at every segment start, so a long sequence such as the loop's return hands its images over as it
   * goes). Every view still ahead asks, the one on screen first, then where the camera will rest (in the
   * order it gets there), then what the glides fly through, for the paintings within IMAGE_REGION_MARGIN
   * screens of it (on screen first, then that margin) that it draws at least MIN_IMAGE_SCREEN_PX big, nearest
   * its centre first (views further out than the opening ask for nothing); they are granted in
   * that order until `budgetBytes` (WALL_IMAGE_BUDGET_BYTES by default) is spent. So what is on screen now
   * keeps its image, and what is only ever seen tiny shows its main colour. A wall whose images all fit the
   * budget skips this and keeps every image. Returns { pieceIndexes,
   * estimatedBytes, wanted }.
   */
  function wallImagePlan(tour, stop, budgetBytes, fromMs) {
    var budget = budgetBytes == null ? WALL_IMAGE_BUDGET_BYTES : budgetBytes;
    // A wall whose images all fit the budget keeps every one: nothing is ever shown as a colour block, and no
    // image is decoded twice (the phone sends the smallest tier, so a 48-painting wall is about 80 MB).
    var everyBytes = 0;
    tour.pieces.forEach(function (p) { everyBytes += wallImageBytes(p); });
    if (everyBytes <= budget) {
      return {
        pieceIndexes: tour.pieces.map(function (p) { return p.index; }),
        estimatedBytes: everyBytes,
        wanted: tour.pieces.length,
      };
    }
    // Views where the camera rests (and the one on screen now) first, then the views glides fly through.
    var resting = [];
    var passing = [];
    stop.segments.forEach(function (seg) {
      if (seg.endMs <= (fromMs || 0)) return;
      if (!resting.length || !seg.move) resting.push(seg.from);
      if (seg.move) {
        seg.path.forEach(function (cam, j) {
          if (j > 0 && j % 4 === 0) passing.push(cam);
        });
        resting.push(seg.to);
      }
    });
    // After the view on screen, the resting views in the order the camera reaches them: since the stop shots are
    // close (M3.1: the painting dominant), a "closest first" order would serve the next stop before the row view
    // the camera rests on first (the loop's last rows). The plan is asked again at every segment start.
    var views = resting.concat(passing);
    var order = [];
    var seen = {};
    // Each view asks for what it shows on screen, then for its margin.
    var asks = [];
    views.forEach(function (cam) {
      asks.push({ cam: cam, margin: 0 });
      asks.push({ cam: cam, margin: IMAGE_REGION_MARGIN });
    });
    asks.forEach(function (ask) {
      var cam = ask.cam;
      // Views further out than the opening (the whole-wall rest, the top of a long rise) ask for nothing:
      // their paintings are small and brief, and may show their colour.
      if (cam.zoom < tour.opening.zoom * 0.999) return;
      var r = viewRect(cam, tour.screen, ask.margin);
      var asked = tour.pieces.filter(function (p) {
        return !seen[p.index] && Math.max(p.w, p.h) * cam.zoom >= MIN_IMAGE_SCREEN_PX &&
          p.x < r.maxX && p.x + p.w > r.minX && p.y < r.maxY && p.y + p.h > r.minY;
      });
      var distance = function (p) {
        var dx = p.x + p.w / 2 - cam.cx;
        var dy = p.y + p.h / 2 - cam.cy;
        return dx * dx + dy * dy;
      };
      asked.sort(function (a, b) { return distance(a) - distance(b); });
      asked.forEach(function (p) {
        seen[p.index] = true;
        order.push(p);
      });
    });
    var picked = [];
    var spent = 0;
    for (var i = 0; i < order.length; i++) {
      var bytes = wallImageBytes(order[i]);
      if (spent + bytes > budget && picked.length > 0) break;
      picked.push(order[i].index);
      spent += bytes;
    }
    return { pieceIndexes: picked, estimatedBytes: spent, wanted: order.length };
  }

  var api = {
    STOP_SHARE_MIN: STOP_SHARE_MIN,
    STOP_SHARE_MAX: STOP_SHARE_MAX,
    STOP_MAX_OFFSET_SHARE: STOP_MAX_OFFSET_SHARE,
    STOP_FRAME_MARGIN_SHARE: STOP_FRAME_MARGIN_SHARE,
    HINT_BAND_MULTIPLE: HINT_BAND_MULTIPLE,
    HINT_MIN_SCREEN_SHARE: HINT_MIN_SCREEN_SHARE,
    HINT_MIN_RATIO: HINT_MIN_RATIO,
    HINT_MAX_RATIO: HINT_MAX_RATIO,
    MIN_BAND_DEVICE_PX: MIN_BAND_DEVICE_PX,
    MIN_WALL_STOP_MS: MIN_WALL_STOP_MS,
    GLIDE_NOMINAL_MS: GLIDE_NOMINAL_MS,
    GLIDE_MIN_MS: GLIDE_MIN_MS,
    GLIDE_MAX_MS: GLIDE_MAX_MS,
    GLIDE_EASING: GLIDE_EASING,
    OPENING_HOLD_MS: OPENING_HOLD_MS,
    ROW_HOLD_MS: ROW_HOLD_MS,
    WHOLE_WALL_HOLD_MS: WHOLE_WALL_HOLD_MS,
    MIN_IMAGE_SCREEN_PX: MIN_IMAGE_SCREEN_PX,
    JUMP_FADE_MS: JUMP_FADE_MS,
    SETTLE_MIN_MS: SETTLE_MIN_MS,
    RELEASE_MS: RELEASE_MS,
    DETAIL_FADE_IN_MS: DETAIL_FADE_IN_MS,
    DETAIL_FADE_OUT_MS: DETAIL_FADE_OUT_MS,
    MIN_DETAIL_HOLD_MS: MIN_DETAIL_HOLD_MS,
    MIN_CLOSE_UP_ZOOM: MIN_CLOSE_UP_ZOOM,
    CLOSE_UP_COMPOSITION_CAP: CLOSE_UP_COMPOSITION_CAP,
    CLOSE_UP_MAX_ZOOM_RATE_PER_S: CLOSE_UP_MAX_ZOOM_RATE_PER_S,
    CLOSE_UP_EASING: CLOSE_UP_EASING,
    CLOSE_UP_EASING_PEAK_SPEED: CLOSE_UP_EASING_PEAK_SPEED,
    PULL_BACK_RATE_FACTOR: PULL_BACK_RATE_FACTOR,
    CAPTION_FADE_MS: CAPTION_FADE_MS,
    WALL_IMAGE_BUDGET_BYTES: WALL_IMAGE_BUDGET_BYTES,
    OPENING_MIN_PAINTING_PX: OPENING_MIN_PAINTING_PX,
    LONG_GLIDE_MAX_MS: LONG_GLIDE_MAX_MS,
    openingCamera: openingCamera,
    lastRowsCamera: lastRowsCamera,
    imageSizeFromUrl: imageSizeFromUrl,
    readingOrder: readingOrder,
    fitCamera: fitCamera,
    stopCamera: stopCamera,
    composeStopCamera: composeStopCamera,
    hintOf: hintOf,
    hintTarget: hintTarget,
    extentOf: extentOf,
    stopNeighbours: stopNeighbours,
    imageRect: imageRect,
    imageUpscale: imageUpscale,
    planTour: planTour,
    rowCamera: rowCamera,
    zoomPath: zoomPath,
    glideMs: glideMs,
    planCloseUp: planCloseUp,
    planStop: planStop,
    withoutCloseUp: withoutCloseUp,
    transformOf: transformOf,
    transformString: transformString,
    cameraTransform: cameraTransform,
    moveKeyframes: moveKeyframes,
    bezierEasing: bezierEasing,
    segmentAt: segmentAt,
    transformAt: transformAt,
    cameraAt: cameraAt,
    windowKeyframes: windowKeyframes,
    windowOpacityAt: windowOpacityAt,
    lightKeyframes: lightKeyframes,
    wallImageBytes: wallImageBytes,
    wallImagePlan: wallImagePlan,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaWallTour = api;
  }
})(typeof window !== "undefined" ? window : this);
