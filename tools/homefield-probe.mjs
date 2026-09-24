// Raw box-score home/away split, with NO model involved.
//
//   node tools/homefield-probe.mjs [--cache DIR]
//
// Answers one question: across both seasons, do home starters actually record
// more outs and allow fewer earned runs than away starters, and do home teams
// actually score more? Everything here is read straight from the cached
// StatsAPI game logs; nothing is projected.
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const CACHE = arg('cache', path.resolve('.backtest-cache'));
const files = fs.readdirSync(CACHE);
const J = (f) => JSON.parse(fs.readFileSync(path.join(CACHE, f), 'utf8'));

function stats(xs) {
  const n = xs.length;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return { n, mean: m, se: Math.sqrt(v / n) };
}
function cmp(label, home, away) {
  const H = stats(home), A = stats(away);
  const d = H.mean - A.mean;
  const se = Math.sqrt(H.se ** 2 + A.se ** 2);
  console.log(
    `${label.padEnd(26)} home ${H.mean.toFixed(4)} (n=${H.n})  away ${A.mean.toFixed(4)} (n=${A.n})  ` +
    `diff ${d >= 0 ? '+' : ''}${d.toFixed(4)} +- ${(1.96 * se).toFixed(4)}  z=${(d / se).toFixed(2)}`,
  );
}

// ── starting pitchers, per start ────────────────────────────────────────────
for (const season of [2025, 2026]) {
  const fields = { outs: 'outs', er: 'earnedRuns', hits: 'hits', bb: 'baseOnBalls', k: 'strikeOuts' };
  const H = {}, A = {};
  for (const f of Object.keys(fields)) { H[f] = []; A[f] = []; }
  let nlog = 0;
  for (const f of files) {
    if (!f.startsWith('pitchlog_') || !f.endsWith(`_${season}.json`)) continue;
    nlog++;
    for (const g of J(f).stats?.[0]?.splits || []) {
      if (Number(g.stat.gamesStarted) !== 1) continue;
      const bucket = g.isHome ? H : A;
      for (const [k, field] of Object.entries(fields)) bucket[k].push(Number(g.stat[field] || 0));
    }
  }
  console.log(`\n### ${season} starting pitchers (raw box score, ${nlog} pitcher logs)`);
  for (const k of Object.keys(fields)) cmp(`starter ${k}`, H[k], A[k]);
}

// ── teams, per team-game ────────────────────────────────────────────────────
for (const season of [2025, 2026]) {
  const H = { runs: [], hits: [], k: [], bb: [] }, A = { runs: [], hits: [], k: [], bb: [] };
  const HP = { er: [], outs: [] }, AP = { er: [], outs: [] };
  for (const f of files) {
    if (f.startsWith('teamhit_') && f.endsWith(`_${season}.json`)) {
      for (const g of J(f).stats?.[0]?.splits || []) {
        const b = g.isHome ? H : A;
        b.runs.push(Number(g.stat.runs || 0));
        b.hits.push(Number(g.stat.hits || 0));
        b.k.push(Number(g.stat.strikeOuts || 0));
        b.bb.push(Number(g.stat.baseOnBalls || 0));
      }
    }
    if (f.startsWith('teampitch_') && f.endsWith(`_${season}.json`)) {
      for (const g of J(f).stats?.[0]?.splits || []) {
        const b = g.isHome ? HP : AP;
        b.er.push(Number(g.stat.earnedRuns || 0));
        b.outs.push(Number(g.stat.outs || 0));
      }
    }
  }
  console.log(`\n### ${season} teams, per team-game (raw box score)`);
  for (const k of Object.keys(H)) cmp(`team batting ${k}`, H[k], A[k]);
  for (const k of Object.keys(HP)) if (HP[k].length) cmp(`team pitching ${k}`, HP[k], AP[k]);
}

