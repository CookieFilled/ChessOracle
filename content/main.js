/* ChessOracle — content script bootstrap & orchestration (ISOLATED world) */
(function (global) {
  'use strict';
  if (global.__ChessOracleBooted) return;

  async function boot() {
    var O = global.ChessOracle;
    var U = O.util;

    var site = O.detectSite();
    if (!site) { U.log('no supported site — staying dormant'); return; }
    global.__ChessOracleBooted = true;

    await O.settings.load();
    O.debug = O.settings.get('advanced.debug') || false;
    U.log('booting on', site.id, location.pathname);

    if (!O.settings.get('enabled')) {
      U.log('extension disabled in settings');
    }

    /* ---- engine client ---- */
    var ec = new O.EngineClient();
    O.ec = ec;
    ec.ensure();

    /* ---- modules ---- */
    var bw = new O.BoardWatcher(site);
    O.bw = bw;
    bw.start();

    var gs = new O.GameState(bw, site, O.settings);
    O.gs = gs;

    var exec = new O.MoveExecutor(bw, gs, site);
    O.exec = exec;

    var analyzer = new O.Analyzer(gs, ec, O.settings);
    O.analyzer = analyzer;

    var overlays = new O.OverlayManager(bw, gs, O.settings, site);
    O.overlays = overlays;

    var autoplay = new O.AutoPlayer(gs, bw, exec, analyzer, O.settings, site);
    O.autoplay = autoplay;

    var autopilot = new O.Autopilot(gs, bw, autoplay, exec, O.settings, site, analyzer);
    O.autopilot = autopilot;

    var panel = new O.Panel({ gs: gs, bw: bw, analyzer: analyzer, settings: O.settings, site: site, autoplay: autoplay, autopilot: autopilot, exec: exec, overlays: overlays, ec: ec });
    O.panel = panel;

    /* ---- analysis params: autoplay-aware ---- */
    analyzer.setParamsProvider(function () {
      var s = O.settings.data;
      if (s.autoplay.on && s.enabled) {
        var p = O.selection.engineParamsFor(s.autoplay.elo, s.autoplay.bias);
        p.multipv = 5;
        return p;
      }
      return {
        depth: O.util.clamp(s.analysis.depth, 6, 24),
        movetime: O.util.clamp(s.analysis.movetime, 200, 3000),
        multipv: O.util.clamp((s.analysis.arrows || 3) + 1, 3, 5),
        skill: 20,
      };
    });

    /* ---- move eval feeding (classification) is handled inside the analyzer ---- */

    /* ---- keyboard shortcuts ---- */
    global.addEventListener('keydown', function (e) {
      if (!e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === 'h') {
        var a = analyzer.lastResult;
        var uci = a && (a.bestmove || (a.lines[0] && a.lines[0].uci));
        if (uci) overlays.showHint(uci, 2600);
      } else if (k === 'b') {
        var cur = O.settings.get('autoplay.on');
        O.settings.set('autoplay.on', !cur);
        panel.toast(!cur ? 'Autoplay ON (' + O.settings.get('autoplay.elo') + ')' : 'Autoplay OFF', !cur ? 'ok' : 'warn');
      } else if (k === 'o') {
        var apOn = !O.settings.get('autopilot.on');
        O.settings.set('autopilot.on', apOn);
        panel.toast(apOn ? 'Autopilot ON — hands-free session' : 'Autopilot OFF', apOn ? 'ok' : 'warn');
      } else if (k === 'a') {
        var n = (O.settings.get('analysis.arrows') + 1) % 4;
        O.settings.set('analysis.arrows', n);
        panel.toast('Arrows: ' + (n === 0 ? 'off' : n), 'ok');
      } else if (k === 'p') {
        var open = O.settings.get('panel.open');
        if (open && !O.settings.get('panel.collapsed')) {
          O.settings.set('panel.collapsed', true);
        } else {
          O.settings.set('panel.open', true);
          O.settings.set('panel.collapsed', false);
        }
        panel.render();
      }
    }, true);

    /* ---- external control (popup / tests) ---- */
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === O.MSG.PANEL_TOGGLE) {
        var collapsed = O.settings.get('panel.collapsed');
        O.settings.set('panel.open', true);
        O.settings.set('panel.collapsed', !collapsed);
        panel.render();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'co:autoplay-set') {
        O.settings.set('autoplay.on', !!msg.on);
        if (msg.on) { autoplay.applyColorSetting(); autoplay.start(); }
        else autoplay.stop();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'co:autopilot-set') {
        if (msg.mode) O.settings.set('autopilot.mode', String(msg.mode));
        O.settings.set('autopilot.on', !!msg.on);
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === 'co:autopilot-reset') {
        try { autopilot.resetSession(); } catch (e) {}
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === O.MSG.STATUS_QUERY) {
        sendResponse({
          ok: true,
          site: site.id,
          engineReady: ec.ready,
          autoplay: {
            on: autoplay.enabled,
            state: autoplay.state,
            detail: autoplay.detail,
            elo: O.settings.get('autoplay.elo'),
            movesPlayed: autoplay.movesPlayed,
          },
          autopilot: autopilot ? autopilot.snapshot() : null,
          game: {
            moves: gs.moves.length,
            myColor: gs.myColor,
            myTurn: gs.isMyTurn(),
            over: gs.gameOver,
            lastEval: analyzer.lastResult ? U.fmtEval(analyzer.lastResult.lines && analyzer.lastResult.lines[0] && analyzer.lastResult.lines[0].score) : null,
            top: analyzer.lastResult && analyzer.lastResult.lines ? analyzer.lastResult.lines.slice(0, 3).map(function (l) {
              return { uci: l.uci, eval: U.fmtEval(l.score) };
            }) : [],
          },
        });
        return;
      }
      if (msg.type === 'co:test:command') {
        handleTestCommand(msg, sendResponse);
        return true;
      }
    });

    /* test hooks (also usable from console: window.__ChessOracleTest in page
     * console runs in page world; use via chrome API messages instead) */
    O.test = {
      status: function () { return { moves: gs.moves.length, fen: gs.currentFEN(), autoplay: autoplay.state, engine: ec.ready }; },
      playBest: function () { return autoplay.playBestOnce(); },
      startAutoplay: function (elo) {
        if (elo) O.settings.set('autoplay.elo', elo);
        O.settings.set('autoplay.on', true);
        autoplay.applyColorSetting();
        return autoplay.start();
      },
      stopAutoplay: function () { O.settings.set('autoplay.on', false); autoplay.stop(); return true; },
      startAutopilot: function (mode) {
        if (mode) O.settings.set('autopilot.mode', mode);
        O.settings.set('autopilot.on', true);
        return true;
      },
      stopAutopilot: function () { O.settings.set('autopilot.on', false); return true; },
      autopilotSnapshot: function () { return autopilot.snapshot(); },
      analyze: function (fen) { return ec.analyze({ fen: fen || gs.currentFEN(), depth: 12, movetime: 600, multipv: 3, skill: 20 }); },
      execMove: function (uci) { return exec.playMove(uci); },
      seed: function (s) { autoplay.rng = U.rng(s >>> 0); return true; },
    };

    async function handleTestCommand(msg, sendResponse) {
      try {
        var t = O.test;
        var r;
        switch (msg.cmd) {
          case 'status': r = t.status(); break;
          case 'analyze': r = await t.analyze(msg.fen); break;
          case 'playBest': r = await t.playBest(); break;
          case 'startAutoplay': r = await t.startAutoplay(msg.elo); break;
          case 'stopAutoplay': r = t.stopAutoplay(); break;
          case 'startAutopilot': r = t.startAutopilot(msg.mode); break;
          case 'stopAutopilot': r = t.stopAutopilot(); break;
          case 'autopilotSnapshot': r = t.autopilotSnapshot(); break;
          case 'execMove': r = await t.execMove(msg.uci); break;
          case 'seed': r = t.seed(msg.seed); break;
          case 'readPosition': r = { fen: gs.currentFEN(), placement: bw.lastStable ? bw.lastStable.placement : null }; break;
          default: r = { error: 'unknown cmd' };
        }
        sendResponse({ ok: true, result: r });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    }

    /* ---- final kick ---- */
    if (O.settings.get('autoplay.on')) autoplay.start();
    if (O.settings.get('autopilot.on')) autopilot.start();
    setTimeout(function () { bw.forceRead(); }, 600);

    U.log('boot complete —', O.book.size(), 'book positions');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 150); });
  } else {
    setTimeout(boot, 150);
  }
})(typeof window !== 'undefined' ? window : globalThis);
