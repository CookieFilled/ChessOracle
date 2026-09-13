/* ChessOracle — shared protocol constants & tiny utils (ISOLATED world) */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || { version: '1.0.0' };

  O.MSG = {
    ENSURE_OFFSCREEN: 'co:ensure-offscreen',
    ENGINE_ANALYZE: 'co:engine:analyze',
    ENGINE_STOP: 'co:engine:stop',
    ENGINE_RESET: 'co:engine:reset',
    ENGINE_STATUS: 'co:engine:status',
    ENGINE_INFO: 'co:engine:info',       // offscreen -> SW -> tab
    ENGINE_RESULT: 'co:engine:result',   // SW -> tab (relay)
    AUTOPLAY_STATE: 'co:autoplay-state', // content -> SW (badge)
    PANEL_TOGGLE: 'co:panel-toggle',     // popup -> content
    STATUS_QUERY: 'co:status-query',     // popup -> content
    SETTINGS_BROADCAST: 'co:settings-broadcast',
  };

  O.util = {
    clamp: function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    now: function () { return Date.now(); },
    uid: function () { return Math.random().toString(36).slice(2, 10); },
    // seeded RNG (mulberry32) for reproducible tests; falls back to Math.random
    rng: function (seed) {
      var s = seed >>> 0;
      return function () {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        var t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    fmtEval: function (score) {
      if (!score) return '0.0';
      if (score.mate != null) return 'M' + (score.mate > 0 ? '' : '-') + Math.abs(score.mate);
      var v = score.cp / 100;
      return (v > 0 ? '+' : v < 0 ? '' : '') + v.toFixed(2);
    },
    winPctFromScore: function (score) { // 0..100 for the side that is moving
      if (!score) return 50;
      if (score.mate != null) {
        var m = score.mate;
        return m > 0 ? Math.max(92, 100 - m * 2) : Math.min(8, m * 2 + 8);
      }
      var cp = O.util.clamp(score.cp, -4000, 4000);
      return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
    },
    throttle: function (fn, ms) {
      var last = 0, timer = null, pendingArgs = null;
      return function () {
        var args = arguments, self = this, t = O.util.now();
        if (t - last >= ms) { last = t; fn.apply(self, args); }
        else {
          pendingArgs = args;
          if (!timer) timer = setTimeout(function () {
            timer = null; last = O.util.now();
            fn.apply(self, pendingArgs);
          }, ms - (t - last));
        }
      };
    },
    log: function () {
      if (O.debug) {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[ChessOracle]');
        console.log.apply(console, a);
      }
    },
  };

  // simple pub/sub bus
  O.bus = {
    _subs: {},
    on: function (ev, fn) { (this._subs[ev] = this._subs[ev] || []).push(fn); return fn; },
    off: function (ev, fn) {
      var a = this._subs[ev] || [];
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    emit: function (ev, data) {
      var a = (this._subs[ev] || []).slice();
      for (var i = 0; i < a.length; i++) { try { a[i](data); } catch (e) { O.util.log('bus error', ev, e); } }
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
