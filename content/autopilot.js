/* ChessOracle — Autopilot: hands-free session controller (chess.com).
 *
 * Sits ABOVE AutoPlayer: it plans each game's outcome (win / lose / mixed),
 * tunes move selection toward that plan, watches for game end, takes a
 * human-like break, clicks "New Game" like a real player and keeps running
 * until the game limit or the user stops it.
 *
 * Outcome plans (per game, decided up-front):
 *   win  — plays a bit above the selected Elo, safety floor on, tryhard
 *          mode if the plan is slipping (real "grinding out a win")
 *   lose — plays a bit below the selected Elo with the safety floor off,
 *          escalating slips; resigns a clearly-lost game at a human rate;
 *          never instantly throws — losses look like an off day
 *
 * Pure decision logic is exported on O.apLogic for unit tests.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;
  var sleep = U.sleep;

  var START_FEN_RX = /^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w /;
  var PHASES = { IDLE: 'idle', WAITING: 'waiting', PLAYING: 'playing', OVER: 'over', STARTING: 'starting', UNSUPPORTED: 'unsupported', DONE: 'done' };

  /* ================= pure logic (unit-testable) ================= */

  /** Decide this game's outcome plan. */
  function planOutcome(cfg, session, rng) {
    var mode = cfg.mode || 'mixed';
    if (mode === 'win') return 'win';
    if (mode === 'lose') return 'lose';
    // mixed: target win rate with soft streak control (no silly 7-in-a-rows)
    var maxStreak = cfg.maxStreak || 4;
    var streak = (session && session.streak) || 0;
    var type = session && session.streakType;
    if (streak >= maxStreak && type === 'win') return 'lose';
    if (streak >= maxStreak && type === 'loss') return 'win';
    var p = (cfg.winRate == null ? 62 : cfg.winRate) / 100;
    return rng() < p ? 'win' : 'lose';
  }

  function updateStreak(session, outcome) {
    if (outcome === 'win' || outcome === 'loss') {
      if (session.streakType === outcome) session.streak = (session.streak || 0) + 1;
      else { session.streakType = outcome; session.streak = 1; }
    } else {
      session.streak = 0;
      session.streakType = null;
    }
  }

  /** Clone the autoplay cfg tuned toward the plan. ctx: {ply, myWin}. */
  function tuneSettings(s, plan, ctx) {
    var t = JSON.parse(JSON.stringify(s));
    if (plan === 'win') {
      t.elo = Math.min((s.elo || 1200) + 220, 2900);
      t.bias = Math.min((s.bias || 0) + 80, 400);
      t.safeFloor = true;
      t.risk = Math.round((s.risk == null ? 70 : s.risk) * 0.6);
      t.randomness = Math.max(5, Math.round((s.randomness == null ? 35 : s.randomness) * 0.8));
      if (t.human === 'manual') {
        t.blunderRate = Math.round((s.blunderRate || 0) * 0.35);
        t.mistakeRate = Math.round((s.mistakeRate || 0) * 0.4);
        t.inaccuracyRate = Math.round((s.inaccuracyRate || 0) * 0.6);
      }
      // tryhard: plan is a win but the game is going badly — clamp down
      if (ctx && ctx.myWin != null && ctx.myWin < 42 && (ctx.ply || 0) > 12 && s.tryhard !== false) {
        t.elo = Math.min((s.elo || 1200) + 480, 2900);
        t.risk = Math.round((s.risk == null ? 70 : s.risk) * 0.35);
        if (t.human === 'manual') {
          t.blunderRate = Math.round((s.blunderRate || 0) * 0.15);
          t.mistakeRate = Math.round((s.mistakeRate || 0) * 0.3);
        }
      }
    } else if (plan === 'lose') {
      t.elo = Math.max((s.elo || 1200) - 150, 400);
      t.safeFloor = false;
      t.risk = Math.min(100, Math.round(s.risk == null ? 70 : s.risk) + 15);
      t.randomness = Math.min(100, (s.randomness == null ? 35 : s.randomness) + 18);
      if (t.human === 'manual') {
        t.blunderRate = Math.min(100, Math.round((s.blunderRate || 0) * 1.9 + 6));
        t.mistakeRate = Math.min(100, Math.round((s.mistakeRate || 0) * 1.7 + 8));
        t.inaccuracyRate = Math.min(100, Math.round((s.inaccuracyRate || 0) * 1.5 + 10));
      }
    }
    return t;
  }

  /** Should we deliberately slip this move (plan = lose)? */
  function sabotageGate(cfg, plan, ctx, state, rng) {
    if (plan !== 'lose' || !cfg.sabotage) return false;
    if (!ctx || ctx.ply == null || ctx.ply < 8) return false;
    var myWin = ctx.myWin;
    if (myWin == null) return false;
    if (myWin < 32) return false;                       // already lost: play it out
    if (state.lastPly != null && ctx.ply - state.lastPly < 6) return false;
    var p = 10 + (ctx.ply - 8) * 2.2;                   // ramps as the game ages
    if (myWin > 60) p += 25;                            // meant to lose but winning: push
    p = Math.min(p, myWin > 65 ? 85 : 60);
    return rng() * 100 < p;
  }

  /** Pick a plausibly-bad line (a real mistake, not an instant giveaway).
   * hard=true (we're stuck WINNING a game we're supposed to lose): pick the
   * most damaging slip available so the plan can actually realize. */
  function pickSabotage(lines, rng, hard) {
    if (!lines || !lines.length) return null;
    if (hard) {
      var worst = lines.filter(function (l) { return l.delta != null && l.delta >= 15; });
      if (worst.length) {
        worst.sort(function (a, b) { return b.delta - a.delta; });
        return worst[0];
      }
    }
    var cands = lines.filter(function (l) { return l.delta != null && l.delta >= 8 && l.delta <= 40; });
    if (!cands.length) cands = lines.filter(function (l) { return l.delta != null && l.delta >= 6; });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return a.delta - b.delta; });  // least-bad first: looks human
    var k = Math.min(cands.length, 3);
    return cands[Math.floor(rng() * k)];
  }

  /** Should we resign this clearly-lost game (plan = lose)? */
  function resignGate(cfg, plan, ctx, state, rng) {
    if (plan !== 'lose') return false;
    var rr = cfg.resignWhenLost == null ? 45 : cfg.resignWhenLost;
    if (rr <= 0) return false;
    if (!ctx || ctx.ply == null || ctx.ply < (cfg.minResignPly || 10)) return false;
    var myWin = ctx.myWin;
    if (myWin == null || myWin >= 22) return false;
    if (state.done) return false;
    var p = rr * (1 + (22 - myWin) / 30);           // percentage, grows when deeply lost
    if (state.rolled) p *= 0.5;                     // soft retries after the big roll
    return rng() * 100 < p;
  }

  /** Game outcome from the game-over modal + mirror knowledge. */
  function parseResult(text, headerCls, mirror, myColor) {
    var t = String(text || '').toLowerCase();
    var c = String(headerCls || '').toLowerCase();
    if (/aborted/.test(t)) return 'draw';               // move-0 resign quirk
    if (/you beat/.test(t)) return 'win';               // "You Beat Cliff - Triangle!"
    if (/beat you|defeated you/.test(t)) return 'loss'; // "Cliff beat you"
    if (/you won|you win|victory|well played/.test(t)) return 'win';
    if (/you lost|you lose|defeat/.test(t)) return 'loss';
    if (/white (won|wins)/.test(t)) return myColor === 'w' ? 'win' : 'loss';
    if (/black (won|wins)/.test(t)) return myColor === 'b' ? 'win' : 'loss';
    if (/draw|drew|stalemate/.test(t)) return 'draw';
    if (/userwon/.test(c) && !/userlost/.test(c)) return 'win';
    if (/userlost/.test(c)) return 'loss';
    if (/draw/.test(c)) return 'draw';
    if (mirror === '1-0') return myColor === 'b' ? 'loss' : 'win';
    if (mirror === '0-1') return myColor === 'w' ? 'loss' : 'win';
    if (mirror === 'draw') return 'draw';
    return 'unknown';
  }

  /** Human pause between games (occasional coffee break). */
  function breakSeconds(cfg, rng) {
    var lo = Math.max(2, cfg.breakMin == null ? 5 : cfg.breakMin);
    var hi = Math.max(lo + 1, cfg.breakMax == null ? 14 : cfg.breakMax);
    if (rng() * 100 < (cfg.longBreakChance || 0)) {
      var llo = Math.max(hi, cfg.longBreakMin || 25);
      var lhi = Math.max(llo + 5, cfg.longBreakMax || 70);
      return llo + rng() * (lhi - llo);
    }
    return lo + rng() * (hi - lo);
  }

  /** Lose-plan game that refuses to die (still clearly winning late vs a
   * weak bot): eventually give up with a "tilt resign" so the session's plan
   * can actually realize. Late-only + probability-gated to stay plausible. */
  function despairGate(cfg, plan, ctx, state, rng) {
    if (plan !== 'lose') return false;
    if (!ctx || ctx.ply == null) return false;
    var minPly = Math.max(30, (cfg.minResignPly || 10) * 3);
    if (ctx.ply < minPly) return false;
    var myWin = ctx.myWin;
    if (myWin == null || myWin < 65) return false;      // only when we can't seem to lose
    if (state.done) return false;
    var p = 20 + (ctx.ply - minPly) * 0.8;              // rises as the game drags
    if (state.rolled) p *= 0.6;                         // softer retries
    return rng() * 100 < Math.min(p, 90);
  }

  O.apLogic = {
    planOutcome: planOutcome, updateStreak: updateStreak, tuneSettings: tuneSettings,
    sabotageGate: sabotageGate, pickSabotage: pickSabotage, resignGate: resignGate,
    despairGate: despairGate, parseResult: parseResult, breakSeconds: breakSeconds,
  };

  /* ================= controller ================= */

  function readGameOverModal() {
    try {
      var el = document.querySelector('.game-over-modal-shell-container, [class*="game-over-modal"]');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 30) return null;
      var header = el.querySelector('[class*="game-over-modal-header"]');
      return {
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
        headerCls: header ? String(header.className) : '',
      };
    } catch (e) { return null; }
  }

  function Autopilot(gs, bw, autoplay, exec, settings, site, analyzer) {
    var self = this;
    this.gs = gs;
    this.bw = bw;
    this.autoplay = autoplay;   // AutoPlayer
    this.exec = exec;
    this.settings = settings;
    this.site = site;
    this.analyzer = analyzer;
    this.enabled = false;
    this.phase = PHASES.IDLE;
    this.detail = '';
    this.plan = null;
    this.rng = U.rng(Date.now() ^ (Math.random() * 1e9));
    this.session = { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, streakType: null, startedAt: Date.now(), lastTs: 0, lastResult: null, plan: null, gameStartFen: null };
    this._gameCounted = false;
    this._busy = false;
    this._timer = null;
    this._breakAt = 0;
    this._startFails = 0;
    this._idleSince = Date.now();
    this._booted = true;        // allows one plan reuse across a reload
    this._lastStatusEmit = 0;
    this._mirrorResult = null;
    this._stuckCount = 0;
    this._sabotage = { lastPly: null };
    this._resign = { rolled: false, done: false, lastTryPly: null };
    this._despair = { rolled: false, lastTryPly: null };
    this._dismissAt = 0;
    this._playClickAt = 0;
    this._guestDialogAt = 0;
    this._queuedSince = Date.now();
    this._cancelAt = 0;
    this._awaitingQueue = 0;
    this._lastProgress = { ply: -1, at: 0 };
    this._handlingOver = false;

    O.bus.on('game:over', function (r) { self._mirrorResult = r && r.result; });
    O.bus.on('game:new', function () { self._stuckCount = 0; });
    O.bus.on('autoplay:stuck', function (e) { self.onStuck(e); });

    // NOTE: only trust real-path notifications. '*' events come from
    // chrome.storage.onChanged, which can deliver STALE snapshots when
    // several writes land in quick succession — reacting to them caused
    // the session to toggle off spuriously. Cross-context control (popup)
    // uses explicit runtime messages that trigger real-path sets here.
    settings.onChanged(function (path) {
      if (path === 'autopilot.on') {
        var on = !!self.settings.get('autopilot.on');
        if (on && !self.enabled) self.start();
        else if (!on && self.enabled) self.stop(true);
      }
      if (path === 'autoplay.on' && self.enabled && !self.settings.get('autoplay.on')) {
        // user killed autoplay manually — autopilot cannot run without it
        self.settings.set('autopilot.on', false);
      }
    });

    this.loadSession();
  }

  /* ---------- bridge (ISOLATED -> MAIN world) ---------- */
  Autopilot.prototype.bridge = function (action, payload) {
    return new Promise(function (resolve) {
      var id = 'ap' + Math.random().toString(36).slice(2, 9);
      var to = setTimeout(function () { cleanup(); resolve({ ok: false, error: 'bridge-timeout' }); }, 12000);
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (d && d.__coBridgeReply === true && d.id === id) {
          clearTimeout(to);
          cleanup();
          resolve(d.res || { ok: false });
        }
      }
      function cleanup() { window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      window.postMessage(Object.assign({ __coBridge: true, id: id, action: action }, payload || {}), '*');
    });
  };

  /* ---------- session persistence ---------- */
  Autopilot.prototype.loadSession = function () {
    var self = this;
    try {
      chrome.storage.local.get('co_ap_session', function (res) {
        if (res && res.co_ap_session) {
          var s = res.co_ap_session;
          self.session.games = s.games || 0;
          self.session.wins = s.wins || 0;
          self.session.losses = s.losses || 0;
          self.session.draws = s.draws || 0;
          self.session.streak = s.streak || 0;
          self.session.streakType = s.streakType || null;
          self.session.lastTs = s.lastTs || 0;
          self.session.lastResult = s.lastResult || null;
          self.session.plan = s.plan || null;
          self.session.gameStartFen = s.gameStartFen || null;
          if (self.session.games) self.session.startedAt = s.startedAt || Date.now();
        }
        self.emitStatus();
      });
    } catch (e) {}
  };

  Autopilot.prototype.saveSession = function () {
    try { chrome.storage.local.set({ co_ap_session: this.session }); } catch (e) {}
  };

  Autopilot.prototype.resetSession = function () {
    this.session = { games: 0, wins: 0, losses: 0, draws: 0, streak: 0, streakType: null, startedAt: Date.now(), lastTs: 0, lastResult: null, plan: null, gameStartFen: null };
    this.saveSession();
    this.emitStatus();
  };

  /* ---------- lifecycle ---------- */
  Autopilot.prototype.start = function () {
    if (this.site.id !== 'chesscom') {
      this.phase = PHASES.UNSUPPORTED;
      this.setStatus('autopilot is chess.com-only');
      this.emitStatus();
      return;
    }
    this.enabled = true;
    this.rng = U.rng(Date.now() ^ (Math.random() * 1e9));
    this.phase = PHASES.WAITING;
    this._idleSince = Date.now();
    this._queuedSince = Date.now();
    this._startFails = 0;
    this._stuckCount = 0;
    this.setStatus('engaged — looking for a game');
    if (!this.settings.get('autoplay.on')) this.settings.set('autoplay.on', true);  // onChange starts AutoPlayer
    this.autoplay.startKeepAlive();
    var self = this;
    clearInterval(this._timer);
    this._timer = setInterval(function () { self.monitor(); }, 1500);
    this.monitor();
    this.saveSession();
    this.emitStatus();
  };

  Autopilot.prototype.stop = function (keepAutoplay) {
    this.enabled = false;
    clearInterval(this._timer);
    this.phase = PHASES.IDLE;
    this.plan = null;
    this.setStatus('off');
    this.saveSession();
    this.emitStatus();
  };

  Autopilot.prototype.completeSession = function () {
    this.phase = PHASES.DONE;
    var s = this.session;
    this.setStatus('session complete — ' + s.games + ' games (' + s.wins + 'W/' + s.losses + 'L/' + s.draws + 'D)');
    this.enabled = false;
    clearInterval(this._timer);
    this.settings.set('autoplay.on', false);
    this.settings.set('autopilot.on', false);
    this.emitStatus();
    try { O.panel && O.panel.toast('Autopilot session complete: ' + s.wins + 'W / ' + s.losses + 'L / ' + s.draws + 'D', 'ok'); } catch (e) {}
  };

  Autopilot.prototype.setStatus = function (d) { this.detail = d; };

  Autopilot.prototype.snapshot = function () {
    return {
      on: this.enabled,
      phase: this.phase,
      detail: this.detail,
      plan: this.plan,
      nextGameIn: this.phase === PHASES.OVER && this._breakAt ? Math.max(0, Math.round((this._breakAt - Date.now()) / 1000)) : null,
      session: {
        games: this.session.games, wins: this.session.wins, losses: this.session.losses,
        draws: this.session.draws, streak: this.session.streak, streakType: this.session.streakType,
      },
    };
  };

  Autopilot.prototype.emitStatus = function (force) {
    var now = Date.now();
    if (!force && now - this._lastStatusEmit < 400) return;
    this._lastStatusEmit = now;
    O.bus.emit('autopilot:status', this.snapshot());
  };

  /* ---------- over / live detection ---------- */
  Autopilot.prototype.isOver = function () {
    try {
      var si = O.siteInfo;
      var fresh = si && si.ts && Date.now() - si.ts < 12000;
      var sdkOver = fresh && si.over === true;
      var mirrorOver = !!(this.gs.gameOver || (this.gs.chess && this.gs.chess.game_over()));
      var modal = readGameOverModal();
      var modalOver = !!(modal && /won|lost|draw|abort|checkmate|resign|stalemate|time/i.test(modal.text));
      return !!(sdkOver || mirrorOver || modalOver);
    } catch (e) { return false; }
  };

  Autopilot.prototype.myWin = function () {
    try {
      var gs = this.gs;
      var a = this.analyzer && this.analyzer.lastResult;
      if (!a || !gs.chess || gs.myColor == null || a.turn == null || a.winPct == null) return null;
      return a.turn === gs.myColor ? a.winPct : 100 - a.winPct;
    } catch (e) { return null; }
  };

  /* ---------- monitor loop ---------- */
  Autopilot.prototype.monitor = async function () {
    if (!this.enabled || this._busy) return;
    this._busy = true;
    try {
      if (this.settings.get('autopilot.autoDismiss') && Date.now() - this._dismissAt > 4000) {
        this._dismissAt = Date.now();
        this.dismissPopups();
      }
      if (this.phase === PHASES.WAITING) await this.stepWaiting();
      else if (this.phase === PHASES.PLAYING) await this.stepPlaying();
      else if (this.phase === PHASES.OVER) await this.stepOver();
      else if (this.phase === PHASES.STARTING) this._startGuard();
    } catch (e) {
      U.log('autopilot monitor error', e);
    }
    this._busy = false;
    this.emitStatus();
  };

  Autopilot.prototype.stepWaiting = async function () {
    var boardEl = document.querySelector('wc-chess-board');
    var hasBoard = boardEl && boardEl.getBoundingClientRect().width > 80;

    // guest onboarding dialog (fresh profiles): pick skill + Play as a
    // Guest — ONLY when the actual skill-level modal is open (the lobby also
    // shows a persistent "Play as a Guest" link that must NOT be clicked:
    // clicking it re-loads /play in a loop)
    if (Date.now() - this._guestDialogAt > 12000 && this.guestDialogOpen()) {
      this._guestDialogAt = Date.now();
      await this.bridge('click-text', { texts: ['I know the rules and basics'] });
      await sleep(500);
      await this.bridge('click-text', { texts: ['Play as a Guest'], includeLinks: true });
      U.log('autopilot: completed guest onboarding dialog');
      this.setStatus('guest sign-in done — starting…');
      return;
    }

    if (!hasBoard) {
      // no board at all — are we mid-queue (finding an opponent)? then WAIT
      var queued = this.isQueued();
      if (queued) {
        this.setStatus('finding an opponent…');
        // queue safety: if it takes forever, bail out and re-queue
        if (Date.now() - this._queuedSince > 150000) {
          U.log('autopilot: queue stuck 2.5min — cancelling and re-queuing');
          await this.bridge('click-text', { texts: ['Cancel'] });
          this._queuedSince = Date.now();
        }
        return;
      }
      // after a while, head to the configured arena (never re-navigate to
      // the page we are already on — that would just reload it in a loop)
      if (this.settings.get('autopilot.autoNavigate') && Date.now() - this._idleSince > 45000 &&
          /chess\.com$/.test(location.hostname || '')) {
        if (this.goToArena(false)) {
          this.setStatus('no board — opening the arena…');
        } else {
          this.setStatus('waiting for a game…');
        }
        this._idleSince = Date.now();
      } else {
        this.setStatus(this.detail.indexOf('no board') < 0 ? 'waiting for a board…' : this.detail);
      }
      return;
    }

    // board present — is a game actually live?
    var r = await this.bridge('chesscom-info');
    var info = r && r.info;
    if (info && info.over === false) {
      // the /play/online lobby has a PREVIEW board with a demo game object —
      // never engage it; click Start Game instead
      if (this.isLobbyPage()) {
        if (Date.now() - this._playClickAt > 6000) {
          this._playClickAt = Date.now();
          this.setStatus('lobby — starting a game…');
          await this.bridge('click-text', { texts: ['Start Game', 'Play', 'Start'] });
          this._queuedSince = Date.now();
        }
        return;
      }
      this.onGameLive();
      return;
    }
    if (info && info.over === true) {
      // right after clicking "New X min" the OLD game object stays over=true
      // while the queue runs (~10s) — do NOT recycle during that window
      if (this._awaitingQueue && Date.now() - this._awaitingQueue < 45000) {
        this.setStatus('queueing the next game…');
        return;
      }
      this._awaitingQueue = 0;
      // a game ended before we engaged (or stale one) — don't record, just recycle
      this._gameCounted = false;
      this.handleGameOver(false);
      return;
    }
    // no game object → setup screen: start the game (throttled)
    if (Date.now() - this._playClickAt > 6000) {
      this._playClickAt = Date.now();
      var found = await this.bridge('find-text', { texts: ['Play', 'Start'] });
      if (found && found.found) {
        if (this.colorExplicit() && this.onComputerPage()) await this.pickSideOption();
        var c = await this.bridge('click-text', { texts: ['Play', 'Start'] });
        if (c && c.ok) this.setStatus('starting game…');
        this._queuedSince = Date.now();
      } else {
        this.setStatus('waiting for a game…');
      }
    }
  };

  /* are we sitting in a "finding opponent" / queue state? (never navigate
   * away or click random things while queued) */
  Autopilot.prototype.isQueued = function () {
    try {
      var t = (document.body.textContent || '').slice(0, 6000);
      if (/finding (an? )?opponent|searching for|looking for (an? )?opponent|waiting for (an? )?opponent/i.test(t)) return true;
    } catch (e) {}
    return false;
  };

  Autopilot.prototype.arenaUrl = function () {
    return this.settings.get('autopilot.arena') === 'computer'
      ? 'https://www.chess.com/play/computer'
      : 'https://www.chess.com/play/online';
  };

  /* navigate to the arena. force=true ignores the "we're already there"
  * guards (used when a finished game view is wedging the flow) */
  Autopilot.prototype.goToArena = function (force) {
    var arena = this.arenaUrl();
    var targetPath = arena.replace(/^https:\/\/[^\/]+/, '');
    var onGameView = /\/game\//.test(location.pathname || '');
    if (!force) {
      if ((location.pathname || '').indexOf(targetPath) === 0) return false;  // already there
      if (onGameView) return false;  // never leave a game view on our own
    }
    U.log('autopilot: navigating to arena', arena, force ? '(forced)' : '');
    location.href = arena;
    return true;
  };

  Autopilot.prototype.onComputerPage = function () {
    return /\/play\/computer/.test(location.pathname || '');
  };

  /* the /play/online lobby (its preview board carries a demo game object) */
  Autopilot.prototype.isLobbyPage = function () {
    try {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var t = (btns[i].textContent || '').replace(/\s+/g, ' ').trim();
        if (t !== 'Start Game' && t !== 'Custom Challenge' && t !== 'Play a Friend') continue;
        var r = btns[i].getBoundingClientRect();
        if (r.width > 10 && r.height > 8) return true;
      }
    } catch (e) {}
    return false;
  };

  /* the "What is your chess skill level?" onboarding modal is open */
  Autopilot.prototype.guestDialogOpen = function () {
    try {
      var els = document.querySelectorAll('dialog[open], .cc-modal-component-v2, [class*="modal"]');
      for (var i = 0; i < els.length; i++) {
        var r = els[i].getBoundingClientRect();
        if (r.width < 100 || r.height < 60) continue;
        var t = (els[i].textContent || '').toLowerCase();
        if (t.indexOf('skill level') >= 0 && t.indexOf('play as a guest') >= 0) return true;
      }
    } catch (e) {}
    return false;
  };

  /* a rematch challenge got sent (legacy bug / opponent flow): the page sits
   * with a pending challenge — cancel it and click the real new-game button */
  Autopilot.prototype.isChallengePending = function () {
    try {
      var t = (document.body.textContent || '').slice(0, 6000);
      if (/challenge (sent|declined)|waiting for \w+ to accept|to accept your|challenge!/i.test(t)) {
        if (/waiting for|accept|challenge/i.test(t)) return true;
      }
      if (/rematch/i.test(t) && /waiting|accept|declin/i.test(t)) return true;
    } catch (e) {}
    return false;
  };

  Autopilot.prototype.stepPlaying = async function () {
    var gs = this.gs;
    if (this.isOver()) { await this.handleGameOver(true); return; }

    // resign decision (plan = lose, clearly lost)
    var ctx = { ply: gs.moves.length, myWin: this.myWin() };
    if (resignGate(this.settings.data.autopilot, this.plan, ctx, this._resign, this.rng)) {
      var ply = ctx.ply;
      if (this._resign.lastTryPly == null || ply - this._resign.lastTryPly >= 3) {
        this._resign.lastTryPly = ply;
        this._resign.rolled = true;
        await this.doResign();
        return;
      }
    }

    // lose-plan game that refuses to die (still winning late vs a weak
    // opponent): tilt-resign so the session's plan can realize
    if (despairGate(this.settings.data.autopilot, this.plan, ctx,
        { rolled: this._despair.rolled, done: this._resign.done }, this.rng)) {
      if (this._despair.lastTryPly == null || ctx.ply - this._despair.lastTryPly >= 4) {
        this._despair.lastTryPly = ctx.ply;
        this._despair.rolled = true;
        U.log('autopilot: game refuses to die — tilt resign');
        await this.doResign();
        return;
      }
    }

    // progress watchdog: if it's our turn and nothing moves for 3 min, kick autoplay
    var ply = gs.moves.length;
    if (ply !== this._lastProgress.ply) { this._lastProgress = { ply: ply, at: Date.now() }; }
    else {
      var stalled = Date.now() - (this._lastProgress.at || Date.now());
      if (gs.isMyTurn() && this.autoplay.enabled && stalled > 180000) {
        U.log('autopilot: no progress 3min — re-kicking autoplay');
        this._lastProgress.at = Date.now();
        try { this.autoplay.start(); } catch (e) {}
      } else if (!gs.isMyTurn() && stalled > 240000) {
        // opponent is not moving (bot engine wedged / page stalled) — resign
        // to unwedge; the game-over flow then recycles into a fresh game
        U.log('autopilot: opponent stalled 4min — unwedging via resign');
        this._lastProgress.at = Date.now();
        await this.doResign();
        return;
      }
    }

    if (this.plan) {
      this.setStatus('game ' + (this.session.games + 1) + ' · plan: ' + (this.plan === 'win' ? 'WIN' : 'LOSE') +
        (ctx.myWin != null ? ' · ' + Math.round(ctx.myWin) + '%' : ''));
    }
  };

  Autopilot.prototype.stepOver = async function () {
    if (Date.now() >= this._breakAt) { await this.startNextGame(); return; }
    var left = Math.max(0, Math.round((this._breakAt - Date.now()) / 1000));
    this.setStatus((this._lastOutcomeLabel || 'game over') + ' · next game in ' + left + 's');
  };

  Autopilot.prototype._startGuard = function () {
    if (Date.now() - (this._startAt || 0) > 15000) {
      // click didn't lead anywhere — re-enter the over loop
      this.phase = PHASES.OVER;
      this._breakAt = Date.now() + 2000;
    }
  };

  /* ---------- game lifecycle ---------- */
  Autopilot.prototype.onGameLive = function () {
    this._idleSince = Date.now();
    this._awaitingQueue = 0;
    this.phase = PHASES.PLAYING;
    this.beginPlan();
    this._gameCounted = true;
    this._lastProgress = { ply: this.gs.moves.length, at: Date.now() };
    if (!this.settings.get('autoplay.on')) this.settings.set('autoplay.on', true);
    if (!this.autoplay.enabled) {
      this.autoplay.applyColorSetting();
      this.autoplay.start();
    } else {
      try { this.autoplay.considerNow(); } catch (e) {}
    }
    this.autoplay.startKeepAlive();
    this.setStatus('game ' + (this.session.games + 1) + ' · plan: ' + (this.plan === 'win' ? 'WIN' : 'LOSE'));
    this.emitStatus(true);
  };

  Autopilot.prototype.beginPlan = function () {
    var gs = this.gs;
    var fen = gs.currentFEN();
    var reuse = this._booted && this.session.plan && this.session.gameStartFen && fen &&
      fen === this.session.gameStartFen && Date.now() - (this.session.lastTs || 0) < 30 * 60000;
    this._booted = false;
    if (reuse) {
      this.plan = this.session.plan;   // reload into the same game — keep the plan
    } else {
      this.plan = planOutcome(this.settings.data.autopilot, this.session, this.rng);
    }
    this.session.plan = this.plan;
    this.session.gameStartFen = fen;
    this._sabotage = { lastPly: null };
    this._resign = { rolled: false, done: false, lastTryPly: null };
    this._despair = { rolled: false, lastTryPly: null };
    this._mirrorResult = null;
    this._stuckCount = 0;
    this.saveSession();
    U.log('autopilot plan for this game:', this.plan);
  };

  Autopilot.prototype.handleGameOver = async function (record) {
    if (this.phase === PHASES.OVER || this.phase === PHASES.DONE || this._handlingOver) return;
    this._handlingOver = true;
    try {
      await this._handleGameOverInner(record);
    } finally {
      this._handlingOver = false;
    }
  };

  Autopilot.prototype._handleGameOverInner = async function (record) {
    var gs = this.gs;

    // give the game-over modal a moment to render (esp. after a resign,
    // where the position is unchanged and only the modal tells the result)
    var modal = readGameOverModal();
    var outcome = modal ? parseResult(modal.text, modal.headerCls, this._mirrorResult, gs.myColor) : 'unknown';
    if ((outcome === 'unknown' || !modal) && record !== false) {
      for (var i = 0; i < 3; i++) {
        await sleep(1300);
        if (!this.enabled) return;
        if (this.phase === PHASES.OVER || this.phase === PHASES.DONE) return;  // a concurrent call finished first
        modal = readGameOverModal();
        if (modal) {
          outcome = parseResult(modal.text, modal.headerCls, this._mirrorResult, gs.myColor);
          if (outcome !== 'unknown') break;
        } else if (this._mirrorResult) {
          outcome = parseResult('', '', this._mirrorResult, gs.myColor);
          if (outcome !== 'unknown') break;
        }
      }
    }
    if (outcome === 'unknown') outcome = 'draw';

    if (record !== false && this._gameCounted) {
      var s = this.session;
      s.games++;
      if (outcome === 'win') s.wins++;
      else if (outcome === 'loss') s.losses++;
      else s.draws++;
      updateStreak(s, outcome);
      s.lastTs = Date.now();
      s.lastResult = outcome;
      s.plan = null;
      s.gameStartFen = null;
      this.saveSession();
      U.log('autopilot game over:', outcome, '| session', s.wins + 'W/' + s.losses + 'L/' + s.draws + 'D');
    }
    this._gameCounted = false;
    this._lastOutcomeLabel = 'game over: ' + outcome;

    // session limit?
    var limit = this.settings.get('autopilot.gamesLimit') || 0;
    if (limit > 0 && this.session.games >= limit) { this.completeSession(); return; }

    var brk = breakSeconds(this.settings.data.autopilot, this.rng);
    this._breakAt = Date.now() + brk * 1000;
    this.phase = PHASES.OVER;
    this.setStatus(this._lastOutcomeLabel + ' · next game in ' + Math.round(brk) + 's');
    this.autoplay.startKeepAlive();   // keep timers honest during the break
    this.emitStatus(true);
  };

  Autopilot.prototype.startNextGame = async function () {
    this.phase = PHASES.STARTING;
    this._startAt = Date.now();
    this.setStatus('finding next game…');
    var clicked = await this.clickNewGame();
    if (clicked) {
      this._startFails = 0;
      this._queuedSince = Date.now();
      this._awaitingQueue = Date.now();   // suppress over-recycling while the queue runs
      this.phase = PHASES.WAITING;   // monitor engages when the game goes live
      this._idleSince = Date.now();
      return;
    }
    // nothing clickable — diagnose
    this._startFails++;
    var rec = await this.recoverStart();
    if (!rec) {
      if (this._startFails >= 3 && this.settings.get('autopilot.autoNavigate')) {
        // finished-game view is wedging the flow (e.g. no game-over modal):
        // force our way back to the arena lobby and queue from there
        if (this.goToArena(true)) {
          this._startFails = 0;
          this._awaitingQueue = Date.now();
          this._queuedSince = Date.now();
          this.phase = PHASES.WAITING;
          this._idleSince = Date.now();
          this.setStatus('heading to the arena to re-queue…');
          return;
        }
      }
      this.phase = PHASES.OVER;
      this._breakAt = Date.now() + 5000;
    }
  };

  /* click the NEXT GAME button — "New 10 min" / "New Game" / "New Bot",
   * and NEVER a "Rematch" challenge on live games (it dies if the opponent
   * doesn't accept). Live-probed ladder: */
  Autopilot.prototype.clickNewGame = async function () {
    // 1. the "New <time>" family — game-over modal first, then anywhere
    var r = await this.bridge('click-new-game', { scope: '[class*="game-over"]' });
    if (r && r.ok) { U.log('autopilot: clicked new-game button (modal)'); return 'new-game'; }
    r = await this.bridge('click-new-game', {});
    if (r && r.ok) { U.log('autopilot: clicked new-game button (page)'); return 'new-game'; }
    // 2. plain-text fallbacks
    var tries = [
      { texts: ['New Game', 'Play Again', 'New Bot'] },
    ];
    for (var i = 0; i < tries.length; i++) {
      var r2 = await this.bridge('click-text', tries[i]);
      if (r2 && r2.ok) { U.log('autopilot: clicked', JSON.stringify(tries[i].texts)); return tries[i].texts[0]; }
      await sleep(250);
    }
    // 3. LAST resort, bot pages only: Rematch (instant re-game vs the same
    //    bot — harmless there, but never on live games where it sends a
    //    challenge to a human that may never be accepted)
    if ((this.settings.get('autopilot.allowRematch') || this.onComputerPage()) && !this.isChallengePending()) {
      var r3 = await this.bridge('click-text', { texts: ['Rematch'] });
      if (r3 && r3.ok) { U.log('autopilot: clicked Rematch (bot-page fallback)'); return 'Rematch'; }
    }
    return null;
  };

  /* figure out where we are and prod the right button */
  Autopilot.prototype.recoverStart = async function () {
    // a pending challenge (declined rematch etc.) is wedging the flow —
    // cancel it, then click the real new-game button
    if (this.isChallengePending() && Date.now() - this._cancelAt > 12000) {
      this._cancelAt = Date.now();
      U.log('autopilot: challenge pending — cancelling');
      await this.bridge('click-text', { texts: ['Cancel', 'Close', 'Decline'] });
      await sleep(700);
      var c2 = await this.clickNewGame();
      if (c2) { this.phase = PHASES.WAITING; this._idleSince = Date.now(); this._queuedSince = Date.now(); return 'requeued'; }
    }
    var r = await this.bridge('chesscom-info');
    var info = r && r.info;
    if (info && info.over === false) { this.onGameLive(); return 'live'; }
    if (info && info.over === true) {
      var c = await this.clickNewGame();
      if (c) { this.phase = PHASES.WAITING; this._idleSince = Date.now(); this._queuedSince = Date.now(); this._awaitingQueue = Date.now(); return 'clicked'; }
    }
    // no game object → setup screen: pick color + press Play
    if (Date.now() - this._playClickAt > 4000) {
      this._playClickAt = Date.now();
      if (this.colorExplicit() && this.onComputerPage()) await this.pickSideOption();
      var p = await this.bridge('click-text', { texts: ['Play', 'Start'] });
      if (p && p.ok) { this.phase = PHASES.WAITING; this._idleSince = Date.now(); this._queuedSince = Date.now(); this.setStatus('starting game…'); return 'play'; }
    }
    return null;
  };

  Autopilot.prototype.colorExplicit = function () {
    var c = this.settings.get('autoplay.color');
    return c === 'white' || c === 'black';
  };

  Autopilot.prototype.pickSideOption = async function () {
    try {
      var want = this.settings.get('autoplay.color');
      var els = document.querySelectorAll('.play-side-selector-option');
      for (var i = 0; i < els.length; i++) {
        var bg = ((els[i].style && els[i].style.backgroundImage) || '').toLowerCase();
        var cls = String(els[i].className || '').toLowerCase();
        if (bg.indexOf(want) >= 0 || (want === 'white' && /white/.test(cls)) || (want === 'black' && /black/.test(cls))) {
          var r = await this.bridge('click', { sel: '.play-side-selector-option', nth: i });
          if (r && r.ok) { U.log('autopilot: picked', want, 'side option'); await sleep(500); return true; }
        }
      }
    } catch (e) {}
    return false;
  };

  /* ---------- resign ---------- */
  Autopilot.prototype.doResign = async function () {
    if (this._resign.done) return;
    this._resign.done = true;
    this.setStatus('resigning…');
    this.emitStatus(true);

    var verifyOver = async function () {
      for (var i = 0; i < 6; i++) {
        await sleep(450);
        var vi = await this.bridge('chesscom-info');
        if (vi && vi.info && vi.info.over === true) return true;
      }
      return false;
    }.bind(this);

    var done = false;
    if (this.onComputerPage()) {
      // bot games: SDK resign is instant and reliable
      var r = await this.bridge('chesscom-resign');
      if (r && r.ok) done = await verifyOver();
      if (!done) {
        var ui = await this.bridge('chesscom-resign-ui');
        if (ui && ui.ok) done = await verifyOver();
      }
    } else {
      // LIVE games: the UI resign FIRST — the SDK resign ends the game on the
      // server but the game-over modal never renders, which breaks the
      // next-game click. The popover flow renders it properly.
      var ui2 = await this.bridge('chesscom-resign-ui');
      if (ui2 && ui2.ok) done = await verifyOver();
      if (!done) {
        var r2 = await this.bridge('chesscom-resign');
        if (r2 && r2.ok) done = await verifyOver();
      }
    }
    // blind fallback ladder
    if (!done) {
      await this.bridge('click-text', { texts: ['Resign', 'Abort'] });
      await sleep(800);
      await this.bridge('click-text', { texts: ['Resign', 'Abort', 'Confirm'] });
      await sleep(800);
    }
    U.log('autopilot: resigned', done ? '(verified)' : '(unverified)');
  };

  /* ---------- stuck recovery (autoplay gave up retrying) ---------- */
  Autopilot.prototype.onStuck = function (e) {
    if (!this.enabled) return;
    this._stuckCount++;
    U.log('autopilot: autoplay stuck x' + this._stuckCount, e && e.error);
    var self = this;
    if (this._stuckCount === 1) {
      try { this.gs.unlockColor(); this.gs.redetectColor(true); } catch (e2) {}
      setTimeout(function () {
        if (!self.enabled) return;
        try { self.autoplay.start(); } catch (e3) {}
      }, 3000);
    } else if (this._stuckCount === 2) {
      this.recoverStart();
    } else {
      // abandon this game: resign (or let the modal recycle) and continue
      this.doResign().then(function () {
        setTimeout(function () {
          if (self.enabled && self.phase === PHASES.PLAYING) self.handleGameOver(true);
        }, 5000);
      });
    }
  };

  /* ---------- popup hygiene ---------- */
  Autopilot.prototype.dismissPopups = function () {
    try {
      // never touch the game-over modal or resign confirmations
      var modal = readGameOverModal();
      if (modal) return;
      var dlg = document.querySelector('dialog[open]');
      if (!dlg) return;
      var txt = (dlg.textContent || '').toLowerCase();
      if (/new game|rematch|you won|you lost|draw|resign|skill level|play as a guest/.test(txt)) return;
      var closeBtn = dlg.querySelector('button[aria-label="Close"], .cc-close-button-component');
      if (closeBtn) {
        this.bridge('click', { sel: 'dialog[open] button[aria-label="Close"], dialog[open] .cc-close-button-component', nth: 0 });
        U.log('autopilot: dismissed a blocking dialog');
      }
    } catch (e) {}
  };

  /* ---------- hooks used by AutoPlayer ---------- */

  /** tune the autoplay cfg toward this game's plan (pre-analysis). */
  Autopilot.prototype.tuneSettings = function (s, ctx) {
    if (!this.enabled || !this.plan) return s;
    return tuneSettings(s, this.plan, ctx);
  };

  /** sabotage override: replace the chosen move with a plausibly worse one. */
  Autopilot.prototype.adjustChoice = function (choice, lines, ctx) {
    if (!this.enabled || this.plan !== 'lose') return null;
    if (!sabotageGate(this.settings.data.autopilot, this.plan, ctx, this._sabotage || {}, this.rng)) return null;
    var hard = ctx && ctx.myWin != null && ctx.myWin > 55 && (ctx.ply || 0) >= 20;
    var pick = pickSabotage(lines, this.rng, hard);
    if (!pick || !pick.uci || pick.uci === (choice && choice.uci)) return null;
    this._sabotage.lastPly = ctx.ply;
    U.log('autopilot: sabotage', pick.uci, 'delta', Math.round(pick.delta), hard ? '(hard)' : '');
    return { uci: pick.uci, tier: 'blunder', winPct: pick.winPct, delta: pick.delta, reason: 'slip' };
  };

  O.Autopilot = Autopilot;
  O.AUTOPILOT_PHASES = PHASES;
})(typeof window !== 'undefined' ? window : globalThis);
