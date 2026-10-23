/**
 * KULTURA Cast Receiver — how the wall is drawn cheaply and sharply on the TV (pure functions, no DOM).
 * Receiver 2.9.0. Measured on the Sony (Chrome 92 Cast, Mali-G52), 2026-10-13: tasks/2026-10-12-wall-on-tv/.
 *
 *  - SHADOWS: the website's CSS box-shadows (receiver.css .wp-shadow / .wp-lip numbers) cost the TV's GPU the most
 *    raster time of anything on the wall, and per-painting layers with live blurs stutter mid-move. The same shadows
 *    are computed here once (a box-shadow is a rectangle blurred by a Gaussian of sigma = blur / 2: separable, so
 *    exact with erf) into alpha images that wallview.js draws as nine-slice border-images (one image per shadow kind)
 *    or, for pieces too small for nine slices, one image per size.
 *  - FRAME LEVEL OF DETAIL: Android Chrome draws CSS images without mipmaps, so a 900 px moulding squeezed into a
 *    25 device-px band shows moire (the "ripple" frame flickers). Pre-filtered copies (wall/lod450, lod300, lod150)
 *    are picked per painting by the band's width in DEVICE px, only while the camera is still.
 *  - LAYERS: Chrome caps the raster resolution of one huge animated layer (the whole wall) during a move: blur.
 *    Paintings near the camera path get their own small composited layer instead (bounded count: memory).
 *
 * Units: u = one website px (receiver.css --u = 0.78 wall points x the layout scale).
 * Loaded by the TV page as a plain script (window.KulturaWallRender) and by Jest via module.exports.
 */
