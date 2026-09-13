/* ChessOracle — per-site configuration (ISOLATED world) */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};

  var FILES = 'abcdefgh';
  var PIECE_BY_NAME = { pawn: 'p', knight: 'n', bishop: 'b', rook: 'r', queen: 'q', king: 'k' };
  var NAME_BY_CODE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

  /* shared rect -> square math (orientation-aware) */
  function squareFromRect(el, boardRect, orientation) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    var sq = boardRect.width / 8;
    var col = Math.round((r.left + r.width / 2 - boardRect.left) / sq - 0.5);
    var row = Math.round((r.top + r.height / 2 - boardRect.top) / (boardRect.height / 8) - 0.5);
    if (col < 0 || col > 7 || row < 0 || row > 7) return null;
    var file = orientation === 'black' ? 7 - col : col;
    var rank = orientation === 'black' ? row + 1 : 8 - row;
    return FILES[file] + rank;
  }

  O.squareFromRect = squareFromRect;
  O.PIECE_BY_NAME = PIECE_BY_NAME;
  O.NAME_BY_CODE = NAME_BY_CODE;
  O.FILES = FILES;

  /* ---- main-world SDK info cache (chess.com) ----
   * inject/main.js polls the page's `board.game` object (MAIN world only)
   * and broadcasts it here. Gives the authoritative playing color / turn. */
  O.siteInfo = { playingAs: null, fen: null, turn: null, over: null, ts: 0 };
  try {
    window.addEventListener('message', function (ev) {
      if (ev.source !== window) return;
      var d = ev.data;
      if (!d || d.__coInfo !== true || !d.info) return;
      var i = d.info;
      O.siteInfo.playingAs = i.playingAs != null ? i.playingAs : O.siteInfo.playingAs;
      O.siteInfo.fen = i.fen != null ? i.fen : O.siteInfo.fen;
      O.siteInfo.turn = i.turn != null ? i.turn : O.siteInfo.turn;
      O.siteInfo.over = i.over != null ? i.over : O.siteInfo.over;
      O.siteInfo.ts = d.ts || Date.now();
      try { O.bus.emit('site:info', O.siteInfo); } catch (e) {}
    });
  } catch (e) {}

  O.sites = {
    lichess: {
      id: 'lichess',
      label: 'lichess.org',

      boardWrapSels: ['.cg-wrap', 'cg-board'],
      findBoards: function () {
        var wraps = [];
        var candidates = document.querySelectorAll('.cg-wrap');
        for (var i = 0; i < candidates.length; i++) {
          var board = candidates[i].querySelector('cg-board');
          if (board) wraps.push({ wrap: candidates[i], board: board });
        }
        if (!wraps.length) {
          var boards = document.querySelectorAll('cg-board');
          for (var j = 0; j < boards.length; j++) {
            var w = boards[j].closest('.cg-wrap') || boards[j].parentElement;
            if (w) wraps.push({ wrap: w, board: boards[j] });
          }
        }
        // keep the largest visible board with pieces
        return wraps
          .map(function (b) {
            var r = b.board.getBoundingClientRect();
            return { wrap: b.wrap, board: b.board, area: r.width * r.height, visible: r.width > 80 && r.height > 80 };
          })
          .filter(function (b) { return b.visible; })
          .sort(function (a, b) { return b.area - a.area; });
      },

      boardRectEl: function (board) { return board; },

      orientation: function (wrap) {
        if (!wrap) return 'white';
        var cls = wrap.className || '';
        if (/orientation-black/.test(cls)) return 'black';
        return 'white';
      },

      readPieces: function (board, wrap) {
        var orientation = this.orientation(wrap);
        var br = board.getBoundingClientRect();
        var out = [];
        var pieces = board.querySelectorAll('piece');
        for (var i = 0; i < pieces.length; i++) {
          var p = pieces[i];
          var cls = p.className || '';
          var color = /white/.test(cls) ? 'w' : /black/.test(cls) ? 'b' : null;
          var name = null;
          var toks = cls.split(/\s+/);
          for (var t = 0; t < toks.length; t++) {
            if (PIECE_BY_NAME[toks[t]]) { name = PIECE_BY_NAME[toks[t]]; break; }
          }
          if (!color || !name) continue;
          var sq = squareFromRect(p, br, orientation);
          if (sq) out.push({ square: sq, piece: color + name, el: p });
        }
        return out;
      },

      isAnalysable: function () {
        return /\/analysis|\/study|\/puzzle/.test(location.pathname) || !!document.querySelector('.analyse');
      },

      /* my color on round pages = board orientation (lichess always puts my side at bottom) */
      detectMyColor: function (wrap) {
        if (/\/analysis|\/study|\/puzzle/.test(location.pathname)) return null;
        return this.orientation(wrap);
      },

      clockText: function () {
        try {
          var clocks = document.querySelectorAll('.rclock .time');
          var bottom = null, top = null;
          // lichess: clocks are ordered top-player then bottom-player in the sidebar flow
          var rects = [];
          for (var i = 0; i < clocks.length; i++) {
            rects.push({ el: clocks[i], y: clocks[i].getBoundingClientRect().top });
          }
          if (rects.length >= 2) {
            rects.sort(function (a, b) { return a.y - b.y; });
            top = rects[0].el.textContent.trim();
            bottom = rects[rects.length - 1].el.textContent.trim();
          }
          return { top: top, bottom: bottom };
        } catch (e) { return null; }
      },

      promotionSelectors: [
        'cg-promotion .choice',
        '.cg-promotion .choice',
        'promotion .choice',
        '.promotion-choice',
      ],
      promotionPick: { sel: 'cg-promotion .choice, .cg-promotion .choice, promotion .choice, .promotion-choice' },

      gameResultText: function () {
        var st = document.querySelector('.status');
        return st ? st.textContent.trim() : null;
      },
    },

    chesscom: {
      id: 'chesscom',
      label: 'chess.com',

      findBoards: function () {
        var hosts = document.querySelectorAll('wc-chess-board');
        var wraps = [];
        for (var i = 0; i < hosts.length; i++) {
          var b = hosts[i];
          var r = b.getBoundingClientRect();
          if (r.width > 80 && r.height > 80) {
            wraps.push({ wrap: b, board: b, area: r.width * r.height });
          }
        }
        return wraps.sort(function (a, b) { return b.area - a.area; });
      },

      boardRectEl: function (board) { return board; },

      orientation: function (wrap) {
        // VISUAL truth: chess.com renders the board rotated via the `flipped`
        // class (set for black games and manual view flips). Piece reading
        // must follow what is actually on screen.
        if (wrap && /(^|\s)flipped(\s|$)/.test(wrap.className || '')) return 'black';
        return 'white';
      },

      /* the game SDK gives the exact FEN — use it when available */
      apiFEN: function (wrap) {
        try {
          var g = wrap && wrap.game;
          if (g && typeof g.getFEN === 'function') return g.getFEN();
        } catch (e) {}
        var si = O.siteInfo;
        if (si && si.fen && si.ts && Date.now() - si.ts < 15000) return si.fen;
        return null;
      },

      apiMyColor: function (wrap) {
        // bridge-cached SDK value is authoritative (set by MAIN-world poller)
        var pa = O.siteInfo && O.siteInfo.playingAs;
        if (pa === 1 || pa === 'white') return 'white';
        if (pa === 2 || pa === 'black') return 'black';
        try {
          var g = wrap && wrap.game;
          if (g && typeof g.getPlayingAs === 'function') {
            var c = g.getPlayingAs();
            if (c === 1 || c === 'white') return 'white';
            if (c === 2 || c === 'black') return 'black';
          }
        } catch (e) {}
        return null;
      },

      readPieces: function (board, wrap) {
        var orientation = this.orientation(wrap);
        var br = board.getBoundingClientRect();
        var out = [];
        var pieces = board.querySelectorAll('.piece');
        for (var i = 0; i < pieces.length; i++) {
          var p = pieces[i];
          var cls = p.className || '';
          var toks = cls.split(/\s+/);
          var code = null;
          for (var t = 0; t < toks.length; t++) {
            if (/^[wb][pnbrqk]$/.test(toks[t])) { code = toks[t]; break; }
          }
          if (!code) continue;
          var sq = squareFromRect(p, br, orientation);
          if (sq) out.push({ square: sq, piece: code, el: p });
        }
        return out;
      },

      isAnalysable: function () { return true; },

      detectMyColor: function (wrap) {
        var c = this.apiMyColor(wrap);
        if (c) return c;
        return this.orientation(wrap); // fallback: board orient = player color
      },

      clockText: function () {
        try {
          var els = document.querySelectorAll('.clock-component, [class*="clock-bottom"], [class*="clock-top"]');
          var bottom = null, top = null;
          var arr = [];
          for (var i = 0; i < els.length; i++) arr.push(els[i]);
          if (arr.length >= 2) {
            for (var j = 0; j < arr.length; j++) {
              var cl = arr[j].className || '';
              var txt = arr[j].textContent.trim();
              if (!/^\d/.test(txt) && !/:/.test(txt)) continue;
              if (/bottom/.test(cl) && !bottom) bottom = txt;
              else if (/top/.test(cl) && !top) top = txt;
            }
            if (!bottom || !top) {
              bottom = bottom || arr[0].textContent.trim();
              top = top || arr[arr.length - 1].textContent.trim();
            }
          }
          return { top: top, bottom: bottom };
        } catch (e) { return null; }
      },

      /* live-probed picker: .promotion-window > .promotion-piece.{wb,wn,wq,wr}
       * (DOM order B,N,Q,R — selection must be token-based, never positional).
       * Used only as metadata; actual picking goes through the bridge action
       * 'promotion-pick' which token-matches the option class. */
      promotionSelectors: ['.promotion-window .promotion-piece', '.promotion-piece', '[class*="promotion"] [class*="piece"]'],
      promotionPick: { sel: '.promotion-piece', byToken: true },

      gameResultText: function () {
        var el = document.querySelector('.game-over-modal-content, [class*="game-over"]');
        return el ? el.textContent.trim().slice(0, 80) : null;
      },
    },
  };

  O.detectSite = function () {
    // debug/test hook: force a site adapter via ?co_site=lichess|chesscom
    try {
      var forced = new URLSearchParams(location.search).get('co_site');
      if (forced === 'lichess') return O.sites.lichess;
      if (forced === 'chesscom') return O.sites.chesscom;
    } catch (e) {}
    var h = location.hostname || '';
    if (/lichess\.org$/.test(h)) return O.sites.lichess;
    if (/chess\.com$/.test(h) || /(^|\.)chess\.com$/.test(h)) return O.sites.chesscom;
    return null;
  };
})(typeof window !== 'undefined' ? window : globalThis);
