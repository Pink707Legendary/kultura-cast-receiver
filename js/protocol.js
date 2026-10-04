/**
 * KULTURA Cast Receiver — message validation (pure functions, no DOM).
 *
 * The phone <-> TV protocol is defined on the phone side in types/cast.ts; this file is the
 * TV's defensive reading of it. Anything malformed is dropped rather than half-applied, and
 * images are only loaded from KULTURA's own image CDN.
 *
 * Loaded by the TV page as a plain script (window.KulturaProtocol) and by Jest via module.exports.
 */
(function (root) {
  "use strict";

  var PROTOCOL_VERSION = 2;

  /** Image hosts the TV will load from. Anything else is ignored. */
  var ALLOWED_IMAGE_PREFIXES = ["https://d3bptqubukeepm.cloudfront.net/"];

  /** Longest source name kept (the phone compares against the same cut; api/cast.ts). */
  var SOURCE_NAME_MAX_LENGTH = 120;

  /** Gallery choreography (motion.js): "gentle" focus is the default; "still" never moves. */
  var MOTION_MODES = ["gentle", "still"];
  var DEFAULT_MOTION = "gentle";

  var MIN_SECONDS = 10;
  var MAX_SECONDS = 600;
  var DEFAULT_SECONDS = 45;

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function isAllowedImageUrl(url) {
    if (typeof url !== "string") return false;
    for (var i = 0; i < ALLOWED_IMAGE_PREFIXES.length; i++) {
      if (url.indexOf(ALLOWED_IMAGE_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  function shortText(value, maxLength) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function readFocus(focus) {
    if (!focus || typeof focus !== "object") return null;
    var keys = ["x0", "y0", "x1", "y1"];
    for (var i = 0; i < keys.length; i++) {
      var v = focus[keys[i]];
      if (!isFiniteNumber(v) || v < 0 || v > 1) return null;
    }
    if (focus.x1 <= focus.x0 || focus.y1 <= focus.y0) return null;
    return { x0: focus.x0, y0: focus.y0, x1: focus.x1, y1: focus.y1 };
  }

  /** At most this many points of interest per artwork are kept (keeps a Cast message under its 64 KiB cap). */
  var MAX_POI_POINTS = 4;

  /** One point of interest: box [x0, y0, x1, y1] as fractions of the image, confidence 0..1 (required). */
  function readPoint(point) {
    if (!point || typeof point !== "object" || !Array.isArray(point.box) || point.box.length !== 4) return null;
    for (var i = 0; i < 4; i++) {
      var v = point.box[i];
      if (!isFiniteNumber(v) || v < 0 || v > 1) return null;
    }
    if (point.box[2] <= point.box[0] || point.box[3] <= point.box[1]) return null;
    var c = point.confidence;
    // Untrusted input: a point whose confidence is missing or invalid is dropped, never guessed (it decides depth).
    if (!isFiniteNumber(c) || c < 0 || c > 1) return null;
    return { box: point.box.slice(), confidence: c };
  }

  /**
   * Optional points of interest (additive, still protocol 2; receivers from 2.7.0 use them, older ones
   * ignore the field): { moveWorthy, points: [{ box, confidence }] } ranked, most important first.
   * Invalid points are dropped; a poi with no valid point is dropped too, unless it says not to move. A poi
   * whose moveWorthy is not a boolean is dropped whole (it would decide between moving and staying still),
   * so the artwork falls back to its AI-crop focus as before 2.7.0.
   */
  function readPoi(poi) {
    if (!poi || typeof poi !== "object" || typeof poi.moveWorthy !== "boolean") return null;
    var moveWorthy = poi.moveWorthy;
    var points = [];
    var raw = Array.isArray(poi.points) ? poi.points : [];
    for (var i = 0; i < raw.length && points.length < MAX_POI_POINTS; i++) {
      var p = readPoint(raw[i]);
      if (p) points.push(p);
    }
    if (!points.length && moveWorthy) return null;
    return { moveWorthy: moveWorthy, points: points };
  }

  /** Returns a clean artwork object, or null if it cannot be shown safely. */
  function readArtwork(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (!isFiniteNumber(raw.id) || !isAllowedImageUrl(raw.imageUrl)) return null;
    var colour = typeof raw.mainColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.mainColor) ? raw.mainColor : "#000000";
    // The API sends Android-style #AARRGGBB; CSS would read that as #RRGGBBAA. Keep the RGB part.
    if (colour.length === 9) colour = "#" + colour.slice(3);
    var artwork = {
      id: raw.id,
      title: shortText(raw.title, 200),
      artist: shortText(raw.artist, 120),
      date: shortText(raw.date, 40),
      imageUrl: raw.imageUrl,
      mainColor: colour,
      focus: readFocus(raw.focus),
      poi: readPoi(raw.poi),
    };
    // Optional second image (the normal size) tried when imageUrl (the zoom tier) fails to load.
    if (isAllowedImageUrl(raw.fallbackImageUrl) && raw.fallbackImageUrl !== raw.imageUrl) {
      artwork.fallbackImageUrl = raw.fallbackImageUrl;
    }
    return artwork;
  }

  function readArtworkList(list) {
    if (!Array.isArray(list)) return [];
    var clean = [];
    for (var i = 0; i < list.length; i++) {
      var artwork = readArtwork(list[i]);
      if (artwork) clean.push(artwork);
    }
    return clean;
  }

  /** Optional id the phone puts on each LOAD_MANIFEST; echoed in STATUS so the phone knows its list arrived. */
  function readManifestId(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
  }

  function readSeconds(value) {
    if (!isFiniteNumber(value)) return null;
    return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(value)));
  }

  /** Backdrop setting: { texture: slug | "none", mood: "auto" | "light" | "dark" }; slugs are checked by backdrop.js. */
  function readBackdrop(value) {
    if (!value || typeof value !== "object") return null;
    var texture = typeof value.texture === "string" && /^[a-z0-9-]{1,40}$/.test(value.texture) ? value.texture : null;
    var mood = value.mood === "light" || value.mood === "dark" || value.mood === "auto" ? value.mood : null;
    if (!texture && !mood) return null;
    return { texture: texture, mood: mood };
  }

  /**
   * Parse one incoming message into a validated command, or null to ignore it.
   * Accepts either a JSON string or an already-parsed object (the Cast SDK delivers both).
   */
  function parseMessage(data) {
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return null;
      }
    }
    if (!data || typeof data !== "object" || typeof data.type !== "string") return null;

    switch (data.type) {
      case "LOAD_MANIFEST": {
        var artworks = readArtworkList(data.artworks);
        if (artworks.length === 0) return null;
        return {
          type: "LOAD_MANIFEST",
          sourceName: shortText(data.sourceName, SOURCE_NAME_MAX_LENGTH),
          manifestId: readManifestId(data.manifestId),
          artworks: artworks,
          secondsPerArtwork: readSeconds(data.secondsPerArtwork),
        };
      }
      case "APPEND_ARTWORKS": {
        var more = readArtworkList(data.artworks);
        return more.length > 0 ? { type: "APPEND_ARTWORKS", artworks: more } : null;
      }
      case "SET_SETTINGS": {
        var seconds = readSeconds(data.secondsPerArtwork);
        var backdrop = readBackdrop(data.backdrop);
        var motion = MOTION_MODES.indexOf(data.motion) >= 0 ? data.motion : null;
        if (!seconds && !backdrop && !motion) return null;
        var settings = { type: "SET_SETTINGS" };
        if (seconds) settings.secondsPerArtwork = seconds;
        if (backdrop) settings.backdrop = backdrop;
        if (motion) settings.motion = motion;
        return settings;
      }
      // Test-only (scripts/tv_capture.py, never sent by the app). The receiver acts on SEEK only in
      // debug mode: page URL with ?debug, or after DEBUG_MODE {enabled: true} in this session.
      case "DEBUG_MODE":
        return typeof data.enabled === "boolean" ? { type: "DEBUG_MODE", enabled: data.enabled } : null;
      case "SEEK":
        if (!isFiniteNumber(data.timeMs) || data.timeMs < 0 || data.timeMs > MAX_SECONDS * 1000) return null;
        return { type: "SEEK", timeMs: data.timeMs, pause: data.pause === true };
      case "NEXT":
      case "PREVIOUS":
      case "PAUSE":
      case "RESUME":
      case "GET_STATUS":
        return { type: data.type };
      default:
        return null;
    }
  }

  var api = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    SOURCE_NAME_MAX_LENGTH: SOURCE_NAME_MAX_LENGTH,
    DEFAULT_MOTION: DEFAULT_MOTION,
    DEFAULT_SECONDS: DEFAULT_SECONDS,
    MIN_SECONDS: MIN_SECONDS,
    MAX_SECONDS: MAX_SECONDS,
    isAllowedImageUrl: isAllowedImageUrl,
    readArtwork: readArtwork,
    parseMessage: parseMessage,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaProtocol = api;
  }
})(typeof window !== "undefined" ? window : this);
