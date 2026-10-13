/**
 * KULTURA Cast Receiver — when the TV page ends itself (pure functions, no DOM).
 *
 * Google's receiver design checklist (https://developers.google.com/cast/docs/design_checklist/receiver),
 * best practices we follow:
 *   - "Receiver app idle" / "Receiver stops cast": disconnect and stop the app after 5 minutes idle.
 *   - "Receiver paused": disconnect and stop the app after 20 minutes paused.
 * Plus our own rule from 2.4: stop after 3 hours with no phone message or remote key at all, so a
 * forgotten slideshow never keeps an OLED lit all night (the page holds a screen wake lock).
 *
 * OLED burn-in safeguard (2.9.0, owner rules 2026-10-13; Yarden's TV is an OLED):
 *   - A paused WALL tour stops after 10 minutes, not 20 (WALL_PAUSED_STOP_MS): the wall is one still,
 *     high-contrast picture (frames, wallpaper), and the paused wall would otherwise stay pixel-static.
 *   - After 60 s paused in wall mode the whole wall first grows 2 % over a minute (so the screen edges never
 *     show the background while it moves), then drifts very slowly (oledDriftOffset: a few px over minutes,
 *     too slow to see as motion). receiver.js applies it (oledDriftTransform); the slideshow does not drift.
 *   - A test-only freeze (SEEK with pause: true, scripts/tv_capture.py) plays on by itself after 3 minutes
 *     (DEBUG_FREEZE_RELEASE_MS), so a test that crashes never leaves the TV frozen.
 *
 * Why not the Cast framework's own idle timeout (CastReceiverOptions.disableIdleTimeout = false):
 * it watches the framework's MEDIA player ("closed when it becomes idle after active playback stops")
 * and Google says to disable it for non-media apps. The TV page shows paintings with plain images and
 * never uses the media player, so the framework cannot tell a running slideshow from an idle page.
 * `maxInactivity` is a different thing (the heartbeat for a phone's connection, default 10 s) and is
 * left at its default. receiver.js asks this module every half minute and, when it names a reason,
 * stops through the framework (CastReceiverContext.stop()), which also tells every phone.
 *
 * Kept apart from receiver.js so the rules are unit-tested (__tests__/cast-receiver/idle.test.ts).
 * Loaded by the TV page as a plain script (window.KulturaIdle) and by Jest via module.exports.
 */
