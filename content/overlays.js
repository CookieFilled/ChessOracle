/* ChessOracle — OverlayManager: arrows, eval bar, move badges, hanging-piece
 * rings. All rendered inside closed shadow DOMs (CSP-safe via
 * adoptedStyleSheets) attached to document.body and synced to board geometry.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;

  var COLORS = {
    best: '#22c55e',
    second: '#38bdf8',
    third: '#94a3b8',
    threat: '#ef4444',
    lastBlunder: '#ef4444',
    lastMistake: '#f59e0b',
    lastInacc: '#eab308',
    good: '#a3e635',
  };

  function makeSheet(css) {
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return sheet;
  }

  function OverlayCSS() {
    return `
:host { all: initial; }
.co-overlay { position: fixed; z-index: 2147483000; pointer-events: none; }
.co-overlay svg { width: 100%; height: 100%; display: block; }
.co-arrow { opacity: .82; }
.co-arrow-anim { animation: coPulse 1.6s ease-in-out infinite; }
@keyframes coPulse { 0%,100% { opacity: .82; } 50% { opacity: .45; } }
.co-ghost { opacity: .55; }
.co-badge circle { animation: coPop .3s cubic-bezier(.34,1.56,.64,1); }
@keyframes coPop { from { transform: scale(0); } to { transform: scale(1); } }
.co-ring { animation: coRing 2s ease-in-out infinite; }
@keyframes coRing { 0%,100% { opacity: .9; } 50% { opacity: .35; } }
`;
  }

  function EvalBarCSS() {
    return `
:host { all: initial; }
.co-evalbar { position: fixed; z-index: 2147483000; pointer-events: none;
  width: 16px; border-radius: 8px; overflow: hidden;
  box-shadow: 0 2px 10px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.12);
  background: #10141c; }
.co-evalbar .white { position: absolute; left: 0; right: 0; bottom: 0;
  background: linear-gradient(180deg, #f8fafc, #e2e8f0); transition: height .5s cubic-bezier(.22,1,.36,1); }
.co-evalbar .black { position: absolute; inset: 0; background: #1a1f2b; }
.co-evalbar .mid { position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: rgba(124,92,255,.85); z-index: 2; }
.co-evalbar .label { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
  font: 700 10px/1 'Segoe UI', system-ui, sans-serif; color: #0b0e14;
  background: #7c5cff; padding: 3px 5px; border-radius: 5px; white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,.5); }
.co-evalbar .depth { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
  font: 600 9px/1 'Segoe UI', system-ui, sans-serif; color: rgba(255,255,255,.75);
  top: calc(100% + 4px); white-space: nowrap; letter-spacing: .3px; }
`;
  }

  /* ---------- overlay ---------- */
  function OverlayManager(bw, gs, settings, site) {
    var self = this;
    this.bw = bw;
    this.gs = gs;
    this.settings = settings;
    this.site = site;
    this.hidden = false;
    this.lastAnalysis = null;
    this.flash = null; // {uci, until}
    this.badges = [];

    this.host = document.createElement('div');
    this.host.id = 'co-overlay-host';
    this.host.style.cssText = 'all:initial;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    this.shadow.adoptedStyleSheets = [makeSheet(OverlayCSS())];
    this.root = document.createElement('div');
    this.root.className = 'co-overlay';
    this.shadow.appendChild(this.root);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.setAttribute('preserveAspectRatio', 'none');
    this.root.appendChild(this.svg);
    this.defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    this.svg.appendChild(this.defs);

    (document.body || document.documentElement).appendChild(this.host);

    // eval bar
    this.barHost = document.createElement('div');
    this.barHost.id = 'co-evalbar-host';
    this.barHost.style.cssText = 'all:initial;';
    this.barShadow = this.barHost.attachShadow({ mode: 'closed' });
    this.barShadow.adoptedStyleSheets = [makeSheet(EvalBarCSS())];
    this.barRoot = document.createElement('div');
    this.barRoot.className = 'co-evalbar';
    this.barRoot.innerHTML = '<div class="black"></div><div class="white"></div><div class="mid"></div><div class="label">0.0</div><div class="depth"></div>';
    this.barShadow.appendChild(this.barRoot);
    (document.body || document.documentElement).appendChild(this.barHost);

    // geometry sync loop
    var syncGeom = function () { self.syncGeometry(); };
    window.addEventListener('scroll', syncGeom, { passive: true });
    window.addEventListener('resize', syncGeom);
    O.bus.on('board:geom', syncGeom);
    O.bus.on('position:stable', syncGeom);
    setInterval(syncGeom, 800);

    // data events
    O.bus.on('analysis', function (a) { self.lastAnalysis = a; self.render(); });
    O.bus.on('analysis:live', U.throttle(function (a) { self.renderLive(a); }, 160));
    O.bus.on('game:move', function (mv) { self.onMove(mv); });
    O.bus.on('game:classified', function (d) { self.render(); });
    O.bus.on('game:new', function () { self.flash = null; self.render(); });

    settings.onChanged(function (path) {
      if (path === 'analysis.*' || path === '*' || path.indexOf('analysis.') === 0 || path === 'enabled') self.render();
    });
  }

  OverlayManager.prototype.syncGeometry = function () {
    var snap = this.bw.lastStable;
    if (!snap || !snap.boardEl.isConnected) {
      this.root.style.display = 'none';
      if (this.barHost) this.barHost.style.display = 'none';
      return;
    }
    var r = snap.boardEl.getBoundingClientRect();
    if (r.width < 80) { this.root.style.display = 'none'; if (this.barHost) this.barHost.style.display = 'none'; return; }
    this.root.style.display = '';
    this.root.style.left = r.left + 'px';
    this.root.style.top = r.top + 'px';
    this.root.style.width = r.width + 'px';
    this.root.style.height = r.height + 'px';
    this.orientation = snap.orientation;

    // eval bar placement (host display is owned here — restored on success)
    var s = this.settings.data;
    var showBar = s.analysis.evalBar !== 'off' && !this.hidden;
    if (this.barHost) this.barHost.style.display = showBar ? '' : 'none';
    if (showBar) {
      var barW = 16, gap = 6;
      var x = s.analysis.evalBar === 'right' ? r.right + gap : r.left - barW - gap;
      if (x < 4) x = r.left + 4; // viewport clamp -> overlap slightly
      if (x + barW > window.innerWidth - 4) x = r.right - barW - 4;
      this.barRoot.style.left = x + 'px';
      this.barRoot.style.top = r.top + 'px';
      this.barRoot.style.height = r.height + 'px';
    }
  };

  /* square -> svg coords (8x8 viewBox), orientation-aware */
  OverlayManager.prototype.sqToXY = function (sq) {
    var f = O.FILES.indexOf(sq[0]);
    var r = parseInt(sq[1], 10);
    var col = this.orientation === 'black' ? 7 - f : f;
    var row = this.orientation === 'black' ? r - 1 : 8 - r;
    return { x: col + 0.5, y: row + 0.5 };
  };

  OverlayManager.prototype.arrowDefs = function () {
    // build arrowheads for each color once
    var id = 'coArrow';
    if (!this.defs.innerHTML) {
      var html = '';
      for (var k in COLORS) {
        html += '<marker id="' + id + k + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4.4" markerHeight="4.4" orient="auto-start-reverse" markerUnits="strokeWidth"><path d="M 0 1 L 9 5 L 0 9 z" fill="' + COLORS[k] + '"/></marker>';
      }
      this.defs.innerHTML = html;
    }
    return id;
  };

  OverlayManager.prototype.clear = function () {
    while (this.svg.firstChild && this.svg.firstChild !== this.defs) this.svg.removeChild(this.svg.firstChild);
    var kids = [...this.svg.children];
    for (var i = 0; i < kids.length; i++) if (kids[i] !== this.defs) this.svg.removeChild(kids[i]);
  };

  OverlayManager.prototype.render = function () {
    this.clear();
    if (this.hidden) { this.updateBar(null); return; }
    var s = this.settings.data;
    if (!s.enabled) return;
    var a = this.lastAnalysis;
    if (!a || !a.lines.length) { this.updateBar(null); return; }
    if (!this.bw.lastStable) return;

    var PFX = this.arrowDefs();
    var gs = this.gs;
    var myTurn = gs.isMyTurn();
    var turn = a.turn;

    /* best-move arrows (for the side to move) */
    var arrowCount = U.clamp(s.analysis.arrows, 0, 3);
    var colors = ['best', 'second', 'third'];
    for (var i = 0; i < Math.min(arrowCount, a.lines.length); i++) {
      var line = a.lines[i];
      if (!line.uci || line.uci.length < 4) continue;
      var isMine = (turn === (gs.myColor || turn));
      // threat arrow mode: only show opponent lines in red when enabled and not my turn
      var colKey;
      if (!myTurn && s.analysis.threatArrow && i === 0) colKey = 'threat';
      else if (!myTurn && !s.analysis.threatArrow) break; // opponent's turn: hide unless threat arrows
      else colKey = colors[i];
      if (this.flash && this.flash.until > Date.now()) {
        colKey = 'best';
      }
      this.drawArrow(line.uci.slice(0, 2), line.uci.slice(2, 4), colKey, i === 0 && this.settings.data.analysis.arrows > 0);
      if (s.analysis.ghost && i === 0 && myTurn) this.drawGhost(line.uci.slice(2, 4));
    }

    /* flash (hint) arrow */
    if (this.flash && this.flash.until > Date.now()) {
      this.drawArrow(this.flash.uci.slice(0, 2), this.flash.uci.slice(2, 4), 'best', true);
    } else if (this.flash) {
      this.flash = null;
    }

    /* last-move badge */
    if (s.analysis.badges && gs.moves.length) {
      var last = gs.moves[gs.moves.length - 1];
      if (last.classification && last.to) {
        this.drawBadge(last.to, last.classification);
      }
    }

    /* hanging pieces rings */
    if (s.coach.hanging && gs.chess) {
      var hanging = this.findHanging();
      for (var h = 0; h < hanging.length && h < 6; h++) {
        this.drawRing(hanging[h]);
      }
    }

    this.updateBar(a);
  };

  OverlayManager.prototype.renderLive = function (live) {
    // light update: depth + partial arrows during thinking
    if (this.hidden) return;
    if (live && live.lines && live.lines.length) {
      var fake = { turn: this.gs.turnColor(), lines: live.lines, depth: live.depth, nodes: live.nodes, nps: live.nps };
      this.lastAnalysisLive = fake;
      this.updateBar(fake);
    }
  };

  OverlayManager.prototype.drawArrow = function (from, to, colorKey, animate) {
    var p1 = this.sqToXY(from);
    var p2 = this.sqToXY(to);
    if (!p1 || !p2) return;
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.2) return;
    // shorten the line so arrowhead lands on square center
    var shorten = 0.34;
    var ux = dx / len, uy = dy / len;
    var x1 = p1.x + ux * 0.22, y1 = p1.y + uy * 0.22;
    var x2 = p2.x - ux * shorten, y2 = p2.y - uy * shorten;

    var line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', COLORS[colorKey] || COLORS.best);
    line.setAttribute('stroke-width', '0.22');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('class', 'co-arrow' + (animate ? ' co-arrow-anim' : ''));
    line.setAttribute('marker-end', 'url(#coArrow' + colorKey + ')');
    this.svg.appendChild(line);
  };

  OverlayManager.prototype.drawGhost = function (to) {
    // chess-piece ghost at destination square
    var gs = this.gs;
    var piece = gs.chess ? gs.chess.get(to) : null;
    if (!piece) return;
    var p = this.sqToXY(to);
    var glyph = { p: '\u265F', n: '\u265E', b: '\u265D', r: '\u265C', q: '\u265B', k: '\u265A' }[piece.type];
    var text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', p.x); text.setAttribute('y', p.y + 0.17);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '0.74');
    text.setAttribute('class', 'co-ghost');
    text.setAttribute('fill', piece.color === 'w' ? '#ffffff' : '#0f172a');
    text.setAttribute('stroke', piece.color === 'w' ? 'rgba(15,23,42,.8)' : 'rgba(255,255,255,.85)');
    text.setAttribute('stroke-width', '0.045');
    text.setAttribute('font-family', "'Segoe UI Symbol','DejaVu Sans',serif");
    text.textContent = glyph;
    this.svg.appendChild(text);
  };

  var BADGE_STYLE = {
    brilliant: { c: '#22d3ee', t: '!!' },
    great: { c: '#38bdf8', t: '!' },
    best: { c: '#22c55e', t: '\u2605' },
    excellent: { c: '#4ade80', t: '\u2713' },
    good: { c: '#a3e635', t: '\u2713' },
    inaccuracy: { c: '#facc15', t: '?!' },
    mistake: { c: '#fb923c', t: '?' },
    blunder: { c: '#ef4444', t: '??' },
  };

  OverlayManager.prototype.drawBadge = function (to, cls) {
    var st = BADGE_STYLE[cls];
    if (!st) return;
    var p = this.sqToXY(to);
    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'co-badge');
    g.setAttribute('transform', 'translate(' + (p.x + 0.32) + ',' + (p.y - 0.32) + ')');
    var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('r', '0.21');
    c.setAttribute('fill', st.c);
    c.setAttribute('stroke', 'rgba(0,0,0,.55)');
    c.setAttribute('stroke-width', '0.035');
    var t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('y', '0.075');
    t.setAttribute('font-size', '0.2');
    t.setAttribute('font-weight', '800');
    t.setAttribute('fill', '#0b0e14');
    t.setAttribute('font-family', "'Segoe UI',system-ui,sans-serif");
    t.textContent = st.t;
    g.appendChild(c);
    g.appendChild(t);
    this.svg.appendChild(g);
  };

  OverlayManager.prototype.drawRing = function (sq) {
    var p = this.sqToXY(sq);
    var r = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    r.setAttribute('cx', p.x); r.setAttribute('cy', p.y);
    r.setAttribute('r', '0.46');
    r.setAttribute('fill', 'none');
    r.setAttribute('stroke', '#ef4444');
    r.setAttribute('stroke-width', '0.08');
    r.setAttribute('class', 'co-ring');
    this.svg.appendChild(r);
  };

  OverlayManager.prototype.updateBar = function (a) {
    var s = this.settings.data;
    if (s.analysis.evalBar === 'off' || this.hidden || !a || !a.lines || !a.lines.length) {
      if (!a) { this.barRoot.style.display = s.analysis.evalBar === 'off' ? 'none' : ''; this.barRoot.querySelector('.white').style.height = '50%'; this.barRoot.querySelector('.label').textContent = '0.0'; }
      return;
    }
    // win% is for side to move; show from WHITE's perspective
    var turn = a.turn || this.gs.turnColor();
    var winForMover = a.lines[0].winPct;
    var whiteWin = turn === 'w' ? winForMover : 100 - winForMover;
    // bar fill: from bottom (white) — orientation-aware visual flip
    var fillPct = this.orientation === 'black' ? 100 - whiteWin : whiteWin;
    this.barRoot.querySelector('.white').style.height = fillPct.toFixed(1) + '%';
    var sc = a.lines[0].score;
    var label;
    if (sc && sc.mate != null) label = 'M' + Math.abs(sc.mate);
    else if (sc) {
      var cpWhite = turn === 'w' ? (sc.cp || 0) : -(sc.cp || 0);
      label = (cpWhite > 0 ? '+' : '') + (cpWhite / 100).toFixed(1);
    } else label = '0.0';
    this.barRoot.querySelector('.label').textContent = label;
    this.barRoot.querySelector('.depth').textContent = a.depth ? 'd' + a.depth : '';
  };

  OverlayManager.prototype.onMove = function (mv) {
    // brief highlight of the last-move square via site's own highlight; nothing needed
  };

  /* simple hanging-piece heuristic: own pieces attacked and not defended */
  OverlayManager.prototype.findHanging = function () {
    var chess = this.gs.chess;
    if (!chess) return [];
    var me = this.gs.myColor || chess.turn();
    var out = [];
    var squares = [];
    for (var f = 0; f < 8; f++) for (var r = 1; r <= 8; r++) squares.push(O.FILES[f] + r);
    for (var i = 0; i < squares.length; i++) {
      var sq = squares[i];
      var piece = chess.get(sq);
      if (!piece || piece.color !== me) continue;
      var attacked = isAttacked(chess, sq, me === 'w' ? 'b' : 'w');
      var defended = isAttacked(chess, sq, me);
      if (attacked && !defended) out.push(sq);
    }
    return out;
  };

  /* attacks on `sq` by color `by` (pseudo-legal, ignores pins) */
  function isAttacked(chess, sq, by) {
    // chess.js 0.10.3 doesn't expose attack maps; implement scan
    var knights = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 };
    var file = O.FILES.indexOf(sq[0]), rank = parseInt(sq[1], 10);
    var dirs = {
      r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
      b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    };
    var q = dirs.r.concat(dirs.b);
    var k = q;
    function pieceAt(f, r) {
      if (f < 0 || f > 7 || r < 1 || r > 8) return undefined;
      return chess.get(O.FILES[f] + r);
    }
    // sliding pieces
    for (var set = 0; set < 2; set++) {
      var dset = set === 0 ? dirs.r : dirs.b;
      var want = set === 0 ? 'rq' : 'bq';
      for (var di = 0; di < dset.length; di++) {
        var f = file + dset[di][0], r = rank + dset[di][1];
        while (f >= 0 && f <= 7 && r >= 1 && r <= 8) {
          var p = pieceAt(f, r);
          if (p) {
            if (p.color === by && want.indexOf(p.type) >= 0) return true;
            break;
          }
          f += dset[di][0]; r += dset[di][1];
        }
      }
    }
    // knights
    var NJ = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
    for (var n = 0; n < NJ.length; n++) {
      var p2 = pieceAt(file + NJ[n][0], rank + NJ[n][1]);
      if (p2 && p2.color === by && p2.type === 'n') return true;
    }
    // pawns
    var dir = by === 'w' ? 1 : -1; // white pawns attack upward
    for (var pf = -1; pf <= 1; pf += 2) {
      var p3 = pieceAt(file + pf, rank + dir);
      if (p3 && p3.color === by && p3.type === 'p') return true;
    }
    // king
    for (var kd = 0; kd < k.length; kd++) {
      var p4 = pieceAt(file + k[kd][0], rank + k[kd][1]);
      if (p4 && p4.color === by && p4.type === 'k') return true;
    }
    return false;
  }

  /* public API */
  OverlayManager.prototype.showHint = function (uci, ms) {
    this.flash = { uci: uci, until: Date.now() + (ms || 2600) };
    this.render();
    var self = this;
    setTimeout(function () { if (self.flash) { self.flash = null; self.render(); } }, ms || 2600);
  };

  OverlayManager.prototype.setHidden = function (h) {
    this.hidden = h;
    this.render();
    this.syncGeometry();
  };

  O.OverlayManager = OverlayManager;
  O.overlayColors = COLORS;
  O.isAttacked = isAttacked;
})(typeof window !== 'undefined' ? window : globalThis);
