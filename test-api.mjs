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
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=BATTER_HOME_RUNS,batter_hits,batter_hits&books=core`,
    `/api/odds?endpoint=event-odds&eventId=${id.toUpperCase()}&markets=batter_hits,batter_home_runs&books=CORE`,
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=batter_hits,batter_home_runs&books=+core+`,
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

console.log("\n── odds.js: named book sets ──");
{
  // Assert helper for the non-status checks in this section.
  const t = (name, ok, detail) => {
    console.log(`${ok ? "  ok  " : " FAIL "} ${name}`);
    if (!ok) { console.log("        " + (detail ?? "")); fail++; } else pass++;
  };

  // Run the handler with fetch stubbed; hand back the upstream URL it built.
  async function upstreamFor(url) {
    process.env.ODDS_API_KEY = "test";
    const original = globalThis.fetch;
    let seen = null;
    globalThis.fetch = async (u) => {
      seen = String(u);
      return { ok: true, status: 200, headers: new Map(), text: async () => "[]" };
    };
    const [req, res] = mock(url);
    try { await odds(req, res); } finally { globalThis.fetch = original; }
    return { res, seen, q: seen ? new URL(seen).searchParams : null };
  }

  const WIDE = [
    "betmgm", "betr_us_dfs", "caesars", "draftkings", "fanduel",
    "kalshi", "novig", "pick6", "pinnacle", "prizepicks",
  ];
  const CORE = ["betmgm", "caesars", "draftkings", "fanduel", "pinnacle"];
  const id = "d".repeat(32);
  const mk = "batter_hits";
  const req_ = (books) =>
    `/api/odds?endpoint=event-odds&eventId=${id}&markets=${mk}` +
    (books === null ? "" : `&books=${books}`);

  // ── 1. books=wide sends exactly the 10 expected keys, plus both flags ──────
  {
    const { res, seen, q } = await upstreamFor(req_("wide"));
    const got = (q?.get("bookmakers") || "").split(",").filter(Boolean);
    t("books=wide -> exactly the 10 expected bookmaker keys",
      res.statusCode === 200 &&
      got.length === 10 &&
      got.join(",") === WIDE.join(","),
      `got ${got.length}: ${got.join(",")}`);
    t("books=wide -> pins bookmakers, never regions",
      q?.has("bookmakers") === true && q?.has("regions") === false,
      String(seen).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));
    t("books=wide -> includeLinks=true & includeMultipliers=true",
      q?.get("includeLinks") === "true" && q?.get("includeMultipliers") === "true",
      String(seen).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));
    console.log("        " + String(seen).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));
  }

  // ── 2. the include flags are fixed, so every mode gets them ───────────────
  {
    const core = await upstreamFor(req_("core"));
    t("books=core -> unchanged 5 keys, and both include flags still on",
      (core.q?.get("bookmakers") || "") === CORE.join(",") &&
      core.q?.get("includeLinks") === "true" &&
      core.q?.get("includeMultipliers") === "true",
      String(core.seen).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));

    const all = await upstreamFor(req_("all"));
    t("books=all -> still regions=us,us2 (back-compat), no bookmakers",
      all.q?.get("regions") === "us,us2" && all.q?.has("bookmakers") === false,
      String(all.seen).replace(/apiKey=[^&]*/, "apiKey=REDACTED"));

    // A caller cannot turn the flags off, so they cannot fragment the cache.
    const off = await upstreamFor(req_("wide") + "&includeLinks=false");
    t("caller-supplied includeLinks=false is stripped by the 308, not honoured",
      off.res.statusCode === 308 &&
      off.res.headers["location"] === req_("wide") &&
      off.seen === null,
      `status ${off.res.statusCode} loc ${off.res.headers["location"]}`);
  }

  // ── 3. unknown books values are rejected, not silently coerced ────────────
  for (const bad of ["bogus", "us", "wide,core", "WIDE2", "regions"]) {
    await check(`books=${bad} rejected`, odds, req_(encodeURIComponent(bad)), { status: 400 });
  }

  // ── 4. books participates in canonicalisation ────────────────────────────
  {
    // Every spelling that resolves to a mode must land on that mode's single
    // canonical URL — and the two modes must not collide.
    const groups = {
      wide: [req_("wide"), req_("WIDE"), req_("+wide+"), req_(null), req_("")],
      core: [req_("core"), req_("CORE"), req_("%20core")],
    };
    const canonicalOf = {};
    let ok = true, detail = [];
    process.env.ODDS_API_KEY = "test";
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => "[]" });
    try {
      for (const [mode, urls] of Object.entries(groups)) {
        const targets = new Set();
        for (const u of urls) {
          const [rq, rs] = mock(u);
          await odds(rq, rs);
          // The already-canonical spelling serves 200; the rest must 308 to it.
          if (rs.statusCode === 308) targets.add(rs.headers["location"]);
          else if (rs.statusCode !== 200) { ok = false; detail.push(`${u} -> ${rs.statusCode}`); }
        }
        if (targets.size !== 1) { ok = false; detail.push(`${mode}: ${[...targets]}`); }
        canonicalOf[mode] = [...targets][0];
      }
    } finally { globalThis.fetch = original; }
    t("wide/core each collapse to exactly one canonical URL", ok, detail.join(" | "));
    t("wide and core are DIFFERENT cache keys",
      canonicalOf.wide !== canonicalOf.core &&
      canonicalOf.wide === req_("wide") &&
      canonicalOf.core === req_("core"),
      `${canonicalOf.wide} vs ${canonicalOf.core}`);
  }

  // ── 5. the canonical wide URL serves 200 and never redirects ─────────────
  {
    const { res, q } = await upstreamFor(req_("wide"));
    const stable = res.statusCode === 200 &&
      !res.headers["location"] &&
      (res.headers["cache-control"] || "").includes("s-maxage=60") &&
      (q?.get("bookmakers") || "").split(",").length === 10;
    t("canonical books=wide URL serves 200, no Location, 10 books",
      stable,
      `${res.statusCode} ${res.headers["cache-control"]} ${res.headers["location"]}`);

    // Re-feeding the redirect target must be a fixed point for every mode.
    for (const mode of ["core", "wide", "all"]) {
      const first = mock(req_(mode.toUpperCase()));
      await odds(first[0], first[1]);
      const target = first[1].statusCode === 308 ? first[1].headers["location"] : req_(mode);
      const again = await upstreamFor(target);
      t(`books=${mode}: redirect target is a fixed point (no loop)`,
        again.res.statusCode === 200 && !again.res.headers["location"],
        `${target} -> ${again.res.statusCode}`);
    }
  }
}

if (process.env.ODDS_LIVE === "1") {
  console.log("\n── odds.js: live upstream (spends credits) ──");
  await check("events", odds, "/api/odds?endpoint=events", { status: 200, cache: "s-maxage=120" });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
