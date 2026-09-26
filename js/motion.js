/**
 * KULTURA Cast Receiver — camera motion maths (pure functions, no DOM).
 *
 * Loaded by the TV page as a plain script (exposes window.KulturaMotion) and by Jest
 * through module.exports, so the geometry can be unit-tested without a browser.
 *
 * Coordinate conventions:
 *  - focus: the AI-crop "interesting region" as FRACTIONS of the image (0..1), or null.
 *  - box:   the on-screen size of the displayed image element, in CSS pixels.
 *  - view:  the TV viewport size, in CSS pixels.
 *  - A camera pose is { scale, x, y }: CSS `translate(x px, y px) scale(scale)` applied with
 *    transform-origin at the image centre. A point p (px from the image centre) lands at
 *    x/y + scale * p, so centring point c needs x = -scale * c.x.
 */
(function (root) {
  "use strict";

  /** Largest zoom: served images are ~1300-2048px, so deeper zooms look soft on a TV. */
  var MAX_SCALE = 2.4;
  /** Smallest zoom into a detail, so every artwork gets a visible move. */
  var MIN_FOCUS_SCALE = 1.25;
  /** Breathing room around the focus region (0.85 = region fills 85% of the screen). */
  var FOCUS_FILL = 0.85;
  /** Gentle zoom for artworks without a focus region. */
  var DRIFT_SCALE = 1.12;

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

  /** Camera pose that frames the focus region in the middle of the screen. */
  function focusPose(focus, box, view) {
    var regionW = (focus.x1 - focus.x0) * box.width;
    var regionH = (focus.y1 - focus.y0) * box.height;
    var scale = Math.min(view.width / regionW, view.height / regionH) * FOCUS_FILL;
    scale = clamp(scale, MIN_FOCUS_SCALE, MAX_SCALE);

    var centreX = ((focus.x0 + focus.x1) / 2 - 0.5) * box.width;
    var centreY = ((focus.y0 + focus.y1) / 2 - 0.5) * box.height;
    return clampPose({ scale: scale, x: -scale * centreX, y: -scale * centreY }, box, view);
  }

  /** Four drift directions for artworks without a focus region, chosen by position in the list. */
  var DRIFTS = [
    { from: [-1, 0], to: [1, 0] },
    { from: [1, 0], to: [-1, 0] },
    { from: [0, -1], to: [0, 1] },
    { from: [0, 1], to: [0, -1] },
  ];

  function driftPose(direction, box, view) {
    var limX = maxShift(DRIFT_SCALE, box.width, view.width);
    var limY = maxShift(DRIFT_SCALE, box.height, view.height);
    return { scale: DRIFT_SCALE, x: direction[0] * limX, y: direction[1] * limY };
  }

  function poseToTransform(pose) {
    return "translate(" + pose.x.toFixed(1) + "px, " + pose.y.toFixed(1) + "px) scale(" + pose.scale.toFixed(4) + ")";
  }

  var REST = { scale: 1, x: 0, y: 0 };

  /**
   * Keyframes for one artwork's whole screen time. Offsets are fractions of the slide duration,
   * so the same choreography stretches from a 20 s slide to a slow 5 min drift.
   *
   * With a focus region: rest -> gentle breath -> glide into the detail -> linger (slight
   * push-in) -> pull back -> rest while the caption shows.
   * Without one: a slow continuous drift across the painting.
   */
  function buildKeyframes(focus, box, view, slideIndex) {
    if (isUsableFocus(focus)) {
      var target = focusPose(focus, box, view);
      var linger = clampPose({ scale: target.scale * 1.04, x: target.x * 1.04, y: target.y * 1.04 }, box, view);
      var breath = { scale: 1.03, x: 0, y: 0 };
      return [
        { offset: 0, transform: poseToTransform(REST) },
        { offset: 0.14, transform: poseToTransform(breath), easing: "ease-in-out" },
        { offset: 0.46, transform: poseToTransform(target), easing: "ease-in-out" },
        { offset: 0.66, transform: poseToTransform(linger), easing: "ease-in-out" },
        { offset: 0.86, transform: poseToTransform(REST) },
        { offset: 1, transform: poseToTransform(REST) },
      ];
    }
    var driftIndex = Math.abs(slideIndex || 0) % DRIFTS.length;
    var drift = DRIFTS[driftIndex];
    var horizontal = drift.from[0] !== 0;
    var slack = horizontal
      ? maxShift(DRIFT_SCALE, box.width, view.width)
      : maxShift(DRIFT_SCALE, box.height, view.height);
    // No room to move on this axis (e.g. a portrait painting drifting sideways): use the other axis.
    if (slack === 0) drift = DRIFTS[(driftIndex + 2) % DRIFTS.length];
    return [
      { offset: 0, transform: poseToTransform(driftPose(drift.from, box, view)), easing: "ease-in-out" },
      { offset: 1, transform: poseToTransform(driftPose(drift.to, box, view)) },
    ];
  }

  /** Caption (title + artist) fades in for the last part of each slide. */
  var CAPTION_KEYFRAMES = [
    { offset: 0, opacity: 0 },
    { offset: 0.8, opacity: 0 },
    { offset: 0.85, opacity: 1 },
    { offset: 0.97, opacity: 1 },
    { offset: 1, opacity: 0 },
  ];

  var api = {
    MAX_SCALE: MAX_SCALE,
    MIN_FOCUS_SCALE: MIN_FOCUS_SCALE,
    isUsableFocus: isUsableFocus,
    focusPose: focusPose,
    clampPose: clampPose,
    buildKeyframes: buildKeyframes,
    CAPTION_KEYFRAMES: CAPTION_KEYFRAMES,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaMotion = api;
  }
})(typeof window !== "undefined" ? window : this);
