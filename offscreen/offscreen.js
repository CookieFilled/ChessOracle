/* ChessOracle — offscreen document: Stockfish engine host.
 * Owns a Web Worker running stockfish-18-lite-single (WASM, embedded small net).
 * Speaks UCI over worker postMessage. Answers analysis requests DIRECTLY via
 * the chrome.runtime message channel (async sendResponse). Streams progress
 * info for overlays through the service worker.
 */
'use strict';

const ENGINE_JS = chrome.runtime.getURL('engine/stockfish-18-lite-single.js');
const MSG = {
  ENGINE_ANALYZE: 'co:engine:analyze',
  ENGINE_STOP: 'co:engine:stop',
  ENGINE_RESET: 'co:engine:reset',
  ENGINE_STATUS: 'co:engine:status',
  ENGINE_INFO: 'co:engine:info',
};

/* ---------------- UCI parsing ---------------- */
const RE = {
  depth: /\bdepth (\d+)\b/,
  multipv: /\bmultipv (\d+)\b/,
  cp: /\bscore cp (-?\d+)\b/,
  mate: /\bscore mate (-?\d+)\b/,
  pv: /\bpv (.+)$/,
  nodes: /\bnodes (\d+)\b/,
  nps: /\bnps (\d+)\b/,
  time: /\btime (\d+)\b/,
};

function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ')) return null;
  if (line.includes(' lowerbound') || line.includes(' upperbound')) return null;
  let m;
  const o = {};
  if ((m = line.match(RE.depth))) o.depth = +m[1];
  if ((m = line.match(RE.multipv))) o.multipv = +m[1];
  if ((m = line.match(RE.mate))) o.score = { mate: +m[1] };
  else if ((m = line.match(RE.cp))) o.score = { cp: +m[1] };
  if ((m = line.match(RE.pv))) o.pv = m[1].trim().split(' ');
  if ((m = line.match(RE.nodes))) o.nodes = +m[1];
  if ((m = line.match(RE.nps))) o.nps = +m[1];
  if ((m = line.match(RE.time))) o.timeMs = +m[1];
  return o.pv ? o : null;
}

