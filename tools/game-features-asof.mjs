// What was knowable at the DECISION TIME, for the games in the feature table.
//
//   node tools/game-features-asof.mjs --season 2026 --from 2026-09-02 \
//     --to 2026-09-22 --cache .backtest-cache --out .backtest-cache/asof_2026.json
//
// `tools/game-features.mjs` records two things the board cannot have when it
// prices a game, and docs/GAME-EDGE-SEARCH.md says so plainly:
//
//   - the posted lineup is the card that TOOK THE FIELD, not the card that was
//     visible two hours out;
//   - the weather is what was RECORDED at first pitch, not a forecast.
//
// That is fine for asking whether a term carries signal. It is not fine as a
// prediction of what the live app will gain, because the live app gets a
// projected card and a forecast. This writes the honest substitutes:
//
//   lineup   the team's most recent PREVIOUSLY POSTED card, with every
//            batter's line as of this game's date — the same idea as
//            src/data/projectedLineup.js, which builds tonight's guess out of
//            recent batting orders.
//   wx       an Open-Meteo hourly forecast for the first-pitch hour:
//            temperature and wind SPEED, and no direction, which is exactly
//            what src/data/loadSlate.js's `fetchWeather` hands the board.
//
// Public MLB Stats API (all of it already cached by game-features.mjs) and
// Open-Meteo. No metered feed.

import fs from 'node:fs';
import path from 'node:path';
import { makeCache, pool, API, argv } from './backtest-common.mjs';
import { PA_BY_LINEUP_SLOT } from '../src/model/batter.js';

const SEASON = Number(argv('season', '2026'));
const FROM = argv('from', `${SEASON}-03-01`);
const TO = argv('to', `${SEASON}-11-15`);
const CACHE = argv('cache', path.resolve('.backtest-cache'));
const OUT = argv('out', path.resolve(`.backtest-cache/asof_${SEASON}.json`));
const cached = makeCache(CACHE);
const log = (s) => process.stderr.write(`${s}\n`);

const n = (v) => Number(v || 0);

// ── the season's days, from the cache game-features.mjs already filled ──────
const seasonSchedule = await cached(
  `gf_schedule_${SEASON}`,
  `${API}/schedule?sportId=1&gameType=R&startDate=${SEASON}-03-01&endDate=${SEASON}-11-15`,
);
const HYDRATE = 'lineups,probablePitcher,officials,weather,linescore,venue,team';
const allDates = (seasonSchedule.dates || []).map((d) => d.date).sort();
const dates = allDates.filter((d) => d <= TO);
log(`${SEASON}: ${dates.length} dates up to ${TO}`);

const dayGames = new Map();
await pool(dates, 6, async (date) => {
  const body = await cached(`gf_day_${date}`, `${API}/schedule?sportId=1&gameType=R&date=${date}&hydrate=${HYDRATE}`);
  dayGames.set(date, body.dates?.[0]?.games || []);
});

// ── batter logs (already cached for every card in the window) ───────────────
const batterIds = new Set();
for (const date of dates) {
  for (const g of dayGames.get(date) || []) {
    for (const k of ['awayPlayers', 'homePlayers']) for (const p of g.lineups?.[k] || []) if (p.id) batterIds.add(p.id);
  }
}
const batterLogs = new Map();
log(`${SEASON}: ${batterIds.size} batter logs`);
await pool([...batterIds], 8, async (id) => {
  const body = await cached(`hitlog_${id}_${SEASON}`, `${API}/people/${id}/stats?stats=gameLog&group=hitting&season=${SEASON}`);
  batterLogs.set(id, body.stats?.[0]?.splits || []);
});

const HIT = ['runs', 'gamesPlayed', 'plateAppearances', 'atBats', 'hits', 'doubles', 'triples', 'homeRuns',
  'baseOnBalls', 'hitByPitch', 'sacFlies', 'totalBases', 'strikeOuts'];
function hitBefore(logs, date) {
  const s = Object.fromEntries(HIT.map((f) => [f, 0]));
  for (const g of logs) {
    if (date != null && g.date >= date) continue;
    for (const f of HIT) s[f] += n(g.stat[f]);
  }
  return s.gamesPlayed ? s : null;
}

