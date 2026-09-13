/* ChessOracle — background service worker (MV3)
 * Responsibilities:
 *   - default settings on install
 *   - offscreen document lifecycle (engine host)
 *   - relay streaming engine info from offscreen -> chess tabs
 *   - action badge reflecting autoplay state
 * Engine requests are sent DIRECTLY from content scripts to the offscreen
 * document (chrome.runtime.sendMessage reaches all extension contexts); the
 * offscreen answers via the async sendResponse channel. The SW deliberately
 * does not respond to engine:* messages from content so it cannot close the
 * response channel early.
 */
'use strict';

const MSG = {
  ENSURE_OFFSCREEN: 'co:ensure-offscreen',
  ENGINE_ANALYZE: 'co:engine:analyze',
  ENGINE_STOP: 'co:engine:stop',
  ENGINE_RESET: 'co:engine:reset',
  ENGINE_STATUS: 'co:engine:status',
  ENGINE_INFO: 'co:engine:info',
  AUTOPLAY_STATE: 'co:autoplay-state',
};
const OFFSCREEN_URL = 'offscreen/offscreen.html';

async function hasOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return contexts && contexts.length > 0;
    }
  } catch (e) { /* older chrome */ }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  const reasons = ['WORKERS', 'BLOBS', 'DOM_SCRAPING'];
  for (const reason of reasons) {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [reason],
        justification: 'Host the Stockfish WASM chess engine in a Web Worker for local move analysis. No network access is required.',
      });
      return true;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg.includes('Only a single offscreen')) return true; // already created
      console.warn('[ChessOracle:SW] offscreen create failed with reason', reason, msg);
    }
  }
  return false;
}

function isChessTab(t) {
  return /lichess\.org|chess\.com/.test(t.url || '');
}

/* ---------------- install ---------------- */
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const res = await chrome.storage.local.get(['settings']);
    if (!res || !res.settings) {
      chrome.storage.local.set({ settings: null }); // content/offscreen will persist defaults on demand
    }
  } catch (e) {}
  ensureOffscreen();
});

/* ---------------- message router ---------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  // --- any context: ensure the engine host exists
  if (msg.type === MSG.ENSURE_OFFSCREEN) {
    ensureOffscreen().then((ok) => sendResponse({ ok, error: ok ? null : 'offscreen-unavailable' }));
    return true;
  }

  // --- offscreen -> SW -> tabs: streaming engine info (fire and forget)
  if (msg.type === MSG.ENGINE_INFO) {
    if (msg.fromTab != null) {
      chrome.tabs.sendMessage(msg.fromTab, msg).catch(() => {});
    } else {
      chrome.tabs.query({}).then((tabs) => {
        for (const t of tabs) {
          if (isChessTab(t)) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
        }
      }).catch(() => {});
    }
    return; // do not respond
  }

  // --- offscreen -> SW: engine status broadcasts
  if (msg.type === MSG.ENGINE_STATUS && msg.broadcast) {
    chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) {
        if (isChessTab(t)) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
      }
    }).catch(() => {});
    return;
  }

  // --- engine:* requests from content scripts: handled DIRECTLY by the
  //     offscreen document. Return false here so this context does not hold
  //     or close the response channel — the offscreen is the sole responder.
  if (msg.type === MSG.ENGINE_ANALYZE || msg.type === MSG.ENGINE_STOP ||
      msg.type === MSG.ENGINE_RESET || msg.type === MSG.ENGINE_STATUS) {
    // ensure the engine host exists (content usually does this itself first)
    ensureOffscreen();
    return false;
  }

  // --- content -> SW: badge state
  if (msg.type === MSG.AUTOPLAY_STATE) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    try {
      if (msg.on) {
        chrome.action.setBadgeText({ text: 'AUTO', tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#7c5cff', tabId });
      } else {
        chrome.action.setBadgeText({ text: '', tabId });
      }
    } catch (e) {}
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
