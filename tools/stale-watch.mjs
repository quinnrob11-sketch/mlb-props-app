// Watch the one edge the studies actually found, live, without placing a thing.
//
//   node tools/stale-watch.mjs [--once] [--every 20]
//
// docs/MARKET-EDGE-SEARCH.md tested 26 hypotheses against the Kalshi MLB book
// and exactly one survived: the price lags the box score. Once a starter has
// recorded his s-th strikeout, "s+ strikeouts" is worth exactly 100c and
// nothing can change it. Once he has left the game with F strikeouts, every
// rung above F is worth exactly 0c. StatsAPI stamps both moments; Kalshi is
// sometimes still quoting a minute later.
//
// Measured over 68 days: about 3.5 chances a day, 7.5c a contract on the
// strikeout leg and 18.4c on the pitching-change leg, and 97% of them gone
// inside sixty seconds. That is a latency race, and the study window ended on
// 2026-09-22 — so the open question is whether it is still there at all.
//
// A caveat on what this can and cannot show. Polling every 25 seconds cannot
// CAPTURE a chance that dies in sixty — collecting this edge needs a socket and
// sub-second reaction, not a polling loop. What it can show is whether the
// chances still OCCUR: any hit at all is evidence the lag is still there, and a
// night of live games with none is evidence it has been arbitraged away since
// the study window closed on 2026-09-22. Read the count, not the money.
//
// This answers that question by watching. It NEVER places an order and needs
// no credentials: public StatsAPI and public Kalshi only. Every chance it sees
// is appended to bot/state/stale-watch.ndjson with the price that was actually
// on the screen, so the record can be graded later against what it would have
// paid.
import fs from 'node:fs';
import path from 'node:path';

const EVERY = Number((process.argv.find((a) => a.startsWith('--every=')) || '').split('=')[1] || 20);
const ONCE = process.argv.includes('--once');
const LOG = 'bot/state/stale-watch.ndjson';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const STATS = 'https://statsapi.mlb.com/api/v1';
const FEE = (c) => (0.07 * c * (100 - c)) / 100;

const et = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// The watcher writes its own log rather than relying on a shell redirect: it
// runs for hours under Task Scheduler, where wrapping it in cmd.exe to get
// ">> file" turned out to be one more thing that can fail silently.
const NEWLINE = String.fromCharCode(10);
const LOGFILE = 'bot/state/stale-watch.log';
const write = (line) => {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOGFILE), { recursive: true });
    fs.appendFileSync(LOGFILE, line + NEWLINE);
  } catch {
    /* logging must never take the watcher down */
  }
};
const log = (msg) => write(`${new Date().toISOString().slice(11, 19)} ${msg}`);

let lastCall = 0;
async function get(url) {
  // One request at a time with a floor between them: this runs for hours and
  // an exchange that rate-limits you is worse than a slow loop.
  const wait = Math.max(0, lastCall + 250 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
      if (res.status !== 429 && res.status < 500) return null;
    } catch (err) {
      // A watcher that runs for eight hours WILL meet a transient network
      // failure, and on 2026-09-23 one DNS miss on statsapi.mlb.com killed it
      // outright four hours in. fetch rejects rather than returning a status,
      // so retrying only on status codes did not cover it. Every attempt is
      // now retried the same way and a run of failures returns null, which
      // every caller already treats as "nothing to see this sweep".
      if (attempt === 3) {
        log(`network: ${String(err?.cause?.code || err?.message || err)} — skipping this sweep`);
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  return null;
}

const record = (entry) => {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
};

/** Every open strikeout market today, by pitcher name, with its rung. */
async function strikeoutLadder() {
  const out = new Map(); // normalised name -> [{ticker, rung}]
  let cursor = '';
  for (let page = 0; page < 12; page += 1) {
    const body = await get(
      `${KALSHI}/markets?series_ticker=KXMLBKS&status=open&limit=1000${cursor ? `&cursor=${cursor}` : ''}`,
    );
    for (const m of body?.markets || []) {
      // "Name: 6+" -> rung 6. floor_strike is 5.5 on that contract.
      const sub = String(m.yes_sub_title || m.subtitle || '');
      const hit = /^(.*?):\s*(\d+)\+/.exec(sub);
      if (!hit) continue;
      const key = norm(hit[1]);
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ ticker: m.ticker, rung: Number(hit[2]) });
    }
    cursor = body?.cursor || '';
    if (!cursor) break;
  }
  return out;
}

const norm = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim();