/** Identical to `lineupLine` in tools/game-features.mjs, on a chosen card. */
function lineupLine(ids, date, slots) {
  let w = 0;
  let pa = 0;
  const acc = { ab: 0, h: 0, bb: 0, hbp: 0, sf: 0, tb: 0, so: 0, hr: 0 };
  let known = 0;
  ids.slice(0, slots).forEach((id, i) => {
    const b = hitBefore(batterLogs.get(id) || [], date);
    const weight = PA_BY_LINEUP_SLOT[i] ?? PA_BY_LINEUP_SLOT[8];
    w += weight;
    if (!b || b.plateAppearances < 25) return;
    known += weight;
    const scale = weight / b.plateAppearances;
    acc.ab += b.atBats * scale; acc.h += b.hits * scale; acc.bb += b.baseOnBalls * scale;
    acc.hbp += b.hitByPitch * scale; acc.sf += b.sacFlies * scale; acc.tb += b.totalBases * scale;
    acc.so += b.strikeOuts * scale; acc.hr += b.homeRuns * scale;
    pa += b.plateAppearances;
  });
  if (!w || known / w < 0.6) return null;
  const den = acc.ab + acc.bb + acc.hbp + acc.sf;
  return {
    knownShare: known / w,
    pa,
    obp: den ? (acc.h + acc.bb + acc.hbp) / den : null,
    slg: acc.ab ? acc.tb / acc.ab : null,
  };
}

// ── the weather forecast ────────────────────────────────────────────────────
// One Open-Meteo request per park for the whole window, with `past_days`, the
// same hourly variables loadSlate asks for, matched back by the first-pitch
// hour exactly as `fetchWeather` does.
const windowGames = [];
for (const date of dates) {
  if (date < FROM) continue;
  for (const g of dayGames.get(date) || []) windowGames.push({ date, g });
}
const venueIds = [...new Set(windowGames.map(({ g }) => g.venue?.id).filter(Boolean))];
const venueBody = venueIds.length
  ? await cached(`venues_${venueIds.length}_${venueIds[0]}`, `${API}/venues?venueIds=${venueIds.join(',')}&hydrate=location`)
  : { venues: [] };
const coords = new Map((venueBody.venues || []).map((v) => [v.id, v.location?.defaultCoordinates]));

const earliest = windowGames.reduce((a, { date }) => (date < a ? date : a), '9999');
const pastDays = Math.min(92, Math.max(1,
  Math.round((Date.now() - Date.parse(`${earliest}T00:00:00Z`)) / 86400e3) + 2));
const forecastByVenue = new Map();
await pool(venueIds, 4, async (id) => {
  const c = coords.get(id);
  if (!c?.latitude) return;
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${c.latitude}&longitude=${c.longitude}`
    + '&hourly=temperature_2m,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph'
    + `&past_days=${pastDays}&forecast_days=1&timezone=UTC`;
  try {
    const body = await cached(`om_${id}_${FROM}_${TO}`, url);
    forecastByVenue.set(id, body);
  } catch {
    // A park with no forecast simply has none, exactly as on the live board.
  }
});
log(`forecasts for ${forecastByVenue.size}/${venueIds.length} parks (past_days ${pastDays})`);

// ── build ───────────────────────────────────────────────────────────────────
/** The team's most recent posted card strictly before `date`, if any. */
const lastCard = new Map(); // teamId -> { date, ids }
const out = {};
let withPrev = 0;
let withWx = 0;
let total = 0;

for (const date of dates) {
  const games = dayGames.get(date) || [];
  if (date >= FROM) {
    for (const g of games) {
      const rec = { away: {}, home: {} };
      for (const which of ['away', 'home']) {
        total++;
        const teamId = g.teams[which].team.id;
        const prev = lastCard.get(teamId);
        if (prev) {
          const nine = lineupLine(prev.ids, date, 9);
          const top4 = lineupLine(prev.ids, date, 4);
          if (nine) {
            rec[which].lineup = { nine, top4, from: prev.date };
            withPrev++;
          }
        }
      }
      const f = forecastByVenue.get(g.venue?.id);
      if (f?.hourly?.time && g.gameDate) {
        const hourKey = `${new Date(g.gameDate).toISOString().slice(0, 13)}:00`;
        const i = f.hourly.time.indexOf(hourKey);
        if (i >= 0) {
          rec.wx = {
            tempF: Math.round(f.hourly.temperature_2m[i]),
            windMph: Math.round(f.hourly.wind_speed_10m[i]),
          };
          withWx++;
        }
      }
      out[g.gamePk] = rec;
    }
  }
  // Only now does today's card become history.
  for (const g of games) {
    for (const which of ['away', 'home']) {
      const ids = (g.lineups?.[which === 'away' ? 'awayPlayers' : 'homePlayers'] || [])
        .map((p) => p.id).filter(Boolean);
      if (ids.length >= 9) lastCard.set(g.teams[which].team.id, { date, ids });
    }
  }
}

const games = Object.keys(out).length;
log(`${games} games in ${FROM}..${TO}: previous card for ${withPrev}/${total} sides, forecast for ${withWx}/${games}`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ season: SEASON, from: FROM, to: TO, builtAt: new Date().toISOString(), games: out }));
log(`wrote ${OUT}`);