(function (root) {
  "use strict";

  /** Nothing to show (no play list yet, or none of its artworks could be loaded): stop after 5 min. */
  var NOTHING_TO_SHOW_STOP_MS = 5 * 60 * 1000;
  /** Paused (by a phone or the TV remote): stop after 20 min (the slideshow). */
  var PAUSED_STOP_MS = 20 * 60 * 1000;
  /** Paused in wall mode: stop after 10 min (OLED: the paused wall is one still picture). */
  var WALL_PAUSED_STOP_MS = 10 * 60 * 1000;
  /** Paused in wall mode this long (and not touched since): the wall starts to drift (oledDriftOffset). */
  var OLED_DRIFT_START_MS = 60 * 1000;
  /** Largest drift each way, CSS px (the TV page is 960 x 540 CSS px; 2 device px per CSS px on the Sony). */
  var OLED_DRIFT_AMPLITUDE_PX = 5;
  /**
   * Periods of the horizontal and vertical drift (a 4:3 Lissajous figure): the whole path repeats every
   * 12 minutes, longer than a paused wall drifts (10 min stop minus the 1 min wait and the 1 min scale-in).
   */
  var OLED_DRIFT_PERIOD_X_MS = 4 * 60 * 1000;
  var OLED_DRIFT_PERIOD_Y_MS = 3 * 60 * 1000;
  /**
   * Scale of the wall while it drifts: 2 % larger covers 9.6 px each side of a 960 px wide screen and
   * 5.4 px of a 540 px tall one, more than OLED_DRIFT_AMPLITUDE_PX, so no edge of the background shows.
   */
  var OLED_DRIFT_SCALE = 1.02;
  /**
   * The drift starts with the 2 % scale-in over this long (edges move under 0.3 px/s), and only then moves
   * sideways, so the edges are always covered and nothing jumps.
   */
  var OLED_DRIFT_SCALE_IN_MS = 60 * 1000;
  /** Samples of the scale-in keyframes (linear between them; the curve is a smoothstep). */
  var OLED_DRIFT_SCALE_IN_STEPS = 12;
  /** A test-only freeze (SEEK with pause: true in debug mode) plays on by itself after this long. */
  var DEBUG_FREEZE_RELEASE_MS = 3 * 60 * 1000;
  /** Playing, but nobody has touched a phone or the remote for 3 hours: stop. */
  var UNATTENDED_STOP_MS = 3 * 60 * 60 * 1000;
  /** How often receiver.js checks (the stop happens at most this much later than the limit). */
  var CHECK_INTERVAL_MS = 30 * 1000;

  /**
   * Why the TV page should stop now, or null to keep going.
   *
   * @param {object} state
   * @param {number} state.now                      Date.now()
   * @param {number|null} state.nothingToShowSince  when the page last had nothing to show (page start,
   *                                                or the "couldn't load the artworks" screen); null
   *                                                while a play list is loading or playing
   * @param {number|null} state.pausedSince         when the slideshow was paused, or last browsed by hand
   *                                                (NEXT / PREVIOUS) while paused; null while it plays
   * @param {number} state.lastActivity             last phone message or TV remote key
   * @param {"slideshow"|"wall"} [state.mode]       what plays (default the slideshow); a paused wall stops sooner
   * @returns {"idle"|"paused"|"unattended"|null}
   */
  function autoStopReason(state) {
    var now = state.now;
    if (state.nothingToShowSince != null && now - state.nothingToShowSince >= NOTHING_TO_SHOW_STOP_MS) return "idle";
    if (state.nothingToShowSince != null) return null; // the idle rule owns this screen
    if (state.pausedSince != null && now - state.pausedSince >= pausedStopMs(state.mode)) return "paused";
    if (now - state.lastActivity >= UNATTENDED_STOP_MS) return "unattended";
    return null;
  }

  /** How long the TV page stays paused before it stops: 10 min for a wall, 20 min for the slideshow. */
  function pausedStopMs(mode) {
    return mode === "wall" ? WALL_PAUSED_STOP_MS : PAUSED_STOP_MS;
  }

  /**
   * Whether the paused wall should drift now: wall mode, paused, and still for OLED_DRIFT_START_MS.
   *
   * @param {object} state
   * @param {number} state.now
   * @param {"slideshow"|"wall"} state.mode
   * @param {number|null} state.stillSince  when the wall last stopped moving while paused (the pause, a
   *                                        NEXT / PREVIOUS while paused, a test SEEK); null while it plays
   * @returns {boolean}
   */
  function oledDriftDue(state) {
    return state.mode === "wall" && state.stillSince != null && state.now - state.stillSince >= OLED_DRIFT_START_MS;
  }

  /**
   * The drift's offset in CSS px, `ms` after it started: a slow Lissajous path that starts at {0, 0}, is
   * continuous, and never goes further than OLED_DRIFT_AMPLITUDE_PX each way. Top speed is about 0.2 px/s,
   * far below what a viewer sees as motion.
   *
   * @param {number} ms  time since the drift started (negative counts as 0)
   * @returns {{x: number, y: number}}
   */
  function oledDriftOffset(ms) {
    var t = Math.max(0, ms || 0);
    return {
      x: OLED_DRIFT_AMPLITUDE_PX * Math.sin((2 * Math.PI * t) / OLED_DRIFT_PERIOD_X_MS),
      y: OLED_DRIFT_AMPLITUDE_PX * Math.sin((2 * Math.PI * t) / OLED_DRIFT_PERIOD_Y_MS),
    };
  }

  /** The wall's scale `ms` after the drift started: 1 -> OLED_DRIFT_SCALE (smoothstep) over the scale-in, then constant. */
  function oledDriftScale(ms) {
    var u = Math.min(1, Math.max(0, (ms || 0) / OLED_DRIFT_SCALE_IN_MS));
    return 1 + (OLED_DRIFT_SCALE - 1) * u * u * (3 - 2 * u);
  }

  function transformCss(x, y, scale) {
    return "translate(" + x + "px, " + y + "px) scale(" + Math.round(scale * 100000) / 100000 + ")";
  }

  /**
   * The drift's transform `ms` after it started. During the scale-in: no offset, the scale growing (receiver.js
   * runs that minute as one Web Animation, oledDriftScaleInKeyframes). After it: the full scale and the
   * Lissajous offset (oledDriftOffset of the time since the scale-in ended), rounded to whole device pixels
   * so the still picture stays sharp (no sub-pixel resampling). receiver.js writes it as a static transform
   * only when it changes (about one device px every few seconds).
   *
   * @param {number} ms   time since the drift started
   * @param {number} dpr  device pixels per CSS px (2 on the Sony)
   * @returns {{x: number, y: number, scale: number, transform: string}}  x / y in CSS px, already rounded
   */
  function oledDriftTransform(ms, dpr) {
    var d = dpr > 0 ? dpr : 1;
    var scale = oledDriftScale(ms);
    if (ms < OLED_DRIFT_SCALE_IN_MS) return { x: 0, y: 0, scale: scale, transform: transformCss(0, 0, scale) };
    var offset = oledDriftOffset(ms - OLED_DRIFT_SCALE_IN_MS);
    var x = Math.round(offset.x * d) / d + 0; // + 0 turns -0 into 0
    var y = Math.round(offset.y * d) / d + 0;
    return { x: x, y: y, scale: scale, transform: transformCss(x, y, scale) };
  }

  /** Keyframes of the scale-in (Web Animation of `transform` on the wall stage, OLED_DRIFT_SCALE_IN_MS long). */
  function oledDriftScaleInKeyframes() {
    var frames = [];
    for (var i = 0; i <= OLED_DRIFT_SCALE_IN_STEPS; i++) {
      var offset = i / OLED_DRIFT_SCALE_IN_STEPS;
      frames.push({ offset: offset, transform: transformCss(0, 0, oledDriftScale(offset * OLED_DRIFT_SCALE_IN_MS)) });
    }
    return frames;
  }

  /**
   * Whether a test-only freeze (SEEK with pause: true) should play on now.
   *
   * @param {object} state
   * @param {number} state.now
   * @param {number|null} state.frozenSince  the last SEEK that froze the picture; null when none is in force
   * @returns {boolean}
   */
  function debugFreezeReleaseDue(state) {
    return state.frozenSince != null && state.now - state.frozenSince >= DEBUG_FREEZE_RELEASE_MS;
  }

  var api = {
    NOTHING_TO_SHOW_STOP_MS: NOTHING_TO_SHOW_STOP_MS,
    PAUSED_STOP_MS: PAUSED_STOP_MS,
    WALL_PAUSED_STOP_MS: WALL_PAUSED_STOP_MS,
    OLED_DRIFT_START_MS: OLED_DRIFT_START_MS,
    OLED_DRIFT_AMPLITUDE_PX: OLED_DRIFT_AMPLITUDE_PX,
    OLED_DRIFT_PERIOD_X_MS: OLED_DRIFT_PERIOD_X_MS,
    OLED_DRIFT_PERIOD_Y_MS: OLED_DRIFT_PERIOD_Y_MS,
    OLED_DRIFT_SCALE: OLED_DRIFT_SCALE,
    OLED_DRIFT_SCALE_IN_MS: OLED_DRIFT_SCALE_IN_MS,
    DEBUG_FREEZE_RELEASE_MS: DEBUG_FREEZE_RELEASE_MS,
    UNATTENDED_STOP_MS: UNATTENDED_STOP_MS,
    CHECK_INTERVAL_MS: CHECK_INTERVAL_MS,
    autoStopReason: autoStopReason,
    pausedStopMs: pausedStopMs,
    oledDriftDue: oledDriftDue,
    oledDriftOffset: oledDriftOffset,
    oledDriftScale: oledDriftScale,
    oledDriftTransform: oledDriftTransform,
    oledDriftScaleInKeyframes: oledDriftScaleInKeyframes,
    debugFreezeReleaseDue: debugFreezeReleaseDue,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaIdle = api;
  }
})(typeof window !== "undefined" ? window : this);