/** Starters in games that are live right now, with their current K count. */
async function liveStarters(date) {
  const sched = await get(`${STATS}/schedule?sportId=1&date=${date}&hydrate=linescore`);
  const live = (sched?.dates?.[0]?.games || []).filter(
    (g) => g.status?.abstractGameState === 'Live',
  );
  const out = [];
  for (const game of live) {
    const box = await get(`${STATS}/game/${game.gamePk}/boxscore`);
    if (!box) continue;
    for (const sideName of ['away', 'home']) {
      const side = box.teams?.[sideName];
      const starterId = side?.pitchers?.[0];
      if (!starterId) continue;
      const entry = side.players?.[`ID${starterId}`];
      const pitching = entry?.stats?.pitching;
      if (!pitching) continue;
      out.push({
        gamePk: game.gamePk,
        name: entry.person?.fullName || '',
        k: pitching.strikeOuts || 0,
        // More than one pitcher used by this side means the starter is out.
        done: (side.pitchers || []).length > 1,
      });
    }
  }
  return out;
}

/** Top of book for one contract. */
async function quote(ticker) {
  const body = await get(`${KALSHI}/markets/${ticker}`);
  const m = body?.market;
  if (!m) return null;
  return { yesBid: m.yes_bid ?? null, yesAsk: m.yes_ask ?? null, status: m.status };
}

// What we have already reported, so a chance is logged once rather than every
// poll until the quote disappears.
const seen = new Set();

async function sweep(ladder, date) {
  const starters = await liveStarters(date);
  if (!starters.length) return { live: 0, chances: 0 };
  let chances = 0;

  for (const s of starters) {
    const rungs = ladder.get(norm(s.name));
    if (!rungs) continue;

    for (const { ticker, rung } of rungs) {
      // A rung at or below the current count is already YES; a rung above the
      // count is already NO once the starter has left the game. Anything else
      // is still a forecast, which is not what this watches.
      const certainYes = rung <= s.k;
      const certainNo = s.done && rung > s.k;
      if (!certainYes && !certainNo) continue;
      const id = `${ticker}:${certainYes ? 'yes' : 'no'}`;
      if (seen.has(id)) continue;

      const q = await quote(ticker);
      if (!q || q.status !== 'active') continue;

      if (certainYes && q.yesAsk != null && q.yesAsk > 0 && q.yesAsk < 100) {
        const edge = 100 - q.yesAsk - FEE(q.yesAsk);
        if (edge <= 0) continue;
        seen.add(id);
        chances += 1;
        log(`YES ${ticker} ask ${q.yesAsk}c -> ${edge.toFixed(1)}c  (${s.name} has ${s.k} K, needs ${rung})`);
        record({ kind: 'strikeout', ticker, side: 'yes', priceCents: q.yesAsk, edgeCents: round1(edge), pitcher: s.name, k: s.k, rung, gamePk: s.gamePk });
      } else if (certainNo && q.yesBid != null && q.yesBid > 1) {
        const edge = q.yesBid - FEE(q.yesBid);
        if (edge <= 0) continue;
        seen.add(id);
        chances += 1;
        log(`NO  ${ticker} bid ${q.yesBid}c -> ${edge.toFixed(1)}c  (${s.name} out with ${s.k} K, rung ${rung})`);
        record({ kind: 'pitching-change', ticker, side: 'no', priceCents: q.yesBid, edgeCents: round1(edge), pitcher: s.name, k: s.k, rung, gamePk: s.gamePk });
      }
    }
  }
  return { live: starters.length, chances };
}

const round1 = (v) => Math.round(v * 10) / 10;

const date = et(new Date());
log(`watching ${date} — public feeds only, nothing is ever ordered`);
let ladder = await strikeoutLadder();
log(`${ladder.size} pitchers on the Kalshi strikeout board`);

let ticks = 0;
for (;;) {
  let live = 0;
  let chances = 0;
  try {
    ({ live, chances } = await sweep(ladder, date));
  } catch (err) {
    // Same lesson one level up: losing a sweep is cheap, losing the night is
    // not, and the chances this watches for last about sixty seconds.
    log(`sweep failed: ${String(err?.message || err)} — continuing`);
  }
  ticks += 1;
  if (ticks % 15 === 1 || chances)
    log(`${live} live starter(s), ${chances} new chance(s) this sweep, ${seen.size} today`);
  if (ONCE) break;
  // The board changes as games are added; refresh it occasionally.
  if (ticks % 60 === 0) ladder = await strikeoutLadder();
  await new Promise((r) => setTimeout(r, EVERY * 1000));
}
