/**
 * KULTURA Cast Receiver — gallery choreography and sharpness limits (pure functions, no DOM).
 *
 * Loaded by the TV page as a plain script (exposes window.KulturaMotion) and by Jest
 * through module.exports, so the geometry can be unit-tested without a browser.
 *
 * Gallery view (2.6.0, owner decision 2026-10-03: "gentle" is the default; reviewed by Astra and
 * Fable): every artwork starts WHOLE (contained on its wall, no crop) and static, holding at least
 * 40 % of the slide. In "gentle" mode it then makes ONE slow move toward the AI-crop subject (never
 * back), no deeper than the image stays sharp and than the subject filling ~70 % of the screen, at
 * most 5 % zoom per second at the fastest point, and holds on the subject (at least 8 s) until the
 * slide ends. Between artworks the picture dips through the wall: the painting fades out, the wall
 * changes, the next painting fades in; two paintings are never on screen together. When a move would
 * not be worth it (less than 1.3x, no usable subject, slide too short for a calm move) the artwork
 * stays still. "still" mode never moves.
 *
 * Coordinate conventions:
 *  - focus:   the AI-crop region as FRACTIONS of the image (0..1), or null.
 *  - natural: the LOADED image's real pixel size { width, height } (the fallback image's if used).
 *  - view:    the TV viewport in CSS px; dpr: device pixels per CSS px (2 on Google TV at 1080p).
 *  - box:     the whole painting fitted inside the view (contain), in CSS px.
 *  - A pose is { scale, x, y }: CSS `translate(x px, y px) scale(scale)` with transform-origin at the
 *    image centre, relative to the contained box. A point p (px from the image centre) lands at
 *    x/y + scale * p, so centring point c needs x = -scale * c.x.
 *  - Effective upscale = device pixels drawn per image pixel. Above 1 the TV invents pixels (soft).
 */
