/* ChessOracle — BoardWatcher: discovers the board, reads positions,
 * detects orientation & new games, and emits stable position events.
 *
 * Events emitted on O.bus:
 *   'board:found'    {boardEl}
 *   'board:lost'     {}
 *   'position'       {pieces, fen-placement, orientation, boardEl, boardRect}
 *   'position:stable' same as above once stable (debounced)
 *   'orientation'    {orientation}
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;

  var QUIET_MS = 140;        // no mutations for this long -> possibly stable
  var CONFIRM_MS = 90;       // two identical reads this far apart -> stable
  var MAX_DISCOVER_ROUNDS = 240;

  function BoardWatcher(site) {
    this.site = site;
    this.boardEl = null;
    this.wrapEl = null;
    this.orientation = 'white';
    this.lastSnapshot = null;
    this.lastStable = null;
    this.observer = null;
    this.discoverTimer = null;
    this.stableTimer = null;
    this.readTimer = null;
    this.discoverRounds = 0;
    this.running = false;
    this.pendingRead = false;
    this.url = location.href;
    this._busy = false;
  }

  BoardWatcher.prototype.start = function () {
    var self = this;
    if (this.running) return;
    this.running = true;

    this.discover();
    this.discoverTimer = setInterval(function () { self.discover(); }, 1200);

    // SPA navigation watch
    setInterval(function () {
      if (location.href !== self.url) {
        self.url = location.href;
        U.log('SPA nav ->', location.pathname);
        // give the new page a moment, then force rediscovery
        self.detachBoard();
        setTimeout(function () { self.discover(); }, 400);
      }
    }, 800);
  };

  BoardWatcher.prototype.discover = function () {
    if (this.boardEl && this.boardEl.isConnected && this.boardEl.getBoundingClientRect().width > 80) {
      if (this.pendingRead) return;
      return;
    }
    var boards = this.site.findBoards();
    if (!boards.length) {
      if (this.boardEl) { this.detachBoard(); }
      return;
    }
    var best = boards[0];
    if (best.board === this.boardEl && this.observer) return;
    this.attachBoard(best);
  };

  BoardWatcher.prototype.attachBoard = function (b) {
    var self = this;
    this.detachBoard();
    this.boardEl = b.board;
    this.wrapEl = b.wrap;
    this.orientation = this.site.orientation(this.wrapEl) || 'white';
    U.log('board attached', this.boardEl.tagName, 'orientation', this.orientation);

    this.observer = new MutationObserver(function () { self.scheduleRead(); });
    var target = this.boardEl;
    try {
      this.observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'transform'] });
      // also observe the wrap (piece promotions / dialogs live there)
      if (this.wrapEl !== this.boardEl && this.wrapEl.contains(this.boardEl)) {
        this.observer.observe(this.wrapEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      }
    } catch (e) {}

    var ro = new ResizeObserver(function () { self.scheduleRead(); });
    ro.observe(this.boardEl);
    this.resizeObs = ro;

    window.addEventListener('scroll', this._scrollHandler = function () { self.onGeomChange(); }, { passive: true });
    window.addEventListener('resize', this._resizeHandler = function () { self.onGeomChange(); });

    O.bus.emit('board:found', { boardEl: this.boardEl });
    this.scheduleRead(120);
  };

  BoardWatcher.prototype.detachBoard = function () {
    if (this.observer) { try { this.observer.disconnect(); } catch (e) {} this.observer = null; }
    if (this.resizeObs) { try { this.resizeObs.disconnect(); } catch (e) {} this.resizeObs = null; }
    if (this._scrollHandler) window.removeEventListener('scroll', this._scrollHandler);
    if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
    if (this.boardEl) {
      this.boardEl = null;
      this.wrapEl = null;
      this.lastSnapshot = null;
      this.lastStable = null;
      O.bus.emit('board:lost', {});
    }
  };

  BoardWatcher.prototype.onGeomChange = function () {
    // overlays listen to geometry changes themselves via ResizeObserver
    O.bus.emit('board:geom', { boardEl: this.boardEl });
  };

  BoardWatcher.prototype.scheduleRead = function (delay) {
    var self = this;
    if (this._busy && delay !== 120) { this.pendingRead = true; return; }
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(function () { self.readAndStabilize(); }, delay || QUIET_MS);
  };

  /* debounce + double-read confirmation */
  BoardWatcher.prototype.readAndStabilize = function () {
    var self = this;
    if (!this.boardEl || !this.boardEl.isConnected) return;
    if (this._busy) { this.pendingRead = true; return; }
    this._busy = true;

    var read1 = this.readSnapshot();
    if (!read1) { this._busy = false; if (this.pendingRead) { this.pendingRead = false; this.scheduleRead(100); } return; }

    setTimeout(function () {
      var read2 = self.readSnapshot();
      self._busy = false;
      if (!read2) { self.scheduleRead(150); return; }
      if (read2.key !== read1.key) {
        // still animating — keep waiting
        self.scheduleRead(120);
        return;
      }
      // stable!
      var prevStable = self.lastStable;
      self.lastStable = read2;
      var orientation = read2.orientation;
      if (prevStable && prevStable.orientation !== orientation) {
        O.bus.emit('orientation', { orientation: orientation });
      }
      if (!prevStable || prevStable.key !== read2.key) {
        O.bus.emit('position', read2);
        O.bus.emit('position:stable', read2);
      } else {
        // same position; still notify geometry-carrying snapshot for overlays
        O.bus.emit('position:stable', read2);
      }
      if (self.pendingRead) { self.pendingRead = false; self.scheduleRead(80); }
    }, CONFIRM_MS);
  };

  /* snapshot: pieces, orientation, board rect */
  BoardWatcher.prototype.readSnapshot = function () {
    if (!this.boardEl || !this.boardEl.isConnected) return null;
    var wrap = this.wrapEl;
    var pieces;
    try {
      pieces = this.site.readPieces(this.boardEl, wrap);
    } catch (e) { return null; }
    if (!pieces || pieces.length < 2) return null;

    var br = this.boardEl.getBoundingClientRect();
    if (br.width < 80) return null;

    var orientation = this.site.orientation(wrap) || this.orientation;
    this.orientation = orientation;

    var key = orientation + '|' + pieces
      .map(function (p) { return p.square + p.piece; })
      .sort()
      .join(',');

    return {
      pieces: pieces,
      placement: O.moveDiff.placementFromList(pieces),
      orientation: orientation,
      boardEl: this.boardEl,
      wrapEl: wrap,
      boardRect: { left: br.left, top: br.top, width: br.width, height: br.height },
      key: key,
      ts: Date.now(),
    };
  };

  /* helpers for other modules */
  BoardWatcher.prototype.squareCenter = function (sq, snapshot) {
    var snap = snapshot || this.lastStable;
    if (!snap || !snap.boardEl.isConnected) return null;
    var br = snap.boardEl.getBoundingClientRect();
    var f = O.FILES.indexOf(sq[0]);
    var r = parseInt(sq[1], 10);
    var col = snap.orientation === 'black' ? 7 - f : f;
    var row = snap.orientation === 'black' ? r - 1 : 8 - r;
    var sqW = br.width / 8, sqH = br.height / 8;
    return { x: br.left + (col + 0.5) * sqW, y: br.top + (row + 0.5) * sqH };
  };

  BoardWatcher.prototype.forceRead = function () {
    this.scheduleRead(30);
  };

  O.BoardWatcher = BoardWatcher;
})(typeof window !== 'undefined' ? window : globalThis);
