/* ChessOracle — settings store (ISOLATED world, also used by popup & SW) */
(function (global) {
  'use strict';
  if (global.ChessOracleSettings) return;
  var O = global.ChessOracle = global.ChessOracle || {};

  var DEFAULTS = {
    enabled: true,
    panel: {
      open: true,
      collapsed: false,
      theme: 'dark',          // dark | light
      opacity: 0.94,
      pos: null,              // {x,y} fixed position; null = default
    },
    analysis: {
      depth: 16,              // max depth for live analysis
      movetime: 900,          // ms cap
      arrows: 3,              // how many arrows (0-3)
      ghost: true,            // ghost piece at destination
      threatArrow: false,     // show opponent's best reply when it's their turn
      evalBar: 'left',        // left | right | off
      badges: true,           // move quality badges on board
      graph: true,            // eval graph in panel
      log: true,              // move log in panel
    },
    autoplay: {
      on: false,
      elo: 1200,              // 400..2900
      bias: 120,              // strength bias (plays a bit above selected elo)
      safeFloor: true,        // never deliberately throw
      risk: 70,               // 0..100 risk tolerance for imperfections
      human: 'auto',          // auto | manual  (error-rate source)
      blunderRate: 4,         // per-100-move probabilities (manual mode)
      mistakeRate: 6,
      inaccuracyRate: 9,
      randomness: 35,         // general chaos 0..100
      color: 'auto',          // auto | white | black
      book: true,             // use opening book
      bookVariety: 55,
      timingMode: 'variable', // variable | fixed
      timeMin: 1.0,           // seconds
      timeMax: 4.0,
      timeFixed: 2.0,
      clockAware: true,
      openingFast: true,
      keepAlive: true,        // audio keepalive when tab hidden & autoplay on
    },
    autopilot: {
      on: false,
      mode: 'mixed',        // 'mixed' | 'win' | 'lose'  (per-game outcome plan)
      winRate: 62,          // % of games planned as wins (mixed mode)
      maxStreak: 4,         // soft cap on consecutive W/L in mixed mode
      gamesLimit: 0,        // 0 = endless session
      breakMin: 5,          // seconds between games (human pause)
      breakMax: 14,
      longBreakChance: 8,   // % chance of a coffee break
      longBreakMin: 25, longBreakMax: 70,
      resignWhenLost: 45,   // % chance to resign once clearly lost (realism)
      minResignPly: 10,     // never resign before this many plies
      sabotage: true,       // allow deliberate losing moves when plan = lose
      tryhard: true,        // claw back strength when plan = win and losing
      autoNavigate: true,   // go to the arena when idle without a board
      autoDismiss: true,    // dismiss blocking popups (welcome etc.)
      arena: 'online',      // 'online' (real opponents) | 'computer' (bots)
      allowRematch: false,  // never send rematch challenges by default
    },
    coach: {
      hanging: false,        // highlight hanging pieces
      alerts: true,           // blunder alert banner
      sound: false,
      hintOnDemand: true,
    },
    advanced: {
      debug: false,
      engineMovetimeCap: 1500,
    },
  };

  function deepMerge(base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  var listeners = [];

  var store = {
    data: deepMerge(DEFAULTS, {}),
    defaults: DEFAULTS,

    load: function () {
      return new Promise(function (resolve) {
        try {
          chrome.storage.local.get(['settings'], function (res) {
            if (res && res.settings) store.data = deepMerge(DEFAULTS, res.settings);
            resolve(store.data);
          });
        } catch (e) { resolve(store.data); }
      });
    },

    save: function () {
      try { chrome.storage.local.set({ settings: store.data }); } catch (e) {}
    },

    get: function (path) {
      var parts = path.split('.');
      var v = store.data;
      for (var i = 0; i < parts.length; i++) {
        if (v == null) return undefined;
        v = v[parts[i]];
      }
      return v;
    },

    set: function (path, value) {
      var parts = path.split('.');
      var v = store.data;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof v[parts[i]] !== 'object' || v[parts[i]] === null) v[parts[i]] = {};
        v = v[parts[i]];
      }
      v[parts[parts.length - 1]] = value;
      store.save();
      if (O.util && O.util.log) O.util.log('settings changed:', path, '=', value);
      store.notify(path, value);
    },

    patch: function (patchObj) {
      store.data = deepMerge(store.data, patchObj);
      store.save();
      store.notify('*', null);
    },

    notify: function (path, value) {
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](path, value, store.data); } catch (e) {}
      }
    },

    onChanged: function (fn) { listeners.push(fn); return fn; },

    reset: function () {
      store.data = deepMerge(DEFAULTS, {});
      store.save();
      store.notify('*', null);
    },
  };

  // cross-tab sync
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.settings) return;
        store.data = deepMerge(DEFAULTS, changes.settings.newValue || {});
        store.notify('*', null);
      });
    }
  } catch (e) {}

  global.ChessOracleSettings = store;
  O.settings = store;
})(typeof window !== 'undefined' ? window : globalThis);
