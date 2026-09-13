/* ChessOracle — opening book (compact, main lines).
 * Stored as SAN lines; compiled at runtime into a position->moves map.
 * Weights are spread by the "variety" slider at selection time.
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};

  var LINES = [
    // --- open games
    { n: 'Italian Game', m: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O' },
    { n: 'Italian Game', m: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O a6' },
    { n: 'Italian: Giuoco Pianissimo', m: 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 a4 a6' },
    { n: 'Two Knights Defense', m: 'e4 e5 Nf3 Nc6 Bc4 Nf6 d3 Bc5 c3 O-O' },
    { n: 'Ruy Lopez: Berlin', m: 'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8' },
    { n: 'Ruy Lopez: Berlin, Rio Gambit', m: 'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 Re1 Nd6 Nxe5 Be7 d4 O-O' },
    { n: 'Ruy Lopez: Morphy', m: 'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3 Na5' },
    { n: 'Ruy Lopez: Exchange', m: 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6 d4 exd4 Nxd4 c5' },
    { n: 'Ruy Lopez: Schliemann', m: 'e4 e5 Nf3 Nc6 Bb5 f5 Nc3 fxe4 Nxe4 d5 Nxe5 dxe4 Nxc6 Qg5 d4' },
    { n: 'Scotch Game', m: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7 Qe2 Nd5 c4 Ba6' },
    { n: 'Scotch Game: Classical', m: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Bc5 Nb3 Bb6 Nc3 Nf6 Qe2 d6' },
    { n: 'Petroff Defense', m: 'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Be7 O-O O-O' },
    { n: 'Vienna Game', m: 'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7 Qe2 Ng5 d3 Nxf3+ gxf3' },
    { n: 'Pirc: Austrian', m: 'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7 Nf3 O-O Bd3 Nc6' },
    { n: 'Pirc: Classical', m: 'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O O-O Nc6' },
    { n: 'Modern Defense', m: 'e4 g6 d4 Bg7 Nc3 d6 f4 Nf6 Nf3 O-O' },
    { n: 'Alekhine Defense', m: 'e4 Nf6 e5 Nd5 d4 d6 Nf3 dxe5 Nxe5 c6 Bc4 Nb6 Bb3' },
    { n: 'Alekhine: Four Pawns', m: 'e4 Nf6 e5 Nd5 d4 d6 c4 Nb6 f4 dxe5 fxe5 Nc6 Nf3 Bf5' },
    { n: 'Center Game', m: 'e4 e5 d4 exd4 Qxd4 Nc6 Qe3 Nf6 Nc3 Bb4' },
    { n: 'King\'s Gambit', m: 'e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5' },
    { n: 'Evans Gambit', m: 'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4 d6' },
    { n: 'Danish Gambit', m: 'e4 e5 d4 exd4 c3 dxc3 Bc4 cxb2 Bxb2' },
    { n: 'Philidor Defense', m: 'e4 e5 Nf3 d6 d4 Nf6 Nc3 exd4 Nxd4 Be7' },
    { n: 'Latvian Gambit', m: 'e4 e5 Nf3 f5 exf5 e4 Ng5 d5 d3 Nf6' },
    { n: 'Elephant Gambit', m: 'e4 e5 Nf3 Bd6 Nc3 Nf6' },

    // --- semi-open
    { n: 'Sicilian: Najdorf', m: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be7 f3 O-O' },
    { n: 'Sicilian: Najdorf, English Attack', m: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 f3 e5 Nb3 Be7 Qd2 O-O' },
    { n: 'Sicilian: Sveshnikov', m: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5 Ndb5 d6 Bg5 a6 Na3 b5' },
    { n: 'Sicilian: Classical', m: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 Nc6 Bg5 e6 Qd2 a6' },
    { n: 'Sicilian: Dragon', m: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7 f3 O-O Qd2 Nc6' },
    { n: 'Sicilian: Accelerated Dragon', m: 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7 Be3 Nf6' },
    { n: 'Sicilian: Rossolimo', m: 'e4 c5 Nf3 Nc6 Bb5 g6 O-O Bg7 Re1 Nf6 c3 O-O' },
    { n: 'Sicilian: Alapin', m: 'e4 c5 c3 Nf6 e5 Nd5 d4 cxd4 Nf3 Nc6 cxd4 d6' },
    { n: 'Sicilian: Taimanov', m: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be2 a6' },
    { n: 'Sicilian: Kan', m: 'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Nc3 Qc7 Bd3 Nf6' },
    { n: 'Sicilian: Smith-Morra', m: 'e4 c5 d4 cxd4 c3 dxc3 Nxc3 Nc6 Nf3 d6 Bc4' },
    { n: 'French Defense: Classical', m: 'e4 e6 d4 d5 Nc3 Nf6 e5 Nfd7 f4 c5 Nf3 Nc6 Be3' },
    { n: 'French: Winawer', m: 'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3+ bxc3 Ne7' },
    { n: 'French: Advance', m: 'e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Nge7' },
    { n: 'French: Tarrasch', m: 'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5 c3 Nc6' },
    { n: 'French: Exchange', m: 'e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bg5 c6 Bd3 Bd6' },
    { n: 'Caro-Kann: Classical', m: 'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6 Nf3 Nd7' },
    { n: 'Caro-Kann: Advance', m: 'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5 Be3 Qb6' },
    { n: 'Caro-Kann: Panov', m: 'e4 c6 d4 d5 exd5 cxd5 c4 Nf6 Nc3 e6 Nf3 Be7' },
    { n: 'Scandinavian: Main', m: 'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5' },
    { n: 'Scandinavian: Modern', m: 'e4 d5 exd5 Nf6 d4 Bg4 c4 e6 Nc3 Bb4' },
    { n: 'Owen Defense / St. George', m: 'e4 b6 d4 Bb7 Nc3 e6 Nf3 Bb4' },

    // --- closed
    { n: 'Queen\'s Gambit Declined', m: 'd4 d5 c4 e6 Nc3 Nf6 Nf3 Be7 Bg5 O-O e3 h6' },
    { n: 'QGD: Exchange', m: 'd4 d5 c4 e6 cxd5 exd5 Nc3 Nf6 Nf3 Be7 Bf4 O-O' },
    { n: 'QGD: Semi-Tarrasch', m: 'd4 Nf6 c4 e6 Nf3 d5 Nc3 c5 cxd5 Nxd5 e4 Nxc3 bxc3 cxd4' },
    { n: 'Slav Defense', m: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6' },
    { n: 'Semi-Slav: Meran', m: 'd4 d5 c4 c6 Nf3 Nf6 Nc3 e6 e3 Nbd7 Bd3 dxc4 Bxc4 b5' },
    { n: 'Queen\'s Gambit Accepted', m: 'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6' },
    { n: 'Catalan Opening', m: 'd4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O O-O dxc4' },
    { n: 'London System', m: 'd4 d5 Nf3 Nf6 Bf4 e6 e3 c5 c3 Nc6 Nbd2 Bd6' },
    { n: 'Colle System', m: 'd4 d5 Nf3 Nf6 e3 e6 Bd3 c5 c3 Nc6' },
    { n: 'Trompowsky Attack', m: 'd4 Nf6 Bg5 e6 e4 h6 Bxf6 Qxf6' },
    { n: 'King\'s Indian Defense', m: 'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6 d5 Ne7' },
    { n: 'Grünfeld Defense', m: 'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7' },
    { n: 'Nimzo-Indian: Rubinstein', m: 'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5' },
    { n: 'Nimzo-Indian: Classical', m: 'd4 Nf6 c4 e6 Nc3 Bb4 Qc2 O-O a3 Bxc3+ Qxc3 b6' },
    { n: 'Queen\'s Indian', m: 'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O' },
    { n: 'Bogo-Indian', m: 'd4 Nf6 c4 e6 Nf3 Bb4+ Bd2' },
    { n: 'Budapest Gambit', m: 'd4 Nf6 c4 e5 dxe5 Ng4 Nf3 Bc5 e4 Nc6' },
    { n: 'Benoni Defense', m: 'd4 Nf6 c4 c5 d5 e6 Nc3 exd5 cxd5 d6 e4 g6' },
    { n: 'Benko Gambit', m: 'd4 Nf6 c4 c5 d5 b5 cxb5 a6 bxa6 Bxa6 Nc3 d6' },
    { n: 'Dutch Defense: Leningrad', m: 'd4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O' },
    { n: 'Dutch: Stonewall', m: 'd4 e6 c4 f5 g3 Nf6 Bg2 d5 Nf3 c6 O-O Bd6' },
    { n: 'Englund Gambit', m: 'd4 e5 dxe5 Nc6 Nf3 Qe7 Bf4 Qb4+' },

    // --- flank /reti / english
    { n: 'English Opening: Reversed Sicilian', m: 'c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6 Nf3 Nc6' },
    { n: 'English: Symmetrical', m: 'c4 c5 Nf3 Nf6 g3 g6 Bg2 Bg7 O-O O-O' },
    { n: 'English: Four Knights', m: 'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5' },
    { n: 'Réti Opening', m: 'Nf3 d5 c4 e6 g3 Nf6 Bg2 Be7 O-O O-O' },
    { n: 'King\'s Indian Attack', m: 'Nf3 d5 g3 c5 Bg2 Nc6 O-O e6 d3 Nf6' },
    { n: 'Zukertort / Neo-Catalan', m: 'Nf3 Nf6 c4 e6 g3 d5 Bg2 Bb4+ Nc3' },
    { n: 'Bird\'s Opening', m: 'f4 d5 Nf3 Nf6 e3 g6 b3 Bg7 Bb2 O-O' },
  ];

  var KEY_MAX_PLY = 12;

  function fenKeyOfChess(chessInstance) {
    // position identity ignoring clocks: placement + turn + castling + ep
    var fen = chessInstance.fen();
    var parts = fen.split(' ');
    return parts[0] + ' ' + parts[1] + ' ' + (parts[2] === '-' ? '-' : parts[2]) + ' -';
  }

  function build() {
    var book = new Map(); // key -> [{san, lineName, uci}]
    var Chess = global.Chess;
    for (var i = 0; i < LINES.length; i++) {
      var line = LINES[i];
      var c = new Chess();
      var sans = line.m.split(' ');
      for (var p = 0; p < sans.length && p < KEY_MAX_PLY; p++) {
        var key = fenKeyOfChess(c);
        var mv;
        try { mv = c.move(sans[p]); } catch (e) { mv = null; }
        if (!mv) break;
        var entry = { san: mv.san, uci: mv.from + mv.to + (mv.promotion || ''), lineName: line.n };
        if (!book.has(key)) book.set(key, []);
        var arr = book.get(key);
        // avoid duplicates of same san from same position
        var exists = arr.some(function (x) { return x.san === mv.san; });
        if (!exists) arr.push(entry);
      }
    }
    return book;
  }

  function pick(book, chessInstance, cfg, rng) {
    if (!book) return null;
    var key = fenKeyOfChess(chessInstance);
    var cands = book.get(key);
    if (!cands || !cands.length) return null;
    rng = rng || Math.random;
    var variety = cfg && cfg.bookVariety != null ? cfg.bookVariety / 100 : 0.55;

    // dedupe by san, count popularity
    var bySan = new Map();
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      bySan.set(c.san, (bySan.get(c.san) || 0) + 1);
    }
    var sans = [...bySan.keys()];
    var weights = sans.map(function (s) {
      var pop = bySan.get(s);
      // variety 0 -> strongly prefer popular; variety 100 -> uniform
      var w = Math.pow(pop, 1 - variety * 0.9);
      return w;
    });
    var total = 0;
    for (var w = 0; w < weights.length; w++) total += weights[w];
    var pickv = rng() * total, acc = 0, chosenSan = sans[0];
    for (var k = 0; k < sans.length; k++) {
      acc += weights[k];
      if (pickv <= acc) { chosenSan = sans[k]; break; }
    }
    for (var j = 0; j < cands.length; j++) {
      if (cands[j].san === chosenSan) return { san: chosenSan, uci: cands[j].uci, lineName: cands[j].lineName };
    }
    return null;
  }

  var cached = null;
  O.book = {
    size: function () {
      if (!cached) cached = build();
      return cached.size;
    },
    build: build,
    pick: function (chessInstance, cfg, rng) {
      if (!cached) cached = build();
      return pick(cached, chessInstance, cfg, rng);
    },
    LINES: LINES,
  };
})(typeof window !== 'undefined' ? window : globalThis);
