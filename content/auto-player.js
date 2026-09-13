/* ChessOracle — AutoPlayer: plays the game for you at a target ELO.
 *
 * Pipeline per move (when it's our turn):
 *   1. opening book (optional) → weighted pick
 *   2. engine analysis at elo-mapped params (multipv 5)
 *   3. selection policy → human-like move (tiers + safety floor)
 *   4. human think time (variable/fixed, clock-aware)
 *   5. MoveExecutor plays it; verified; loop
 *
 * Emits 'autoplay:status' {state, detail} for the panel and badge.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;
  var sleep = U.sleep;

  var STATES = { IDLE: 'idle', WAITING: 'waiting', THINKING: 'thinking', PAUSED_MOVE: 'moving', ERROR: 'error', DONE: 'done' };

  function AutoPlayer(gs, bw, exec, analyzer, settings, site) {
    var self = this;
    this.gs = gs;
    this.bw = bw;
    this.exec = exec;
    this.analyzer = analyzer;
    this.settings = settings;
    this.site = site;
    this.state = STATES.IDLE;
    this.detail = '';
    this.rng = U.rng(Date.now() ^ (Math.random() * 1e9));
    this.planned = null;      // {uci, at, tier, reason}
    this.enabled = false;
    this.movesPlayed = 0;
    this.errorCount = 0;
    this.keepAliveNode = null;
    this._timer = null;

    O.bus.on('position:stable', function (snap) {
      if (!self.enabled) return;
      self.consider(snap);
    });
    O.bus.on('game:new', function () {
      self.movesPlayed = 0;
      self.planned = null;
      self.applyColorSetting();   // re-assert explicit color / re-detect for auto
      if (self.enabled) { self.setStatus(STATES.WAITING, 'new game'); }
    });
    O.bus.on('game:color', function (d) {
      // our detected color changed (late game config, board flip, fix)
      if (!self.enabled) return;
      self.planned = null;        // drop any plan made for the wrong side
      self.setStatus(STATES.WAITING, 'playing as ' + (d.myColor === 'w' ? 'white' : 'black'));
      self.considerNow();
    });
    O.bus.on('game:over', function (r) {
      if (self.enabled) self.setStatus(STATES.DONE, 'game over: ' + (r && r.result));
      self.stopKeepAlive();
    });
    O.bus.on('board:lost', function () {
      if (self.enabled) self.setStatus(STATES.WAITING, 'waiting for board');
    });

    settings.onChanged(function (path) {
      if (path === 'autoplay.on') {
        if (self.settings.data.autoplay.on) self.start();
        else self.stop();
      }
      if (path === 'autoplay.color') { self.applyColorSetting(); }
    });
  }

  AutoPlayer.prototype.applyColorSetting = function () {
    var s = this.settings.data.autoplay;
    if (s.color === 'white') this.gs.setMyColor('w');
    else if (s.color === 'black') this.gs.setMyColor('b');
    else {
      // auto: trust the site's own color signal (SDK playingAs on chess.com,
      // board orientation on lichess), re-read right now
      this.gs.unlockColor();
      this.gs.redetectColor(true);
    }
  };

  AutoPlayer.prototype.start = function () {
    this.enabled = true;
    this.rng = U.rng(Date.now() ^ (Math.random() * 1e9));
    this.errorCount = 0;
    this.applyColorSetting();
    this.setStatus(STATES.WAITING, 'engaged');
    this.reportBadge(true);
    this.startKeepAlive();
    this.considerNow();
  };

  AutoPlayer.prototype.stop = function () {
    this.enabled = false;
    clearTimeout(this._timer);
    this.planned = null;
    this.setStatus(STATES.IDLE, 'stopped');
    this.reportBadge(false);
    this.stopKeepAlive();
  };

  AutoPlayer.prototype.reportBadge = function (on) {
    try {
      chrome.runtime.sendMessage({ type: O.MSG.AUTOPLAY_STATE, on: on, elo: this.settings.data.autoplay.elo });
    } catch (e) {}
  };

  /* silent-audio keepalive so background-tab timers aren't throttled to 1/min */
  AutoPlayer.prototype.startKeepAlive = function () {
    if (!this.settings.data.autoplay.keepAlive) return;
    if (this.keepAliveNode) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var buffer = ctx.createBuffer(1, 4410, 22050); // 0.2s of near silence
      var data = buffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = 0.0001 * Math.sin(i * 0.01);
      var src = ctx.createBufferSource();
      src.buffer = buffer; src.loop = true;
      var gain = ctx.createGain(); gain.gain.value = 0.001;
      src.connect(gain).connect(ctx.destination);
      src.start();
      this.keepAliveNode = { ctx: ctx, src: src };
    } catch (e) {}
  };

  AutoPlayer.prototype.stopKeepAlive = function () {
    if (this.keepAliveNode) {
      try { this.keepAliveNode.src.stop(); this.keepAliveNode.ctx.close(); } catch (e) {}
      this.keepAliveNode = null;
    }
  };

  AutoPlayer.prototype.setStatus = function (state, detail) {
    this.state = state;
    this.detail = detail || '';
    O.bus.emit('autoplay:status', { state: state, detail: this.detail, movesPlayed: this.movesPlayed });
  };

  /* ---------------- main loop ---------------- */
  AutoPlayer.prototype.consider = function (snap) {
    clearTimeout(this._considerTimer);
    // small debounce: let classification etc settle
    this._considerTimer = setTimeout(() => this.considerNow(), 260);
  };

  AutoPlayer.prototype.considerNow = async function () {
    if (!this.enabled) return;
    // when an autopilot session owns the flow, stay parked between games
    // (game-over modal, breaks, setup screens) — it re-engages us itself
    var ap = O.autopilot;
    if (ap && ap.enabled && (ap.phase === 'over' || ap.phase === 'starting' || ap.phase === 'waiting')) {
      this.setStatus(STATES.WAITING, 'autopilot: ' + (ap.detail || ap.phase));
      return;
    }
    if (this.exec.busy) return;
    var gs = this.gs;
    if (!gs.chess || !gs.synced) {
      this.setStatus(STATES.WAITING, 'calibrating position…');
      return;
    }
    if (gs.gameOver || gs.chess.game_over()) {
      this.setStatus(STATES.DONE, 'game over');
      this.stopKeepAlive();
      return;
    }
    if (!gs.isMyTurn()) {
      this.setStatus(STATES.WAITING, gs.myColor ? "opponent's turn" : 'waiting for color…');
      return;
    }

    // color sanity: the side we are about to move must actually be ours
    if (gs.myColor && gs.turnColor() && gs.turnColor() !== gs.myColor) {
      // (defensive — isMyTurn already implies turn === myColor)
      this.setStatus(STATES.WAITING, 'waiting');
      return;
    }

    // if a move is already planned for this position, honor the schedule
    if (this.planned && this.planned.fen === gs.currentFEN() && this.planned.at > Date.now()) {
      this.armTimer(this.planned.at - Date.now());
      return;
    }
    if (this.planned && this.planned.fen === gs.currentFEN() && this.planned.at <= Date.now()) {
      await this.executePlanned();
      return;
    }
    this.planned = null;

    var s = this.settings.data.autoplay;
    var fen = gs.currentFEN();
    this.setStatus(STATES.THINKING, 'engine thinking…');

    /* 1. opening book */
    if (s.book && gs.trackedFromStart && gs.moves.length < 12) {
      var bookMove = O.book.pick(gs.chess, s, this.rng);
      if (bookMove) {
        // human book feel: usually 0.8-3.5s, occasionally near-instant
        var thinkBook;
        if (this.rng() < 0.14) thinkBook = 0.25 + this.rng() * 0.5;
        else thinkBook = 0.8 + this.rng() * 2.6;
        this.planned = {
          fen: fen, uci: bookMove.uci, san: bookMove.san,
          at: Date.now() + thinkBook * 1000,
          tier: 'book', reason: bookMove.lineName,
        };
        this.setStatus(STATES.PAUSED_MOVE, 'book: ' + bookMove.lineName + ' — playing ' + bookMove.san);
        this.armTimer(thinkBook * 1000);
        return;
      }
    }

    /* 2. engine analysis at elo params (autopilot plan may retune cfg) */
    var preCtx = this.buildContext();
    if (O.autopilot && O.autopilot.enabled && O.autopilot.plan) {
      s = O.autopilot.tuneSettings(s, preCtx);
    }
    var params = O.selection.engineParamsFor(s.elo, s.bias);
    var res;
    try {
      res = await this.analyzer.ec.analyze({
        fen: fen,
        moves: gs.trackedFromStart && gs.uciHistory.length ? gs.uciHistory : null,
        depth: params.depth,
        movetime: params.movetime,
        multipv: params.multipv,
        skill: params.skill,
      });
    } catch (e) {
      this.setStatus(STATES.ERROR, 'engine error: ' + e.message);
      await sleep(1500);
      if (this.enabled) this.considerNow();
      return;
    }
    if (!this.enabled || fen !== gs.currentFEN()) return; // position changed meanwhile

    var lines = (res.lines || []).filter(function (l) { return l.uci && l.uci.length >= 4; });
    if (!lines.length) {
      this.setStatus(STATES.ERROR, 'engine returned no lines');
      return;
    }
    // decorate with win%
    for (var i = 0; i < lines.length; i++) {
      lines[i].winPct = U.winPctFromScore(lines[i].score || { cp: 0 });
      lines[i].delta = lines[0].winPct - lines[i].winPct;
    }

    /* 3. selection */
    var ctx = this.buildContext();
    var choice = O.selection.chooseMove(lines, s, ctx);
    if (!choice || !choice.uci) {
      this.setStatus(STATES.ERROR, 'selection failed');
      return;
    }

    /* 3.2 autopilot sabotage: when the plan is to lose this game, sometimes
     * swap the choice for a plausibly worse move (a real mistake) */
    if (O.autopilot && O.autopilot.enabled) {
      var adj = O.autopilot.adjustChoice(choice, lines, ctx);
      if (adj && adj.uci) choice = adj;
    }

    /* 3.25 human realism: non-best moves never underpromote. Real players
     * blunder by choosing a WORSE QUEEN promotion, not by promoting to a
     * bishop/knight — yet engine suboptimal lines are frequently
     * underpromotions. Keep the engine's own best line untouched (rare
     * tactical knight/rook promos stay), normalize everything else to queen. */
    if (choice.uci && choice.uci.length === 5 && choice.uci[4] !== 'q' &&
        !(lines[0] && lines[0].uci === choice.uci)) {
      choice.uci = choice.uci.slice(0, 4) + 'q';
    }

    /* 3.5 safety: never move a piece that isn't ours */
    var mover = null;
    try { mover = gs.chess.get(choice.uci.slice(0, 2)); } catch (e) {}
    if (gs.myColor && (!mover || mover.color !== gs.myColor)) {
      // color detection is off — re-read it from the site and abort this
      // cycle WITHOUT burning error retries
      gs.unlockColor();
      var fixed = gs.redetectColor(true);
      this.planned = null;
      if (fixed) {
        this.setStatus(STATES.WAITING, 'playing as ' + (fixed === 'w' ? 'white' : 'black'));
      } else {
        this.setStatus(STATES.ERROR, 'color confusion — set Play-As manually');
      }
      return;
    }

    /* 4. think time */
    var think = O.selection.thinkTime(s, ctx);
    this.planned = {
      fen: fen,
      uci: choice.uci,
      at: Date.now() + think * 1000,
      tier: choice.tier,
      reason: choice.reason,
      winPct: choice.winPct,
    };
    this.setStatus(STATES.PAUSED_MOVE, 'playing ' + choice.uci.slice(0, 4) + ' in ' + think.toFixed(1) + 's (' + choice.tier + ')');
    this.armTimer(think * 1000);
  };

  AutoPlayer.prototype.buildContext = function () {
    var gs = this.gs;
    var a = this.analyzer.lastResult;
    var myWin = null;
    if (a && a.turn === (gs.myColor || gs.turnColor())) myWin = a.winPct;
    else if (a) myWin = 100 - a.winPct;
    return {
      rng: this.rng,
      ply: gs.moves.length,
      legalCount: gs.legalMoves().length,
      inCheck: gs.chess.in_check(),
      captureAvailable: gs.legalMoves().some(function (m) { return m.captured; }),
      pieceCount: gs.chess ? Object.keys(gs.chess.board() || {}).length : 32,
      winningBig: myWin != null && myWin > 92,
      losing: myWin != null && myWin < 40,
      myWin: myWin,
      clockSeconds: this.readMyClockSeconds(),
    };
  };

  AutoPlayer.prototype.readMyClockSeconds = function () {
    if (!this.settings.data.autoplay.clockAware) return null;
    try {
      var ct = this.site.clockText && this.site.clockText();
      if (!ct) return null;
      // bottom clock is mine (sites put the local player at the bottom)
      var txt = ct.bottom || ct.top;
      if (!txt) return null;
      txt = txt.trim();
      var m = txt.match(/(\d+):(\d+):(\d+)/);
      if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
      m = txt.match(/(\d+):(\d+)/);
      if (m) return +m[1] * 60 + +m[2];
      m = txt.match(/^(\d+)$/);
      if (m) return +m[1];
      return null;
    } catch (e) { return null; }
  };

  AutoPlayer.prototype.armTimer = function (ms) {
    var self = this;
    clearTimeout(this._timer);
    this._timer = setTimeout(function () {
      self.executePlanned().catch(function (e) {
        U.log('autoplay execute error', e);
      });
    }, Math.max(10, ms));
  };

  /* 5. execution */
  AutoPlayer.prototype.executePlanned = async function () {
    if (!this.enabled || !this.planned) return;
    var planned = this.planned;
    // verify position didn't change
    if (this.gs.currentFEN() !== planned.fen) {
      this.planned = null;
      this.considerNow();
      return;
    }
    // last-second site-turn check (cheap, no bridge): the MAIN-world poller
    // keeps O.siteInfo fresh — if the server says it's not our turn, the
    // mirror is stale; drop the plan and re-sync instead of dragging into a
    // premove that never registers
    if (this.site.id === 'chesscom' && this.gs.myColor) {
      var si = O.siteInfo;
      if (si && si.ts && Date.now() - si.ts < 2500 && si.turn != null) {
        var st = O.normColor(si.turn);
        if (st && st !== this.gs.myColor) {
          this.planned = null;
          this.setStatus(STATES.WAITING, 'waiting for our turn (server)');
          this.bw.forceRead();
          try { this.exec.resyncFromSite(si); } catch (e) {}
          return;
        }
      }
    }
    this.setStatus(STATES.PAUSED_MOVE, 'playing ' + planned.uci.slice(0, 4) + (planned.uci.length > 4 ? planned.uci[4] : '') + '…');
    var r = await this.exec.playMove(planned.uci);
    if (r && r.ok) {
      this.movesPlayed++;
      this.errorCount = 0;
      this.planned = null;
      this.setStatus(STATES.WAITING, 'move ' + (this.gs.moves.length) + ' done (' + (planned.tier || '') + ')');
    } else {
      // sync races are NOT autoplay failures — the executor already
      // resynced the mirror; just re-consider on the fresh position
      var err = String((r && r.error) || '');
      if (/site-turn-mismatch|site-desync|site-reset|premove-cancelled|position-changed/.test(err)) {
        this.planned = null;
        this.setStatus(STATES.WAITING, 're-synced with the server — re-planning');
        await sleep(700);
        if (this.enabled) this.considerNow();
        return;
      }
      this.errorCount++;
      U.log('autoplay move failed', r && r.error);
      if (this.errorCount >= 4) {
        if (O.autopilot && O.autopilot.enabled) {
          // autopilot session owns recovery — never burn the session on a jam
          O.bus.emit('autoplay:stuck', { error: r && r.error, movesPlayed: this.movesPlayed });
          this.errorCount = 0;
          this.planned = null;
          this.setStatus(STATES.WAITING, 'recovering…');
          await sleep(2000);
          if (this.enabled) this.considerNow();
          return;
        }
        this.setStatus(STATES.ERROR, 'giving up after 4 failures: ' + (r && r.error));
        this.settings.set('autoplay.on', false);
        return;
      }
      // a failed move often means stale color or desync — re-detect before retry
      this.planned = null;
      try { this.gs.unlockColor(); this.gs.redetectColor(true); } catch (e) {}
      await sleep(700);
      this.considerNow();
    }
  };

  /* single best move on demand (hint-play button) */
  AutoPlayer.prototype.playBestOnce = async function () {
    var gs = this.gs;
    if (!gs.chess || !gs.isMyTurn()) return { ok: false, error: 'not my turn' };
    var a = this.analyzer.lastResult;
    if (!a || a.fen !== gs.currentFEN() || !a.lines.length) {
      var s = this.settings.data.autoplay;
      var params = O.selection.engineParamsFor(Math.max(s.elo, 2000), 0);
      a = await this.analyzer.ec.analyze({
        fen: gs.currentFEN(),
        moves: gs.trackedFromStart && gs.uciHistory.length ? gs.uciHistory : null,
        depth: params.depth, movetime: Math.max(600, params.movetime), multipv: 3, skill: 20,
      });
      a = this.analyzer.decorate ? this.analyzer.decorate(gs.currentFEN(), a) : a;
    }
    var uci = a.bestmove || (a.lines[0] && a.lines[0].uci);
    if (!uci) return { ok: false, error: 'no move' };
    return this.exec.playMove(uci);
  };

  O.AutoPlayer = AutoPlayer;
  O.AUTOPLAY_STATES = STATES;
})(typeof window !== 'undefined' ? window : globalThis);
