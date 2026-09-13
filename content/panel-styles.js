/* ChessOracle — panel CSS (injected as adopted stylesheet in closed shadow root) */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  O.PANEL_CSS = `
:host { all: initial; }

* { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
  position: fixed; bottom: 18px; left: 18px; width: 356px;
  max-height: calc(100vh - 36px);
  overflow-y: auto; overflow-x: hidden;
  z-index: 2147483646;
  font-family: 'Segoe UI', -apple-system, system-ui, Roboto, 'Inter', sans-serif;
  font-size: 13px; line-height: 1.45;
  color: #e6e9f0;
  border-radius: 16px;
  box-shadow: 0 18px 56px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.07);
  transition: box-shadow .2s;
  scrollbar-width: thin;
}
.panel.light { color: #1c2230; box-shadow: 0 18px 56px rgba(30,40,80,.25), 0 0 0 1px rgba(0,0,0,.10); }

.p-head {
  display: flex; align-items: center; gap: 9px;
  padding: 10px 12px 10px 14px;
  background: linear-gradient(120deg, rgba(124,92,255,.28), rgba(34,211,238,.16));
  cursor: move; user-select: none;
}
.theme .p-head { background: linear-gradient(120deg, rgba(124,92,255,.16), rgba(34,211,238,.10)); }
.light .p-head { background: linear-gradient(120deg, rgba(99,102,241,.14), rgba(14,165,233,.10)); }

.logo { width: 26px; height: 26px; border-radius: 8px; flex: 0 0 auto;
  background: linear-gradient(135deg, #7c5cff, #22d3ee);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 3px 10px rgba(124,92,255,.45); }
.logo svg { width: 17px; height: 17px; }

.title { font-weight: 700; font-size: 13.5px; letter-spacing: .2px; flex: 1; min-width: 0; }
.title .sub { display: block; font-weight: 500; font-size: 10.5px; opacity: .72; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.site-pill { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px;
  background: rgba(34,197,94,.18); color: #4ade80; white-space: nowrap; }
.site-pill.err { background: rgba(239,68,68,.18); color: #f87171; }

.dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; flex: 0 0 auto; }
.dot.ok { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,.7); }
.dot.think { background: #22d3ee; animation: blink 1s infinite; }
.dot.err { background: #ef4444; }
@keyframes blink { 50% { opacity: .35; } }

.icon-btn { width: 26px; height: 26px; border-radius: 8px; border: 0; cursor: pointer;
  background: rgba(255,255,255,.08); color: inherit; display: flex; align-items: center; justify-content: center;
  transition: background .15s; flex: 0 0 auto; }
.icon-btn:hover { background: rgba(255,255,255,.16); }
.light .icon-btn { background: rgba(0,0,0,.07); }
.light .icon-btn:hover { background: rgba(0,0,0,.14); }
.icon-btn svg { width: 13px; height: 13px; }

.body { background: rgba(13,16,24,.94); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }
.light .body { background: rgba(248,250,252,.96); }

.tabs { display: flex; gap: 3px; padding: 9px 8px 0 8px; }
.tab { flex: 1; text-align: center; padding: 6px 2px; font-size: 10.6px; font-weight: 600;
  border-radius: 8px 8px 0 0; cursor: pointer; opacity: .6; border: 0; background: none; color: inherit;
  border-bottom: 2px solid transparent; transition: all .15s; }
.tab:hover { opacity: .9; }
.tab.on { opacity: 1; border-bottom-color: #7c5cff; background: rgba(124,92,255,.12); }

.tab-body { padding: 10px 12px 12px 12px; max-height: min(62vh, 560px); overflow-y: auto; }
.tab-body::-webkit-scrollbar { width: 8px; }
.tab-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 4px; }
.light .tab-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,.18); }

.section { margin: 10px 0 4px 0; }
.section:first-child { margin-top: 2px; }
.sec-title { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .8px;
  opacity: .55; margin: 12px 2px 6px 2px; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 2px; }
.row .lab { flex: 1; min-width: 0; font-size: 12px; }
.row .lab .hint { display: block; font-size: 10px; opacity: .5; }

/* toggles */
.switch { position: relative; width: 38px; height: 21px; flex: 0 0 auto; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch .tr { position: absolute; inset: 0; border-radius: 20px; background: rgba(255,255,255,.14); transition: .18s; cursor: pointer; }
.switch .tr::after { content: ''; position: absolute; width: 17px; height: 17px; border-radius: 50%; top: 2px; left: 2px;
  background: #fff; transition: .18s; box-shadow: 0 1px 4px rgba(0,0,0,.4); }
.switch input:checked + .tr { background: linear-gradient(90deg, #7c5cff, #22d3ee); }
.switch input:checked + .tr::after { left: 19px; }
.light .switch .tr { background: rgba(0,0,0,.16); }

/* big toggle */
.big-toggle { display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 12px;
  background: linear-gradient(120deg, rgba(124,92,255,.14), rgba(34,211,238,.08));
  border: 1px solid rgba(124,92,255,.35); margin-bottom: 4px; }
.big-toggle .switch { width: 46px; height: 25px; }
.big-toggle .switch .tr::after { width: 21px; height: 21px; }
.big-toggle .switch input:checked + .tr::after { left: 23px; }
.big-toggle .txt { flex: 1; font-weight: 700; font-size: 13px; }
.big-toggle .txt .sub { font-weight: 500; font-size: 10.5px; opacity: .6; }

/* sliders */
.srow { padding: 4px 2px 6px 2px; }
.srow .stop { display: flex; justify-content: space-between; align-items: baseline; }
.srow .lab { font-size: 12px; }
.srow .val { font-size: 11.5px; font-weight: 700; color: #a5b4fc; }
.light .srow .val { color: #6366f1; }
input[type=range] { width: 100%; height: 4px; -webkit-appearance: none; appearance: none; margin: 7px 0 2px 0;
  background: linear-gradient(90deg, #7c5cff var(--fill,50%), rgba(255,255,255,.15) var(--fill,50%));
  border-radius: 2px; outline: none; cursor: pointer; }
.light input[type=range] { background: linear-gradient(90deg, #6366f1 var(--fill,50%), rgba(0,0,0,.14) var(--fill,50%)); }
input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; border: 2px solid #7c5cff; box-shadow: 0 1px 6px rgba(0,0,0,.45); cursor: grab; }

/* segmented */
.seg { display: inline-flex; background: rgba(255,255,255,.08); border-radius: 8px; padding: 2px; gap: 2px; flex: 0 0 auto; }
.light .seg { background: rgba(0,0,0,.07); }
.seg button { border: 0; background: none; color: inherit; font-size: 11px; font-weight: 600;
  padding: 4px 9px; border-radius: 6px; cursor: pointer; opacity: .65; }
.seg button.on { background: rgba(124,92,255,.75); color: #fff; opacity: 1; }

.chips { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
.chip { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 6px; cursor: pointer;
  background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.09); transition: all .12s; }
.chip:hover, .chip.on { background: rgba(124,92,255,.4); border-color: rgba(124,92,255,.6); }
.light .chip { background: rgba(0,0,0,.06); border-color: rgba(0,0,0,.08); }

/* detected playing-color note */
.color-note { font-size: 10.5px; font-weight: 600; opacity: .62; padding: 5px 2px 2px 2px;
  letter-spacing: .2px; }
.color-note::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  margin-right: 5px; background: #7c5cff; vertical-align: 1px; }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  border: 0; border-radius: 10px; padding: 8px 12px; font-size: 12px; font-weight: 700; cursor: pointer;
  color: #fff; background: linear-gradient(120deg, #7c5cff, #6d28d9);
  box-shadow: 0 4px 14px rgba(124,92,255,.35); transition: transform .1s, box-shadow .15s; width: 100%; }
.btn:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(124,92,255,.5); }
.btn.ghost { background: rgba(255,255,255,.09); box-shadow: none; }
.light .btn.ghost { background: rgba(0,0,0,.08); }
.btn.warn { background: linear-gradient(120deg, #f59e0b, #d97706); }
.btn.small { width: auto; padding: 5px 10px; font-size: 11px; }

/* status line */
.status-line { display: flex; align-items: center; gap: 7px; padding: 7px 10px; margin: 0 0 6px 0;
  border-radius: 10px; background: rgba(124,92,255,.12); font-size: 11.5px; min-height: 32px; }
.status-line.warn { background: rgba(245,158,11,.14); }
.status-line.err { background: rgba(239,68,68,.14); }
.status-line.ok { background: rgba(34,197,94,.14); }
.status-line .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* eval display */
.eval-box { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px;
  background: rgba(255,255,255,.05); }
.light .eval-box { background: rgba(0,0,0,.05); }
.eval-num { font-size: 21px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: -.5px;
  background: linear-gradient(120deg, #f8fafc, #a5b4fc); -webkit-background-clip: text; background-clip: text; color: #818cf8; }
.eval-num.black-adv { color: #f87171; background: none; }
.eval-meta { font-size: 10.5px; opacity: .6; line-height: 1.5; }
.winbar { height: 6px; border-radius: 3px; overflow: hidden; background: #0b0e14; margin: 7px 10px 2px 10px; position: relative; }
.light .winbar { background: #cbd5e1; }
.winbar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: linear-gradient(90deg, #e2e8f0, #f8fafc); transition: width .5s; border-radius: 3px; }

/* accuracy bars */
.acc-row { display: flex; align-items: center; gap: 8px; padding: 3px 2px; font-size: 11.5px; }
.acc-row .who { width: 58px; opacity: .75; }
.acc-row .bar { flex: 1; height: 7px; border-radius: 4px; background: rgba(255,255,255,.1); overflow: hidden; }
.light .acc-row .bar { background: rgba(0,0,0,.09); }
.acc-row .bar .fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #22c55e, #4ade80); transition: width .5s; }
.acc-row .bar .fill.opp { background: linear-gradient(90deg, #64748b, #94a3b8); }
.acc-row .num { width: 44px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }

/* graph */
.graph { margin: 6px 2px; height: 74px; border-radius: 10px; background: rgba(255,255,255,.04); overflow: hidden; }
.graph svg { width: 100%; height: 100%; display: block; }

/* move log */
.log { margin-top: 4px; border-radius: 10px; background: rgba(255,255,255,.04); max-height: 170px; overflow-y: auto; }
.light .log { background: rgba(0,0,0,.04); }
.log::-webkit-scrollbar { width: 7px; }
.log::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 4px; }
.log-row { display: flex; align-items: center; gap: 7px; padding: 3px 9px; font-size: 11.5px; cursor: pointer; }
.log-row:hover { background: rgba(124,92,255,.12); }
.log-row .no { width: 26px; opacity: .5; font-variant-numeric: tabular-nums; }
.log-row .san { font-weight: 700; width: 52px; }
.log-row .ev { flex: 1; text-align: right; opacity: .6; font-variant-numeric: tabular-nums; }
.badge-chip { font-size: 9.5px; font-weight: 800; padding: 1px 5px; border-radius: 4px; color: #0b0e14; }

/* hint/alert banner */
.alert { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 10px; margin: 8px 2px;
  background: rgba(239,68,68,.16); font-size: 11.5px; animation: slidein .25s ease; }
.alert.warn { background: rgba(245,158,11,.16); }
@keyframes slidein { from { transform: translateY(-6px); opacity: 0; } }

/* info footer */
.foot { padding: 7px 12px; font-size: 10px; opacity: .45; display: flex; justify-content: space-between; }
.foot a { color: inherit; text-decoration: underline; cursor: pointer; }

/* collapsed pill */
.pill { position: fixed; bottom: 18px; left: 18px; z-index: 2147483646;
  display: flex; align-items: center; gap: 7px; padding: 8px 12px; border-radius: 30px; cursor: pointer;
  font-family: 'Segoe UI', system-ui, sans-serif; font-size: 11.5px; font-weight: 700; color: #e6e9f0;
  background: rgba(13,16,24,.92); backdrop-filter: blur(10px);
  box-shadow: 0 8px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
.pill:hover { background: rgba(20,24,34,.95); }
.pill .eval { color: #a5b4fc; font-variant-numeric: tabular-nums; }
.pill svg { width: 13px; height: 13px; }

.kbd { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,.1);
  border: 1px solid rgba(255,255,255,.14); font-family: Consolas, monospace; }
.light .kbd { background: rgba(0,0,0,.06); border-color: rgba(0,0,0,.1); }
.about { font-size: 10.5px; opacity: .55; line-height: 1.6; }

/* autopilot tab */
.ap-stats { display: flex; gap: 6px; margin: 8px 0 2px 0; }
.ap-stats .cell { flex: 1; text-align: center; padding: 8px 4px 7px; border-radius: 10px;
  background: rgba(255,255,255,.05); }
.light .ap-stats .cell { background: rgba(0,0,0,.05); }
.ap-stats .cell .n { display: block; font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
.ap-stats .cell .l { display: block; font-size: 9px; text-transform: uppercase; letter-spacing: .6px; opacity: .55; margin-top: 2px; }
.ap-stats .cell.win .n { color: #4ade80; }
.ap-stats .cell.loss .n { color: #f87171; }
.ap-stats .cell.draw .n { color: #facc15; }
.ap-note { font-size: 10.5px; opacity: .62; line-height: 1.5; margin: 6px 2px; }
`;
})(typeof window !== 'undefined' ? window : globalThis);
