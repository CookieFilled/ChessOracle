/* ChessOracle — action popup: quick autoplay control + live status */
'use strict';

(async function () {
  const sub = document.getElementById('subtitle');
  const dot = document.getElementById('dot');
  const autoOn = document.getElementById('autoOn');
  const apOn = document.getElementById('apOn');
  const apModeRow = document.getElementById('apModeRow');
  const apStatus = document.getElementById('apStatus');
  const elo = document.getElementById('elo');
  const eloVal = document.getElementById('eloVal');
  const statusTxt = document.getElementById('statusTxt');
  const openPanel = document.getElementById('openPanel');
  const liveBody = document.getElementById('liveBody');

  // settings lib is loaded before this script
  const store = window.ChessOracleSettings;
  await store.load();

  // find active tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  let contentReady = false;

  function queryStatus() {
    if (!tab) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tab.id, { type: 'co:status-query' }, (res) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }

  function paintElo() {
    eloVal.textContent = elo.value;
    const pct = ((elo.value - 400) / 2500) * 100;
    elo.style.setProperty('--fill', pct + '%');
  }

  elo.addEventListener('input', paintElo);
  elo.addEventListener('change', () => { store.set('autoplay.elo', +elo.value); });

  function paintApMode() {
    const mode = store.get('autopilot.mode') || 'mixed';
    for (const btn of apModeRow.querySelectorAll('button')) {
      btn.classList.toggle('on', btn.dataset.v === mode);
    }
  }
  apModeRow.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    store.set('autopilot.mode', btn.dataset.v);
    paintApMode();
    // push to the page immediately if a session is running
    if (tab && apOn.checked) {
      try { chrome.tabs.sendMessage(tab.id, { type: 'co:autopilot-set', on: true, mode: btn.dataset.v }, () => {}); } catch (err) {}
    }
  });
  paintApMode();

  apOn.addEventListener('change', async () => {
    store.set('autopilot.on', apOn.checked);
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'co:autopilot-set', on: apOn.checked, mode: store.get('autopilot.mode') });
      } catch (e) {}
    }
    refresh();
  });

  autoOn.addEventListener('change', async () => {
    store.set('autoplay.on', autoOn.checked);
    // tell the page content script to start/stop
    if (tab) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'co:autoplay-set', on: autoOn.checked });
      } catch (e) {}
    }
    refresh();
  });

  openPanel.addEventListener('click', async () => {
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'co:panel-toggle' });
      window.close();
    } catch (e) {
      sub.textContent = 'open a chess.com or lichess.org game tab';
    }
  });

  // initial UI from settings
  elo.value = store.get('autoplay.elo');
  paintElo();

  async function refresh() {
    const st = await queryStatus();
    contentReady = !!(st && st.ok);
    if (!contentReady) {
      sub.textContent = 'no chess page detected';
      dot.className = 'dot';
      autoOn.disabled = true;
      apOn.disabled = true;
      apModeRow.classList.add('disabled');
      openPanel.disabled = true;
      liveBody.innerHTML = '<div class="nogame">Open a game on chess.com or lichess.org, then click this icon again.</div>';
      statusTxt.textContent = '—';
      apStatus.textContent = '—';
      return;
    }
    autoOn.disabled = false;
    apOn.disabled = st.site !== 'chesscom';
    apModeRow.classList.toggle('disabled', st.site !== 'chesscom');
    openPanel.disabled = false;
    apOn.checked = !!(st.autopilot && st.autopilot.on);
    paintApMode();
    const ap = st.autopilot;
    if (st.site !== 'chesscom') {
      apStatus.textContent = 'autopilot is chess.com-only';
    } else if (ap && ap.on) {
      const s = ap.session || {};
      const rec = s.games ? ` · ${s.games} games: ${s.wins}W/${s.losses}L/${s.draws}D` : '';
      const plan = ap.plan ? ` · plan: ${ap.plan === 'win' ? 'WIN' : 'LOSE'}` : '';
      apStatus.textContent = `${ap.phase}${ap.detail ? ' · ' + ap.detail : ''}${plan}${rec}`;
    } else if (ap && ap.session && ap.session.games) {
      const s = ap.session;
      apStatus.textContent = `idle · session ${s.games} games: ${s.wins}W/${s.losses}L/${s.draws}D`;
    } else {
      apStatus.textContent = 'idle — mixed win/lose by default';
    }
    sub.textContent = st.site === 'lichess' ? 'lichess.org · active' : 'chess.com · active';
    dot.className = 'dot ' + (st.engineReady ? 'ok' : 'err');
    autoOn.checked = st.autoplay.on;
    elo.value = st.autoplay.elo;
    paintElo();
    statusTxt.textContent = st.autoplay.on || (st.autopilot && st.autopilot.on)
      ? `${st.autoplay.state}${st.autoplay.detail ? ' · ' + st.autoplay.detail : ''}`
      : (st.game.over ? 'game over' : `${st.game.moves} moves tracked${st.game.myTurn ? ' · your turn' : ''}`);

    let html = '';
    if (st.game.top && st.game.top.length) {
      html = st.game.top.map((l, i) =>
        `<div class="line"><span class="m">${i === 0 ? '★ ' : ''}${l.uci.slice(0, 4)}${l.uci.length > 4 ? l.uci[4] : ''}</span><span class="e">${l.eval}</span></div>`
      ).join('');
      if (st.game.lastEval) html += `<div class="line" style="opacity:.6"><span class="m">eval</span><span class="e">${st.game.lastEval} · ${st.game.moves} moves</span></div>`;
    } else {
      html = '<div class="nogame">waiting for a position…</div>';
    }
    liveBody.innerHTML = html;
  }

  await refresh();
  const iv = setInterval(refresh, 1200);
  window.addEventListener('unload', () => clearInterval(iv));
})();
