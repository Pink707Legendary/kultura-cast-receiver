/**
 * KULTURA Cast Receiver — camera motion maths (pure functions, no DOM).
 *
 * Loaded by the TV page as a plain script (exposes window.KulturaMotion) and by Jest
 * through module.exports, so the geometry can be unit-tested without a browser.
 *
 * Coordinate conventions:
 *  - focus: the AI-crop "interesting region" as FRACTIONS of the image (0..1), or null.
 *  - box:   the on-screen size of the whole painting fitted inside the screen, in CSS pixels.
 *  - view:  the TV viewport size, in CSS pixels.
 *  - A camera pose is { scale, x, y }: CSS `translate(x px, y px) scale(scale)` applied with
 *    transform-origin at the image centre. A point p (px from the image centre) lands at
 *    x/y + scale * p, so centring point c needs x = -scale * c.x.
 */
(function (root) {
  "use strict";

  /** Deepest zoom relative to "painting fills the screen". */
  var DETAIL_ZOOM = 2.1;
  /** How far past 1 image pixel per screen pixel we accept before the detail looks soft. */
  var MAX_UPSCALE = 1.35;
  var ABSOLUTE_MAX_SCALE = 5;

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

  /**
   * Largest translation (px) along one axis that keeps the image covering the screen on that
   * axis. If the zoomed image is narrower than the screen there is no slack: stay centred.
   */
  function maxShift(scale, boxSize, viewSize) {
    return Math.max(0, (scale * boxSize - viewSize) / 2);
  }

  /** Clamp a pose so the camera never slides past the painting's edge into empty background. */
  function clampPose(pose, box, view) {
    var limX = maxShift(pose.scale, box.width, view.width);
    var limY = maxShift(pose.scale, box.height, view.height);
    return {
      scale: pose.scale,
      x: clamp(pose.x, -limX, limX),
      y: clamp(pose.y, -limY, limY),
    };
  }

  /** Scale at which the painting fills the whole screen (cropping its edges), never below 1. */
  function coverScale(box, view) {
    return Math.max(1, view.width / box.width, view.height / box.height);
  }

  /** Pose that puts image point (fx, fy) (fractions) at the screen centre, clamped to the edges. */
  function poseAt(fx, fy, scale, box, view) {
    return clampPose({ scale: scale, x: -scale * (fx - 0.5) * box.width, y: -scale * (fy - 0.5) * box.height }, box, view);
  }

  /** Detail zoom: about twice "fill the screen", limited by the image's real resolution. */
  function detailScale(cover, box, sourceWidth) {
    var sharpLimit = sourceWidth > 0 ? (sourceWidth / box.width) * MAX_UPSCALE : cover * 1.4;
    var limit = Math.min(ABSOLUTE_MAX_SCALE, Math.max(cover * 1.25, sharpLimit));
    return Math.min(cover * DETAIL_ZOOM, limit);
  }

  /** Where to dive in: the AI crop's subject area if we have one, else slightly above centre. */
  function detailPoint(focus) {
    if (isUsableFocus(focus)) {
      return { x: (focus.x0 + focus.x1) / 2, y: focus.y0 + 0.4 * (focus.y1 - focus.y0) };
    }
    return { x: 0.5, y: 0.42 };
  }

  function poseToTransform(pose) {
    return "translate(" + pose.x.toFixed(1) + "px, " + pose.y.toFixed(1) + "px) scale(" + pose.scale.toFixed(4) + ")";
  }

  var REST = { scale: 1, x: 0, y: 0 };

  /**
   * Keyframes for one artwork's whole screen time (Ken Burns). Offsets are fractions of the slide,
   * so the same choreography stretches from a 20 s slide to a slow 5 min drift:
   *   0-30%   the painting fills the screen and the camera pans along it towards the detail
   *   30-55%  push in to the detail (as deep as the image resolution allows)
   *   55-72%  drift slowly across the detail
   *   72-88%  pull back to the whole painting
   *   88-100% hold the whole painting while the caption shows
   * sourceWidth is the image's real pixel width; slideIndex alternates the pan direction.
   */
  function buildKeyframes(focus, box, view, slideIndex, sourceWidth) {
    var cover = coverScale(box, view);
    var detail = detailScale(cover, box, sourceWidth || 0);
    var point = detailPoint(focus);

    // Pan along the axis the filled painting overflows (portrait on a landscape TV: vertically),
    // starting from the far end so the camera travels towards the detail.
    var alongY = cover * box.height - view.height > cover * box.width - view.width;
    var flip = Math.abs(slideIndex || 0) % 2 === 1;
    var farEnd = function (v) {
      return (v < 0.5) !== flip ? 1 : 0;
    };
    var nudge = function (v) {
      return v + (v < 0.5 ? 0.08 : -0.08);
    };
    var start = alongY ? { x: point.x, y: farEnd(point.y) } : { x: farEnd(point.x), y: point.y };
    var drift = alongY ? { x: point.x, y: nudge(point.y) } : { x: nudge(point.x), y: point.y };

    return [
      { offset: 0, transform: poseToTransform(poseAt(start.x, start.y, cover, box, view)), easing: "ease-in-out" },
      { offset: 0.3, transform: poseToTransform(poseAt(point.x, point.y, cover, box, view)), easing: "ease-in-out" },
      { offset: 0.55, transform: poseToTransform(poseAt(point.x, point.y, detail, box, view)), easing: "ease-in-out" },
      { offset: 0.72, transform: poseToTransform(poseAt(drift.x, drift.y, detail, box, view)), easing: "ease-in-out" },
      { offset: 0.88, transform: poseToTransform(REST) },
      { offset: 1, transform: poseToTransform(REST) },
    ];
  }

  /** Caption (title + artist) fades in while the whole painting is shown at the end. */
  var CAPTION_KEYFRAMES = [
    { offset: 0, opacity: 0 },
    { offset: 0.86, opacity: 0 },
    { offset: 0.9, opacity: 1 },
    { offset: 0.98, opacity: 1 },
    { offset: 1, opacity: 0 },
  ];

  var api = {
    isUsableFocus: isUsableFocus,
    clampPose: clampPose,
    coverScale: coverScale,
    poseAt: poseAt,
    detailScale: detailScale,
    buildKeyframes: buildKeyframes,
    CAPTION_KEYFRAMES: CAPTION_KEYFRAMES,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaMotion = api;
  }
})(typeof window !== "undefined" ? window : this);