(function (root) {
  "use strict";

  /** Zoom no further than 1 image pixel per device pixel if that is enough for a worthwhile move... */
  var PREFERRED_UPSCALE = 1.0;
  /** ...otherwise accept up to this much (hard limit; beyond it the detail looks soft). */
  var MAX_UPSCALE = 1.1;
  /** Composition limit: never more than this times the whole-painting view. */
  var COMPOSITION_CAP = 1.5;
  /** A move smaller than this is not worth making: stay on the whole painting. */
  var MIN_WORTHWHILE_ZOOM = 1.3;
  /** At the deepest point the AI-crop subject fills about this share of the screen (context around it). */
  var SUBJECT_SCREEN_SHARE = 0.7;
  /**
   * An AI crop spanning at least this share of the image's width or height is a STRIP (most of today's
   * crops are phone-portrait strips the full height of the painting): a direction hint, not a subject
   * box. The move then heads for the strip's centre, slightly above the middle, as deep as composition
   * and sharpness allow (orchestrator decision 2026-10-03), keeping headroom above the strip's top
   * (STRIP_HEADROOM).
   */
  var STRIP_SPAN = 0.9;
  /** Strips: aim this far down the strip (0.4 = a little above its middle, where faces and skies are). */
  var STRIP_VERTICAL_BIAS = 0.4;
  /**
   * Strips that do not span the full height: at the deepest point the strip's top edge lands at least
   * this share of the screen height below the screen's top edge. Phone-portrait crops of tall paintings
   * often start at the eyes; the head or sky above them stays in view (2104 Mucha, TV QA 2026-10-03).
   */
  var STRIP_HEADROOM = 0.15;
  /** Gentle moves need at least this long a slide; shorter slides stay still. */
  var MIN_GENTLE_SLIDE_MS = 30000;
  /** The whole painting is shown, still, for at least this share of every slide. */
  var MIN_WHOLE_SHARE = 0.4;
  /** The move ends on the subject and stays there at least this long (and at most MAX_FOCUS_HOLD_MS). */
  var MIN_FOCUS_HOLD_MS = 8000;
  var MAX_FOCUS_HOLD_MS = 30000;
  /** Share of the time left after the move that goes to the focus hold (the rest is the whole hold). */
  var FOCUS_HOLD_SHARE = 0.25;
  /** Move easing: slow, asymmetric start; long soft landing (Fable review 2026-10-03). */
  var MOVE_EASING = "cubic-bezier(0.45, 0, 0.15, 1)";
  /** That curve's fastest point is 3.14x its average speed (computed numerically). */
  var MOVE_EASING_PEAK_SPEED = 3.14;
  /**
   * Fastest allowed zoom speed: 5 % per second (as a ratio: ln(scale) per second). Faster reads as a
   * slideshow effect, slower as cinematic.
   */
  var MAX_ZOOM_RATE_PER_S = 0.05;
  /** Between artworks: painting fades out, wall changes, next painting fades in (ms). */
  var TRANSITION_MS = { out: 1200, wall: 500, in: 1500 };
  /** The museum label shows once the painting has appeared, for this long, then fades (OLED care). */
  var LABEL_VISIBLE_MS = 8000;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /** True when the focus region is a usable sub-rectangle of the image. */
  function isUsableFocus(focus) {
    if (!focus) return false;
    var w = focus.x1 - focus.x0;
    var h = focus.y1 - focus.y0;
    if (!(w > 0.02 && h > 0.02)) return false;
    // A region covering nearly the whole image carries no information.
    return w * h < 0.9;
  }

  function hasSize(natural) {
    return !!natural && natural.width > 0 && natural.height > 0;
  }

  /** The whole painting fitted inside the view (contain), in CSS px. */
  function fitBox(natural, view) {
    var fit = Math.min(view.width / natural.width, view.height / natural.height);
    return { width: natural.width * fit, height: natural.height * fit };
  }

  /**
   * Device pixels drawn per image pixel at `scale` (1 = whole painting):
   * max(scale * boxW * dpr / naturalW, scale * boxH * dpr / naturalH).
   */
  function effectiveUpscale(scale, box, dpr, natural) {
    return scale * Math.max((box.width * dpr) / natural.width, (box.height * dpr) / natural.height);
  }

  /** Largest scale whose effective upscale stays within `maxUpscale` (below 1 if even the whole is soft). */
  function sharpZoomLimit(box, dpr, natural, maxUpscale) {
    return maxUpscale / effectiveUpscale(1, box, dpr, natural);
  }

  /** True when the AI crop is a full-height or full-width strip (a direction hint, see STRIP_SPAN). */
  function isStrip(focus) {
    return focus.x1 - focus.x0 >= STRIP_SPAN || focus.y1 - focus.y0 >= STRIP_SPAN;
  }

  /** Where the move heads (image fractions): a strip's biased centre, or a subject box's centre. */
  function focusTarget(focus) {
    if (isStrip(focus)) {
      return { x: (focus.x0 + focus.x1) / 2, y: focus.y0 + STRIP_VERTICAL_BIAS * (focus.y1 - focus.y0) };
    }
    return { x: (focus.x0 + focus.x1) / 2, y: (focus.y0 + focus.y1) / 2 };
  }

  /**
   * Deepest zoom the subject allows: a subject box fills about SUBJECT_SCREEN_SHARE of the screen; a
   * strip sets no limit of its own (composition and sharpness decide).
   */
  function subjectZoomLimit(focus, box, view) {
    if (isStrip(focus)) return Infinity;
    var fw = (focus.x1 - focus.x0) * box.width;
    var fh = (focus.y1 - focus.y0) * box.height;
    return Math.min((view.width * SUBJECT_SCREEN_SHARE) / fw, (view.height * SUBJECT_SCREEN_SHARE) / fh);
  }

  /**
   * Zoom available for the gentle move: composition cap and subject extent, then sharpness, preferring
   * 1.0 upscale and allowing up to 1.1 only when 1.0 is too little for a worthwhile move.
   */
  function availableZoom(focus, box, view, dpr, natural) {
    var cap = Math.min(COMPOSITION_CAP, subjectZoomLimit(focus, box, view));
    var zoom = Math.min(cap, sharpZoomLimit(box, dpr, natural, PREFERRED_UPSCALE));
    if (zoom < MIN_WORTHWHILE_ZOOM) zoom = Math.min(cap, sharpZoomLimit(box, dpr, natural, MAX_UPSCALE));
    return zoom;
  }

  /**
   * Largest translation (px) along one axis that keeps the zoomed painting covering the screen on
   * that axis. If it is narrower than the screen there is no slack: stay centred.
   */
  function maxShift(scale, boxSize, viewSize) {
    return Math.max(0, (scale * boxSize - viewSize) / 2);
  }

  /** Clamp a pose so the camera never slides past the painting's edge. */
  function clampPose(pose, box, view) {
    var limX = maxShift(pose.scale, box.width, view.width);
    var limY = maxShift(pose.scale, box.height, view.height);
    return { scale: pose.scale, x: clamp(pose.x, -limX, limX), y: clamp(pose.y, -limY, limY) };
  }

  /** Pose that puts image point (fx, fy) (fractions) at the screen centre, clamped to the edges. */
  function poseAt(fx, fy, scale, box, view) {
    return clampPose({ scale: scale, x: -scale * (fx - 0.5) * box.width, y: -scale * (fy - 0.5) * box.height }, box, view);
  }

  /**
   * Moves a strip pose down (toward the painting's top) until the strip's top edge sits at least
   * STRIP_HEADROOM of the screen below the top edge, clamped to the painting's edges. Strips that start
   * at the painting's top are left alone (nothing above to keep; the vertical bias decides). Any strip
   * that starts lower gets headroom, even one 90-100 % tall (Fable review 2.6.1: phone crops of
   * paintings with aspect ~0.41-0.46 start just below the top, at the eyes).
   */
  function keepStripHeadroom(focus, pose, box, view) {
    if (!isStrip(focus) || focus.y0 <= 0.01) return pose;
    // Screen position of the strip's top edge, px from the screen centre (see project in the tests).
    var stripTop = pose.y + pose.scale * (focus.y0 - 0.5) * box.height;
    var highest = -view.height / 2 + STRIP_HEADROOM * view.height;
    if (stripTop >= highest) return pose;
    return clampPose({ scale: pose.scale, x: pose.x, y: pose.y + (highest - stripTop) }, box, view);
  }

  /** Shortest move to `zoom` that keeps the fastest point under MAX_ZOOM_RATE_PER_S. */
  function minMoveMs(zoom) {
    return Math.ceil((MOVE_EASING_PEAK_SPEED * Math.log(zoom) * 1000) / MAX_ZOOM_RATE_PER_S);
  }

  /** Deepest zoom a slide of `durationMs` has time for (whole share, calm move and focus hold included). */
  function zoomThatFits(durationMs) {
    // (10 ms margin: minMoveMs rounds up)
    var moveMs = durationMs * (1 - MIN_WHOLE_SHARE) - MIN_FOCUS_HOLD_MS - 10;
    return moveMs > 0 ? Math.exp((MAX_ZOOM_RATE_PER_S * moveMs) / 1000 / MOVE_EASING_PEAK_SPEED) : 1;
  }

  /**
   * When each part of a gentle slide ends (ms from the slide start): whole hold, then the move (as long
   * as the zoom rate needs, never stretched), then the focus hold to the end. Longer slides lengthen the
   * holds, not the move. Returns null when the slide is too short for this zoom.
   */
  function gentleTimeline(durationMs, zoom) {
    var moveMs = minMoveMs(zoom);
    var rest = durationMs - moveMs;
    var focusHold = Math.min(MAX_FOCUS_HOLD_MS, Math.max(MIN_FOCUS_HOLD_MS, rest * FOCUS_HOLD_SHARE));
    var whole = rest - focusHold;
    if (whole < durationMs * MIN_WHOLE_SHARE - 0.5) return null;
    var wholeEnd = Math.round(whole);
    return { wholeEndMs: wholeEnd, focusStartMs: wholeEnd + moveMs, durationMs: durationMs };
  }

  var REST = { scale: 1, x: 0, y: 0 };

  function withReason(result, reason) {
    result.reason = reason;
    return result;
  }

  /**
   * Decide how one artwork is shown. Input: { motion: "gentle" | "still", durationMs, focus,
   * natural, view, dpr }. Returns { plan: "gentle" | "still", reason, box, restUpscale,
   * insufficientResolution, zoom, detailPose, timeline }.
   * Reasons for staying still: "setting", "unknown-size", "no-focus", "zoom-too-small", "short-slide"
   * (the slide has no time for a calm move of at least MIN_WORTHWHILE_ZOOM).
   */
  function planSlide(o) {
    var known = hasSize(o.natural);
    var box = known ? fitBox(o.natural, o.view) : { width: o.view.width, height: o.view.height };
    var restUpscale = known ? effectiveUpscale(1, box, o.dpr, o.natural) : null;
    var result = {
      plan: "still",
      reason: null,
      box: box,
      restUpscale: restUpscale,
      // Even the whole painting is softer than the limit: shown whole anyway, reported.
      insufficientResolution: restUpscale != null && restUpscale > MAX_UPSCALE,
      zoom: 1,
      detailPose: REST,
      timeline: null,
    };
    if (o.motion === "still") return withReason(result, "setting");
    // Never zoom speculatively into an image whose size is unknown.
    if (!known) return withReason(result, "unknown-size");
    if (!(o.durationMs >= MIN_GENTLE_SLIDE_MS)) return withReason(result, "short-slide");
    if (!isUsableFocus(o.focus)) return withReason(result, "no-focus");
    var zoom = availableZoom(o.focus, box, o.view, o.dpr, o.natural);
    if (zoom < MIN_WORTHWHILE_ZOOM) {
      result.zoom = zoom;
      return withReason(result, "zoom-too-small");
    }
    // A shorter slide gets a shallower move rather than a faster one.
    zoom = Math.min(zoom, zoomThatFits(o.durationMs));
    var timeline = zoom >= MIN_WORTHWHILE_ZOOM ? gentleTimeline(o.durationMs, zoom) : null;
    if (!timeline) {
      result.zoom = zoom;
      return withReason(result, "short-slide");
    }
    var target = focusTarget(o.focus);
    var cx = target.x;
    var cy = target.y;
    result.plan = "gentle";
    result.reason = "ok";
    result.zoom = zoom;
    result.detailPose = keepStripHeadroom(o.focus, poseAt(cx, cy, zoom, box, o.view), box, o.view);
    result.timeline = timeline;
    return result;
  }

  function poseToTransform(pose) {
    return "translate(" + pose.x.toFixed(1) + "px, " + pose.y.toFixed(1) + "px) scale(" + pose.scale.toFixed(4) + ")";
  }

  /**
   * The painting is animated ONLY during the move (2.6.1, TV QA 2026-10-03). A transform animation that
   * spans the whole slide makes the TV's Chrome treat the painting as moving for the whole slide and
   * draw it softer than its file allows (Irises, same scale: sharpness 2419 in Gentle vs 5350 in Still).
   * Before and after the move the painting holds a static transform (restingTransformAt), which Chrome
   * redraws crisp at the exact scale.
   */

  /** Keyframes of the one eased move, whole -> subject (null for a still plan). */
  function moveKeyframes(plan) {
    if (plan.plan !== "gentle") return null;
    return [
      { transform: poseToTransform(REST), easing: MOVE_EASING },
      { transform: poseToTransform(plan.detailPose) },
    ];
  }

  /** Static transform for the painting at slide time `timeMs` outside the move: whole before it, subject after. */
  function restingTransformAt(plan, timeMs) {
    var subject = plan.plan === "gentle" && timeMs >= plan.timeline.focusStartMs;
    return poseToTransform(subject ? plan.detailPose : REST);
  }

  /** Which part of the slide is on screen at `timeMs` ("still" for a still plan). */
  function slidePhaseAt(plan, timeMs) {
    if (plan.plan !== "gentle") return "still";
    var t = plan.timeline;
    if (timeMs < t.wholeEndMs) return "whole";
    if (timeMs < t.focusStartMs) return "approach";
    return "focus";
  }

  /**
   * Label: fades in once the painting has appeared (after the wall dip), stays LABEL_VISIBLE_MS, then
   * fades out for the rest of the slide.
   */
  function captionKeyframes(durationMs) {
    var at = function (ms) {
      return Math.min(1, Math.max(0, ms / durationMs));
    };
    var appear = TRANSITION_MS.wall + TRANSITION_MS.in;
    var shownUntil = Math.min(appear + 1000 + LABEL_VISIBLE_MS, durationMs * 0.6);
    return [
      { offset: 0, opacity: 0 },
      { offset: at(appear), opacity: 0 },
      { offset: at(appear + 1000), opacity: 1 },
      { offset: at(shownUntil), opacity: 1 },
      { offset: at(shownUntil + 1200), opacity: 0 },
      { offset: 1, opacity: 0 },
    ];
  }

  var api = {
    PREFERRED_UPSCALE: PREFERRED_UPSCALE,
    MAX_UPSCALE: MAX_UPSCALE,
    COMPOSITION_CAP: COMPOSITION_CAP,
    MIN_WORTHWHILE_ZOOM: MIN_WORTHWHILE_ZOOM,
    SUBJECT_SCREEN_SHARE: SUBJECT_SCREEN_SHARE,
    STRIP_HEADROOM: STRIP_HEADROOM,
    MIN_WHOLE_SHARE: MIN_WHOLE_SHARE,
    MIN_FOCUS_HOLD_MS: MIN_FOCUS_HOLD_MS,
    MOVE_EASING: MOVE_EASING,
    MOVE_EASING_PEAK_SPEED: MOVE_EASING_PEAK_SPEED,
    MAX_ZOOM_RATE_PER_S: MAX_ZOOM_RATE_PER_S,
    TRANSITION_MS: TRANSITION_MS,
    LABEL_VISIBLE_MS: LABEL_VISIBLE_MS,
    minMoveMs: minMoveMs,
    zoomThatFits: zoomThatFits,
    isStrip: isStrip,
    focusTarget: focusTarget,
    isUsableFocus: isUsableFocus,
    fitBox: fitBox,
    effectiveUpscale: effectiveUpscale,
    sharpZoomLimit: sharpZoomLimit,
    subjectZoomLimit: subjectZoomLimit,
    availableZoom: availableZoom,
    clampPose: clampPose,
    poseAt: poseAt,
    keepStripHeadroom: keepStripHeadroom,
    gentleTimeline: gentleTimeline,
    planSlide: planSlide,
    moveKeyframes: moveKeyframes,
    restingTransformAt: restingTransformAt,
    slidePhaseAt: slidePhaseAt,
    captionKeyframes: captionKeyframes,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaMotion = api;
  }
})(typeof window !== "undefined" ? window : this);
