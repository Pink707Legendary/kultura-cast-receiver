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

  /** Available texture slugs, in the order shown on the comparison page. */
  var TEXTURES = ["t1-linen", "t2-matboard", "t3-canvas", "t4-felt", "t5-plaster", "t6-silk"];
  var DEFAULT_TEXTURE = "t1-linen";

  /** Final lightness of the tint for each mood (0..1); the texture's own grain sits on top. */
  var MOOD_LIGHTNESS = { light: 0.94, dark: 0.25 };
  /** Maximum saturation kept from the painting's colour: a whisper of its hue, never a colour field. */
  var MAX_SATURATION = { light: 0.14, dark: 0.18 };
  /** Paintings whose dominant colour is darker than this get the dark backdrop in "auto" mood. */
  var DARK_PAINTING_LUMINANCE = 0.2;

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

  /** "light" mat for light paintings, "dark" fabric for dark ones (most old masters). */
  function chooseMood(mainColor) {
    return luminance(parseHex(mainColor)) < DARK_PAINTING_LUMINANCE ? "dark" : "light";
  }

  /** Tint for the backdrop: the painting's hue, heavily muted, at the mood's lightness. */
  function backdropTint(mainColor, mood) {
    var hsl = rgbToHsl(parseHex(mainColor));
    return hslToHex({ h: hsl.h, s: Math.min(hsl.s, MAX_SATURATION[mood]), l: MOOD_LIGHTNESS[mood] });
  }

  /** Everything the TV needs to paint the backdrop for one artwork. */
  function backdropFor(mainColor, texture, moodSetting) {
    var mood = moodSetting === "light" || moodSetting === "dark" ? moodSetting : chooseMood(mainColor);
    var slug = texture === "none" ? null : TEXTURES.indexOf(texture) >= 0 ? texture : DEFAULT_TEXTURE;
    return { texture: slug, mood: mood, tint: backdropTint(mainColor, mood) };
  }

  var api = {
    TEXTURES: TEXTURES,
    DEFAULT_TEXTURE: DEFAULT_TEXTURE,
    luminance: luminance,
    parseHex: parseHex,
    chooseMood: chooseMood,
    backdropTint: backdropTint,
    backdropFor: backdropFor,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.KulturaBackdrop = api;
  }
})(typeof window !== "undefined" ? window : this);
