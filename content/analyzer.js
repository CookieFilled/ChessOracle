/* ChessOracle — Analyzer: continuous engine loop + EngineClient messaging.
 *
 * - EngineClient: request/response against the offscreen engine via the SW.
 * - Analyzer: whenever the position stabilizes, asks the engine for the
 *   current position and broadcasts rich analysis results for overlays,
 *   the panel and the auto-player.
 *
 * Events on O.bus:
 *   'engine:ready'  {status}
 *   'engine:down'   {error}
 *   'analysis'      {fen, turn, bestmove, lines[], depth, nodes, nps, winPct, thinking}
 *   'analysis:live' (streaming partial results)
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;
  var M = O.MSG;

  /* ---------------- EngineClient ---------------- */
  function EngineClient() {
    var self = this;
    this.ready = false;
    this.lastError = null;
    this.pending = new Map(); // reqId -> {resolve, reject, startedAt}
    this.seq = 0;
    this.status = null;

    chrome.runtime.onMessage.addListener(function (msg) {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === M.ENGINE_RESULT) {
        var p = self.pending.get(msg.reqId);
        if (p) {
          self.pending.delete(msg.reqId);
          if (msg.ok) p.resolve(msg);
          else p.reject(new Error(msg.error || 'engine-error'));
        }
      } else if (msg.type === M.ENGINE_INFO) {
        if (self.pending.has(msg.reqId)) {
          O.bus.emit('analysis:live', msg);
        }
      } else if (msg.type === M.ENGINE_STATUS && msg.broadcast) {
        self.status = msg.status;
        if (msg.status && msg.status.ready && !self.ready) {
          self.ready = true;
          O.bus.emit('engine:ready', msg.status);
        }
      }
    });
  }

  EngineClient.prototype.ensure = function () {
    var self = this;
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: M.ENSURE_OFFSCREEN }, function (res) {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          if (res && res.ok) {
            self.ready = true;
            O.bus.emit('engine:ready', {});
          }
          resolve(res || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  };

  /**
   * @param {object} req {fen, moves?, depth, movetime, multipv, skill}
   * @returns {Promise} {ok, bestmove, lines, depth, nodes, nps}
   * The offscreen document answers directly on the message channel.
   */
  EngineClient.prototype.analyze = function (req) {
    var self = this;
    var reqId = 'r' + (++this.seq) + '_' + U.uid();
    return new Promise(function (resolve, reject) {
      var payload = {
        type: M.ENGINE_ANALYZE,
        reqId: reqId,
        fen: req.fen,
        moves: req.moves || null,
        depth: req.depth,
        movetime: req.movetime,
        multipv: req.multipv || 4,
        skill: req.skill != null ? req.skill : 20,
      };
      // keep reqId registered so streaming info updates can be correlated
      self.pending.set(reqId, { resolve: function () {}, reject: function () {} });
      setTimeout(function () { self.pending.delete(reqId); }, 30000);

      var timeout = setTimeout(function () {
        clearTimeout(timeout);
        self.pending.delete(reqId);
        reject(new Error('engine-timeout'));
      }, (req.movetime || 900) + 12000);

      var attempt = function (retried) {
        chrome.runtime.sendMessage(payload, function (res) {
          if (chrome.runtime.lastError || !res) {
            if (!retried) {
              // engine/offscreen may not be up yet — ensure and retry once
              self.ensure().then(function () {
                setTimeout(function () { attempt(true); }, 600);
              });
              return;
            }
            clearTimeout(timeout);
            self.pending.delete(reqId);
            self.ready = false;
            O.bus.emit('engine:down', { error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'no-response' });
            reject(new Error('engine-unavailable'));
            return;
          }
          clearTimeout(timeout);
          self.pending.delete(reqId);
          if (res.ok) {
            self.ready = true;
            resolve(res);
          } else {
            reject(new Error(res.error || 'engine-error'));
          }
        });
      };
      attempt(false);
    });
  };

  EngineClient.prototype.stop = function () {
    try { chrome.runtime.sendMessage({ type: M.ENGINE_STOP }); } catch (e) {}
  };

  /* ---------------- Analyzer ---------------- */
  function Analyzer(gameState, engineClient, settings) {
    var self = this;
    this.gs = gameState;
    this.ec = engineClient;
    this.settings = settings;
    this.currentFen = null;
    this.lastResult = null;      // full result for current position
    this.liveResult = null;      // streaming partial
    this.thinking = false;
    this.reqToken = 0;
    this.paused = false;
    this._pendingEval = null;    // last move record awaiting its after-eval

    O.bus.on('position:stable', function (snap) { self.onPosition(snap); });
    O.bus.on('game:new', function () { self.currentFen = null; self._pendingEval = null; });
    O.bus.on('engine:down', function () { self.thinking = false; });
    O.bus.on('game:move', function (rec) { self.onMoveRegistered(rec); });

    settings.onChanged(function (path) {
      if (path === 'analysis.depth' || path === 'analysis.movetime' || path === '*') {
        self.onPosition(null, true);
      }
    });
  }

  Analyzer.prototype.onPosition = function (snap, force) {
    var fen = this.gs.currentFEN();
    if (!fen) return;
    if (!force && fen === this.currentFen) return;
    this.currentFen = fen;
    this.analyzeNow(fen);
  };

  /* main.js injects a param provider that accounts for autoplay mode */
  Analyzer.prototype.setParamsProvider = function (fn) { this.getParams = fn; };

  Analyzer.prototype.analyzeNow = function (fen) {
    var self = this;
    if (this.paused) return;
    var token = ++this.reqToken;
    var params = this.getParams ? this.getParams() : {
      depth: 16, movetime: 900, multipv: 4, skill: 20,
    };

    this.thinking = true;
    // NOTE: repetition-aware position: send startpos+moves when tracked from start
    var movesArg = this.gs.trackedFromStart ? this.gs.uciHistory : null;

    this.ec.analyze({
      fen: fen,
      moves: movesArg && movesArg.length ? movesArg : null,
      depth: params.depth,
      movetime: params.movetime,
      multipv: params.multipv,
      skill: params.skill,
    }).then(function (res) {
      if (token !== self.reqToken) return; // stale
      self.thinking = false;
      self.lastResult = self.decorate(fen, res);
      O.bus.emit('analysis', self.lastResult);
      self.completeMoveEval();
    }).catch(function (e) {
      if (token !== self.reqToken) return;
      self.thinking = false;
      U.util.log && O.util.log('analysis failed', e.message);
    });
  };

  /* convert engine scores to win% for the side to move & decorate lines */
  Analyzer.prototype.decorate = function (fen, res) {
    var lines = (res.lines || []).map(function (l) {
      var score = l.score || { cp: 0 };
      return {
        uci: l.uci,
        pv: l.pv || [],
        score: score,
        winPct: U.winPctFromScore(score),
      };
    });
    var best = lines[0] || null;
    return {
      fen: fen,
      turn: this.gs.turnColor(),
      bestmove: res.bestmove,
      lines: lines,
      depth: res.depth,
      nodes: res.nodes,
      nps: res.nps,
      winPct: best ? best.winPct : 50,
      thinking: false,
      ts: Date.now(),
    };
  };

  /* -------- move classification inputs -------- */

  var PIECE_VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  /* called when a move is registered: capture the PRE-move analysis */
  Analyzer.prototype.onMoveRegistered = function (rec) {
    var a = this.lastResult;
    if (a && a.fen && rec.fenBefore && a.fen.split(' ').slice(0, 4).join(' ') === rec.fenBefore.split(' ').slice(0, 4).join(' ')) {
      rec.evalBefore = a.winPct;
      rec.scoreBefore = a.lines && a.lines[0] ? a.lines[0].score : null;
      rec.isBest = !!a.bestmove && a.bestmove === rec.uci;
      rec.onlyMove = !!(a.lines && a.lines.length > 1 && (a.lines[0].winPct - a.lines[1].winPct) > 6);
    }
    this._pendingEval = rec;
  };

  /* called after each analysis completes: fill the AFTER eval and classify */
  Analyzer.prototype.completeMoveEval = function () {
    var rec = this._pendingEval;
    if (!rec || rec.evalAfter != null) { if (rec && rec.evalAfter != null) this._pendingEval = null; return; }
    var a = this.lastResult;
    if (!a || !a.fen || !rec.fenAfter) return;
    if (a.fen.split(' ').slice(0, 4).join(' ') !== rec.fenAfter.split(' ').slice(0, 4).join(' ')) return;
    // a.winPct is for the side to move AFTER the move (the opponent)
    rec.evalAfter = 100 - a.winPct;
    rec.scoreAfter = a.lines && a.lines[0] ? flipScore(a.lines[0].score) : null;

    // sacrifice heuristic: a valuable piece sits on the destination square,
    // attacked by the opponent, yet the eval stays decent
    var gs = this.gs;
    try {
      var piece = gs.chess.get(rec.to);
      if (piece && PIECE_VAL[piece.type] >= 3 &&
          O.isAttacked(gs.chess, rec.to, rec.color === 'w' ? 'b' : 'w') &&
          rec.evalAfter >= 45) {
        rec.sacrifice = true;
      }
    } catch (e) {}

    this._pendingEval = null;
    gs.classifyMove(gs.moves.length - 1);
    O.bus.emit('game:classified', { move: rec, index: gs.moves.length - 1 });
  };

  function flipScore(score) {
    if (!score) return null;
    if (score.mate != null) return { mate: -score.mate };
    return { cp: -score.cp };
  }

  O.EngineClient = EngineClient;
  O.Analyzer = Analyzer;
})(typeof window !== 'undefined' ? window : globalThis);