(function (root) {
  "use strict";

  /** CSS blur radius -> Gaussian sigma (CSS Backgrounds 3: "a standard deviation equal to half the blur radius"). */
  var SIGMA_PER_BLUR = 0.5;
  /** Shadows reach this many sigmas past their edge (alpha there < 0.3 %). */
  var SHADOW_REACH_SIGMAS = 3;

  /**
   * The website's shadows (receiver.css before 2.9.0 drew them as box-shadows), in u:
   * [offsetX, offsetY, blur, spread, alpha], black. `inset` shadows are the lips inside the frame.
   */
  var SHADOW_SPECS = {
    frame: { inset: false, layers: [[0, 30, 40, -12, 0.7], [0, 8, 14, 0, 0.42]] },
    canvas: { inset: false, layers: [[16, 30, 38, -10, 0.72], [5, 9, 14, 0, 0.42]] },
    lip: { inset: true, layers: [[0, 6, 9, -2, 0.55], [0, 0, 3, 1, 0.45]] },
    "lip-thin": { inset: true, layers: [[0, 2, 4, 0, 0.35]] },
    "lip-canvas": { inset: true, layers: [[0, 0, 1, 0, 0.45]] },
  };
  /** Frames whose lip is the thin one (receiver.css .wp[data-frame=...] .wp-lip). */
  var THIN_LIP_FRAMES = { oak: true, maple: true, brass: true, thin: true, float: true };
  /** Image pixels per u: outer shadows are soft (sigma >= 7 u); lips are sharper (sigma down to 0.5 u). */
  var PX_PER_U = { outer: 2, inset: 4, outerPerPiece: 1 };

  /** The lip kind of a frame kind. */
  function lipKind(frame) {
    if (frame === "canvas") return "lip-canvas";
    return THIN_LIP_FRAMES[frame] ? "lip-thin" : "lip";
  }

  function erf(x) {
    // Abramowitz-Stegun 7.1.26 (|error| < 1.5e-7): plenty for 8-bit alpha.
    var s = x < 0 ? -1 : 1;
    var a = Math.abs(x);
    var t = 1 / (1 + 0.3275911 * a);
    var y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return s * y;
  }

  /** Coverage of [lo, hi] blurred by a Gaussian of `sigma`, at x. */
  function blurredInterval(x, lo, hi, sigma) {
    if (hi <= lo) return 0;
    if (sigma <= 0) return x >= lo && x < hi ? 1 : 0;
    var s = sigma * Math.SQRT2;
    return 0.5 * (erf((x - lo) / s) - erf((x - hi) / s));
  }

  /** How far each shadow reaches past each side of the box (u, whole numbers): { top, right, bottom, left }. */
  function shadowOutset(kind) {
    var spec = SHADOW_SPECS[kind];
    var out = { top: 0, right: 0, bottom: 0, left: 0 };
    if (spec.inset) return out;
    spec.layers.forEach(function (l) {
      var reach = l[3] + SHADOW_REACH_SIGMAS * l[2] * SIGMA_PER_BLUR;
      out.left = Math.max(out.left, reach - l[0]);
      out.right = Math.max(out.right, reach + l[0]);
      out.top = Math.max(out.top, reach - l[1]);
      out.bottom = Math.max(out.bottom, reach + l[1]);
    });
    ["top", "right", "bottom", "left"].forEach(function (k) { out[k] = Math.ceil(Math.max(0, out[k])); });
    return out;
  }

  /**
   * How deep (u) into the box the shadow still changes along an edge near the corners: the nine-slice corners
   * must be at least this deep, so the edge slices (stretched) only hold the part that is constant along the edge.
   */
  function shadowCornerDepth(kind) {
    var spec = SHADOW_SPECS[kind];
    var depth = 0;
    spec.layers.forEach(function (l) {
      var sigmaReach = SHADOW_REACH_SIGMAS * l[2] * SIGMA_PER_BLUR;
      depth = Math.max(depth, Math.abs(l[0]) + Math.abs(l[1]) + Math.abs(l[3]) + sigmaReach);
    });
    return Math.ceil(depth) + 2;
  }

  /**
   * Alpha (0..255) of shadow `kind` for a box of boxW x boxH u, drawn at pxPerU, over the box plus its outset.
   * Returns { width, height, alpha: Uint8ClampedArray (width x height), outset (u), pxPerU }.
   * Outer shadows are not drawn under the box (alpha 0 inside), except one image pixel along the inside of the
   * edge that repeats the outside value: scaled up, the image's filtering then ramps under the frame, not beside it.
   */
  function shadowImage(kind, boxW, boxH, pxPerU) {
    var spec = SHADOW_SPECS[kind];
    var o = shadowOutset(kind);
    var width = Math.max(1, Math.round((o.left + boxW + o.right) * pxPerU));
    var height = Math.max(1, Math.round((o.top + boxH + o.bottom) * pxPerU));
    var xs = new Float64Array(width);
    var ys = new Float64Array(height);
    var i, j, k;
    for (i = 0; i < width; i++) xs[i] = (i + 0.5) / pxPerU - o.left;
    for (j = 0; j < height; j++) ys[j] = (j + 0.5) / pxPerU - o.top;
    // Per layer: the blurred profile along x and along y (the shadow is their product).
    var profiles = spec.layers.map(function (l) {
      var sigma = l[2] * SIGMA_PER_BLUR;
      var spread = spec.inset ? l[3] : -l[3];
      var fx = new Float64Array(width);
      var fy = new Float64Array(height);
      for (i = 0; i < width; i++) fx[i] = blurredInterval(xs[i], l[0] + spread, l[0] + boxW - spread, sigma);
      for (j = 0; j < height; j++) fy[j] = blurredInterval(ys[j], l[1] + spread, l[1] + boxH - spread, sigma);
      return { fx: fx, fy: fy, a: l[4] };
    });
    var alpha = new Uint8ClampedArray(width * height);
    var edge = 1 / pxPerU; // one image pixel, in u
    for (j = 0; j < height; j++) {
      var y = ys[j];
      var insideY = y > 0 && y < boxH;
      for (i = 0; i < width; i++) {
        var x = xs[i];
        var inside = insideY && x > 0 && x < boxW;
        var clear = 1;
        if (spec.inset) {
          if (!inside) continue;
          for (k = 0; k < profiles.length; k++) clear *= 1 - profiles[k].a * (1 - profiles[k].fx[i] * profiles[k].fy[j]);
        } else {
          var px = i;
          var py = j;
          if (inside) {
            // Deep inside: nothing. On the inner edge pixel: the value just outside (see above).
            var nearX = x < edge ? -1 : x > boxW - edge ? 1 : 0;
            var nearY = y < edge ? -1 : y > boxH - edge ? 1 : 0;
            if (!nearX && !nearY) continue;
            px = Math.min(width - 1, Math.max(0, i + nearX));
            py = Math.min(height - 1, Math.max(0, j + nearY));
          }
          for (k = 0; k < profiles.length; k++) clear *= 1 - profiles[k].a * profiles[k].fx[px] * profiles[k].fy[py];
        }
        alpha[j * width + i] = Math.round((1 - clear) * 255);
      }
    }
    return { width: width, height: height, alpha: alpha, outset: o, pxPerU: pxPerU };
  }

  /**
   * How to draw shadow `kind` on a box of boxW x boxH u: { mode: "nine", corner (u), refBox (u) } when the box is
   * big enough for nine slices of the shared reference image, else { mode: "piece" } (an image of its own size).
   */
  function shadowPlan(kind, boxW, boxH) {
    var corner = shadowCornerDepth(kind);
    if (boxW >= 2 * corner && boxH >= 2 * corner) return { mode: "nine", corner: corner, refBox: 2 * corner + 4 };
    return { mode: "piece" };
  }

  // ─── Frame level of detail ───

  /** Moulding texture sizes (px): 900 = the website's; smaller ones pre-filtered (scripts/make_frame_lods.py). */
  var FRAME_LOD_LEVELS = [150, 300, 450, 900];
  /** The texture's band (px) must cover at least this share of the drawn band (device px): never visibly soft. */
  var LOD_MIN_RATIO = 1;
  /** ...and at most this many texture px per device px where it rests (bilinear without mipmaps: moire above ~2). */
  var LOD_MAX_RATIO = 2;
  /** Hysteresis: the level in use is kept while its ratio stays within these (no flip-flop between stops). */
  var LOD_KEEP_MIN_RATIO = 0.8;
  var LOD_KEEP_MAX_RATIO = 2.4;
  /** Slice of each moulding texture (% of its side; receiver.css .wp-frame rules, the website's numbers). */
  var FRAME_SLICE_PCT = {
    gold: 20, gilded: 16, walnut: 12, lacquer: 12, oak: 6.5, thin: 4.5, float: 6.7, cassetta: 16.7, acanthus: 17.3,
    venetian: 18, louis: 16, victorian: 16.5, ripple: 13.5, maple: 8.5, brass: 3.3,
  };

  /**
   * The moulding texture level for one frame.
   *   frame: kind; bandDevicePx: the band's width on screen now (device px); needDevicePx: the widest it will be
   *   before the camera rests again (>= bandDevicePx); current: the level in use (or null).
   * Picks the smallest level that is never upscaled (ratio >= LOD_MIN_RATIO at needDevicePx) while not squeezed
   * past LOD_MAX_RATIO where the camera rests now; if both cannot hold, resting without moire wins.
   */
  function frameLod(frame, bandDevicePx, needDevicePx, current) {
    var slice = FRAME_SLICE_PCT[frame];
    if (!slice || !(bandDevicePx > 0)) return current || 900;
    var need = Math.max(bandDevicePx, needDevicePx || 0);
    var ratio = function (level) { return (level * slice) / 100 / bandDevicePx; };
    var ratioNeed = function (level) { return (level * slice) / 100 / need; };
    if (current && ratio(current) <= LOD_KEEP_MAX_RATIO && ratioNeed(current) >= LOD_KEEP_MIN_RATIO) return current;
    var sharp = null;
    for (var i = 0; i < FRAME_LOD_LEVELS.length; i++) {
      if (ratioNeed(FRAME_LOD_LEVELS[i]) >= LOD_MIN_RATIO) {
        sharp = FRAME_LOD_LEVELS[i];
        break;
      }
    }
    if (sharp == null) sharp = FRAME_LOD_LEVELS[FRAME_LOD_LEVELS.length - 1];
    if (ratio(sharp) <= LOD_MAX_RATIO) return sharp;
    // Too fine for this view: the largest level that rests without moire (the smallest one if none does).
    var calm = FRAME_LOD_LEVELS[0];
    FRAME_LOD_LEVELS.forEach(function (level) {
      if (ratio(level) <= LOD_MAX_RATIO) calm = level;
    });
    return calm;
  }

  // ─── Which paintings get their own layer ───

  /** At most this many paintings are composited layers at once (GPU memory on 1.5 GB devices). */
  var MAX_PIECE_LAYERS = 28;
  /** A view's rectangle grows by this share of its size on every side when asking which paintings it shows. */
  var LAYER_VIEW_MARGIN = 0.25;
  /**
   * Views this far out (camera zoom / layout scale) need no own layers: the whole-wall layer is rastered at about
   * 1 device px per layout px while it moves, which is sharp enough at half the layout scale or less.
   */
  var LAYER_MIN_VIEW_SCALE = 0.45;

  /**
   * Indexes of the paintings that should be layers for the camera views `views` ([{cx, cy, zoom}], most
   * important first): those any close-enough view shows (with a margin), nearest to their view first, at most
   * MAX_PIECE_LAYERS.
   */
  function pieceLayerPlan(pieces, views, screen, layoutScale, maxLayers) {
    var cap = maxLayers == null ? MAX_PIECE_LAYERS : maxLayers;
    var picked = [];
    var seen = {};
    views.forEach(function (cam) {
      if (cam.zoom / layoutScale < LAYER_MIN_VIEW_SCALE) return;
      var halfW = (screen.width / 2 / cam.zoom) * (1 + 2 * LAYER_VIEW_MARGIN);
      var halfH = (screen.height / 2 / cam.zoom) * (1 + 2 * LAYER_VIEW_MARGIN);
      var shown = pieces.filter(function (p) {
        return !seen[p.index] && p.x < cam.cx + halfW && p.x + p.w > cam.cx - halfW && p.y < cam.cy + halfH && p.y + p.h > cam.cy - halfH;
      });
      var d = function (p) {
        var dx = p.x + p.w / 2 - cam.cx;
        var dy = p.y + p.h / 2 - cam.cy;
        return dx * dx + dy * dy;
      };
      shown.sort(function (a, b) { return d(a) - d(b); });
      shown.forEach(function (p) {
        seen[p.index] = true;
        picked.push(p.index);
      });
    });
    return picked.slice(0, cap);
  }

  /** Spotlight mask resolution: image px per CSS px (a quarter: 360 x 203 px for the 1440 x 810 overlay). */
  var SPOTLIGHT_MASK_PX_PER_CSS = 0.25;

  /** Is a camera view showing (part of) piece `p` (wall points), with `margin` share of the view added? */
  function viewShows(cam, p, screen, margin) {
    var halfW = (screen.width / 2 / cam.zoom) * (1 + 2 * (margin || 0));
    var halfH = (screen.height / 2 / cam.zoom) * (1 + 2 * (margin || 0));
    return p.x < cam.cx + halfW && p.x + p.w > cam.cx - halfW && p.y < cam.cy + halfH && p.y + p.h > cam.cy - halfH;
  }

  /**
   * The spotlight's mask (walltour.js "Spotlight"; the overlay wallview.js draws as ONE image fixed to the screen, so
   * the TV never re-rasters it: it is only faded and, during the close-up, moved). Black at alpha 0 inside the lit
   * rect `rect` ({ x0, y0, x1, y1 }, CSS px), rising smoothly to `strength` over `feather` CSS px beyond it (the
   * distance to the rect: its dark edge is a rounded rectangle). `overlay` { x, y, w, h } (CSS px) is the area the
   * image covers; one image px per 1 / SPOTLIGHT_MASK_PX_PER_CSS CSS px (a soft gradient: the GPU's bilinear
   * scaling is invisible). Returns { width, height, alpha } (alpha: one byte per px, rows top to bottom).
   */
  function spotlightMask(rect, overlay, feather, strength) {
    var scale = SPOTLIGHT_MASK_PX_PER_CSS;
    var width = Math.max(1, Math.round(overlay.w * scale));
    var height = Math.max(1, Math.round(overlay.h * scale));
    var alpha = new Uint8ClampedArray(width * height);
    var full = Math.max(0, Math.min(1, strength)) * 255;
    var f = Math.max(feather, 1e-6);
    for (var j = 0; j < height; j++) {
      var y = overlay.y + ((j + 0.5) / height) * overlay.h;
      var dy = Math.max(rect.y0 - y, 0, y - rect.y1);
      for (var i = 0; i < width; i++) {
        var x = overlay.x + ((i + 0.5) / width) * overlay.w;
        var dx = Math.max(rect.x0 - x, 0, x - rect.x1);
        var u = Math.min(1, Math.sqrt(dx * dx + dy * dy) / f);
        alpha[j * width + i] = Math.round(full * u * u * (3 - 2 * u));
      }
    }
    return { width: width, height: height, alpha: alpha };
  }

  var api = {
    SIGMA_PER_BLUR: SIGMA_PER_BLUR,
    SPOTLIGHT_MASK_PX_PER_CSS: SPOTLIGHT_MASK_PX_PER_CSS,
    SHADOW_SPECS: SHADOW_SPECS,
    PX_PER_U: PX_PER_U,
    FRAME_LOD_LEVELS: FRAME_LOD_LEVELS,
    FRAME_SLICE_PCT: FRAME_SLICE_PCT,
    LOD_MIN_RATIO: LOD_MIN_RATIO,
    LOD_MAX_RATIO: LOD_MAX_RATIO,
    MAX_PIECE_LAYERS: MAX_PIECE_LAYERS,
    lipKind: lipKind,
    erf: erf,
    shadowOutset: shadowOutset,
    shadowCornerDepth: shadowCornerDepth,
    shadowImage: shadowImage,
    shadowPlan: shadowPlan,
    frameLod: frameLod,
    pieceLayerPlan: pieceLayerPlan,
    viewShows: viewShows,
    spotlightMask: spotlightMask,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaWallRender = api;
  }
})(typeof window !== "undefined" ? window : this);
