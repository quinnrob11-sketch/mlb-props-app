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

console.log("\n── odds.js: market canonicalisation ──");
{
  // Same set, different order/case/dupes must produce one identical upstream URL.
  const seen = new Set();
  const original = globalThis.fetch;
  globalThis.fetch = async (u) => {
    seen.add(String(u).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));
    return { ok: true, status: 200, headers: new Map(), text: async () => "[]" };
  };
  process.env.ODDS_API_KEY = "test";
  const id = "b".repeat(32);
  for (const m of ["batter_hits,batter_rbis", "batter_rbis,batter_hits", "BATTER_RBIS, batter_hits ,batter_hits"]) {
    const [req, res] = mock(`/api/odds?endpoint=event-odds&eventId=${id}&markets=${encodeURIComponent(m)}`);
    await odds(req, res);
  }
  globalThis.fetch = original;
  const ok = seen.size === 1;
  console.log(`${ok ? "  ok  " : " FAIL "} 3 orderings collapse to 1 cache key`);
  ok ? pass++ : fail++;
  if (!ok) for (const u of seen) console.log("        " + u);
  else console.log("        " + [...seen][0]);
}

console.log("\n── odds.js: rate limiter ──");
{
  const [, res] = mock("/api/odds?endpoint=events");
  let limited = false;
  for (let i = 0; i < 200; i++) {
    const [rq, rs] = mock("/api/odds?endpoint=events", { "x-forwarded-for": "9.9.9.9" });
    // Short-circuit before any network by using an invalid endpoint after limit.
    await odds(rq, rs);
    if (rs.statusCode === 429) { limited = true; break; }
  }
  console.log(`${limited ? "  ok  " : " FAIL "} 429 after burst from one IP`);
  limited ? pass++ : fail++;
  void res;
}

if (process.env.ODDS_LIVE === "1") {
  console.log("\n── odds.js: live upstream (spends credits) ──");
  await check("events", odds, "/api/odds?endpoint=events", { status: 200, cache: "s-maxage=120" });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
