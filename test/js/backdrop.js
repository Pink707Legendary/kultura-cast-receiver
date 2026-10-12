/**
 * KULTURA Cast Receiver — backdrop (passe-partout / fabric) behind paintings that don't fill the screen.
 *
 * Textures are neutral light-grey images (cast-receiver/textures/<slug>.webp, made by
 * scripts/cast_textures.py). The TV multiplies them with a tint derived from the painting's own
 * dominant colour, muted almost to neutral, so the backdrop complements the work instead of fighting it.
 *
 * Pure functions: loaded by the TV page (window.KulturaBackdrop) and by Jest (module.exports).
 */
(function (root) {
  "use strict";

  /** Available texture slugs, in the order shown on the comparison page (still selectable). */
  var TEXTURES = ["t1-linen", "t2-matboard", "t3-canvas", "t4-felt", "t5-plaster", "t6-silk"];
  /**
   * Default backdrop: plain muted tint, no texture, no vignette (2.6.0). At the TV's 1080p page
   * resolution the textures read as coarse upholstery and compete with the painting (2026-10-03).
   */
  var DEFAULT_TEXTURE = "none";

  /**
   * The wall is always dark (2.6.0): lightness 0.10 for dark paintings up to 0.16 for light ones. The
   * old light mood (lightness 0.94) is gone: a near-white field makes the OLED's automatic brightness
   * limiter dim the painting itself, and dark walls are how museums hang old masters.
   */
  var WALL_LIGHTNESS_MIN = 0.1;
  var WALL_LIGHTNESS_MAX = 0.16;
  /** Painting luminance at which the wall reaches its lightest. */
  var LIGHT_PAINTING_LUMINANCE = 0.5;
  /** Maximum saturation kept from the painting's colour: a whisper of its hue, never a colour field. */
  var MAX_SATURATION = 0.18;

  function parseHex(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 8) h = h.slice(2); // API sends #AARRGGBB
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 };
  }

  /** Relative luminance (sRGB, 0..1) — how light the colour looks. */
  function luminance(rgb) {
    function lin(c) {
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  function rgbToHsl(rgb) {
    var max = Math.max(rgb.r, rgb.g, rgb.b);
    var min = Math.min(rgb.r, rgb.g, rgb.b);
    var l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l };
    var d = max - min;
    var s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    var h;
    if (max === rgb.r) h = (rgb.g - rgb.b) / d + (rgb.g < rgb.b ? 6 : 0);
    else if (max === rgb.g) h = (rgb.b - rgb.r) / d + 2;
    else h = (rgb.r - rgb.g) / d + 4;
    return { h: h / 6, s: s, l: l };
  }

  function hslToHex(hsl) {
    function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    var r, g, b;
    if (hsl.s === 0) {
      r = g = b = hsl.l;
    } else {
      var q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
      var p = 2 * hsl.l - q;
      r = hue2rgb(p, q, hsl.h + 1 / 3);
      g = hue2rgb(p, q, hsl.h);
      b = hue2rgb(p, q, hsl.h - 1 / 3);
    }
    function hex(c) {
      var v = Math.round(c * 255).toString(16);
      return v.length === 1 ? "0" + v : v;
    }
    return "#" + hex(r) + hex(g) + hex(b);
  }

  /** Lightness of the wall for a painting: 0.10 (dark painting) to 0.16 (light painting). */
  function wallLightness(mainColor) {
    var t = Math.min(1, luminance(parseHex(mainColor)) / LIGHT_PAINTING_LUMINANCE);
    return WALL_LIGHTNESS_MIN + (WALL_LIGHTNESS_MAX - WALL_LIGHTNESS_MIN) * t;
  }

  /** Tint for the wall: the painting's hue, heavily muted, dark. */
  function backdropTint(mainColor) {
    var hsl = rgbToHsl(parseHex(mainColor));
    return hslToHex({ h: hsl.h, s: Math.min(hsl.s, MAX_SATURATION), l: wallLightness(mainColor) });
  }

  /**
   * Everything the TV needs to paint the wall for one artwork. The mood setting is still accepted
   * (protocol 2) but the wall is always dark now, so it no longer changes anything.
   */
  function backdropFor(mainColor, texture) {
    var mood = "dark";
    // A known texture slug when chosen; anything else (incl. "none" and unknown slugs) is the plain tint.
    var slug = TEXTURES.indexOf(texture) >= 0 ? texture : null;
    return { texture: slug, mood: mood, tint: backdropTint(mainColor) };
  }

  var api = {
    TEXTURES: TEXTURES,
    DEFAULT_TEXTURE: DEFAULT_TEXTURE,
    luminance: luminance,
    parseHex: parseHex,
    wallLightness: wallLightness,
    backdropTint: backdropTint,
    backdropFor: backdropFor,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaBackdrop = api;
  }
})(typeof window !== "undefined" ? window : this);
