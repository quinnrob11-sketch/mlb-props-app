// Exercises both handlers with a mock req/res. Run: node test-api.mjs
// Live upstream calls are made only for MLB (free). Odds tests stay on the
// validation paths so no credits are spent unless ODDS_LIVE=1.

import mlb from "./api/mlb.js";
import odds from "./api/odds.js";

function mock(url, headers = {}) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = String(v); },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = JSON.stringify(o); return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
  return [{ method: "GET", url, headers: { "x-forwarded-for": "1.2.3.4", ...headers } }, res];
}

let pass = 0, fail = 0;
async function check(name, handler, url, expect, headers) {
  const [req, res] = mock(url, headers);
  await handler(req, res);
  const got = { status: res.statusCode, cache: res.headers["cache-control"] || "" };
  const ok = got.status === expect.status &&
    (expect.cache === undefined || got.cache.includes(expect.cache));
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
  if (!ok) {
    console.log(`        want ${JSON.stringify(expect)}`);
    console.log(`        got  ${JSON.stringify(got)}  body=${String(res.body).slice(0, 160)}`);
    fail++;
  } else pass++;
  return res;
}

const enc = (p) => "/api/mlb?path=" + encodeURIComponent(p);

console.log("\n── mlb.js: rejects what it should ──");
await check("no path", mlb, "/api/mlb", { status: 400 });
await check("absolute url", mlb, enc("https://evil.com/x"), { status: 400 });
await check("scheme-relative", mlb, enc("//evil.com/x"), { status: 400 });
await check("traversal out of allowlist", mlb, enc("/api/v1/../../etc/passwd"), { status: 400 });
await check("unlisted endpoint", mlb, enc("/api/v1/draft"), { status: 400 });

console.log("\n── mlb.js: allows + caches real routes ──");
await check("schedule", mlb, enc("/api/v1/schedule?sportId=1&date=2026-07-28"), { status: 200, cache: "s-maxage=60" });
await check("venues (long ttl)", mlb, enc("/api/v1/venues?venueIds=15"), { status: 200, cache: "s-maxage=86400" });
await check("teams/stats", mlb, enc("/api/v1/teams/stats?stats=season&group=hitting&season=2026&sportId=1"), { status: 200, cache: "s-maxage=900" });
await check("boxscore (short ttl)", mlb, enc("/api/v1/game/813000/boxscore"), { status: 200, cache: "s-maxage=30" });

console.log("\n── odds.js: rejects what it should ──");
await check("no endpoint", odds, "/api/odds", { status: 400 });
await check("bogus endpoint", odds, "/api/odds?endpoint=sports", { status: 400 });
await check("bad eventId", odds, "/api/odds?endpoint=event-odds&eventId=nope&markets=batter_hits", { status: 400 });
await check("unlisted market", odds, "/api/odds?endpoint=event-odds&eventId=" + "a".repeat(32) + "&markets=player_anytime_td", { status: 400 });
await check("no markets", odds, "/api/odds?endpoint=event-odds&eventId=" + "a".repeat(32), { status: 400 });

console.log("\n── odds.js: upstream URL is canonical ──");
{
  // Given already-canonical input, the upstream URL must have sorted markets
  // and a fixed bookmaker list — the thing that bounds cost per cache entry.
  let seen = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => {
    seen = String(u).replace(/apiKey=[^&]*/, "apiKey=REDACTED");
    return { ok: true, status: 200, headers: new Map(), text: async () => "[]" };
  };
  process.env.ODDS_API_KEY = "test";
  const id = "b".repeat(32);
  const [req, res] = mock(`/api/odds?endpoint=event-odds&eventId=${id}&markets=batter_hits%2Cbatter_rbis&books=core`);
  await odds(req, res);
  globalThis.fetch = original;
  const ok = res.statusCode === 200 &&
    seen.includes("markets=batter_hits%2Cbatter_rbis") &&
    seen.includes("bookmakers=betmgm%2Ccaesars%2Cdraftkings%2Cfanduel%2Cpinnacle");
  console.log(`${ok ? "  ok  " : " FAIL "} canonical input builds sorted upstream URL`);
  ok ? pass++ : fail++;
  console.log("        " + seen);
}

console.log("\n── odds.js: CDN cache-key canonicalisation ──");
{
  const id = "c".repeat(32);
  const canonical = `/api/odds?endpoint=event-odds&eventId=${id}&markets=batter_hits%2Cbatter_home_runs&books=core`;
  // Non-canonical forms must 308 to exactly one target, so the CDN sees one key.
  const variants = [
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=batter_home_runs,batter_hits&books=core`,
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=BATTER_HOME_RUNS,batter_hits,batter_hits`,
    `/api/odds?endpoint=event-odds&eventId=${id.toUpperCase()}&markets=batter_hits,batter_home_runs`,
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=batter_hits,batter_home_runs`,
  ];
  const targets = new Set();
  let all308 = true;
  for (const v of variants) {
    const [req, res] = mock(v);
    await odds(req, res);
    if (res.statusCode !== 308) all308 = false;
    else targets.add(res.headers["location"]);
  }
  const ok = all308 && targets.size === 1 && [...targets][0] === canonical;
  console.log(`${ok ? "  ok  " : " FAIL "} 4 permutations all 308 to one canonical URL`);
  ok ? pass++ : fail++;
  if (!ok) console.log("        targets:", [...targets], "all308:", all308);

  // The canonical URL itself must NOT redirect, or it loops forever.
  process.env.ODDS_API_KEY = "test";
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => "{}" });
  const [rq, rs] = mock(canonical);
  await odds(rq, rs);
  globalThis.fetch = original;
  const noLoop = rs.statusCode === 200 && (rs.headers["cache-control"] || "").includes("s-maxage=60");
  console.log(`${noLoop ? "  ok  " : " FAIL "} canonical URL serves 200 and does not redirect`);
  noLoop ? pass++ : fail++;
  if (!noLoop) console.log("        got", rs.statusCode, rs.headers["cache-control"], rs.headers["location"]);
}

if (process.env.ODDS_LIVE === "1") {
  console.log("\n── odds.js: live upstream (spends credits) ──");
  await check("events", odds, "/api/odds?endpoint=events", { status: 200, cache: "s-maxage=120" });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
