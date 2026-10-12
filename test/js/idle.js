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
  /** Paused (by a phone or the TV remote): stop after 20 min. */
  var PAUSED_STOP_MS = 20 * 60 * 1000;
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
   * @returns {"idle"|"paused"|"unattended"|null}
   */
  function autoStopReason(state) {
    var now = state.now;
    if (state.nothingToShowSince != null && now - state.nothingToShowSince >= NOTHING_TO_SHOW_STOP_MS) return "idle";
    if (state.nothingToShowSince != null) return null; // the idle rule owns this screen
    if (state.pausedSince != null && now - state.pausedSince >= PAUSED_STOP_MS) return "paused";
    if (now - state.lastActivity >= UNATTENDED_STOP_MS) return "unattended";
    return null;
  }

  var api = {
    NOTHING_TO_SHOW_STOP_MS: NOTHING_TO_SHOW_STOP_MS,
    PAUSED_STOP_MS: PAUSED_STOP_MS,
    UNATTENDED_STOP_MS: UNATTENDED_STOP_MS,
    CHECK_INTERVAL_MS: CHECK_INTERVAL_MS,
    autoStopReason: autoStopReason,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaIdle = api;
  }
})(typeof window !== "undefined" ? window : this);
