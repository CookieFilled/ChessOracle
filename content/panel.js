/* ChessOracle — floating control panel (closed shadow DOM).
 * Tabs: Play / Analyze / Coach / Settings. Draggable, collapsible, themed.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;
  var BADGE_STYLE = {
    brilliant: { c: '#22d3ee', t: '!!' }, great: { c: '#38bdf8', t: '!' },
    best: { c: '#22c55e', t: '\u2605' }, excellent: { c: '#4ade80', t: '\u2713' },
    good: { c: '#a3e635', t: '\u2713' }, inaccuracy: { c: '#facc15', t: '?!' },
    mistake: { c: '#fb923c', t: '?' }, blunder: { c: '#ef4444', t: '??' },
  };
  var STATE_LABEL = {
    idle: 'Off', waiting: 'Waiting', thinking: 'Thinking', moving: 'Playing',
    error: 'Error', done: 'Game over',
  };
  var AP_PHASE_LABEL = {
    idle: 'Off', waiting: 'Waiting', playing: 'Playing', over: 'On a break',
    starting: 'Starting', unsupported: 'chess.com only', done: 'Session complete',
  };

  var LOGO_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 21c.6-2.6 1-4.4 1.2-5.4C5.4 14.2 4.6 12 4.6 9.6c0-3.5 2-6.1 5.2-6.1 2.6 0 4.1 1.7 4.1 4 0 1.5-.6 2.7-1.6 3.6.5.3 1.1.4 1.7.2 1-.3 1.9-1 2.5-2.1.9 1.2 1.4 2.6 1.4 4.1 0 4.2-3.4 7.2-8.2 7.2-.9 0-1.7-.1-2.4-.3L6 21z" fill="#fff"/><circle cx="13.2" cy="7.3" r="1.05" fill="#7c5cff"/></svg>';
  var CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var BOLT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/></svg>';

  function Panel(ctx) {
    var self = this;
    this.ctx = ctx; // {gs, bw, analyzer, settings, site, autoplay, exec, overlays}
    this.settings = ctx.settings;

    this.host = document.createElement('div');
    this.host.id = 'co-panel-host';
    this.host.style.cssText = 'all:initial;';
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(O.PANEL_CSS);
    this.shadow.adoptedStyleSheets = [sheet];
    (document.body || document.documentElement).appendChild(this.host);

    this.el = document.createElement('div');
    this.shadow.appendChild(this.el);

    this.tab = 'play';
    this.drag = null;

    // data subscriptions
    O.bus.on('analysis', function () { self.refreshLive(); });
    O.bus.on('analysis:live', U.throttle(function () { self.refreshLive(); }, 250));
    O.bus.on('autoplay:status', function (s) { self.refreshStatus(s); });
    O.bus.on('autopilot:status', function (s) { self.refreshAutopilot(s); });
    O.bus.on('game:move', function () { self.refreshStats(); });
    O.bus.on('game:classified', function () { self.refreshStats(); });
    O.bus.on('game:new', function () { self.refreshStats(); self.refreshStatus(); self.refreshColorNote(); });
    O.bus.on('game:color', function () { self.refreshColorNote(); });
    O.bus.on('engine:ready', function () { self.refreshHead(); });
    O.bus.on('engine:down', function () { self.refreshHead(); });
    O.bus.on('site:info', U.throttle(function () { self.refreshColorNote(); }, 1200));

    this.settings.onChanged(function (path) {
      self.applyTheme();
      if (self.tab === 'play' || path === 'autoplay.on') self.refreshStatus();
    });

    this.render();
    this.restorePos();
  }

  /* ---------------- skeleton ---------------- */
  Panel.prototype.render = function () {
    var s = this.settings.data;
    var collapsed = !s.panel.open || s.panel.collapsed;
    if (collapsed) return this.renderPill();
    var self = this;

    this.el.className = 'panel theme' + (s.panel.theme === 'light' ? ' light' : '');
    this.el.innerHTML = `
      <div class="p-head" data-drag>
        <div class="logo">${LOGO_SVG}</div>
        <div class="title">ChessOracle
          <span class="sub" data-sub>${this.ctx.site.label} · ready</span>
        </div>
        <span class="site-pill" data-pill>${this.ctx.site.id === 'lichess' ? 'LICHESS' : 'CHESS.COM'}</span>
        <span class="dot" data-dot></span>
        <button class="icon-btn" data-min title="Collapse">${CHEVRON}</button>
        <button class="icon-btn" data-close title="Hide panel (Alt+P reopens)">${CLOSE}</button>
      </div>
      <div class="body">
        <div class="tabs">
          <button class="tab" data-tab="play">Play</button>
          <button class="tab" data-tab="autopilot">Autopilot</button>
          <button class="tab" data-tab="analyze">Analyze</button>
          <button class="tab" data-tab="coach">Coach</button>
          <button class="tab" data-tab="settings">Settings</button>
        </div>
        <div class="tab-body" data-body></div>
      </div>
      <div class="foot"><span>v${O.version} · local engine</span><span data-foot-toggle>Show intro</span></div>
    `;

    this.el.querySelector('[data-min]').addEventListener('click', function () {
      self.settings.set('panel.collapsed', true);
      self.render();
    });
    this.el.querySelector('[data-close]').addEventListener('click', function () {
      self.settings.set('panel.open', false);
      self.render();
    });
    this.el.querySelector('[data-foot-toggle]').addEventListener('click', function () {
      var b = self.el.querySelector('[data-body]');
      if (self.tab !== 'about') { self.prevTab = self.tab; self.tab = 'about'; self.renderTab(); }
      else { self.tab = self.prevTab || 'play'; self.renderTab(); }
    });

    var tabs = this.el.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        t.addEventListener('click', function () { self.tab = t.getAttribute('data-tab'); self.renderTab(); });
      })(tabs[i]);
    }

    this.makeDraggable(this.el.querySelector('.p-head'), this.el);
    this.renderTab();
    this.refreshHead();
    this.refreshStatus();
    this.refreshStats();
  };

  Panel.prototype.renderPill = function () {
    var self = this;
    var s = this.settings.data;
    this.el.className = '';
    this.el.innerHTML = `
      <div class="pill" data-pill-expand>
        <span class="logo" style="width:20px;height:20px;border-radius:6px;">${LOGO_SVG}</span>
        <span data-pill-eval>…</span>
        <span class="dot" data-dot></span>
      </div>`;
    this.el.querySelector('[data-pill-expand]').addEventListener('click', function () {
      self.settings.set('panel.open', true);
      self.settings.set('panel.collapsed', false);
      self.render();
    });
    this.refreshHead();
    this.refreshLive();
  };

  Panel.prototype.renderTab = function () {
    var b = this.el.querySelector('[data-body]');
    if (!b) return;
    var tabs = this.el.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === this.tab);
    }
    if (this.tab === 'play') this.renderPlay(b);
    else if (this.tab === 'autopilot') this.renderAutopilot(b);
    else if (this.tab === 'analyze') this.renderAnalyze(b);
    else if (this.tab === 'coach') this.renderCoach(b);
    else if (this.tab === 'settings') this.renderSettings(b);
    else if (this.tab === 'about') this.renderAbout(b);
    this.refreshStats();
    this.refreshStatus();
    this.refreshAutopilot();
  };

  /* ---------------- controls ---------------- */
  Panel.prototype.toggle = function (path, opts) {
    var s = this.settings;
    var wrap = document.createElement('div');
    wrap.className = 'row';
    wrap.innerHTML = `
      <div class="lab">${opts.label}${opts.hint ? '<span class="hint">' + opts.hint + '</span>' : ''}</div>
      <label class="switch"><input type="checkbox" ${s.get(path) ? 'checked' : ''}><span class="tr"></span></label>`;
    var input = wrap.querySelector('input');
    input.addEventListener('change', function () { s.set(path, input.checked); });
    s.onChanged(function (p) { if (p === path || p === '*') input.checked = !!s.get(path); });
    return wrap;
  };

  Panel.prototype.slider = function (path, opts) {
    var s = this.settings;
    var wrap = document.createElement('div');
    wrap.className = 'srow';
    var min = opts.min, max = opts.max, step = opts.step || 1;
    var fmt = opts.fmt || function (v) { return v; };
    wrap.innerHTML = `
      <div class="stop"><span class="lab">${opts.label}</span><span class="val">${fmt(s.get(path))}</span></div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${s.get(path)}">`;
    var input = wrap.querySelector('input');
    var val = wrap.querySelector('.val');
    var paint = function () {
      var pct = ((input.value - min) / (max - min)) * 100;
      input.style.setProperty('--fill', pct + '%');
      val.textContent = fmt(+input.value);
    };
    paint();
    input.addEventListener('input', function () { paint(); });
    input.addEventListener('change', function () { s.set(path, +input.value); });
    s.onChanged(function (p) { if (p === path || p === '*') { input.value = s.get(path); paint(); } });
    return wrap;
  };

  Panel.prototype.seg = function (path, opts) {
    var s = this.settings;
    var wrap = document.createElement('div');
    wrap.className = 'row';
    var btns = opts.options.map(function (o) {
      return `<button data-v="${o.v}" class="${String(s.get(path)) === String(o.v) ? 'on' : ''}">${o.l}</button>`;
    }).join('');
    wrap.innerHTML = `
      <div class="lab">${opts.label}</div>
      <div class="seg">${btns}</div>`;
    var seg = wrap.querySelector('.seg');
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button');
      if (!btn) return;
      s.set(path, isNaN(+btn.dataset.v) || btn.dataset.v === '' ? btn.dataset.v : +btn.dataset.v);
      var all = seg.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === btn);
    });
    return wrap;
  };

  Panel.prototype.section = function (title) {
    var d = document.createElement('div');
    d.className = 'section';
    if (title) {
      var t = document.createElement('div');
      t.className = 'sec-title';
      t.textContent = title;
      d.appendChild(t);
    }
    return d;
  };

  /* ---------------- Play tab ---------------- */
  Panel.prototype.refreshColorNote = function () {
    var el = this.el.querySelector('[data-color-note]');
    if (!el) return;
    var gs = this.ctx.gs;
    var mode = this.settings.get('autoplay.color');
    var txt;
    if (mode === 'white' || mode === 'black') {
      txt = 'Locked to ' + (mode === 'white' ? 'White' : 'Black') + ' (manual)';
    } else if (gs && gs.myColor) {
      txt = 'Detected: you play ' + (gs.myColor === 'w' ? 'White' : 'Black');
    } else {
      txt = 'Color: waiting for a game…';
    }
    el.textContent = txt;
  };

  Panel.prototype.renderPlay = function (b) {
    var self = this;
    var s = this.settings;
    b.innerHTML = '';

    // master toggle
    var big = document.createElement('div');
    big.className = 'big-toggle';
    big.innerHTML = `
      <label class="switch"><input type="checkbox" data-auto ${s.get('autoplay.on') ? 'checked' : ''}><span class="tr"></span></label>
      <div class="txt">AUTOPLAY<span class="sub" data-auto-sub>plays as you at selected strength</span></div>`;
    var autoInput = big.querySelector('[data-auto]');
    autoInput.addEventListener('change', function () {
      s.set('autoplay.on', autoInput.checked);
      if (autoInput.checked && s.get('autoplay.color') === 'auto') self.ctx.autoplay.applyColorSetting();
    });
    b.appendChild(big);

    // status line
    var st = document.createElement('div');
    st.className = 'status-line';
    st.innerHTML = '<span class="dot" data-st-dot></span><span class="txt" data-st-txt>off</span>';
    st.setAttribute('data-status-line', '');
    b.appendChild(st);

    // strength
    var strength = this.section('Strength');
    strength.appendChild(this.slider('autoplay.elo', { label: 'Elo rating', min: 400, max: 2900, step: 25, fmt: function (v) { return v; } }));
    var chips = document.createElement('div');
    chips.className = 'chips';
    [800, 1200, 1600, 2000, 2400, 2800].forEach(function (e) {
      var c = document.createElement('span');
      c.className = 'chip' + (s.get('autoplay.elo') === e ? ' on' : '');
      c.textContent = e;
      c.addEventListener('click', function () { s.set('autoplay.elo', e); });
      chips.appendChild(c);
    });
    strength.appendChild(chips);
    strength.appendChild(this.slider('autoplay.bias', { label: 'Strength bias', min: 0, max: 250, step: 10, fmt: function (v) { return '+' + v; }, hint: 'plays this much above the set Elo' }));
    strength.appendChild(this.toggle('autoplay.safeFloor', { label: 'Never lose a game', hint: 'filters risky human slips when ahead' }));
    strength.appendChild(this.slider('autoplay.risk', { label: 'Risk tolerance', min: 0, max: 100, step: 5, fmt: function (v) { return v + '%'; } }));
    b.appendChild(strength);

    // humanity
    var human = this.section('Humanity');
    human.appendChild(this.seg('autoplay.human', { label: 'Error style', options: [{ v: 'auto', l: 'Auto (Elo)' }, { v: 'manual', l: 'Manual' }] }));
    human.appendChild(this.slider('autoplay.blunderRate', { label: 'Blunders', min: 0, max: 100, step: 1, fmt: function (v) { return v; }, hint: 'moves per 100 that hang something' }));
    human.appendChild(this.slider('autoplay.mistakeRate', { label: 'Mistakes', min: 0, max: 100, step: 1, fmt: function (v) { return v; } }));
    human.appendChild(this.slider('autoplay.inaccuracyRate', { label: 'Inaccuracies', min: 0, max: 100, step: 1, fmt: function (v) { return v; } }));
    human.appendChild(this.slider('autoplay.randomness', { label: 'Randomness', min: 0, max: 100, step: 5, fmt: function (v) { return v + '%'; }, hint: 'variety among equal moves' }));
    b.appendChild(human);

    // timing
    var timing = this.section('Move timing');
    timing.appendChild(this.seg('autoplay.timingMode', { label: 'Mode', options: [{ v: 'variable', l: 'Variable' }, { v: 'fixed', l: 'Fixed' }] }));
    timing.appendChild(this.slider('autoplay.timeMin', { label: 'Min think time', min: 0.2, max: 15, step: 0.1, fmt: function (v) { return v.toFixed(1) + 's'; } }));
    timing.appendChild(this.slider('autoplay.timeMax', { label: 'Max think time', min: 0.5, max: 30, step: 0.5, fmt: function (v) { return v.toFixed(1) + 's'; } }));
    timing.appendChild(this.slider('autoplay.timeFixed', { label: 'Fixed think time', min: 0.2, max: 20, step: 0.2, fmt: function (v) { return v.toFixed(1) + 's'; } }));
    timing.appendChild(this.toggle('autoplay.clockAware', { label: 'Clock aware', hint: 'thinks faster in time trouble' }));
    timing.appendChild(this.toggle('autoplay.openingFast', { label: 'Fast opening moves' }));
    b.appendChild(timing);

    // openings & color
    var misc = this.section('Openings & color');
    misc.appendChild(this.toggle('autoplay.book', { label: 'Opening book', hint: 'varied main lines for first ~6 moves' }));
    misc.appendChild(this.slider('autoplay.bookVariety', { label: 'Book variety', min: 0, max: 100, step: 5, fmt: function (v) { return v + '%'; } }));
    misc.appendChild(this.seg('autoplay.color', { label: 'Play as', options: [{ v: 'auto', l: 'Auto' }, { v: 'white', l: 'White' }, { v: 'black', l: 'Black' }] }));
    var colorNote = document.createElement('div');
    colorNote.className = 'color-note';
    colorNote.setAttribute('data-color-note', '');
    misc.appendChild(colorNote);
    b.appendChild(misc);

    // action buttons
    var btns = this.section();
    var row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    var playBtn = document.createElement('button');
    playBtn.className = 'btn small';
    playBtn.innerHTML = BOLT + ' Play best move once';
    playBtn.addEventListener('click', async function () {
      playBtn.textContent = 'Playing…';
      var r = await self.ctx.autoplay.playBestOnce();
      playBtn.innerHTML = BOLT + ' Play best move once';
      if (!r.ok) self.toast(r.error || 'failed', 'err');
    });
    row.appendChild(playBtn);
    btns.appendChild(row);
    b.appendChild(btns);

    this.refreshColorNote();
  };

  /* ---------------- Autopilot tab ---------------- */
  Panel.prototype.renderAutopilot = function (b) {
    var self = this;
    var s = this.settings;
    b.innerHTML = '';

    if (this.ctx.site.id !== 'chesscom') {
      var note = document.createElement('div');
      note.className = 'ap-note';
      note.textContent = 'Autopilot sessions are chess.com-only for now (single-game Autoplay still works fine here on lichess).';
      b.appendChild(note);
    }

    // master toggle
    var big = document.createElement('div');
    big.className = 'big-toggle';
    big.innerHTML = `
      <label class="switch"><input type="checkbox" data-apon ${s.get('autopilot.on') ? 'checked' : ''}><span class="tr"></span></label>
      <div class="txt">AUTOPILOT<span class="sub">plays, finishes & re-queues games like a human</span></div>`;
    var apInput = big.querySelector('[data-apon]');
    apInput.addEventListener('change', function () {
      s.set('autopilot.on', apInput.checked);
      if (apInput.checked && s.get('autoplay.color') === 'auto') {
        try { self.ctx.autoplay.applyColorSetting(); } catch (e) {}
      }
    });
    if (this.ctx.site.id !== 'chesscom') apInput.disabled = true;
    b.appendChild(big);

    // status line
    var st = document.createElement('div');
    st.className = 'status-line';
    st.innerHTML = '<span class="dot" data-ap-dot></span><span class="txt" data-ap-txt>off</span>';
    b.appendChild(st);

    // session stats
    var stats = document.createElement('div');
    stats.className = 'ap-stats';
    stats.innerHTML = `
      <div class="cell"><span class="n" data-n-games>0</span><span class="l">games</span></div>
      <div class="cell win"><span class="n" data-n-wins>0</span><span class="l">won</span></div>
      <div class="cell loss"><span class="n" data-n-losses>0</span><span class="l">lost</span></div>
      <div class="cell draw"><span class="n" data-n-draws>0</span><span class="l">drawn</span></div>`;
    b.appendChild(stats);

    var streak = document.createElement('div');
    streak.className = 'ap-note';
    streak.setAttribute('data-ap-streak', '');
    b.appendChild(streak);

    // outcomes
    var outcome = this.section('Game outcomes');
    outcome.appendChild(this.seg('autopilot.mode', { label: 'Session plan', options: [
      { v: 'mixed', l: 'Mixed' }, { v: 'win', l: 'Win all' }, { v: 'lose', l: 'Lose all' },
    ]}));
    var modeHint = document.createElement('div');
    modeHint.className = 'ap-note';
    modeHint.setAttribute('data-ap-modehint', '');
    var paintModeHint = function () {
      var m = s.get('autopilot.mode') || 'mixed';
      modeHint.textContent = m === 'win'
        ? 'Win all — every game is played to win (full strength + fightbacks).'
        : m === 'lose'
          ? 'Lose all — every game is played to LOSE it: weaker moves, human slips, resigns when lost. Never an instant giveaway.'
          : 'Mixed — wins ~' + (s.get('autopilot.winRate') || 62) + '% of games and loses the rest, like a real player having good and bad days.';
    };
    paintModeHint();
    s.onChanged(function (p) { if (p === 'autopilot.mode' || p === 'autopilot.winRate') paintModeHint(); });
    outcome.appendChild(modeHint);
    outcome.appendChild(this.slider('autopilot.winRate', { label: 'Target win rate', min: 5, max: 95, step: 1, fmt: function (v) { return v + '%'; }, hint: 'mixed mode: share of games planned as wins' }));
    outcome.appendChild(this.slider('autopilot.maxStreak', { label: 'Streak cap', min: 1, max: 8, step: 1, fmt: function (v) { return v + ' in a row'; }, hint: 'mixed mode stays believable' }));
    outcome.appendChild(this.slider('autoplay.elo', { label: 'Strength (same Elo)', min: 400, max: 2900, step: 25, fmt: function (v) { return v; }, hint: 'win/lose plans modulate around this' }));
    b.appendChild(outcome);

    // session flow
    var flow = this.section('Session flow');
    flow.appendChild(this.slider('autopilot.gamesLimit', { label: 'Games limit', min: 0, max: 50, step: 1, fmt: function (v) { return v === 0 ? 'endless' : v; }, hint: '0 = keep going until you stop it' }));
    flow.appendChild(this.slider('autopilot.breakMin', { label: 'Break between games', min: 2, max: 60, step: 1, fmt: function (v) { return v + 's min'; } }));
    flow.appendChild(this.slider('autopilot.breakMax', { label: '', min: 5, max: 120, step: 1, fmt: function (v) { return v + 's max'; } }));
    flow.appendChild(this.slider('autopilot.longBreakChance', { label: 'Coffee-break chance', min: 0, max: 30, step: 1, fmt: function (v) { return v + '%'; }, hint: 'occasional 25–70s pause like a real player' }));
    b.appendChild(flow);

    // realism
    var real = this.section('Realism');
    real.appendChild(this.slider('autopilot.resignWhenLost', { label: 'Resign when lost', min: 0, max: 90, step: 5, fmt: function (v) { return v + '%'; }, hint: 'chance to resign a clearly lost game' }));
    real.appendChild(this.slider('autopilot.minResignPly', { label: 'No resign before move', min: 4, max: 40, step: 1, fmt: function (v) { return v; } }));
    real.appendChild(this.toggle('autopilot.sabotage', { label: 'Human slips when losing', hint: 'gradual plausible mistakes, never instant giveaways' }));
    real.appendChild(this.toggle('autopilot.tryhard', { label: 'Tryhard mode', hint: 'fights back when a planned win slips away' }));
    b.appendChild(real);

    // behavior
    var beh = this.section('Behavior');
    beh.appendChild(this.seg('autopilot.arena', { label: 'Play against', options: [
      { v: 'online', l: 'Real people' }, { v: 'computer', l: 'Bots' },
    ]}));
    beh.appendChild(this.toggle('autopilot.autoNavigate', { label: 'Auto-navigate to arena', hint: 'opens the arena if left idle without a board' }));
    beh.appendChild(this.toggle('autopilot.autoDismiss', { label: 'Dismiss popups', hint: 'closes welcome/help dialogs blocking the flow' }));
    beh.appendChild(this.toggle('autopilot.allowRematch', { label: 'Allow rematch', hint: 'off by default — rematch sends a challenge that can stall the session' }));
    b.appendChild(beh);

    // actions
    var btns = this.section();
    var row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '8px';
    var stopBtn = document.createElement('button');
    stopBtn.className = 'btn small';
    stopBtn.textContent = 'Stop now';
    stopBtn.addEventListener('click', function () {
      s.set('autopilot.on', false);
      s.set('autoplay.on', false);
      self.toast('Autopilot stopped', 'warn');
    });
    row.appendChild(stopBtn);
    var resetBtn = document.createElement('button');
    resetBtn.className = 'btn ghost small';
    resetBtn.style.flex = '1';
    resetBtn.textContent = 'Reset session stats';
    resetBtn.addEventListener('click', function () {
      try { self.ctx.autopilot.resetSession(); } catch (e) {}
      self.toast('Session stats cleared', 'ok');
      self.refreshAutopilot();
    });
    row.appendChild(resetBtn);
    btns.appendChild(row);
    b.appendChild(btns);

    this.refreshAutopilot();
  };

  Panel.prototype.refreshAutopilot = function (st) {
    var line = this.el.querySelector('[data-ap-txt]');
    if (!line) return;
    var ap = this.ctx.autopilot;
    var s = st || (ap && ap.snapshot ? ap.snapshot() : null);
    if (!s) return;
    var phase = s.phase || 'idle';
    var dot = line.parentElement.querySelector('[data-ap-dot]');
    if (dot) dot.className = 'dot ' + (phase === 'playing' ? 'think' : (phase === 'over' || phase === 'starting' || phase === 'waiting' || phase === 'done') ? 'ok' : phase === 'unsupported' ? 'err' : '');
    line.textContent = (AP_PHASE_LABEL[phase] || phase) + (s.detail ? ' · ' + s.detail : '');
    var set = function (sel, v) { var el = this.el.querySelector(sel); if (el) el.textContent = v; }.bind(this);
    var ses = s.session || {};
    set('[data-n-games]', ses.games || 0);
    set('[data-n-wins]', ses.wins || 0);
    set('[data-n-losses]', ses.losses || 0);
    set('[data-n-draws]', ses.draws || 0);
    var streakEl = this.el.querySelector('[data-ap-streak]');
    if (streakEl) {
      streakEl.textContent = ses.games
        ? ('Streak: ' + (ses.streak ? (ses.streakType === 'win' ? ses.streak + ' wins' : ses.streak + ' losses') : 'none') +
           ' · last game: ' + (ap && ap.session && ap.session.lastResult ? ap.session.lastResult : '—'))
        : 'No games this session yet.';
    }
  };

  /* ---------------- Analyze tab ---------------- */
  Panel.prototype.renderAnalyze = function (b) {
    var self = this;
    b.innerHTML = '';

    var evalBox = document.createElement('div');
    evalBox.className = 'eval-box';
    evalBox.innerHTML = `
      <div class="eval-num" data-eval>0.0</div>
      <div class="eval-meta" data-eval-meta>depth 0<br>stockfish 18</div>`;
    b.appendChild(evalBox);
    var winbar = document.createElement('div');
    winbar.className = 'winbar';
    winbar.innerHTML = '<div class="fill" data-winbar style="width:50%"></div>';
    b.appendChild(winbar);

    var graph = document.createElement('div');
    graph.className = 'graph';
    graph.innerHTML = this.graphSVG();
    b.appendChild(graph);

    var acc = this.section('Live accuracy');
    acc.innerHTML += `
      <div class="acc-row"><span class="who">You</span><div class="bar"><div class="fill" data-acc-me style="width:0%"></div></div><span class="num" data-acc-me-n>—</span></div>
      <div class="acc-row"><span class="who">Opponent</span><div class="bar"><div class="fill opp" data-acc-opp style="width:0%"></div></div><span class="num" data-acc-opp-n>—</span></div>`;
    b.appendChild(acc);

    var disp = this.section('Display');
    disp.appendChild(this.seg('analysis.evalBar', { label: 'Eval bar', options: [{ v: 'left', l: 'Left' }, { v: 'right', l: 'Right' }, { v: 'off', l: 'Off' }] }));
    disp.appendChild(this.slider('analysis.arrows', { label: 'Suggestion arrows', min: 0, max: 3, step: 1, fmt: function (v) { return v; } }));
    disp.appendChild(this.toggle('analysis.ghost', { label: 'Ghost piece on target' }));
    disp.appendChild(this.toggle('analysis.threatArrow', { label: 'Threat arrow', hint: "opponent's best reply (red)" }));
    disp.appendChild(this.toggle('analysis.badges', { label: 'Move badges' }));
    b.appendChild(disp);

    var eng = this.section('Engine');
    eng.appendChild(this.slider('analysis.depth', { label: 'Depth', min: 6, max: 24, step: 1, fmt: function (v) { return v; } }));
    eng.appendChild(this.slider('analysis.movetime', { label: 'Time per position', min: 200, max: 2500, step: 50, fmt: function (v) { return (v / 1000).toFixed(1) + 's'; } }));
    b.appendChild(eng);

    var logSec = this.section('Moves');
    var log = document.createElement('div');
    log.className = 'log';
    log.setAttribute('data-log', '');
    logSec.appendChild(log);
    b.appendChild(logSec);

    // hooks
    self.onceSub('game:move', function () { self.refreshLog(); });
    this.refreshLive();
    this.refreshLog();
  };

  /* ---------------- Coach tab ---------------- */
  Panel.prototype.renderCoach = function (b) {
    var self = this;
    b.innerHTML = '';

    var hintBtn = document.createElement('button');
    hintBtn.className = 'btn';
    hintBtn.innerHTML = 'Show best move (hint)';
    hintBtn.addEventListener('click', function () {
      var a = self.ctx.analyzer.lastResult;
      var uci = a && (a.bestmove || (a.lines[0] && a.lines[0].uci));
      if (uci) self.ctx.overlays.showHint(uci, 2600);
      else self.toast('no analysis yet', 'warn');
    });
    b.appendChild(hintBtn);
    b.appendChild(document.createElement('div')).style.height = '8px';

    var sec = this.section('Assistance');
    sec.appendChild(this.toggle('coach.hanging', { label: 'Hanging pieces', hint: 'red rings on undefended pieces (heuristic)' }));
    sec.appendChild(this.toggle('coach.alerts', { label: 'Blunder alerts', hint: 'banner when a move loses advantage' }));
    sec.appendChild(this.toggle('coach.sound', { label: 'Sound on blunder', hint: 'subtle beep' }));
    b.appendChild(sec);

    var alertBox = document.createElement('div');
    alertBox.setAttribute('data-alert-box', '');
    b.appendChild(alertBox);

    var info = this.section('Shortcuts');
    info.innerHTML += `
      <div class="row"><span class="lab">Hint</span><span class="kbd">Alt+H</span></div>
      <div class="row"><span class="lab">Toggle autoplay</span><span class="kbd">Alt+B</span></div>
      <div class="row"><span class="lab">Toggle autopilot</span><span class="kbd">Alt+O</span></div>
      <div class="row"><span class="lab">Toggle arrows</span><span class="kbd">Alt+A</span></div>
      <div class="row"><span class="lab">Show / hide panel</span><span class="kbd">Alt+P</span></div>`;
    b.appendChild(info);

    self.onceSub('game:classified', function (d) { self.maybeAlert(d); });
  };

  /* ---------------- Settings tab ---------------- */
  Panel.prototype.renderSettings = function (b) {
    var self = this;
    b.innerHTML = '';

    var look = this.section('Appearance');
    look.appendChild(this.seg('panel.theme', { label: 'Theme', options: [{ v: 'dark', l: 'Dark' }, { v: 'light', l: 'Light' }] }));
    b.appendChild(look);

    var focus = this.section('Focus mode');
    var frow = document.createElement('div');
    frow.className = 'row';
    frow.innerHTML = `<div class="lab">Hide all overlays<span class="hint">arrows, eval bar, badges</span></div>`;
    var fbtn = document.createElement('button');
    fbtn.className = 'btn small';
    fbtn.textContent = this.focusOn ? 'Disabled' : 'Enable';
    fbtn.addEventListener('click', function () {
      self.focusOn = !self.focusOn;
      self.ctx.overlays.setHidden(self.focusOn);
      fbtn.textContent = self.focusOn ? 'Disable' : 'Enable';
    });
    frow.appendChild(fbtn);
    focus.appendChild(frow);
    b.appendChild(focus);

    var data = this.section('Data');
    var pgn = document.createElement('button');
    pgn.className = 'btn ghost';
    pgn.textContent = 'Copy game PGN with comments';
    pgn.addEventListener('click', function () {
      var pgn = self.ctx.gs.pgn();
      if (!pgn) { self.toast('no moves yet', 'warn'); return; }
      navigator.clipboard.writeText(pgn).then(
        function () { self.toast('PGN copied to clipboard', 'ok'); },
        function () { self.toast('clipboard blocked', 'err'); }
      );
    });
    data.appendChild(pgn);
    data.appendChild(document.createElement('div')).style.height = '8px';

    var resetBtn = document.createElement('button');
    resetBtn.className = 'btn ghost';
    resetBtn.textContent = 'Reset panel position';
    resetBtn.addEventListener('click', function () {
      self.settings.set('panel.pos', null);
      self.el.style.top = 'auto';
      self.el.style.left = '18px';
      self.el.style.right = 'auto';
      self.el.style.bottom = '18px';
    });
    data.appendChild(resetBtn);

    var wipe = document.createElement('button');
    wipe.className = 'btn ghost';
    wipe.textContent = 'Reset all settings';
    wipe.addEventListener('click', function () {
      self.settings.reset();
      self.render();
    });
    data.appendChild(wipe);
    b.appendChild(data);

    var about = this.section('About');
    about.innerHTML += `<div class="about">
      ChessOracle runs Stockfish 18 (WASM) fully locally in your browser — nothing is sent anywhere.<br><br>
      Engine assistance in rated games violates chess.com & lichess Terms of Service. Best enjoyed in bot games, casual play, training and analysis.
    </div>`;
    b.appendChild(about);
  };

  Panel.prototype.renderAbout = function (b) {
    b.innerHTML = '';
    var s = this.section('ChessOracle v' + O.version);
    s.innerHTML += `<div class="about">
      <b>What it does</b><br>
      Real-time Stockfish analysis with arrows, eval bar and move badges; an Elo-matched autoplay engine (400–2900) with human-like timing and imperfection sliders; coach hints; opening book; PGN export.<br><br>
      <b>How autoplay works</b><br>
      The engine searches at Elo-mapped depth/skill, then a selection policy picks a human-plausible move. Sliders tune blunder/mistake/inaccuracy rates; "Never lose a game" keeps a safety floor when ahead; timing mimics real think times.<br><br>
      <b>Privacy</b><br>
      100% local. No accounts, no network calls, no telemetry.<br><br>
      <b>Credits</b><br>
      Stockfish (GPLv3) · chess.js (MIT) · NNUE net by Linmiao Xu.
    </div>`;
    b.appendChild(s);
  };

  /* ---------------- live refresh ---------------- */
  Panel.prototype.onceSub = function (event, fn) {
    // re-render-safe subscription: replaces the previous handler
    if (this._subs && this._subs[event]) {
      O.bus.off(event, this._subs[event]);
    }
    if (!this._subs) this._subs = {};
    this._subs[event] = fn;
    O.bus.on(event, fn);
  };

  Panel.prototype.refreshHead = function () {
    var dot = this.el.querySelector('[data-dot]');
    var sub = this.el.querySelector('[data-sub]');
    if (!dot) return;
    var a = this.ctx.analyzer;
    if (this.ctx.autoplay.enabled) {
      dot.className = 'dot ' + (this.ctx.autoplay.state === 'thinking' || this.ctx.autoplay.state === 'moving' ? 'think' : 'ok');
    } else if (a && a.thinking) dot.className = 'dot think';
    else if (this.ctx.ec.ready) dot.className = 'dot ok';
    else dot.className = 'dot err';
    if (sub) {
      var siteLabel = this.ctx.site.label;
      sub.textContent = siteLabel + (this.ctx.ec.ready ? ' · engine ready' : ' · engine starting…');
    }
  };

  Panel.prototype.refreshStatus = function (st) {
    var line = this.el.querySelector('[data-status-line]');
    if (!line) return;
    var ap = this.ctx.autoplay;
    var state = st ? st.state : ap.state;
    var detail = st ? st.detail : ap.detail;
    var dot = line.querySelector('[data-st-dot]');
    var txt = line.querySelector('[data-st-txt]');
    dot.className = 'dot ' + (state === 'error' ? 'err' : state === 'moving' || state === 'thinking' ? 'think' : state === 'done' ? 'ok' : '');
    line.className = 'status-line ' + (state === 'error' ? 'err' : state === 'moving' || state === 'thinking' ? '' : state === 'done' ? 'ok' : '');
    txt.textContent = STATE_LABEL[state] || state + (detail ? ' · ' + detail : '');
    this.refreshHead();
  };

  Panel.prototype.refreshLive = function () {
    var a = this.ctx.analyzer.lastResult || this.ctx.analyzer.liveResult;
    if (!a) return;
    var evEl = this.el.querySelector('[data-eval]');
    if (evEl) {
      var sc = a.lines && a.lines[0] && a.lines[0].score;
      var turn = a.turn;
      var label = U.fmtEval(sc);
      var cpWhite = sc && sc.cp != null ? (turn === 'w' ? sc.cp : -sc.cp) : null;
      evEl.textContent = label;
      evEl.className = 'eval-num' + (cpWhite != null && cpWhite < -100 ? ' black-adv' : '');
      var meta = this.el.querySelector('[data-eval-meta]');
      if (meta) meta.innerHTML = 'depth ' + (a.depth || 0) + (a.nps ? '<br>' + (a.nps / 1e6).toFixed(1) + ' Mnps' : '<br>stockfish 18');
      var wb = this.el.querySelector('[data-winbar]');
      if (wb) {
        var whiteWin = turn === 'w' ? (a.winPct || 50) : 100 - (a.winPct || 50);
        wb.style.width = whiteWin.toFixed(1) + '%';
      }
    }
    var pillEval = this.el.querySelector('[data-pill-eval]');
    if (pillEval) pillEval.textContent = U.fmtEval(sc);
  };

  Panel.prototype.refreshStats = function () {
    var gs = this.ctx.gs;
    var g = this.el.querySelector('[data-graph]');
    if (g) g.innerHTML = this.graphSVG();
    var me = this.el.querySelector('[data-acc-me]');
    var meN = this.el.querySelector('[data-acc-me-n]');
    var opp = this.el.querySelector('[data-acc-opp]');
    var oppN = this.el.querySelector('[data-acc-opp-n]');
    if (me) {
      var myColor = gs.myColor;
      var accMe = myColor ? gs.accuracy(myColor) : null;
      var accOpp = myColor ? gs.accuracy(myColor === 'w' ? 'b' : 'w') : null;
      me.style.width = accMe != null ? accMe.toFixed(1) + '%' : '0%';
      meN.textContent = accMe != null ? accMe.toFixed(1) + '%' : '—';
      opp.style.width = accOpp != null ? accOpp.toFixed(1) + '%' : '0%';
      oppN.textContent = accOpp != null ? accOpp.toFixed(1) + '%' : '—';
    }
    this.refreshLog();
  };

  Panel.prototype.refreshLog = function () {
    var logEl = this.el.querySelector('[data-log]');
    if (!logEl) return;
    var gs = this.ctx.gs;
    var html = '';
    for (var i = 0; i < gs.moves.length; i++) {
      var m = gs.moves[i];
      var badge = m.classification && BADGE_STYLE[m.classification];
      var ev = m.evalAfter != null ? Math.round(m.evalAfter) + '%' : '';
      var color = m.color === 'w' ? '#e2e8f0' : '#94a3b8';
      html += `<div class="log-row" data-i="${i}">
        <span class="no">${m.color === 'w' ? Math.ceil((i + 1) / 2) + '.' : '…'}</span>
        <span class="san" style="color:${color}">${m.san}</span>
        ${badge ? `<span class="badge-chip" style="background:${badge.c}">${badge.t}</span>` : ''}
        <span class="ev">${ev}</span>
      </div>`;
    }
    logEl.innerHTML = html || '<div class="log-row" style="opacity:.5">no moves yet</div>';
    var self = this;
    logEl.querySelectorAll('.log-row[data-i]').forEach(function (r) {
      r.addEventListener('click', function () {
        var idx = +r.getAttribute('data-i');
        var mv = gs.moves[idx];
        if (mv) self.ctx.overlays.showHint(mv.uci, 1800);
      });
    });
    logEl.scrollTop = logEl.scrollHeight;
  };

  Panel.prototype.graphSVG = function () {
    var gs = this.ctx.gs;
    var pts = [];
    for (var i = 0; i < gs.moves.length; i++) {
      var m = gs.moves[i];
      if (m.evalAfter == null) continue;
      pts.push(m.color === 'w' ? m.evalAfter : 100 - m.evalAfter);
    }
    if (pts.length < 2) return '<svg viewBox="0 0 300 74"><line x1="0" y1="37" x2="300" y2="37" stroke="rgba(124,92,255,.4)" stroke-dasharray="4 4"/><text x="150" y="42" text-anchor="middle" font-size="10" fill="rgba(255,255,255,.35)" font-family="Segoe UI">eval graph appears as moves are played</text></svg>';
    var n = pts.length;
    var path = '';
    var area = 'M0,74 ';
    for (var p = 0; p < n; p++) {
      var x = (p / (n - 1)) * 300;
      var y = 74 - (pts[p] / 100) * 74;
      path += (p === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      area += 'L' + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    }
    area += 'L300,74 Z';
    return `<svg viewBox="0 0 300 74" preserveAspectRatio="none">
      <line x1="0" y1="37" x2="300" y2="37" stroke="rgba(124,92,255,.4)" stroke-dasharray="4 4"/>
      <path d="${area}" fill="rgba(226,232,240,.18)"/>
      <path d="${path}" fill="none" stroke="#a5b4fc" stroke-width="1.6" stroke-linejoin="round"/>
    </svg>`;
  };

  /* alerts + sounds + toast */
  Panel.prototype.maybeAlert = function (d) {
    var s = this.settings.data;
    var m = d.move;
    if (!s.coach.alerts || !m.classification) return;
    if (m.classification !== 'blunder' && m.classification !== 'mistake') return;
    if (this.ctx.gs.myColor && m.color !== this.ctx.gs.myColor) return; // only my moves
    var box = this.el.querySelector('[data-alert-box]');
    if (box) {
      box.innerHTML = `<div class="alert ${m.classification === 'blunder' ? '' : 'warn'}">
        <span>${m.classification === 'blunder' ? 'Blunder' : 'Mistake'}: ${m.san} ${BADGE_STYLE[m.classification].t}</span></div>`;
      var self = this;
      setTimeout(function () { if (box.firstChild) box.innerHTML = ''; }, 5000);
    }
    if (s.coach.sound) this.beep(m.classification === 'blunder');
  };

  Panel.prototype.beep = function (bad) {
    try {
      var ctx = this._actx || (this._actx = new (window.AudioContext || window.webkitAudioContext)());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.frequency.value = bad ? 220 : 440;
      o.type = 'sine';
      g.gain.value = 0.08;
      o.connect(g).connect(ctx.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      o.stop(ctx.currentTime + 0.36);
    } catch (e) {}
  };

  Panel.prototype.toast = function (msg, kind) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:26px;right:26px;z-index:2147483647;padding:10px 16px;border-radius:12px;font:600 12.5px "Segoe UI",system-ui,sans-serif;color:#fff;background:' + (kind === 'err' ? 'rgba(239,68,68,.92)' : kind === 'warn' ? 'rgba(245,158,11,.92)' : 'rgba(34,197,94,.92)') + ';box-shadow:0 10px 30px rgba(0,0,0,.4);transition:opacity .3s;';
    t.textContent = msg;
    (this.shadow.host.ownerDocument.body || document.body).appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 350); }, 2400);
  };

  /* ---------------- drag ---------------- */
  Panel.prototype.makeDraggable = function (handle, target) {
    var self = this;
    handle.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.icon-btn')) return;
      var r = target.getBoundingClientRect();
      target.style.left = r.left + 'px';
      target.style.top = r.top + 'px';
      target.style.right = 'auto';
      target.style.bottom = 'auto';
      self.drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      handle.setPointerCapture && handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!self.drag) return;
      var x = Math.max(4, Math.min(window.innerWidth - 60, e.clientX - self.drag.dx));
      var y = Math.max(4, Math.min(window.innerHeight - 40, e.clientY - self.drag.dy));
      target.style.left = x + 'px';
      target.style.top = y + 'px';
    });
    handle.addEventListener('pointerup', function (e) {
      if (!self.drag) return;
      self.drag = null;
      var r = target.getBoundingClientRect();
      self.settings.set('panel.pos', { x: Math.round(r.left), y: Math.round(r.top) });
    });
  };

  Panel.prototype.restorePos = function () {
    var pos = this.settings.get('panel.pos');
    if (pos && this.el.classList.contains('panel')) {
      this.el.style.left = pos.x + 'px';
      this.el.style.top = pos.y + 'px';
      this.el.style.right = 'auto';
      this.el.style.bottom = 'auto';
    }
  };

  Panel.prototype.applyTheme = function () {
    var light = this.settings.get('panel.theme') === 'light';
    if (this.el.classList.contains('panel') || this.el.classList.contains('pill')) {
      this.el.classList.toggle('light', light);
    }
  };

  O.Panel = Panel;
})(typeof window !== 'undefined' ? window : globalThis);
