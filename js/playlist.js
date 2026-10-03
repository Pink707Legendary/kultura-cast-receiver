/**
 * KULTURA Cast Receiver — play list rules and engine watchdog (pure functions, no DOM).
 *
 * Kept apart from receiver.js so the takeover rule and the stall detector are unit-tested
 * (__tests__/cast-receiver/playlist.test.ts). Loaded by the TV page as a plain script
 * (window.KulturaPlaylist) and by Jest via module.exports.
 */
(function (root) {
  "use strict";

  /** A load still pending this long after its worst-case deadline is stuck. */
  var LOADING_GRACE_MS = 5000;

  /**
   * Longest one artwork can legitimately take to load in receiver.js: the large image's timeout,
   * then the fallback image's timeout, then the capped decode wait.
   */
  function worstCaseLoadMs(imageLoadTimeoutMs, decodeWaitMaxMs) {
    return 2 * imageLoadTimeoutMs + decodeWaitMaxMs;
  }

  function createPlaylist() {
    return { artworks: [], sourceName: "", manifestId: null, ownerSenderId: null, generation: 0 };
  }

  /**
   * Apply a validated LOAD_MANIFEST or APPEND_ARTWORKS command (see protocol.js).
   *
   * Takeover rule: LOAD_MANIFEST always replaces the list, whoever sent it and whatever was playing.
   * APPEND_ARTWORKS only extends the list started by the same sender, so the leftover batches of a
   * phone that was just taken over cannot mix into the new list. An unknown sender id (the dev page,
   * or a Cast SDK that does not report one) matches any list.
   *
   * Returns { playlist, restart }: restart=true means start again from the first artwork.
   * Returns null when the command changes nothing (an APPEND from another sender).
   */
  function applyManifestCommand(playlist, command, senderId) {
    var sender = senderId == null ? null : String(senderId);
    if (command.type === "LOAD_MANIFEST") {
      return {
        playlist: {
          artworks: command.artworks.slice(),
          sourceName: command.sourceName,
          manifestId: command.manifestId || null,
          ownerSenderId: sender,
          generation: playlist.generation + 1,
        },
        restart: true,
      };
    }
    if (command.type === "APPEND_ARTWORKS") {
      var owner = playlist.ownerSenderId;
      if (owner != null && sender != null && owner !== sender) return null;
      if (playlist.artworks.length === 0) return null;
      return {
        playlist: {
          artworks: playlist.artworks.concat(command.artworks),
          sourceName: playlist.sourceName,
          manifestId: playlist.manifestId,
          ownerSenderId: owner,
          generation: playlist.generation,
        },
        restart: false,
      };
    }
    return null;
  }

  /**
   * Engine watchdog, called every few seconds. Returns a short reason when the slideshow should have
   * moved on but has not, or null when all is well.
   *   - "loading-timeout": a load has been pending past its worst-case deadline (worstCaseLoadMs) plus
   *     a grace period, so the watchdog never cuts the fallback image short.
   *   - "animation-frozen": the slide is visible, not paused, but its animation has not advanced
   *     since the previous check (a finished animation whose onfinish never fired also looks like this).
   * Hidden pages (Google TV Ambient mode) are not stalls: browsers freeze animations there on purpose.
   */
  function detectEngineStall(s) {
    if (s.visibility !== "visible" || s.isPaused) return null;
    if (s.phase === "loading" && s.now - s.phaseStartedAt > s.loadDeadlineMs + LOADING_GRACE_MS) {
      return "loading-timeout";
    }
    if (
      s.phase === "playing" &&
      s.animationTimeMs != null &&
      s.previousAnimationTimeMs != null &&
      s.animationTimeMs === s.previousAnimationTimeMs
    ) {
      return "animation-frozen";
    }
    return null;
  }

  var api = {
    LOADING_GRACE_MS: LOADING_GRACE_MS,
    worstCaseLoadMs: worstCaseLoadMs,
    createPlaylist: createPlaylist,
    applyManifestCommand: applyManifestCommand,
    detectEngineStall: detectEngineStall,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaPlaylist = api;
  }
})(typeof window !== "undefined" ? window : this);