// ── rates, which is what the model actually predicts ────────────────────────
for (const season of [2025, 2026]) {
  const acc = { home: {}, away: {} };
  for (const s of ['home', 'away']) acc[s] = { bf: 0, k: 0, bb: 0, h: 0, hr: 0, er: 0, outs: 0, n: 0, pitches: 0 };
  for (const f of files) {
    if (!f.startsWith('pitchlog_') || !f.endsWith(`_${season}.json`)) continue;
    for (const g of J(f).stats?.[0]?.splits || []) {
      if (Number(g.stat.gamesStarted) !== 1) continue;
      const a = acc[g.isHome ? 'home' : 'away'];
      a.n++;
      a.bf += Number(g.stat.battersFaced || 0);
      a.k += Number(g.stat.strikeOuts || 0);
      a.bb += Number(g.stat.baseOnBalls || 0);
      a.h += Number(g.stat.hits || 0);
      a.hr += Number(g.stat.homeRuns || 0);
      a.er += Number(g.stat.earnedRuns || 0);
      a.outs += Number(g.stat.outs || 0);
      a.pitches += Number(g.stat.numberOfPitches || 0);
    }
  }
  const r = (s) => ({
    'K/BF': acc[s].k / acc[s].bf, 'BB/BF': acc[s].bb / acc[s].bf, 'H/BF': acc[s].h / acc[s].bf,
    'HR/BF': acc[s].hr / acc[s].bf, 'ER/9': (27 * acc[s].er) / acc[s].outs,
    'outs/start': acc[s].outs / acc[s].n, 'pitches/start': acc[s].pitches / acc[s].n,
    'BF/start': acc[s].bf / acc[s].n,
  });
  const H = r('home'), A = r('away');
  console.log(`\n### ${season} starter RATES (home n=${acc.home.n}, away n=${acc.away.n})`);
  for (const k of Object.keys(H)) {
    const rel = (100 * (H[k] - A[k])) / A[k];
    console.log(`${k.padEnd(14)} home ${H[k].toFixed(5)}  away ${A[k].toFixed(5)}  home/away ${(H[k] / A[k]).toFixed(4)}  (${rel >= 0 ? '+' : ''}${rel.toFixed(2)}%)`);
  }
}

// ── the opponent aggregate: is a team's hitting the same on both sides? ─────
for (const season of [2025, 2026]) {
  const acc = { home: { pa: 0, k: 0, bb: 0, h: 0, ab: 0, r: 0 }, away: { pa: 0, k: 0, bb: 0, h: 0, ab: 0, r: 0 } };
  for (const f of files) {
    if (!f.startsWith('teamhit_') || !f.endsWith(`_${season}.json`)) continue;
    for (const g of J(f).stats?.[0]?.splits || []) {
      const a = acc[g.isHome ? 'home' : 'away'];
      a.pa += Number(g.stat.plateAppearances || 0);
      a.k += Number(g.stat.strikeOuts || 0);
      a.bb += Number(g.stat.baseOnBalls || 0);
      a.h += Number(g.stat.hits || 0);
      a.ab += Number(g.stat.atBats || 0);
      a.r += Number(g.stat.runs || 0);
    }
  }
  const r = (s) => ({ 'K/PA': acc[s].k / acc[s].pa, 'BB/PA': acc[s].bb / acc[s].pa, AVG: acc[s].h / acc[s].ab, 'H/PA': acc[s].h / acc[s].pa, 'R/PA': acc[s].r / acc[s].pa });
  const H = r('home'), A = r('away');
  console.log(`\n### ${season} TEAM HITTING per PA, by side of the ballpark (the opponent aggregate is pooled over both)`);
  for (const k of Object.keys(H)) {
    const rel = (100 * (H[k] - A[k])) / A[k];
    console.log(`${k.padEnd(6)} batting at home ${H[k].toFixed(5)}  batting away ${A[k].toFixed(5)}  (${rel >= 0 ? '+' : ''}${rel.toFixed(2)}%)`);
  }
}