/* ---------------- Engine worker wrapper ---------------- */
class EngineHost {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.booting = false;
    this.dead = false;
    this.queue = [];
    this.current = null;
    this.lastLines = new Map(); // multipv idx -> info object
    this.currentMeta = null;
    this.watchdog = null;
    this.bootTimeout = null;
    this._t0 = 0;
  }

  boot() {
    if (this.worker && (this.ready || this.booting)) return;
    this.booting = true;
    this.dead = false;
    this.ready = false;
    this._t0 = Date.now();
    const w = new Worker(ENGINE_JS);
    this.worker = w;
    w.addEventListener('message', (e) => this.onMessage(e));
    w.addEventListener('error', (e) => {
      console.error('[ChessOracle:engine] worker error', e.message || e);
      this.dead = true;
      this.booting = false;
      this.failCurrent('engine-crash');
      this.broadcastStatus();
    });
    w.postMessage('setoption name CanOutputEngineDownloadProgress');
    w.postMessage('uci');
    w.postMessage('isready');
    this.bootTimeout = setTimeout(() => {
      if (!this.ready) {
        console.error('[ChessOracle:engine] boot timeout');
        this.dead = true;
        this.booting = false;
        this.failCurrent('engine-boot-timeout');
        // fail everything queued as well
        for (const q of this.queue.splice(0)) {
          if (q.respond) { try { q.respond({ ok: false, error: 'engine-boot-timeout' }); } catch (e) {} }
        }
        this.broadcastStatus();
      }
    }, 30000);
  }

  onMessage(e) {
    let text = e.data;
    if (text && typeof text === 'object') text = text.line || text.data || JSON.stringify(text);
    if (typeof text !== 'string') return;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.includes('uciok')) {
        this.applyOptions({ MultiPV: 4, Threads: 1, Hash: 24 });
        continue;
      }
      if (line.includes('readyok')) {
        if (!this.ready) {
          this.ready = true;
          this.booting = false;
          clearTimeout(this.bootTimeout);
          console.log('[ChessOracle:engine] ready in', Date.now() - this._t0, 'ms');
          this.broadcastStatus();
          this.pump();
        }
        continue;
      }
      if (line.startsWith('info ')) {
        const info = parseInfo(line);
        if (info && this.current) this.onInfo(info);
        continue;
      }
      if (line.startsWith('bestmove')) {
        this.onBestMove(line);
        continue;
      }
    }
  }

  applyOptions(opts) {
    for (const [k, v] of Object.entries(opts)) {
      this.worker.postMessage(`setoption name ${k} value ${v}`);
    }
    this.worker.postMessage('isready');
  }

  /* -------- request lifecycle -------- */
  analyze(req) {
    this.seq = (this.seq || 0) + 1;
    const item = {
      id: this.seq,
      fen: req.fen,
      moves: req.moves || null,
      depth: Math.max(1, Math.min(30, req.depth || 12)),
      movetime: Math.max(40, Math.min(8000, req.movetime || 800)),
      multipv: Math.max(1, Math.min(6, req.multipv || 4)),
      skill: Math.max(0, Math.min(20, req.skill != null ? req.skill : 20)),
      fromTab: req.fromTab,
      reqId: req.reqId,
      respond: req.respond || null, // sendResponse channel
      issuedAt: Date.now(),
    };
    this.queue.push(item);
    this.pump();
    return item;
  }

  pump() {
    if (this.current || !this.queue.length) return;
    if (!this.worker || this.dead) { this.boot(); return; }
    if (!this.ready) { if (!this.booting) this.boot(); return; }
    const item = this.queue.shift();
    this.current = item;
    this.lastLines = new Map();
    this.currentMeta = { depth: 0, nodes: 0, nps: 0, timeMs: 0 };
    this.worker.postMessage(`setoption name Skill Level value ${item.skill}`);
    this.worker.postMessage(`setoption name MultiPV value ${item.multipv}`);
    if (item.moves && item.moves.length) {
      this.worker.postMessage('position startpos moves ' + item.moves.join(' '));
    } else {
      this.worker.postMessage('position fen ' + item.fen);
    }
    this.worker.postMessage(`go depth ${item.depth} movetime ${item.movetime}`);
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.current === item) {
        console.warn('[ChessOracle:engine] watchdog stop');
        try { this.worker.postMessage('stop'); } catch (e) {}
      }
    }, item.movetime + 8000);
  }

  onInfo(info) {
    const idx = info.multipv || 1;
    this.lastLines.set(idx, {
      uci: info.pv && info.pv[0],
      pv: info.pv || [],
      score: info.score || null,
      depth: info.depth || 0,
    });
    if (info.nodes) this.currentMeta.nodes = info.nodes;
    if (info.nps) this.currentMeta.nps = info.nps;
    if (info.timeMs) this.currentMeta.timeMs = info.timeMs;
    if (info.depth) this.currentMeta.depth = Math.max(this.currentMeta.depth, info.depth);
    this.streamThrottled();
  }

  streamThrottled = (() => {
    let last = 0;
    return () => {
      const now = Date.now();
      if (now - last < 140) return;
      last = now;
      this.stream();
    };
  })();

  stream() {
    if (!this.current) return;
    const lines = [...this.lastLines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    chrome.runtime.sendMessage({
      type: MSG.ENGINE_INFO,
      fromTab: this.current.fromTab,
      reqId: this.current.reqId,
      depth: this.currentMeta.depth,
      nodes: this.currentMeta.nodes,
      nps: this.currentMeta.nps,
      lines,
    }).catch(() => {});
  }

  onBestMove(line) {
    clearTimeout(this.watchdog);
    const item = this.current;
    if (!item) return;
    this.current = null;
    const bestmove = (line.split(' ')[1] || '').trim();
    const lines = [...this.lastLines.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v)
      .filter((v) => v.uci);
    if (bestmove && (!lines.length || lines[0].uci !== bestmove)) {
      lines.unshift({ uci: bestmove, pv: [bestmove], score: lines[0] ? lines[0].score : null, depth: this.currentMeta.depth });
    }
    const result = {
      ok: true,
      bestmove,
      lines,
      depth: this.currentMeta.depth,
      nodes: this.currentMeta.nodes,
      nps: this.currentMeta.nps,
      timeMs: Date.now() - item.issuedAt,
    };
    if (item.respond) { try { item.respond(result); } catch (e) {} }
    setTimeout(() => this.pump(), 30);
  }

  stop() {
    if (this.worker && this.current) this.worker.postMessage('stop');
  }

  reset() {
    if (this.worker && this.ready) {
      this.worker.postMessage('stop');
      this.worker.postMessage('ucinewgame');
      this.worker.postMessage('isready');
    }
  }

  failCurrent(err) {
    const item = this.current;
    this.current = null;
    clearTimeout(this.watchdog);
    if (item && item.respond) {
      try { item.respond({ ok: false, error: err }); } catch (e) {}
    }
    setTimeout(() => this.pump(), 250);
  }

  restart() {
    if (this.worker) { try { this.worker.terminate(); } catch (e) {} }
    this.worker = null;
    this.ready = false;
    this.current = null;
    this.lastLines = new Map();
    clearTimeout(this.watchdog);
    this.boot();
  }

  status() {
    return {
      booted: !!this.worker,
      ready: this.ready,
      dead: this.dead,
      queued: this.queue.length,
      current: this.current ? { fen: this.current.fen, depth: this.current.depth } : null,
    };
  }

  broadcastStatus() {
    chrome.runtime.sendMessage({
      type: MSG.ENGINE_STATUS,
      broadcast: true,
      status: this.status(),
    }).catch(() => {});
  }
}

/* ---------------- wiring ---------------- */
const host = new EngineHost();
host.boot();

// health heartbeat: detect silently-dead worker (e.g. after browser sleep)
setInterval(() => {
  if (host.worker && host.ready && !host.current) {
    try { host.worker.postMessage('isready'); } catch (e) { host.restart(); }
  }
}, 15000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === MSG.ENGINE_ANALYZE) {
    if (!host.worker || host.dead || (!host.ready && !host.booting)) host.boot();
    const item = host.analyze(Object.assign({}, msg, { respond: sendResponse }));
    // keep the response channel open until the engine finishes
    void item;
    return true;
  }

  if (msg.type === MSG.ENGINE_STOP) {
    host.stop();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === MSG.ENGINE_RESET) {
    host.reset();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === MSG.ENGINE_STATUS) {
    if (msg.wantBroadcast) host.broadcastStatus();
    sendResponse({ ok: true, status: host.status() });
    return;
  }
});
