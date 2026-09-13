/* ChessOracle — GameState: keeps a chess.js mirror of the game, applies
 * inferred moves, classifies move quality, computes accuracy & eval history.
 *
 * Events on O.bus:
 *   'game:new'      {fen, ply, myColor}
 *   'game:move'     {san, uci, from, to, color, ply, fen, fenAfter, capture, check}
 *   'game:sync'     {fen, ply, syncedFrom: 'start'|'adopted'}
 *   'game:over'     {result}
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;

  var START_PLACEMENT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

  function normColor(c) {
    if (c === 'white' || c === 'w' || c === 1) return 'w';
    if (c === 'black' || c === 'b' || c === 2) return 'b';
    return null;
  }
  O.normColor = normColor;

  function GameState(boardWatcher, site, settings) {
    var self = this;
    this.bw = boardWatcher;
    this.site = site;
    this.settings = settings || null;
    this.chess = null;          // chess.js instance synced to current position
    this.uciHistory = [];       // full uci list when tracked from start
    this.moves = [];            // move records
    this.myColor = null;        // 'w' | 'b' | null
    this.trackedFromStart = false;
    this.synced = false;
    this.gameOver = false;
    this.awaitingColorProbe = false;
    this._colorLocked = false;  // set once we've PROVEN our color (successful own move / explicit setting)
    this._lastRedetect = 0;
    this._prevPieces = null;
    this._skipBootstrapOnce = false;   // set by adoptGame/adoptFEN resyncs

    O.bus.on('position:stable', function (snap) { self.onSnapshot(snap); });
    O.bus.on('orientation', function () { self.onOrientationChange(); });
    O.bus.on('site:info', function () { self.redetectColor(); });
  }

  GameState.prototype.onOrientationChange = function () {
    var self = this;
    // board flipped 180°: our color mapping may change with it
    setTimeout(function () { self.redetectColor(true); }, 150);
  }

  /* Re-detect my color from the site. Fixes the classic race where the
   * extension boots on a pre-game / setup screen (board in white view) and
   * the player then starts or joins a game as BLACK: orientation updates
   * itself on every snapshot, but myColor used to be read exactly once at
   * bootstrap and stayed stale — making autoplay try to move the OPPONENT'S
   * pieces until it gave up. Skipped when the color is locked or explicitly
   * set via the Play-As setting. */
  GameState.prototype.redetectColor = function (force) {
    var now = Date.now();
    if (!force && now - this._lastRedetect < 1200) return null;
    this._lastRedetect = now;
    if (this._colorLocked) return null;
    var mode = this.settings && this.settings.get ? this.settings.get('autoplay.color') : 'auto';
    if (mode === 'white' || mode === 'black') return null;  // explicit user choice wins
    if (!this.site || typeof this.site.detectMyColor !== 'function') return null;
    var detected = null;
    try { detected = normColor(this.site.detectMyColor(this.bw ? this.bw.wrapEl : null)); } catch (e) {}
    if (!detected) return null;
    if (detected !== this.myColor) {
      this.myColor = detected;
      U.log('myColor re-detected ->', detected);
      O.bus.emit('game:color', { myColor: detected, ply: this.moves.length });
      return detected;
    }
    return null;
  };

  /* Lock our color once proven (a move the site ACCEPTED from us can only
   * have been our own piece). Protects against view flips mid-game. */
  GameState.prototype.lockColor = function (color) {
    var c = normColor(color);
    if (!c) return;
    this._colorLocked = true;
    if (this.myColor !== c) {
      this.myColor = c;
      U.log('myColor locked ->', c);
      O.bus.emit('game:color', { myColor: c, locked: true, ply: this.moves.length });
    }
  };

  GameState.prototype.unlockColor = function () {
    this._colorLocked = false;
  };

  GameState.prototype.onSnapshot = function (snap) {
    // keep my color in sync with the site (late-arriving game config, board
    // flips, games joined/started after we booted)
    this.redetectColor();

    if (this._suppressUntil && Date.now() < this._suppressUntil) { this._prevPieces = snap.pieces; return; }
    var prev = this._prevPieces;
    this._prevPieces = snap.pieces;

    if (!prev) {
      // after adoptGame/adoptFEN we already know the position — just adopt
      // the DOM pieces without re-bootstrapping
      if (this._skipBootstrapOnce) {
        this._skipBootstrapOnce = false;
        return;
      }
      this.bootstrap(snap);
      return;
    }

    // detect full reset / new game
    if (snap.placement === START_PLACEMENT && prev && O.moveDiff.placementFromList(prev) !== START_PLACEMENT) {
      this.bootstrap(snap, true);
      return;
    }

    if (!this.chess) { this.bootstrap(snap); return; }

    // remember pre-move fen for the record
    this._fenBeforeMove = this.chess.fen();

    var mv = O.moveDiff.inferMove(this.chess, prev, snap.pieces);
    if (!mv && prev) {
      /* repair pass: the DOM 'prev' can consume unregistrable intermediate
       * states (chess.com parks the pawn ON the promotion square while the
       * piece picker is open — that's no legal move, and neither is the
       * follow-up pawn->promoted swap). Re-run the inference against the
       * mirror's own board (the last REGISTERED position); the promotion
       * then matches exactly and the mirror stays in sync. */
      try {
        var mirrorPrev = O.moveDiff.listFromBoard(this.chess);
        if (mirrorPrev && mirrorPrev.length) mv = O.moveDiff.inferMove(this.chess, mirrorPrev, snap.pieces);
      } catch (e) {}
    }
    if (mv) {
      this.registerMove(mv, snap);
    } else {
      // maybe board rotated 180 (analysis flip) or desynced — try rotation
      var rotated = this.isRotated(prev, snap.pieces);
      if (rotated) {
        U.log('board flip detected — adopting new orientation');
        this._prevPieces = snap.pieces;
        O.bus.emit('orientation', { orientation: snap.orientation });
        return;
      }
      // big jump? resync
      var diffCount = this.countDiffs(prev, snap.pieces);
      if (diffCount > 6) {
        U.log('desync detected (' + diffCount + ' squares) — resyncing');
        this.bootstrap(snap, true);
      }
      // else: piece mid-drag or transient UI state; ignore
    }
  };

  GameState.prototype.isRotated = function (prevList, nextList) {
    var prev = O.moveDiff.mapFromList(prevList);
    var next = O.moveDiff.mapFromList(nextList);
    if (prev.size !== next.size) return false;
    for (var [sq, pc] of prev) {
      var rotSq = O.FILES[7 - O.FILES.indexOf(sq[0])] + (9 - parseInt(sq[1], 10));
      if (next.get(rotSq) !== pc) return false;
    }
    return true;
  };

  GameState.prototype.countDiffs = function (a, b) {
    var ma = O.moveDiff.mapFromList(a), mb = O.moveDiff.mapFromList(b);
    var n = Math.abs(ma.size - mb.size);
    for (var [k, v] of ma) if (mb.get(k) !== v) n++;
    return n;
  };

  /* (re)initialize tracking from a stable snapshot */
  GameState.prototype.bootstrap = function (snap, isReset) {
    var self = this;
    var isStart = snap.placement === START_PLACEMENT;

    // a fresh game means a fresh color mapping — unlock and re-read
    this._colorLocked = false;

    // side to move: from start -> white; else try move list parity / API
    var turn = 'w';
    if (!isStart) turn = this.guessTurn(snap);

    var fen = snap.placement + ' ' + turn + ' KQkq - 0 1';
    // guess castling rights: refine from placement (rook/king home squares)
    fen = this.refineCastling(snap.placement, turn);

    this.chess = new Chess(fen);
    this.uciHistory = [];
    this.moves = [];
    this.synced = isStart;   // exact from start; otherwise approximate
    this.trackedFromStart = isStart;
    this.gameOver = false;
    this._prevPieces = snap.pieces;
    this.myColor = normColor(this.site.detectMyColor ? this.site.detectMyColor(snap.wrapEl) : null);

    U.log('game bootstrap', isStart ? '(from start)' : '(adopted: ' + fen.slice(0, 24) + '...)', 'myColor=', this.myColor);

    O.bus.emit('game:new', {
      fen: fen,
      ply: 0,
      myColor: this.myColor,
      exact: isStart,
    });
    O.bus.emit('game:sync', { fen: fen, ply: 0, syncedFrom: isStart ? 'start' : 'adopted' });
  };

  GameState.prototype.guessTurn = function (snap) {
    // chess.com: bridge-cached SDK turn is exact (MAIN-world poller)
    if (this.site.id === 'chesscom') {
      var si = O.siteInfo;
      if (si && si.turn != null) {
        if (si.turn === 1 || si.turn === 'white') return 'w';
        if (si.turn === 2 || si.turn === 'black') return 'b';
      }
      try {
        var g = snap.wrapEl && snap.wrapEl.game;
        if (g && typeof g.getTurn === 'function') {
          var t = g.getTurn();
          if (t === 1 || t === 'white') return 'w';
          if (t === 2 || t === 'black') return 'b';
        }
      } catch (e) {}
    }
    // lichess: count plies in move list DOM
    try {
      var ml = document.querySelector('.rmv, lrmoves, [class*="moves"]');
      if (ml) {
        var sans = (ml.textContent || '').match(/\b([KQRBNa-h][a-h1-8x+=#-]{1,6})[+#]?/g);
        if (sans && sans.length) return sans.length % 2 === 0 ? 'w' : 'b';
      }
    } catch (e) {}
    return 'w';
  };

  GameState.prototype.refineCastling = function (placement, turn) {
    var rights = '';
    var m = O.moveDiff.mapFromList([{ square: 'e1', piece: placement.includes('RNBQKBNR') ? 'wK' : '' }]); // unused
    var rows = placement.split('/');
    var row8 = rows[0] || '', row1 = rows[7] || '';
    var has = function (row, sqIdx, ch) { return row[sqIdx] === ch; };
    if (row1[4] === 'K') {
      if (row1[7] === 'R') rights += 'K';
      if (row1[0] === 'R') rights += 'Q';
    }
    if (row8[4] === 'k') {
      if (row8[7] === 'r') rights += 'k';
      if (row8[0] === 'r') rights += 'q';
    }
    if (!rights) rights = '-';
    return placement + ' ' + turn + ' ' + rights + ' - 0 1';
  };

  GameState.prototype.registerMove = function (mv, snap) {
    var color = mv.color;
    var record = {
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion || ''),
      from: mv.from,
      to: mv.to,
      promotion: mv.promotion || null,
      color: color,
      captured: mv.captured || null,
      flags: mv.flags || '',
      ply: this.moves.length + 1,
      fenBefore: this._fenBeforeMove || null,
      fenAfter: this.chess.fen(),
      ts: Date.now(),
      classification: null,
      evalBefore: null,   // win% for mover before the move
      evalAfter: null,    // win% for mover after the move
      scoreBefore: null,
      scoreAfter: null,
      isBest: false,
      onlyMove: false,
      sacrifice: false,
    };
    this.moves.push(record);
    this.uciHistory.push(record.uci);

    if (this.chess.game_over()) {
      this.gameOver = true;
      O.bus.emit('game:over', { result: this.chess.in_checkmate() ? (color === 'w' ? '1-0' : '0-1') : 'draw' });
    }

    O.bus.emit('game:move', record);
  };

  GameState.prototype.currentFEN = function () {
    return this.chess ? this.chess.fen() : null;
  };

  GameState.prototype.turnColor = function () {
    return this.chess ? this.chess.turn() : null;
  };

  GameState.prototype.isMyTurn = function () {
    if (!this.chess || !this.myColor) return false;
    return this.chess.turn() === this.myColor;
  };

  GameState.prototype.legalMoves = function () {
    if (!this.chess) return [];
    try { return this.chess.moves({ verbose: true }); } catch (e) { return []; }
  };

  GameState.prototype.sanToUci = function (san) {
    if (!this.chess) return null;
    try {
      var mv = this.chess.move(san);
      if (mv) { this.chess.undo(); return mv.from + mv.to + (mv.promotion || ''); }
    } catch (e) {}
    return null;
  };

  GameState.prototype.uciToSan = function (uci) {
    if (!this.chess) return null;
    var from = uci.slice(0, 2), to = uci.slice(2, 4), promo = uci.length > 4 ? uci[4] : undefined;
    try {
      var mv = this.chess.move({ from: from, to: to, promotion: promo });
      if (mv) { this.chess.undo(); return mv.san; }
    } catch (e) {}
    return null;
  };

  /* ---------------- server-authoritative resync (chess.com) ----------------
   * The DOM mirror can drift from the server (missed opponent move, phantom
   * premove baked in by the board watcher, tab throttling). chess.com's SDK
   * exposes the REAL server history — replay it and the mirror is exact. */

  /** Rebuild the whole game from the server's SAN history (authoritative). */
  GameState.prototype.adoptGame = function (sans) {
    try {
      if (!Array.isArray(sans) || !sans.length) return false;
      var c = new Chess();
      var records = [];
      var ucis = [];
      for (var i = 0; i < sans.length; i++) {
        var mv;
        try { mv = c.move(sans[i]); } catch (e) { mv = null; }
        if (!mv) break;                         // history diverged — keep what we have
        records.push({
          san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''),
          from: mv.from, to: mv.to, promotion: mv.promotion || null,
          color: mv.color, captured: mv.captured || null, flags: mv.flags || '',
          ply: i + 1, fenBefore: null, fenAfter: null, ts: Date.now(),
          classification: null, evalBefore: null, evalAfter: null,
          scoreBefore: null, scoreAfter: null, isBest: false, onlyMove: false, sacrifice: false,
        });
        ucis.push(records[i].uci);
      }
      if (!records.length) return false;
      this.chess = c;
      this.moves = records;
      this.uciHistory = ucis;
      this.trackedFromStart = true;
      this.synced = true;
      this.gameOver = c.game_over();
      this._prevPieces = null;
      this._skipBootstrapOnce = true;           // next snapshot only refreshes _prevPieces
      U.log('mirror resynced from server history (' + records.length + ' plies)');
      O.bus.emit('game:sync', { fen: c.fen(), ply: records.length, syncedFrom: 'site' });
      if (this.gameOver) O.bus.emit('game:over', { result: c.in_checkmate() ? (records[records.length - 1].color === 'w' ? '1-0' : '0-1') : 'draw' });
      return true;
    } catch (e) { return false; }
  };

  /** Fallback resync when no history is available: adopt the server FEN. */
  GameState.prototype.adoptFEN = function (fen) {
    try {
      if (!fen) return false;
      var c = new Chess(fen);
      this.chess = c;
      this.moves = [];            // history unknown — records start fresh
      this.uciHistory = [];
      this.trackedFromStart = false;
      this.synced = true;
      this.gameOver = c.game_over();
      this._prevPieces = null;
      this._skipBootstrapOnce = true;
      U.log('mirror resynced from server FEN');
      O.bus.emit('game:sync', { fen: fen, ply: 0, syncedFrom: 'site-fen' });
      return true;
    } catch (e) { return false; }
  };

  /* set my color manually (autoplay setting). Guarded so re-applying the
   * same color does not re-emit game:new (which would re-trigger listeners
   * and could loop). */
  GameState.prototype.setMyColor = function (color) {
    var c = normColor(color);
    this._colorLocked = !!c;   // explicit choice is authoritative until changed
    if (this.myColor === c) return;
    this.myColor = c;
    O.bus.emit('game:color', { myColor: c, locked: !!c });
    O.bus.emit('game:new', { fen: this.currentFEN(), ply: this.moves.length, myColor: this.myColor, exact: this.trackedFromStart });
  };

  /* classification -------------------------------------------------- */
  var CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder'];

  GameState.prototype.classifyMove = function (idx) {
    var rec = this.moves[idx];
    if (!rec || rec.evalBefore == null || rec.evalAfter == null) return;
    var delta = rec.evalBefore - rec.evalAfter; // positive = quality drop (win% lost)
    var cls;
    if (delta >= 20) cls = 'blunder';
    else if (delta >= 10) cls = 'mistake';
    else if (delta >= 5) cls = 'inaccuracy';
    else if (delta >= 2) cls = 'good';
    else if (delta >= 0.6) cls = 'excellent';
    else if (rec.isBest) cls = 'best';
    else cls = 'best';

    // brilliant: a real sacrifice that keeps eval
    if (delta < 2 && rec.sacrifice && rec.evalAfter >= 45) cls = 'brilliant';
    // great: only-move (second best much worse)
    if (cls === 'best' && rec.onlyMove) cls = 'great';

    rec.classification = cls;
  };

  GameState.prototype.accuracy = function (color) {
    var sum = 0, n = 0;
    for (var i = 0; i < this.moves.length; i++) {
      var r = this.moves[i];
      if (r.color !== color || r.evalBefore == null || r.evalAfter == null) continue;
      var loss = Math.max(0, r.evalBefore - r.evalAfter);
      var acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
      sum += U.clamp(acc, 0, 100);
      n++;
    }
    return n ? sum / n : null;
  };

  GameState.prototype.pgn = function () {
    if (!this.moves.length) return '';
    var out = [];
    for (var i = 0; i < this.moves.length; i++) {
      var r = this.moves[i];
      if (r.color === 'w') out.push((Math.floor(i / 2) + 1) + '.');
      else if (i === 0) out.push('1...');
      var ann = '';
      if (r.classification) {
        var mark = { brilliant: '!!', great: '!', best: '', excellent: '', good: '', inaccuracy: '?!', mistake: '?', blunder: '??' }[r.classification];
        if (mark) ann = mark;
        var ev = r.evalAfter != null ? ' (win ' + r.evalAfter.toFixed(0) + '%' + (ann ? ', ' + r.classification : '') + ')' : '';
        if (ev || ann) out.push(r.san + (ann + ev ? ' {' + (r.classification || '') + ev + '}' : ''));
        else out.push(r.san);
      } else {
        out.push(r.san);
      }
    }
    return out.join(' ');
  };

  O.GameState = GameState;
  O.CLASS_ORDER = CLASS_ORDER;
})(typeof window !== 'undefined' ? window : globalThis);
