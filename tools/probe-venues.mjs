// Diagnostic: does The Odds API actually return player props for the exchange
// and DFS venue keys, and are the deep links usable?  Run: node tools/probe-venues.mjs
//
// Spends ONE event-odds credit-unit (5 bookmakers = 1 region-equivalent); the
// events lookup that picks a game is free. The key is read from `.env.local`
// (ODDS_API_KEY=...) in the current directory or from $ODDS_API_KEY — never
// from the command line, and never printed, not even inside an error body.

import { readFileSync } from "node:fs";

const UPSTREAM = "https://api.the-odds-api.com/v4";
const SPORT = "baseball_mlb";
const VENUES = ["kalshi", "novig", "prizepicks", "pick6", "betr_us_dfs"];
const MARKETS = ["batter_hits", "pitcher_strikeouts"];

function readKey() {
  if (process.argv.length > 2) {
    die("this tool takes no arguments — put ODDS_API_KEY in .env.local so the key never lands in your shell history");
  }
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?ODDS_API_KEY\s*=\s*(.*)$/);
      if (m) {
        const v = m[1].trim().replace(/^(['"])(.*)\1$/, "$2").trim();
        if (v) return v;
      }
    }
  } catch { /* no .env.local; fall through to the environment */ }
  const env = (process.env.ODDS_API_KEY || "").trim();
  if (env) return env;
  die("no API key: add ODDS_API_KEY=... to .env.local in this directory, or export it");
}

function die(msg) {
  console.error(`\nprobe-venues: ${msg}\n`);
  process.exit(1);
}

// Never let a key reach stdout/stderr, even inside an upstream error body.
const scrub = (s, key) => String(s).split(key).join("<KEY>");

async function get(url, key, label) {
  const u = new URL(url);
  u.searchParams.set("apiKey", key);
  let resp, body;
  try {
    resp = await fetch(u.toString(), { headers: { accept: "application/json" } });
    body = await resp.text();
  } catch (e) {
    die(`${label} request failed: ${e.message}`);
  }
  if (!resp.ok) die(`${label} returned HTTP ${resp.status}: ${scrub(body, key).slice(0, 300)}`);
  try {
    return { data: JSON.parse(body), headers: resp.headers };
  } catch {
    die(`${label} returned non-JSON: ${scrub(body, key).slice(0, 200)}`);
  }
}

// ── run ──────────────────────────────────────────────────────────────────────

const key = readKey();

const events = (await get(`${UPSTREAM}/sports/${SPORT}/events?dateFormat=iso`, key, "events")).data;
if (!Array.isArray(events) || !events.length) die("no MLB events on the board right now");

// Prefer the next game that has not started; otherwise just take the first.
const now = Date.now();
const event =
  events.filter((e) => new Date(e.commence_time) > now)
        .sort((a, b) => new Date(a.commence_time) - new Date(b.commence_time))[0] || events[0];

console.log(`\nevent  ${event.away_team} @ ${event.home_team}`);
console.log(`       ${event.id}  ${event.commence_time}`);
console.log(`books  ${VENUES.join(", ")}`);
console.log(`mkts   ${MARKETS.join(", ")}  (includeLinks + includeMultipliers on)`);

const oddsUrl = new URL(`${UPSTREAM}/sports/${SPORT}/events/${event.id}/odds`);
oddsUrl.searchParams.set("bookmakers", VENUES.join(","));
oddsUrl.searchParams.set("markets", MARKETS.join(","));
oddsUrl.searchParams.set("oddsFormat", "american");
oddsUrl.searchParams.set("dateFormat", "iso");
oddsUrl.searchParams.set("includeLinks", "true");
oddsUrl.searchParams.set("includeMultipliers", "true");

const { data: odds, headers } = await get(oddsUrl.toString(), key, "event-odds");

console.log(`\ncost   x-requests-last=${headers.get("x-requests-last") ?? "?"}` +
  `  remaining=${headers.get("x-requests-remaining") ?? "?"}` +
  `  used=${headers.get("x-requests-used") ?? "?"}`);

const byKey = new Map((odds.bookmakers || []).map((b) => [b.key, b]));

// ── per-bookmaker table ──────────────────────────────────────────────────────
const rows = VENUES.map((venue) => {
  const bk = byKey.get(venue);
  if (!bk) return { venue, seen: "no", markets: "—", point: "—", price: "—", link: "—" };

  const mkts = bk.markets || [];
  const outs = mkts.flatMap((m) => m.outcomes || []);
  const names = new Set(outs.map((o) => String(o.name || "").toLowerCase()));
  const twoSided = names.has("over") && names.has("under");
  const multi = outs.filter((o) => typeof o.multiplier === "number");
  const priced = outs.filter((o) => o.price !== undefined && o.price !== null);

  const nodes = [bk, ...mkts, ...outs];
  const link = nodes.some((x) => x && x.link) ? "link" : "";
  const sid = nodes.some((x) => x && x.sid) ? "sid" : "";
  let price = "none";
  if (twoSided) price = `two-sided (${priced.length} px)`;
  else if (multi.length) price = `multiplier x${multi[0].multiplier}`;
  else if (priced.length) price = `one-way (${priced.length} px)`;

  return {
    venue,
    seen: "YES",
    markets: mkts.length ? mkts.map((m) => `${m.key}(${(m.outcomes || []).length})`).join(" ") : "none",
    point: outs.some((o) => o.point !== undefined && o.point !== null) ? "yes" : "no",
    price,
    link: [link, sid].filter(Boolean).join("+") || "none",
  };
});

const cols = [["venue", 12], ["seen", 5], ["point", 6], ["price", 22], ["link", 9], ["markets", 40]];
const line = (r) => cols.map(([c, w]) => String(r[c]).padEnd(w)).join(" ");
console.log("\n" + line(Object.fromEntries(cols.map(([c]) => [c, c.toUpperCase()]))));
console.log(cols.map(([, w]) => "-".repeat(w)).join(" "));
for (const r of rows) console.log(line(r));

// ── verdict ──────────────────────────────────────────────────────────────────
const present = rows.filter((r) => r.seen === "YES" && r.markets !== "none");
const exchanges = present.filter((r) => ["kalshi", "novig"].includes(r.venue));
const dfs = present.filter((r) => ["prizepicks", "pick6", "betr_us_dfs"].includes(r.venue));
const linked = present.filter((r) => r.link !== "none");

console.log("\nVERDICT");
console.log(
  exchanges.length
    ? `  Exchanges DO carry these props: ${exchanges.map((r) => r.venue).join(", ")}.`
    : "  Exchanges (kalshi, novig) returned NO props for these markets — do not plan around them.",
);
console.log(
  dfs.length
    ? `  DFS venues returned props: ${dfs.map((r) => r.venue).join(", ")} ` +
      `(${dfs.every((r) => r.price.startsWith("multiplier")) ? "multipliers, not two-sided prices" : "mixed price shapes"}).`
    : "  DFS venues (prizepicks, pick6, betr_us_dfs) returned NO props for these markets.",
);
console.log(
  linked.length
    ? `  Deep links are usable: ${linked.length}/${present.length} responding venues carried a link and/or sid.`
    : "  No deep links or sids came back — includeLinks bought nothing here.",
);
console.log("");
