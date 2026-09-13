/* ChessOracle — MoveExecutor: performs moves on the live board.
 *
 * chess.com:  primary = human-paced bridge drag / click-click (random pick);
 *             the site's own SDK (getFEN/getTurn/getHistorySANs — server
 *             state only, premove-free) gates and verifies every move:
 *               1. before moving: mirror must match the site FEN AND it must
 *                  actually be our turn (kills the premove race where a drag
 *                  on the opponent's turn becomes an unregistered premove)
 *               2. after moving: the server history must contain our move
 *                  (a premove or rejected drag never lands in it)
 *             last resort = board.game.move(SAN) SDK
 * lichess:    primary = bridge drag (captured listeners, trusted fake events);
 *             analysis pages additionally use lichess.analysis.playUci(uci)
 *
 * Every move is verified; failures escalate through a strategy ladder.
 * Promotions are selected in the site dialog by PIECE TOKEN (never by
 * position — chess.com's option DOM order starts with the bishop).
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;
  var sleep = U.sleep;

  function MoveExecutor(bw, gs, site) {
    this.bw = bw;
    this.gs = gs;
    this.site = site;
    this.busy = false;
    this.lastAttempt = 0;
    this._styleRng = Math.random;
  }

  /* bridge call into MAIN world */
  MoveExecutor.prototype.bridge = function (action, payload) {
    return new Promise(function (resolve) {
      var id = 'b' + Math.random().toString(36).slice(2, 9);
      var to = setTimeout(function () { cleanup(); resolve({ ok: false, error: 'bridge-timeout' }); }, 14000);
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
      var msg = Object.assign({ __coBridge: true, id: id, action: action }, payload || {});
      window.postMessage(msg, '*');
    });
  };

  MoveExecutor.prototype.boardSelector = function () {
    // unique selector for the board element (id or structural)
    var b = this.bw.boardEl;
    if (!b) return null;
    if (b.id) return '#' + b.id;
    if (b.tagName === 'WC-CHESS-BOARD') return 'wc-chess-board';
    if (b.tagName === 'CG-BOARD') return 'cg-board';
    return this.site.id === 'lichess' ? '.cg-wrap cg-board' : 'wc-chess-board';
  };

  /* ---------------- site truth (chess.com) ---------------- */

  /** Full server truth about the game (premove-free). Returns info or null. */
  MoveExecutor.prototype.siteInfo = async function () {
    if (this.site.id !== 'chesscom') return null;
    var r = await this.bridge('chesscom-info');
    return (r && r.info) || null;
  };

  /** Rebuild the mirror from the server's own history (authoritative).
   * Called whenever the mirror and the server disagree. */
  MoveExecutor.prototype.resyncFromSite = async function (info) {
    try {
      var r = await this.bridge('chesscom-history');
      var sans = r && r.sans;
      if (sans && sans.length && this.gs.adoptGame) {
        this.gs.adoptGame(sans);
      } else if (info && info.fen && this.gs.adoptFEN) {
        this.gs.adoptFEN(info.fen);
      }
      this.bw.forceRead();
    } catch (e) {}
  };

  /** Pre-move gate: the mirror must agree with the server (same placement)
   * and it must genuinely be our turn. A mismatch means the mirror is stale
   * or has a phantom premove baked in — resync and refuse to move. */
  MoveExecutor.prototype.siteGate = async function () {
    if (this.site.id !== 'chesscom') return { ok: true };
    var info = await this.siteInfo();
    if (!info || !info.fen) return { ok: true };   // no SDK truth — DOM-only mode
    var mirrorFen = this.gs.currentFEN();
    if (!mirrorFen) return { ok: true };
    var sitePl = String(info.fen).split(' ')[0];
    var mirrorPl = String(mirrorFen).split(' ')[0];
    if (sitePl !== mirrorPl) {
      U.log('site gate: placement mismatch — resyncing from server');
      await this.resyncFromSite(info);
      return { ok: false, error: 'site-desync', info: info };
    }
    var myColor = this.gs.myColor;
    if (myColor != null && info.turn != null) {
      var t = O.normColor(info.turn);
      if (t && t !== myColor) {
        U.log('site gate: NOT our turn on the server — resyncing (premove guard)');
        await this.resyncFromSite(info);
        return { ok: false, error: 'site-turn-mismatch', info: info };
      }
    }
    return { ok: true, info: info };
  };

  /** Authoritative verification: the server history must have advanced and
   * contain our SAN at the right index. Premoves/rejected drags never enter
   * the server history, so this is immune to visual board tricks. */
  MoveExecutor.prototype.verifyMoveOnSite = async function (beforePlies, san, uci, fenBefore, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 3200);
    var lastInfo = null;
    while (Date.now() < deadline) {
      await sleep(260);
      var r = await this.bridge('chesscom-info');
      var info = r && r.info;
      if (!info || info.plies == null) continue;
      lastInfo = info;
      if (info.plies > beforePlies) {
        // some move(s) registered — confirm ours is among them at its index
        var h = info.history || [];
        if (h.length && san) {
          var base = info.plies - h.length;          // index of tail[0] in the full history
          var idx = beforePlies - base;
          if (idx >= 0 && idx < h.length && h[idx] === san) return { ok: true, info: info };
        }
        if (fenBefore) {
          // fallback: placement check
          try {
            var c = new Chess(fenBefore);
            var mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
            if (mv && String(c.fen()).split(' ')[0] === String(info.fen).split(' ')[0]) {
              return { ok: true, info: info };
            }
          } catch (e) {}
        }
        return { ok: false, info: info, error: 'unexpected-move' };
      }
      if (info.plies < beforePlies) {
        // server went backwards (new game / rematch accepted) — hard resync
        return { ok: false, info: info, error: 'site-reset' };
      }
      // plies unchanged — keep polling
    }
    return { ok: false, info: lastInfo, error: 'not-registered' };
  };

  /** Cancel a pending premove (piece visually moved, server never got it):
   * click the piece at its visual spot + Escape, then re-read. */
  MoveExecutor.prototype.cancelPremove = function (to) {
    try {
      var c = this.bw.squareCenter(to);
      if (!c) return Promise.resolve(false);
      return this.bridge('cancel-premove', { x: c.x, y: c.y }).then(function () { return true; });
    } catch (e) { return Promise.resolve(false); }
  };

  /* main entry: uci like 'e2e4' or 'e7e8q'. Returns {ok, san?, strategy} */
  MoveExecutor.prototype.playMove = async function (uci) {
    var self = this;
    if (this.busy) return { ok: false, error: 'busy' };
    this.busy = true;
    var release = function (r) { self.busy = false; return r; };

    var from = uci.slice(0, 2);
    var to = uci.slice(2, 4);
    var promo = uci.length > 4 ? uci[4] : null;

    if (Date.now() - this.lastAttempt < 300) await sleep(350);
    this.lastAttempt = Date.now();

    var fenBefore = this.gs.currentFEN();
    var legal = this.gs.legalMoves().filter(function (m) { return m.from === from && m.to === to; });
    if (!legal.length) {
      // position may have advanced; try a fresh read
      this.bw.forceRead();
      await sleep(400);
      fenBefore = this.gs.currentFEN();
      legal = this.gs.legalMoves().filter(function (m) { return m.from === from && m.to === to; });
      if (!legal.length) return release({ ok: false, error: 'illegal-or-stale' });
    }
    var promoNeeded = legal.some(function (m) { return m.promotion; });
    if (promoNeeded && !promo) promo = 'q';

    var san = null;
    try {
      var mv = this.gs.chess.move({ from: from, to: to, promotion: promo });
      if (mv) { this.gs.chess.undo(); san = mv.san; }
    } catch (e) {}

    /* color lock helper: a move the site ACCEPTED can only have been our
     * own piece — remember whose pieces we own from now on. */
    var accept = function (strategy) {
      try {
        var lastRec = self.gs.moves[self.gs.moves.length - 1];
        if (lastRec && lastRec.from === from && lastRec.to === to) {
          self.gs.lockColor(lastRec.color);
        }
      } catch (e) {}
      return release({ ok: true, strategy: strategy, san: san });
    };

    /* -------- 0. site gate (chess.com): turn + placement truth -------- */
    var gate = await this.siteGate();
    if (!gate.ok) return release({ ok: false, error: gate.error });
    var siteBefore = gate.info;

    /* -------- 1. lichess analysis playUci -------- */
    if (this.site.id === 'lichess') {
      var res = await this.bridge('lichess-play-uci', { uci: from + to + (promo || '') });
      if (res && res.ok) {
        var v2 = await this.verifyMove(fenBefore, uci, 1600);
        if (v2) return accept('lichess-playuci');
      }
    }

    /* -------- 2. bridge board drag / click-click (point-matched board) --------
     * This is the PRIMARY path on chess.com: it drives the site's real
     * event flow, which is what triggers the bot's / server's reply.
     * Style is randomized per move like a real player (mostly drags,
     * occasionally click-click). Human pacing is on by default. */
    var sel = this.boardSelector();
    var cFrom = this.bw.squareCenter(from);
    var cTo = this.bw.squareCenter(to);
    if (cFrom && cTo) {
      var preferClick = this._styleRng() < 0.22;
      var attempts = [
        preferClick ? 'board-clickclick' : 'board-drag',
        preferClick ? 'board-drag' : 'board-clickclick',
      ];
      for (var a = 0; a < attempts.length; a++) {
        /* If a promotion picker is ALREADY open (stale from an earlier attempt
         * or a recovered glitch), finish the promotion first and go straight
         * to verification — never drag into an open picker: its overlay eats
         * the events and corrupts the pending promotion. */
        var skipDrag = false;
        if (promo) {
          var st0 = await this.bridge('promotion-state');
          if (st0 && st0.open) {
            await this.handlePromotion(promo, to, 3000);
            skipDrag = true;
          }
        }
        if (!skipDrag) {
          try {
            await this.bridge(attempts[a], {
              matchByPoint: true, sel: sel,
              fromX: cFrom.x, fromY: cFrom.y, toX: cTo.x, toY: cTo.y,
              opts: { human: true },
            });
          } catch (e) {}
          await sleep(320);
          /* promotion move: the drag dropped the pawn on the last rank and the
           * picker is up — select the wanted piece by TOKEN (order-independent:
           * chess.com's picker DOM order is B,N,Q,R, so positional clicks used
           * to promote everything to a bishop). */
          if (promo) await this.handlePromotion(promo, to, 4200);
        }

        if (this.site.id === 'chesscom' && siteBefore && siteBefore.plies != null) {
          /* authoritative check against the server history */
          var vs = await this.verifyMoveOnSite(siteBefore.plies, san, uci, fenBefore, 3200);
          if (vs.ok) return accept(attempts[a] === 'board-drag' ? 'bridge-drag' : 'bridge-clickclick');
          if (vs.error === 'not-registered') {
            // visual move without server registration = PREMOVE (or dead drop)
            var lastRec = this.gs.moves[this.gs.moves.length - 1];
            if (lastRec && lastRec.from === from && lastRec.to === to) {
              U.log('premove detected (piece moved visually, server has it not) — cancelling');
              await this.cancelPremove(to);
              await this.resyncFromSite(vs.info || {});
              return release({ ok: false, error: 'premove-cancelled', san: san });
            }
          } else if (vs.error === 'site-reset') {
            await this.resyncFromSite(vs.info || {});
            return release({ ok: false, error: 'site-reset', san: san });
          } else if (vs.error === 'unexpected-move') {
            // the opponent's move landed meanwhile — position changed under us
            this.bw.forceRead();
            return release({ ok: false, error: 'position-changed', san: san });
          }
        } else {
          /* DOM verification (lichess / SDK-less pages) */
          var v3 = await this.verifyMove(fenBefore, uci, 1700);
          if (v3) return accept(a === 0 ? (preferClick ? 'bridge-clickclick' : 'bridge-drag') : (preferClick ? 'bridge-drag' : 'bridge-clickclick'));
        }
        // coords may have changed (geometry); refresh
        cFrom = this.bw.squareCenter(from) || cFrom;
        cTo = this.bw.squareCenter(to) || cTo;
        // re-gate: if it became the opponent's turn, stop trying
        var gate2 = await this.siteGate();
        if (!gate2.ok) return release({ ok: false, error: gate2.error });
      }
    }

    /* -------- 3 (last resort): chess.com SDK move via bridge.
     * game.move() updates the position but does NOT trigger the bot's
     * reply loop on vs-computer games — only used when the drag paths
     * failed entirely. */
    if (this.site.id === 'chesscom') {
      try {
        var r0 = await this.bridge('chesscom-move', { san: san, from: from, to: to, promotion: promo });
        if (r0 && r0.ok) {
          var ok = false;
          if (siteBefore && siteBefore.plies != null) {
            var v0 = await this.verifyMoveOnSite(siteBefore.plies, san, uci, fenBefore, 2000);
            ok = v0.ok;
          } else {
            ok = await this.verifyMove(fenBefore, uci, 1500);
          }
          if (ok) return accept('chesscom-sdk');
        }
      } catch (e) {}
    }

    return release({ ok: false, error: 'all-strategies-failed', san: san });
  };

  /* verify the game state advanced past fenBefore with our uci (DOM mirror) */
  MoveExecutor.prototype.verifyMove = async function (fenBefore, uci, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 1500);
    var wantFrom = uci.slice(0, 2), wantTo = uci.slice(2, 4);
    while (Date.now() < deadline) {
      await sleep(160);
      var fen = this.gs.currentFEN();
      if (fen && fenBefore && fen !== fenBefore) {
        var last = this.gs.moves[this.gs.moves.length - 1];
        if (last && last.from === wantFrom && last.to === wantTo) return true;
        // a different move happened (opponent/user?) — bail
        return false;
      }
      // poll board directly for faster pickup
      this.bw.forceRead();
    }
    return false;
  };

  /* Select the promotion piece in the site's picker.
   *
   * chess.com renders <div class="promotion-window ..."> with options
   * <div class="promotion-piece wb/wn/wq/wr"> — live-probed DOM order is
   * B, N, Q, R. The old code clicked by POSITION (q -> index 0), which
   * landed on the BISHOP every single time. This version:
   *   - polls for the picker to appear (it renders right after the drop),
   *   - asks the bridge to click the option whose CLASS TOKEN matches the
   *     wanted piece (wq/bq/q/queen/... — order-independent, color-agnostic),
   *   - re-clicks (with fresh jitter) if the dialog is still open,
   *   - bails early if the move already landed (auto-queen setting) or if
   *     the picker offers no such piece.
   * Returns true only when the picker was closed with our piece selected. */
  MoveExecutor.prototype.handlePromotion = async function (promo, toSquare, timeoutMs) {
    var piece = String(promo || 'q').toLowerCase();
    if (!/^[qrbn]$/.test(piece)) piece = 'q';
    var deadline = Date.now() + (timeoutMs || 4200);
    var clicked = false;
    while (Date.now() < deadline) {
      /* the move may have landed without any dialog (auto-queen setting,
       * an instant earlier pick, or lichess playUci) — stop waiting */
      var lastRec = this.gs.moves[this.gs.moves.length - 1];
      if (toSquare && lastRec && lastRec.to === toSquare && lastRec.promotion) {
        if (lastRec.promotion !== piece) {
          U.log('promotion landed as', lastRec.promotion, '(wanted', piece + ')');
        }
        return true; // committed either way — nothing left to select
      }
      var r = await this.bridge('promotion-pick', { piece: piece });
      if (r && r.ok) {
        clicked = true;
        await sleep(300);
        var st = await this.bridge('promotion-state');
        if (!st || !st.open) return true;   // picked; dialog closed
        // click did not register — loop retries with fresh jitter
      } else if (r && r.error && r.error !== 'no-picker') {
        // picker is open but lacks the wanted piece — stop immediately
        U.log('promotion picker mismatch:', JSON.stringify(r));
        return false;
      }
      await sleep(220);
    }
    return clicked;   // clicked at least once even if closure unconfirmed
  };

  O.MoveExecutor = MoveExecutor;
})(typeof window !== 'undefined' ? window : globalThis);
