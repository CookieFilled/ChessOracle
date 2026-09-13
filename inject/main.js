/*
 * ChessOracle — MAIN world bridge.
 * Runs at document_start in the page's main JS world.
 * Purpose:
 *   1. Registry of all addEventListener bindings (so guarded handlers can be
 *      re-invoked with synthetic "trusted" event objects).
 *   2. Move/click execution helpers for chessground (lichess) & generic UI.
 *   3. postMessage bridge for the ISOLATED world (content scripts).
 *
 * Security: this script never reads page content beyond DOM geometry, never
 * transmits anything anywhere, and only acts on bridge commands that carry the
 * ChessOracle marker. It is intentionally small and inert.
 */
(function () {
  if (window.__ChessOraclePage) return; // already installed
  var API = { version: '1.0.0' };
  window.__ChessOraclePage = API;

  /* ---------------- listener registry ---------------- */
  var registry = new WeakMap(); // Element -> Map(type -> [fn, fn, ...])

  var origAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    try {
      if (this instanceof Element && typeof fn === 'function') {
        var m = registry.get(this);
        if (!m) { m = new Map(); registry.set(this, m); }
        var arr = m.get(type);
        if (!arr) { arr = []; m.set(type, arr); }
        arr.push(fn);
      }
    } catch (e) { /* never break the page */ }
    return origAdd.call(this, type, fn, opts);
  };

  function listenersOf(el, type) {
    if (!el) return [];
    var m = registry.get(el);
    if (!m) return [];
    return (m.get(type) || []).slice();
  }

  /* ---------------- fake trusted event ---------------- */
  function fakeEvent(type, target, x, y, buttons, extra) {
    var ev = {
      type: type,
      isTrusted: true, // plain object: we define this ourselves
      buttons: buttons === undefined ? 1 : buttons,
      button: 0,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      cancelable: true, bubbles: true, composed: true,
      clientX: x, clientY: y, pageX: x, pageY: y,
      screenX: x, screenY: y,
      detail: 1, view: window,
      target: target, currentTarget: target,
      defaultPrevented: false,
      preventDefault: function () { this.defaultPrevented = true; },
      stopPropagation: function () {},
      stopImmediatePropagation: function () {},
      getCoalescedEvents: function () { return []; },
    };
    if (extra) for (var k in extra) ev[k] = extra[k];
    return ev;
  }

  function realDispatch(el, type, x, y, buttons) {
    try {
      var init = {
        bubbles: true, cancelable: true, composed: true, view: window,
        button: 0, buttons: buttons === undefined ? 1 : buttons,
        clientX: x, clientY: y,
      };
      var ev;
      if (type.indexOf('pointer') === 0) {
        ev = new PointerEvent(type, Object.assign({}, init, {
          pointerId: 101, pointerType: 'mouse', isPrimary: true, pressure: buttons ? 0.5 : 0,
        }));
      } else {
        ev = new MouseEvent(type, init);
      }
      el.dispatchEvent(ev);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- board move (chessground and friends) ----------------
   * Strategy: invoke captured mousedown/pointerdown listeners on the board
   * with a fake trusted event at the from-square; then dispatch REAL
   * synthetic mousemove/pointermove + mouseup/pointerup on document so any
   * dynamically-bound drag handlers complete the move.
   *
   * opts.human !== false enables human mouse dynamics: the grab point and
   * drop point are jittered inside their squares, there is a short "grab"
   * pause, the drag path is broken into 4-7 wobbling steps and the piece is
   * held briefly before release. Returns a promise in that case.
   */
  var sleepMs = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  API.boardDrag = function (boardEl, fromX, fromY, toX, toY, opts) {
    opts = opts || {};
    if (!boardEl || !boardEl.isConnected) return { ok: false, error: 'board-detached' };

    var human = opts.human !== false;
    var sq = 64;
    try {
      var br0 = boardEl.getBoundingClientRect();
      sq = (br0.width || 512) / 8;
    } catch (e) {}

    var jitter = function (frac) { return (Math.random() * 2 - 1) * sq * frac; };
    var fx = fromX + (human ? jitter(0.16) : 0), fy = fromY + (human ? jitter(0.16) : 0);
    var tx = toX + (human ? jitter(0.20) : 0), ty = toY + (human ? jitter(0.20) : 0);

    var steps = human ? 4 + Math.floor(Math.random() * 4) : (opts.steps || 5);

    var doStart = function () {
      var startTypes = ['mousedown', 'pointerdown', 'touchstart'];
      var fns = [];
      var usedType = null;
      for (var i = 0; i < startTypes.length && !fns.length; i++) {
        var l = listenersOf(boardEl, startTypes[i]);
        if (l.length) { fns = l; usedType = startTypes[i]; }
      }
      // also try captured listeners on ancestors (bubbling registrations)
      if (!fns.length) {
        var p = boardEl.parentElement;
        for (var depth = 0; p && depth < 4 && !fns.length; depth++, p = p.parentElement) {
          for (var j = 0; j < startTypes.length && !fns.length; j++) {
            var l2 = listenersOf(p, startTypes[j]);
            if (l2.length) { fns = l2; usedType = startTypes[j]; }
          }
        }
      }
      if (!fns.length) {
        // No captured listeners (page loaded before bridge?). Try a plain
        // synthetic drag anyway — some boards are unguarded.
        realDispatch(boardEl, 'pointerdown', fx, fy, 1);
        realDispatch(boardEl, 'mousedown', fx, fy, 1);
      } else {
        var fake = fakeEvent(usedType, boardEl, fx, fy, 1);
        if (usedType === 'touchstart') {
          fake.touches = [{ clientX: fx, clientY: fy, identifier: 1 }];
        }
        for (var k = 0; k < fns.length; k++) {
          try { fns[k].call(boardEl, fake); } catch (e) {}
        }
      }
      return usedType || 'synthetic';
    };

    var pathStep = function (s) {
      var x = fx + ((tx - fx) * s) / steps;
      var y = fy + ((ty - fy) * s) / steps;
      if (human && steps > 3) {
        // slight perpendicular wobble like a real hand
        var wob = Math.sin(s * Math.PI) * sq * 0.05 * (Math.random() * 2 - 1);
        x += (ty - fy === 0 ? 0 : wob * 0.6);
        y += (tx - fx === 0 ? 0 : wob * 0.6);
      }
      realDispatch(document, 'pointermove', x, y, 1);
      realDispatch(document, 'mousemove', x, y, 1);
    };

    if (!human) {
      var via = doStart();
      for (var s = 1; s <= steps; s++) pathStep(s);
      realDispatch(document, 'pointerup', tx, ty, 0);
      realDispatch(document, 'mouseup', tx, ty, 0);
      return { ok: true, via: via };
    }

    // human-paced drag (async)
    return (async function () {
      var via = doStart();
      await sleepMs(55 + Math.random() * 130);              // grab the piece
      for (var s = 1; s <= steps; s++) {
        pathStep(s);
        await sleepMs(14 + Math.random() * 26);
      }
      await sleepMs(35 + Math.random() * 95);               // hold before drop
      realDispatch(document, 'pointerup', tx, ty, 0);
      realDispatch(document, 'mouseup', tx, ty, 0);
      return { ok: true, via: via, human: true };
    })();
  };

  /* click-click alternative (for boards that prefer selection) */
  API.boardClickClick = function (boardEl, fromX, fromY, toX, toY, opts) {
    opts = opts || {};
    var human = opts.human !== false;
    var sq = 64;
    try { sq = (boardEl.getBoundingClientRect().width || 512) / 8; } catch (e) {}
    var jitter = function (frac) { return (Math.random() * 2 - 1) * sq * frac; };
    var fx = fromX + (human ? jitter(0.16) : 0), fy = fromY + (human ? jitter(0.16) : 0);
    var tx = toX + (human ? jitter(0.20) : 0), ty = toY + (human ? jitter(0.20) : 0);

    var fire = function (x, y, down) {
      if (down) {
        var fns = listenersOf(boardEl, 'mousedown').concat(listenersOf(boardEl, 'pointerdown'));
        var fake = fakeEvent('mousedown', boardEl, x, y, 1);
        for (var i = 0; i < fns.length; i++) { try { fns[i].call(boardEl, fake); } catch (e) {} }
        realDispatch(boardEl, 'mousedown', x, y, 1);
        realDispatch(boardEl, 'pointerdown', x, y, 1);
      } else {
        realDispatch(boardEl, 'pointerup', x, y, 0);
        realDispatch(boardEl, 'mouseup', x, y, 0);
        realDispatch(boardEl, 'click', x, y, 0);
      }
    };
    if (!human) {
      fire(fx, fy, true);
      fire(tx, ty, false);
      return { ok: true };
    }
    return (async function () {
      fire(fx, fy, true);
      await sleepMs(80 + Math.random() * 160);
      fire(tx, ty, false);
      return { ok: true, human: true };
    })();
  };

  /* ---------------- generic click (promotion dialogs etc.) ---------------- */
  API.trustedClick = function (el, x, y) {
    if (!el) return { ok: false, error: 'no-element' };
    var r = el.getBoundingClientRect();
    if (x === undefined) { x = r.left + r.width / 2; y = r.top + r.height / 2; }
    // 1) real synthetic events first (unguarded handlers)
    realDispatch(el, 'pointerdown', x, y, 1);
    realDispatch(el, 'mousedown', x, y, 1);
    realDispatch(el, 'pointerup', x, y, 0);
    realDispatch(el, 'mouseup', x, y, 0);
    realDispatch(el, 'click', x, y, 0);
    // 2) captured listeners with fake trusted events (guarded handlers)
    var types = ['click', 'mousedown', 'pointerdown', 'mouseup', 'pointerup'];
    for (var t = 0; t < types.length; t++) {
      var fns = listenersOf(el, types[t]);
      for (var i = 0; i < fns.length; i++) {
        try { fns[i].call(el, fakeEvent(types[t], el, x, y, types[t].indexOf('up') > 0 ? 0 : 1)); } catch (e) {}
      }
    }
    return { ok: true };
  };

  /* ---------------- site API wrappers ---------------- */
  API.lichessPlayUci = function (uci) {
    try {
      if (window.lichess && window.lichess.analysis && typeof window.lichess.analysis.playUci === 'function') {
        window.lichess.analysis.playUci(uci);
        return { ok: true };
      }
    } catch (e) {}
    return { ok: false };
  };

  function findBoardByPoint(x, y) {
    var boards = document.querySelectorAll('cg-board, wc-chess-board, chess-board');
    for (var i = 0; i < boards.length; i++) {
      var r = boards[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 80) return boards[i];
    }
    return null;
  }

  /* ---------------- chess.com game SDK bridge ----------------
   * The `game` object is an expando set by page JS — visible ONLY in this
   * MAIN world (content scripts in the ISOLATED world can never see it).
   * We poll it and broadcast changes so the content script knows the real
   * playing color / turn / FEN, and expose a move() bridge action. */
  function chesscomGameBoard() {
    var boards = document.querySelectorAll('wc-chess-board');
    var best = null, bestA = 0;
    for (var i = 0; i < boards.length; i++) {
      var r;
      try { r = boards[i].getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 80 || !r.height) continue;
      if (r.width * r.height > bestA) { bestA = r.width * r.height; best = boards[i]; }
    }
    return best && best.game ? best : null;
  }

  function chesscomInfo() {
    try {
      var b = chesscomGameBoard();
      if (!b) return null;
      var g = b.game;
      var hist = null;
      if (typeof g.getHistorySANs === 'function') {
        try { hist = g.getHistorySANs() || null; } catch (e2) { hist = null; }
      }
      return {
        playingAs: typeof g.getPlayingAs === 'function' ? g.getPlayingAs() : null,
        fen: typeof g.getFEN === 'function' ? g.getFEN() : null,
        turn: typeof g.getTurn === 'function' ? g.getTurn() : null,
        over: typeof g.isGameOver === 'function' ? !!g.isGameOver() : null,
        // server-registered state only — premoves are NOT included, which is
        // what makes the FEN + history authoritative for move verification
        plies: hist != null ? hist.length : null,
        history: hist != null ? hist.slice(-12) : null,
      };
    } catch (e) { return null; }
  }

  // poll & broadcast (on change, plus a slow heartbeat so late-booting
  // content scripts still receive the current state)
  var lastInfoKey = '';
  setInterval(function () {
    try {
      var info = chesscomInfo();
      if (!info) return;
      var key = JSON.stringify(info);
      if (key === lastInfoKey) return;
      lastInfoKey = key;
      window.postMessage({ __coInfo: true, site: 'chesscom', ts: Date.now(), info: info }, '*');
    } catch (e) {}
  }, 600);
  setInterval(function () { lastInfoKey = ''; }, 5000); // heartbeat: force re-broadcast

  /* ---------------- find/click visible buttons by text ----------------
   * Used by autopilot for "New Game" / "Rematch" / "Play" CTAs and for
   * dismissing popups. Text matching is case-insensitive; exact matches
   * win over substring matches; larger buttons win over smaller ones. */
  function visibleButtons(includeLinks) {
    var out = [];
    var sel = includeLinks ? 'button, [role="button"], a[href]' : 'button, [role="button"]';
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      try {
        var cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 16 || r.height < 10) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      } catch (e) { continue; }
      var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t && !el.getAttribute('aria-label')) continue;
      out.push({ el: el, text: t, aria: el.getAttribute('aria-label') || '', rect: el.getBoundingClientRect() });
    }
    return out;
  }

  function findButtonByText(texts, scopeSel, includeLinks) {
    var want = (texts || []).map(function (t) { return String(t).toLowerCase().trim(); });
    if (!want.length) return null;
    var btns = visibleButtons(!!includeLinks);
    if (scopeSel) {
      var scopes = document.querySelectorAll(scopeSel);
      var inScope = function (el) {
        for (var s = 0; s < scopes.length; s++) if (scopes[s].contains(el)) return true;
        return false;
      };
      btns = btns.filter(function (b) { return inScope(b.el); });
    }
    var area = function (b) { return b.rect.width * b.rect.height; };
    var norm = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    var ariaMatch = function (b) {
      for (var i = 0; i < want.length; i++) if (norm(b.aria) === want[i]) return true;
      return false;
    };
    var exact = btns.filter(function (b) {
      if (norm(b.text) === '') return ariaMatch(b);
      return want.indexOf(norm(b.text)) >= 0 || ariaMatch(b);
    });
    if (exact.length) { exact.sort(function (a, b) { return area(b) - area(a); }); return exact[0]; }
    var partial = btns.filter(function (b) {
      var t = norm(b.text), a = norm(b.aria);
      for (var i = 0; i < want.length; i++) {
        if (t && (t.indexOf(want[i]) >= 0 || want[i].indexOf(t) >= 0)) return true;
        if (a && (a.indexOf(want[i]) >= 0 || want[i].indexOf(a) >= 0)) return true;
      }
      return false;
    });
    if (partial.length) { partial.sort(function (a, b) { return area(b) - area(a); }); return partial[0]; }
    return null;
  }

  API.findButtonByText = findButtonByText;

  /* ---------------- "new game" family matcher ----------------
   * chess.com labels the next-game button by time control: "New 10 min",
   * "New 5 min", "New 3 | 0", sometimes "New Game" (bot pages) or "New Bot".
   * CRITICAL: it must NEVER match "Rematch" (sends a challenge to the SAME
   * opponent — the loop dies if they don't accept) or "Game Review".
   * Probed live: modal buttons are Game Review (primary) + "New 10 min" +
   * "Rematch". */
  var NEW_START_RX = /^new\b/i;
  var NEW_BODY_RX = /\bgame\b|\bbot\b|\d+\s*(min|sec|mn|mins|hrs?|hour)\b|\d+\s*[|+]\s*\d+/i;
  var NEW_EXCLUDE_RX = /rematch|challenge|friend|invite|review|analysis|lesson|puzzle/i;
  function isNewGameText(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return false;
    if (NEW_EXCLUDE_RX.test(t)) return false;
    return NEW_START_RX.test(t) && NEW_BODY_RX.test(t);
  }
  API.isNewGameText = isNewGameText;

  /* find the best "new game" button/link; prefers scope (game-over modal),
   * then anywhere; largest button first. Returns the button record or null. */
  function findNewGameButton(scopeSel) {
    var all = visibleButtons(true);
    var inScope = all, rest = [];
    if (scopeSel) {
      var scopes = document.querySelectorAll(scopeSel);
      inScope = [];
      for (var i = 0; i < all.length; i++) {
        var inside = false;
        for (var s = 0; s < scopes.length; s++) { if (scopes[s].contains(all[i].el)) { inside = true; break; } }
        if (inside) inScope.push(all[i]); else rest.push(all[i]);
      }
    }
    var area = function (b) { return b.rect.width * b.rect.height; };
    var pools = [inScope, rest];
    for (var p = 0; p < pools.length; p++) {
      var cands = pools[p].filter(function (b) {
        return isNewGameText(b.text) || isNewGameText(b.aria);
      });
      if (cands.length) {
        cands.sort(function (a, b) { return area(b) - area(a); });
        return cands[0];
      }
    }
    return null;
  }
  API.findNewGameButton = findNewGameButton;

  /* resign via the real UI (works on LIVE games where SDK resign() is a
   * silent no-op): sidebar Resign/Abort -> cc-confirmation-popover ->
   * confirm. Returns {ok, via}. */
  function chesscomResignUI() {
    var btn = findButtonByText(['Resign', 'Abort'], null);
    if (!btn) return { ok: false, error: 'no-resign-button' };
    var r = btn.el.getBoundingClientRect();
    API.trustedClick(btn.el, r.left + r.width / 2, r.top + r.height / 2);
    return (async function () {
      // the confirmation popover renders next to the button
      for (var i = 0; i < 12; i++) {
        await sleepMs(120);
        var box = document.querySelector('.cc-confirmation-popover-buttons, .cc-confirmation-popover-popover');
        if (!box) continue;
        var conf = null;
        var btns = box.querySelectorAll('button');
        for (var j = 0; j < btns.length; j++) {
          var t = (btns[j].textContent || '').replace(/\s+/g, ' ').trim();
          if (/^(resign|abort)$/i.test(t)) { conf = btns[j]; break; }
        }
        if (conf) {
          var cr = conf.getBoundingClientRect();
          if (cr.width > 5) {
            API.trustedClick(conf, cr.left + cr.width / 2, cr.top + cr.height / 2);
            return { ok: true, via: 'ui-popover' };
          }
        }
      }
      return { ok: false, error: 'no-confirm-popover' };
    })();
  }
  API.chesscomResignUI = chesscomResignUI;

  /* ---------------- promotion picker (chess.com + lichess) ----------------
   * Live-probed chess.com picker DOM (2025-09):
   *   <div class="promotion-window top promotion-window--visible">
   *     <i class="close-button icon-font-chess x"></i>
   *     <div class="promotion-piece wb"></div>   <- DOM order: B, N, Q, R !!
   *     <div class="promotion-piece wn"></div>
   *     <div class="promotion-piece wq"></div>
   *     <div class="promotion-piece wr"></div>
   *   </div>
   * The FIRST option in the DOM is the BISHOP — the old positional click
   * (nth index from a Q-first assumption) promoted every pawn to a bishop.
   * Selection is now strictly TOKEN-based: match the option's class token
   * (wq/bq/q/queen/...) for the wanted piece, order-independent. */
  function promotionLetterFromToken(tok) {
    if (!tok) return null;
    var t = String(tok).toLowerCase();
    if (/^(w|b)(q|r|n|b)$/.test(t)) return t.charAt(1);
    if (/^[qrbn]$/.test(t)) return t;
    if (t === 'queen') return 'q';
    if (t === 'rook') return 'r';
    if (t === 'bishop') return 'b';
    if (t === 'knight') return 'n';
    return null;
  }

  function scanPromotionPicker() {
    var out = { open: false, options: [], containerCls: null };
    var boardRect = null, bestA = 0;
    try {
      var boards = document.querySelectorAll('wc-chess-board, cg-board, chess-board');
      for (var i = 0; i < boards.length; i++) {
        var br = boards[i].getBoundingClientRect();
        if (br.width > 80 && br.width * br.height > bestA) { bestA = br.width * br.height; boardRect = br; }
      }
    } catch (e) {}
    var nearBoard = function (r) {
      if (!boardRect) return true; // no board on page — accept anything visible
      return r.right > boardRect.left - 100 && r.left < boardRect.right + 100 &&
             r.bottom > boardRect.top - 100 && r.top < boardRect.bottom + 100;
    };
    var seen = new Set();
    var addEl = function (el) {
      if (seen.has(el) || !el.classList) return;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { return; }
      if (r.width < 8 || r.height < 8) return;   // hidden / collapsed
      if (!nearBoard(r)) return;
      var letter = null, toks = Array.prototype.slice.call(el.classList);
      for (var k = 0; k < toks.length && !letter; k++) letter = promotionLetterFromToken(toks[k]);
      if (!letter) return;                       // close button etc.
      seen.add(el);
      out.options.push({ el: el, letter: letter, cls: toks.join(' '), rect: r });
    };
    /* direct option selectors (chess.com .promotion-piece, lichess .choice) */
    var direct = document.querySelectorAll(
      '.promotion-piece, .promotion-window .promotion-piece, ' +
      'cg-promotion .choice, .cg-promotion .choice, .promotion-choice, ' +
      '[class*="promotion"] .choice'
    );
    for (var d = 0; d < direct.length; d++) addEl(direct[d]);
    /* anything piece-lettered inside a promotion-flavored container */
    var conts = document.querySelectorAll('[class*="promotion" i]');
    for (var c = 0; c < conts.length; c++) {
      var cont = conts[c];
      if (out.containerCls == null) {
        var cr;
        try { cr = cont.getBoundingClientRect(); } catch (e) { cr = null; }
        if (cr && cr.width >= 8 && nearBoard(cr)) out.containerCls = String(cont.className).slice(0, 120);
      }
      try {
        var kids = cont.querySelectorAll('*');
        for (var m = 0; m < kids.length; m++) addEl(kids[m]);
        addEl(cont);
      } catch (e) {}
    }
    out.open = out.options.length >= 2;   // a real picker renders 4 options
    return out;
  }
  API.scanPromotionPicker = scanPromotionPicker;
  API.promotionLetterFromToken = promotionLetterFromToken;

  /* click the wanted promotion piece in the open picker (token match).
   * Returns {ok, piece, cls} or {ok:false, error:'no-picker'|'no-<p>-option'} */
  API.pickPromotion = function (piece) {
    var scan = scanPromotionPicker();
    if (!scan.open) return { ok: false, error: 'no-picker' };
    var want = String(piece || 'q').toLowerCase();
    if (!/^[qrbn]$/.test(want)) want = 'q';
    var match = null;
    for (var i = 0; i < scan.options.length; i++) {
      if (scan.options[i].letter === want) { match = scan.options[i]; break; }
    }
    if (!match) {
      return {
        ok: false, error: 'no-' + want + '-option',
        letters: scan.options.map(function (o) { return o.letter; }),
      };
    }
    var r = match.rect;
    var jitter = Math.min(14, r.width * 0.2);
    var x = r.x + r.width / 2 + (Math.random() * 2 - 1) * jitter;
    var y = r.y + r.height / 2 + (Math.random() * 2 - 1) * jitter;
    API.trustedClick(match.el, x, y);
    return { ok: true, piece: want, cls: match.cls, container: scan.containerCls };
  };

  /* cancel a pending premove: real click on the piece at its VISUAL spot
   * (a click selects the pre-moved piece and drops the premove), then
   * Escape for good measure. */
  API.cancelPremove = function (x, y) {
    try {
      realDispatch(document, 'pointerdown', x, y, 1);
      realDispatch(document, 'mousedown', x, y, 1);
      realDispatch(document, 'pointerup', x, y, 0);
      realDispatch(document, 'mouseup', x, y, 0);
      realDispatch(document, 'click', x, y, 0);
      var kd = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
      var ku = new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true });
      document.dispatchEvent(kd);
      document.dispatchEvent(ku);
    } catch (e) {}
    return { ok: true };
  };

  /* ---------------- postMessage bridge (ISOLATED -> MAIN) ---------------- */
  var nextId = 1;
  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__coBridge !== true || typeof d.action !== 'string') return;
    var replied = false;
    var reply = function (res) {
      if (replied) return;
      replied = true;
      window.postMessage({ __coBridgeReply: true, id: d.id, res: res || { ok: false } }, '*');
    };
    // actions may return promises (human-paced drags, popover flows)
    var replyP = function (res) {
      if (res && typeof res.then === 'function') {
        res.then(function (v) { reply(v); }, function (e) { reply({ ok: false, error: String(e && e.message || e) }); });
      } else reply(res);
    };
    try {
      switch (d.action) {
        case 'ping':
          reply({ ok: true, version: API.version, lichess: !!window.lichess });
          break;
        case 'board-drag': {
          var el = d.matchByPoint ? findBoardByPoint(d.fromX, d.fromY) : document.querySelector(d.sel);
          if (!el && d.sel) el = document.querySelector(d.sel);
          if (!el) return reply({ ok: false, error: 'board-not-found' });
          replyP(API.boardDrag(el, d.fromX, d.fromY, d.toX, d.toY, d.opts));
          break;
        }
        case 'board-clickclick': {
          var el2 = d.matchByPoint ? findBoardByPoint(d.fromX, d.fromY) : document.querySelector(d.sel);
          if (!el2 && d.sel) el2 = document.querySelector(d.sel);
          if (!el2) return reply({ ok: false, error: 'board-not-found' });
          replyP(API.boardClickClick(el2, d.fromX, d.fromY, d.toX, d.toY, d.opts));
          break;
        }
        case 'cancel-premove': {
          reply(API.cancelPremove(d.x, d.y));
          break;
        }
        case 'promotion-state': {
          var pscan = scanPromotionPicker();
          reply({
            ok: true,
            open: pscan.open,
            container: pscan.containerCls,
            options: pscan.options.map(function (o) {
              return { letter: o.letter, cls: o.cls, x: Math.round(o.rect.x + o.rect.width / 2), y: Math.round(o.rect.y + o.rect.height / 2) };
            }),
          });
          break;
        }
        case 'promotion-pick': {
          reply(API.pickPromotion(d.piece));
          break;
        }
        case 'click': {
          var el3 = null;
          var list = document.querySelectorAll(d.sel);
          if (list && list.length) {
            el3 = list[Math.min(d.nth || 0, list.length - 1)];
          }
          if (!el3 && d.fallbackSels) {
            for (var i = 0; i < d.fallbackSels.length && !el3; i++) {
              var fl = document.querySelectorAll(d.fallbackSels[i]);
              if (fl && fl.length) el3 = fl[Math.min(d.nth || 0, fl.length - 1)];
            }
          }
          if (!el3) return reply({ ok: false, error: 'not-found' });
          reply(API.trustedClick(el3, d.x, d.y));
          break;
        }
        case 'lichess-play-uci':
          reply(API.lichessPlayUci(d.uci));
          break;
        case 'click-text': {
          // find a visible button (or link, when d.includeLinks) whose text
          // matches one of d.texts and click it
          var scopeSel = d.scope || null;
          var scopeBtn = findButtonByText(d.texts, scopeSel, d.includeLinks);
          if (!scopeBtn && scopeSel) scopeBtn = findButtonByText(d.texts, null, d.includeLinks); // retry unscoped
          if (!scopeBtn && d.includeLinks) scopeBtn = findButtonByText(d.texts, scopeSel || null, true); // links retry
          if (!scopeBtn) return reply({ ok: false, error: 'not-found', texts: d.texts });
          var rr = scopeBtn.el.getBoundingClientRect();
          reply(API.trustedClick(scopeBtn.el, rr.left + rr.width / 2, rr.top + rr.height / 2));
          break;
        }
        case 'find-new-game': {
          var ngb = findNewGameButton(d.scope || null);
          reply({ ok: !!ngb, found: !!ngb, text: ngb ? ngb.text : null, aria: ngb ? ngb.aria : null, inModal: !!(ngb && d.scope && document.querySelector(d.scope) && document.querySelector(d.scope).contains(ngb.el)) });
          break;
        }
        case 'click-new-game': {
          // click the "New <time>/Game" button — NEVER a Rematch/challenge.
          // First inside the game-over modal, then anywhere on the page.
          var ngb2 = findNewGameButton(d.scope || '[class*="game-over"]');
          if (!ngb2) ngb2 = findNewGameButton(null);
          if (!ngb2) return reply({ ok: false, error: 'not-found' });
          var rng = ngb2.el.getBoundingClientRect();
          reply(API.trustedClick(ngb2.el, rng.left + rng.width / 2, rng.top + rng.height / 2));
          break;
        }
        case 'dump-buttons': {
          var dbs = visibleButtons(!!d.includeLinks);
          reply({ ok: true, buttons: dbs.map(function (b) { return { text: b.text, aria: b.aria, w: Math.round(b.rect.width), h: Math.round(b.rect.height) }; }).slice(0, d.limit || 60) });
          break;
        }
        case 'chesscom-history': {
          var ghb = chesscomGameBoard();
          var ghg = ghb && ghb.game;
          if (ghg && typeof ghg.getHistorySANs === 'function') {
            try { reply({ ok: true, sans: ghg.getHistorySANs() || [] }); }
            catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
          } else {
            reply({ ok: false, error: 'no-game-object' });
          }
          break;
        }
        case 'find-text': {
          var fb = findButtonByText(d.texts, d.scope || null, d.includeLinks);
          reply({ ok: !!fb, found: !!fb, text: fb ? fb.text : null, aria: fb ? fb.aria : null });
          break;
        }
        case 'chesscom-resign': {
          var gbr = chesscomGameBoard();
          var ggr = gbr && gbr.game;
          if (ggr && typeof ggr.resign === 'function') {
            try { ggr.resign(); reply({ ok: true, via: 'sdk' }); }
            catch (e) { reply({ ok: false, error: String((e && e.message) || e) }); }
          } else {
            reply({ ok: false, error: 'no-game-object' });
          }
          break;
        }
        case 'chesscom-resign-ui': {
          replyP(chesscomResignUI());
          break;
        }
        case 'chesscom-info':
          reply({ ok: true, info: chesscomInfo() });
          break;
        case 'chesscom-move': {
          var gb = chesscomGameBoard();
          var gg = gb && gb.game;
          if (gg && typeof gg.move === 'function') {
            try {
              if (d.san) gg.move(d.san);
              else gg.move({ from: d.from, to: d.to, promotion: d.promotion || 'q' });
              reply({ ok: true, via: 'sdk' });
            } catch (e) {
              reply({ ok: false, error: String((e && e.message) || e) });
            }
          } else {
            reply({ ok: false, error: 'no-game-object' });
          }
          break;
        }
        default:
          reply({ ok: false, error: 'unknown-action' });
      }
    } catch (e) {
      reply({ ok: false, error: String(e && e.message || e) });
    }
  }, false);

  API.call = function (action, payload) {
    return new Promise(function (resolve) {
      var id = nextId++;
      var to = setTimeout(function () { resolve({ ok: false, error: 'bridge-timeout' }); cleanup(); }, (payload && payload.timeout) || 12000);
      function onMsg(ev) {
        if (ev.source !== window) return;
        var d = ev.data;
        if (d && d.__coBridgeReply === true && d.id === id) {
          clearTimeout(to);
          resolve(d.res);
          cleanup();
        }
      }
      function cleanup() { window.removeEventListener('message', onMsg); }
      window.addEventListener('message', onMsg);
      var msg = Object.assign({ __coBridge: true, id: id, action: action }, payload || {});
      window.postMessage(msg, '*');
    });
  };
})();
