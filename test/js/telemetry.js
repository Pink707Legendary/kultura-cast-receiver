/**
 * KULTURA Cast Receiver — error reporting to Sentry (no personal data).
 *
 * This file loads Sentry's official CDN loader (async, after startup; see init) and wraps
 * the few things we report: uncaught errors (automatic once the SDK loads), image load failures and
 * engine stalls. Every event carries the engine diagnostics (same object as STATUS.debug), so a
 * failure on someone's TV can be read in Sentry without access to the TV.
 *
 * Privacy: no user ids, emails or names; artwork ids and the TV's model/user agent only.
 * Without the loader (dev.html, Jest) every call is a no-op.
 */
(function (root) {
  "use strict";

  /** Public DSN of the KULTURA app's Sentry project. Keep in sync with app/_layout.tsx. */
  var SENTRY_DSN = "https://9d08e7fa3ed69d5a42aa566d0e8cb198@o4510650021904384.ingest.us.sentry.io/4510849713831936";
  /** One page session should never flood Sentry, whatever goes wrong. */
  var MAX_EVENTS_PER_PAGE = 30;

  /** Sentry's official CDN loader for that DSN's public key. */
  var SENTRY_LOADER_URL = "https://js.sentry-cdn.com/9d08e7fa3ed69d5a42aa566d0e8cb198.min.js";
  /** Reports made before Sentry has loaded are kept (up to this many) and sent once it is ready. */
  var MAX_QUEUED_REPORTS = 20;

  var eventsSent = 0;
  var reportedOnce = {};
  var sentryReady = false;
  var queuedReports = [];
  var getDiagnostics = function () {
    return {};
  };

  /** Sentry, only once our init has run (before that, reports are queued). */
  function sentry() {
    var s = root.Sentry;
    return sentryReady && s && typeof s.captureMessage === "function" ? s : null;
  }

  function sendOrQueue(report) {
    var s = sentry();
    if (s) {
      report(s);
    } else if (queuedReports.length < MAX_QUEUED_REPORTS) {
      queuedReports.push(report);
    }
  }

  function initSentry(version) {
    var s = root.Sentry;
    if (sentryReady || !s || typeof s.init !== "function") return;
    s.init({
      dsn: SENTRY_DSN,
      release: "kultura-cast-receiver@" + version,
      environment: "production",
      sendDefaultPii: false,
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      // The loader may add session replay and tracing (project settings); a TV slideshow needs
      // neither, and replay's DOM recording would cost frames on slow TV chips.
      integrations: function (defaults) {
        return defaults.filter(function (integration) {
          return integration.name !== "Replay" && integration.name !== "BrowserTracing";
        });
      },
      initialScope: { tags: { component: "cast-receiver", receiverVersion: version } },
      beforeSend: function (event) {
        if (eventsSent >= MAX_EVENTS_PER_PAGE) return null;
        eventsSent++;
        event.contexts = event.contexts || {};
        try {
          event.contexts.receiver = getDiagnostics();
        } catch (e) {
          event.contexts.receiver = { error: "diagnostics unavailable" };
        }
        delete event.user;
        return event;
      },
    });
    sentryReady = true;
    var pending = queuedReports;
    queuedReports = [];
    for (var i = 0; i < pending.length; i++) pending[i](s);
  }

  /**
   * Start error reporting without ever delaying the slideshow: the Sentry loader is added as an
   * async script after the receiver has started, and may arrive late or never (blocked or stalled
   * CDN); reports made meanwhile are queued. Only pages that opt in with
   * <body data-telemetry="sentry"> (index.html) load it; dev.html and tests stay offline.
   */
  function init(options) {
    getDiagnostics = options.getDiagnostics || getDiagnostics;
    var doc = root.document;
    if (!doc || !doc.body || doc.body.getAttribute("data-telemetry") !== "sentry") return;
    var whenLoaded = function () {
      initSentry(options.version);
    };
    // The loader calls this once the SDK is in; Sentry.onLoad below also forces the lazy loader to fetch it.
    root.sentryOnLoad = whenLoaded;
    var script = doc.createElement("script");
    script.src = SENTRY_LOADER_URL;
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = function () {
      if (root.Sentry && typeof root.Sentry.onLoad === "function") root.Sentry.onLoad(whenLoaded);
    };
    doc.head.appendChild(script);
  }

  /** Report once per key (per page session) so a repeating problem is one event, not hundreds. */
  function reportMessage(message, level, extra, onceKey) {
    if (onceKey) {
      if (reportedOnce[onceKey]) return;
      reportedOnce[onceKey] = true;
    }
    sendOrQueue(function (s) {
      s.captureMessage(message, {
        level: level,
        tags: { component: "cast-receiver", category: extra && extra.category ? extra.category : "engine" },
        extra: extra || {},
        fingerprint: ["cast-receiver", message],
      });
    });
  }

  function reportImageFailure(artworkId, reason) {
    reportMessage("Cast receiver: image failed to load", "warning", { category: "image", artworkId: artworkId, reason: reason }, "image:" + artworkId);
  }

  /** The large image failed and the normal one was used instead (a missing zoom file on the CDN). */
  function reportImageFallback(artworkId, reason) {
    reportMessage("Cast receiver: large image failed, used fallback", "warning", { category: "image", artworkId: artworkId, reason: reason }, "fallback:" + artworkId);
  }

  function reportStall(reason, extra) {
    var details = extra || {};
    details.category = "stall";
    details.reason = reason;
    reportMessage("Cast receiver: engine stalled (" + reason + ")", "error", details, null);
  }

  function reportError(error, extra) {
    sendOrQueue(function (s) {
      s.captureException(error, { tags: { component: "cast-receiver" }, extra: extra || {} });
    });
  }

  root.KulturaTelemetry = {
    init: init,
    reportMessage: reportMessage,
    reportImageFailure: reportImageFailure,
    reportImageFallback: reportImageFallback,
    reportStall: reportStall,
    reportError: reportError,
  };
})(typeof window !== "undefined" ? window : this);
