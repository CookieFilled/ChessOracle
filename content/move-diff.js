/* ChessOracle — move inference from position snapshots (chess.js powered).
 * Given a chess.js game synced to the previous position and two piece maps,
 * find the legal move whose board effect matches the diff exactly.
 * Handles: normal moves, captures, en passant, castling, promotions.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};

  function mapFromList(list) {
    var m = new Map();
    for (var i = 0; i < list.length; i++) m.set(list[i].square, list[i].piece);
    return m;
  }

  /* apply a chess.js verbose move to a board map, return the resulting map */
  function applyMoveToMap(map, mv) {
    var m = new Map(map);
    var mover = m.get(mv.from);
    if (!mover) return null;
    m.delete(mv.from);
    // en passant capture: remove pawn behind the target square
    if (mv.flags && mv.flags.indexOf('e') >= 0) {
      var epSq = mv.to[0] + mv.from[1];
      m.delete(epSq);
    }
    // castling: move the rook too
    if (mv.flags && (mv.flags.indexOf('k') >= 0 || mv.flags.indexOf('q') >= 0)) {
      var rank = mv.from[1];
      if (mv.flags.indexOf('k') >= 0) {
        m.delete('h' + rank);
        m.set('f' + rank, mover[0] + 'r');
      } else {
        m.delete('a' + rank);
        m.set('d' + rank, mover[0] + 'r');
      }
    }
    var placed = (mv.promotion ? mover[0] + mv.promotion : mover);
    m.set(mv.to, placed);
    return m;
  }

  function mapsEqual(a, b) {
    if (a.size !== b.size) return false;
    for (var [k, v] of a) {
      if (b.get(k) !== v) return false;
    }
    return true;
  }

  /**
   * Infer the move between two piece maps.
   * @param {Chess} chessInstance  chess.js synced to the PREVIOUS position
   * @param {Array}  prevList      previous piece list [{square, piece}]
   * @param {Array}  nextList      next piece list
   * @returns {object|null} chess.js verbose move object (already applied), or null
   */
  function inferMove(chessInstance, prevList, nextList) {
    if (chessInstance.game_over()) return null;
    var prev = mapFromList(prevList);
    var next = mapFromList(nextList);
    if (mapsEqual(prev, next)) return null;

    var legal;
    try { legal = chessInstance.moves({ verbose: true }); } catch (e) { return null; }
    if (!legal.length) return null;

    var matches = [];
    for (var i = 0; i < legal.length; i++) {
      var applied = applyMoveToMap(prev, legal[i]);
      if (applied && mapsEqual(applied, next)) matches.push(legal[i]);
    }
    if (matches.length !== 1) return null; // ambiguous (shouldn't happen on real boards)
    try {
      var mv = chessInstance.move({ from: matches[0].from, to: matches[0].to, promotion: matches[0].promotion });
      return mv || matches[0];
    } catch (e) {
      return matches[0];
    }
  }

  /* Build a FEN placement string from a piece list (board part only). */
  function placementFromList(list) {
    var m = mapFromList(list);
    var rows = [];
    for (var r = 8; r >= 1; r--) {
      var row = '', empty = 0;
      for (var f = 0; f < 8; f++) {
        var pc = m.get('abcdefgh'[f] + r);
        if (!pc) { empty++; continue; }
        if (empty) { row += empty; empty = 0; }
        row += pc[0] === 'w' ? pc[1].toUpperCase() : pc[1];
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join('/');
  }

  /* Piece LIST of the chess.js instance's OWN current board (the last
   * registered position) — same shape as the DOM readers produce.
   * Used to repair diffs whose DOM 'prev' consumed an unregistrable
   * intermediate state — the classic case: chess.com renders the pawn
   * sitting ON the promotion square while the piece picker is open.
   * 'pawn a7 -> pawn a8' matches no legal move, so the transition is skipped
   * and _prevPieces advances; the follow-up 'pawn a8 -> wq a8' (the actual
   * pick) matches nothing either and the promotion is lost. Re-running the
   * inference against the mirror's own board (pawn still on a7) matches
   * a7a8q exactly and the move registers. */
  function listFromBoard(chessInstance) {
    try {
      var out = [];
      var b = chessInstance.board();
      if (!Array.isArray(b)) return out;
      /* chess.js 0.10.x: 8 rows (rank 8 first), each 8 entries
       * {type, color} | null */
      for (var r = 0; r < b.length && r < 8; r++) {
        var row = b[r];
        if (!Array.isArray(row)) continue;
        for (var f = 0; f < row.length && f < 8; f++) {
          var pc = row[f];
          if (pc && pc.type) out.push({ square: 'abcdefgh'[f] + (8 - r), piece: (pc.color === 'w' ? 'w' : 'b') + pc.type });
        }
      }
      return out;
    } catch (e) { return []; }
  }

  O.moveDiff = {
    inferMove: inferMove,
    applyMoveToMap: applyMoveToMap,
    mapsEqual: mapsEqual,
    mapFromList: mapFromList,
    listFromBoard: listFromBoard,
    placementFromList: placementFromList,
  };
})(typeof window !== 'undefined' ? window : globalThis);
