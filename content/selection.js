/* ChessOracle — elo-matched move selection policy.
 *
 * Turns engine lines into a human-like move choice:
 *   - elo ladder (400-2900) maps to skill/depth/time/error-rate profiles
 *   - error tiers (inaccuracy / mistake / blunder) chosen per move by
 *     probability, then a plausible move within the tier's eval-loss window
 *   - safety floor: when "never lose" is on, risky picks are filtered so the
 *     game is never thrown away while still looking human
 *   - desperation: losing positions get near-best play (like real humans)
 */
(function (global) {
  'use strict';
  var O = global.ChessOracle = global.ChessOracle || {};
  var U = O.util;

  /* elo -> engine params + per-move error probabilities (percent) */
  var LADDER = [
    //  elo   skill depth movetime  pB    pM    pI
    [400, 0, 2, 90, 20.0, 18.0, 18.0],
    [600, 1, 3, 120, 15.0, 15.0, 16.0],
    [800, 2, 4, 160, 11.0, 12.0, 14.0],
    [1000, 4, 5, 220, 8.0, 10.0, 12.0],
    [1200, 5, 6, 300, 6.0, 8.0, 10.0],
    [1400, 7, 8, 420, 4.2, 6.2, 8.5],
    [1600, 9, 10, 560, 2.8, 4.4, 7.0],
    [1800, 11, 12, 700, 1.8, 3.0, 5.5],
    [2000, 13, 14, 850, 1.1, 2.0, 4.0],
    [2200, 15, 16, 950, 0.6, 1.2, 2.6],
    [2400, 17, 18, 1100, 0.3, 0.7, 1.6],
    [2600, 19, 20, 1250, 0.12, 0.35, 0.9],
    [2800, 20, 22, 1350, 0.04, 0.12, 0.35],
    [2900, 20, 24, 1500, 0.0, 0.04, 0.12],
  ];

  function ladderAt(elo) {
    elo = U.clamp(elo, 400, 2900);
    var lo = LADDER[0], hi = LADDER[LADDER.length - 1];
    for (var i = 0; i < LADDER.length - 1; i++) {
      if (elo >= LADDER[i][0] && elo <= LADDER[i + 1][0]) { lo = LADDER[i]; hi = LADDER[i + 1]; break; }
    }
    if (elo >= 2900) return { skill: 20, depth: 24, movetime: 1500, pB: 0, pM: 0.04, pI: 0.12 };
    var t = (elo - lo[0]) / (hi[0] - lo[0]);
    return {
      skill: Math.round(U.lerp(lo[1], hi[1], t)),
      depth: Math.round(U.lerp(lo[2], hi[2], t)),
      movetime: Math.round(U.lerp(lo[3], hi[3], t)),
      pB: U.lerp(lo[4], hi[4], t),
      pM: U.lerp(lo[5], hi[5], t),
      pI: U.lerp(lo[6], hi[6], t),
    };
  }

  /* window of win%-loss for each tier */
  var TIERS = {
    blunder: [18, 60],
    mistake: [8, 18],
    inaccuracy: [3, 8],
    clean: [0, 3],
  };

  /**
   * Choose a move from engine lines.
   * @param {Array} lines [{uci, winPct, score, pv}] best-first
   * @param {object} cfg {elo, bias, safeFloor, risk, human:'auto'|'manual',
   *                      blunderRate, mistakeRate, inaccuracyRate, randomness}
   * @param {object} ctx {rng, winningBig, losing, ply}
   * @returns {object} {uci, tier, winPct, reason}
   */
  function chooseMove(lines, cfg, ctx) {
    if (!lines || !lines.length) return null;
    var rng = ctx && ctx.rng ? ctx.rng : Math.random;
    var elo = U.clamp((cfg.elo || 1200) + (cfg.bias || 0), 400, 2950);
    var prof = ladderAt(elo);

    var best = lines[0];
    var bestW = best.winPct;
    for (var i = 0; i < lines.length; i++) lines[i].delta = bestW - lines[i].winPct;

    // ---- contextual modifiers (real human tendencies)
    var pB = prof.pB, pM = prof.pM, pI = prof.pI;
    if (cfg.human === 'manual') {
      pB = cfg.blunderRate / 100 * 4;   // slider 0..100 -> per-move %
      pM = cfg.mistakeRate / 100 * 4;
      pI = cfg.inaccuracyRate / 100 * 4;
      pB = Math.min(pB, 35); pM = Math.min(pM, 40); pI = Math.min(pI, 45);
    }
    if (ctx.winningBig) { pB *= 1.5; pM *= 1.4; pI *= 1.3; }   // sloppy when winning
    if (ctx.losing) { pB *= 0.25; pM *= 0.4; pI *= 0.6; }      // try hard when losing

    // ---- safety floor
    var pool = lines;
    if (cfg.safeFloor) {
      var floor;
      if (bestW > 90) floor = 55;        // clearly winning: stay clearly winning
      else if (bestW > 70) floor = 48;   // winning: never drop below equality
      else if (bestW > 55) floor = 42;   // slight edge: no blunders
      else floor = -100;                 // equal or worse: no artificial floor
      // risk slider relaxes the floor toward bestW
      var riskRelax = (100 - (cfg.risk == null ? 70 : cfg.risk)) * 0.5;
      var effFloor = Math.min(floor, bestW - riskRelax);
      var filtered = lines.filter(function (l) { return l.winPct >= effFloor; });
      if (filtered.length) pool = filtered;
    }

    // ---- pick tier
    var r = rng() * 100;
    var tier;
    if (r < pB) tier = 'blunder';
    else if (r < pB + pM) tier = 'mistake';
    else if (r < pB + pM + pI) tier = 'inaccuracy';
    else tier = 'clean';

    var cands = pool.filter(function (l) { return l.delta >= TIERS[tier][0] && l.delta < TIERS[tier][1]; });
    if (!cands.length) {
      // degrade: try softer tiers first, then anything reasonable
      var order = tier === 'blunder' ? ['mistake', 'inaccuracy', 'clean'] : ['inaccuracy', 'clean'];
      for (var o = 0; o < order.length && !cands.length; o++) {
        cands = pool.filter(function (l) { return l.delta >= TIERS[order[o]][0] && l.delta < TIERS[order[o]][1]; });
        if (cands.length) tier = order[o];
      }
      if (!cands.length) {
        // nothing in any window: take least-bad sub-floor move or the best
        cands = pool.filter(function (l) { return l.delta < TIERS.blunder[1]; });
        if (!cands.length) cands = [best];
        tier = 'clean';
      }
    }

    // ---- weighted pick inside tier (prefer "least bad" errors like humans)
    var randomness = cfg.randomness == null ? 35 : cfg.randomness;
    var temp = 2 + (randomness / 100) * 28; // softmax-ish temperature over delta
    var weights = cands.map(function (l) { return Math.exp(-l.delta / temp); });
    var total = 0;
    for (var w = 0; w < weights.length; w++) total += weights[w];
    var pick = rng() * total, acc = 0, chosen = cands[0];
    for (var c = 0; c < cands.length; c++) {
      acc += weights[c];
      if (pick <= acc) { chosen = cands[c]; break; }
    }

    return {
      uci: chosen.uci,
      tier: tier,
      winPct: chosen.winPct,
      delta: chosen.delta,
      reason: tier === 'clean' ? 'solid' : tier,
      profile: prof,
    };
  }

  /* engine params for the auto player */
  function engineParamsFor(elo, bias) {
    var prof = ladderAt(U.clamp((elo || 1200) + (bias || 0), 400, 2950));
    return {
      depth: prof.depth,
      movetime: U.clamp(prof.movetime, 80, 2200),
      multipv: 5,
      skill: prof.skill,
    };
  }

  /* human think-time (seconds) for a position.
   * Shaped like a real player: lognormal base (quick most moves, occasional
   * long thinks), context multipliers, rare "deep think" outliers, and
   * near-instant replies in forced situations. */
  function thinkTime(cfg, ctx) {
    var rng = ctx && ctx.rng ? ctx.rng : Math.random;
    var t;
    if (cfg.timingMode === 'fixed') {
      t = Math.max(0.15, cfg.timeFixed || 2);
      t *= 0.85 + rng() * 0.3;
      return t;
    }
    var lo = Math.max(0.2, cfg.timeMin || 1);
    var hi = Math.max(lo + 0.3, cfg.timeMax || 4);

    // lognormal-ish: mass near lo with a natural long tail
    t = Math.exp(Math.log(lo) + rng() * Math.log(hi / lo));
    // rare deep think (a real "hmm, let me calculate this" moment)
    if (rng() < 0.045) t = hi * (1.15 + rng() * 1.5);

    var mult = 1;
    if (ctx) {
      if (ctx.ply != null && ctx.ply < 10 && cfg.openingFast) mult *= 0.55;
      if (ctx.inCheck) mult *= 1.35;
      if (ctx.captureAvailable) mult *= 1.12;
      if (ctx.legalCount > 34) mult *= 1.2;
      if (ctx.legalCount < 12) mult *= 0.85;
      if (ctx.legalCount != null && ctx.legalCount <= 2) mult *= 0.45;  // forced — snap reply
      if (ctx.pieceCount < 14) mult *= 0.9;
      if (ctx.losing) mult *= 1.3;
      if (ctx.winningBig) mult *= 0.7;
    }
    t *= mult;
    if (ctx && ctx.clockSeconds != null && cfg.clockAware) {
      if (ctx.clockSeconds < 5) t = Math.min(t, 0.12 + rng() * 0.2);
      else if (ctx.clockSeconds < 15) t = Math.min(t, 0.3 + rng() * 0.5);
      else if (ctx.clockSeconds < 60) t = Math.min(t, 1 + rng() * ctx.clockSeconds * 0.05);
    }
    return Math.max(0.12, Math.min(t, hi * 3.2));
  }

  O.selection = {
    LADDER: LADDER,
    ladderAt: ladderAt,
    chooseMove: chooseMove,
    engineParamsFor: engineParamsFor,
    thinkTime: thinkTime,
    TIERS: TIERS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
