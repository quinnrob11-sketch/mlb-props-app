/**
 * Headless UI check for the DFS board, the venue click-through and the
 * maker/taker toggle.
 *
 * NOTHING HERE TOUCHES THE LIVE API. The slate is a synthetic fixture written
 * straight into `localStorage` under the app's own cache key, and `/api/kalshi`
 * is answered from a canned payload by the local server below. The only network
 * the browser sees is 127.0.0.1.
 *
 *   npm run build && node tools/e2e-ui.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const DIST = path.resolve("dist");
const PORT = 4271;
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
};

// ── the canned Kalshi book (never fetched from Kalshi) ──────────────────────
const KALSHI_MARKETS = {
  markets: [
    {
      ticker: "KXMLBTB-26JUL281945CHCSTL-STLPRAMIREZ-2",
      event_ticker: "KXMLBTB-26JUL281945CHCSTL",
      series_ticker: "KXMLBTB",
      title: "Pedro Ramirez: 2+ total bases",
      status: "active",
      yes_bid: 43,
      yes_ask: 47,
      no_bid: 53,
      no_ask: 57,
      volume: 1200,
      open_interest: 3400,
    },
  ],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/api/kalshi") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(KALSHI_MARKETS));
  }
  if (url.pathname.startsWith("/api/")) {
    res.writeHead(500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "live API is off-limits in this check" }));
  }
  let file = path.join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(DIST, "index.html");
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file)] || "application/octet-stream",
  });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

// ── the synthetic slate ─────────────────────────────────────────────────────

const today = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
})();
const firstPitch = new Date(Date.now() + 3 * 3600e3).toISOString();

const venue = (o) => ({
  multiplier: null,
  over: null,
  under: null,
  consensus: true,
  exact: false,
  granularity: null,
  link: null,
  ...o,
});

const KALSHI_URL =
  "https://kalshi.com/markets/kxmlbtb/-/kxmlbtb-26jul281945chcstl";

const slate = {
  date: today,
  loadedAt: new Date().toISOString(),
  remaining: null,
  skipped: 0,
  games: [
    {
      gameDate: firstPitch,
      away: { abbr: "PIT" },
      home: { abbr: "CHC" },
      pitchers: [
        {
          id: 1001,
          name: "Paul Skenes",
          teamAbbr: "PIT",
          hand: "R",
          oppAbbr: "CHC",
          flags: [],
          proj: { k: 7.4 },
          props: [
            {
              market: "pitcher_strikeouts",
              short: "K",
              label: "Strikeouts",
              distKey: "k",
              line: 6.5,
              book: "DK",
              overBook: "DK",
              underBook: "FD",
              nBooks: 4,
              over: -115,
              under: -105,
              proj: 7.4,
              edge: {
                modelOver: 0.61,
                usedOver: 0.58,
                fairOver: 0.52,
                vig: 0.043,
                twoSided: true,
                nBooks: 4,
                sharp: true,
                edge: 0.09,
                side: "over",
                sideEdge: 0.09,
                ev: 6.4,
                odds: -115,
                verdict: "STRONG",
                kelly: 0.021,
              },
              venue: {
                key: "draftkings",
                label: "DraftKings",
                kind: "book",
                link: "https://sportsbook.draftkings.com/event/123?outcome=abc",
                exact: true,
                granularity: "outcome",
              },
              venues: [
                venue({
                  key: "draftkings",
                  label: "DraftKings",
                  short: "DK",
                  kind: "book",
                  link: "https://sportsbook.draftkings.com/event/123?outcome=abc",
                  exact: true,
                  granularity: "outcome",
                  line: 6.5,
                  side: "over",
                  over: -115,
                  under: -105,
                }),
                venue({
                  key: "fanduel",
                  label: "FanDuel",
                  short: "FD",
                  kind: "book",
                  link: "https://sportsbook.fanduel.com/market/999",
                  exact: false,
                  granularity: "market",
                  line: 6.5,
                  side: "over",
                  over: -120,
                  under: +100,
                }),
                venue({
                  key: "novig",
                  label: "Novig",
                  short: "NVG",
                  kind: "exchange",
                  link: null,
                  exact: false,
                  granularity: null,
                  line: 6.5,
                  side: "over",
                  over: -104,
                  under: -106,
                  consensus: false,
                }),
                venue({
                  key: "prizepicks",
                  label: "PrizePicks",
                  short: "PP",
                  kind: "dfs",
                  link: "https://app.prizepicks.com",
                  exact: false,
                  granularity: "brand",
                  line: 6.5,
                  side: "over",
                  multiplier: 1.25,
                  consensus: false,
                }),
                venue({
                  key: "pick6",
                  label: "DraftKings Pick6",
                  short: "PK6",
                  kind: "dfs",
                  link: "https://pick6.draftkings.com",
                  exact: false,
                  granularity: "brand",
                  line: 7,
                  side: "over",
                  consensus: false,
                }),
                venue({
                  key: "betr_us_dfs",
                  label: "Betr Picks",
                  short: "BETR",
                  kind: "dfs",
                  link: "https://www.betr.app",
                  exact: false,
                  granularity: "brand",
                  line: 6.5,
                  side: "over",
                  consensus: false,
                }),
              ],
            },
          ],
        },
      ],
      batters: [
        {
          id: 2001,
          name: "Pedro Ramirez",
          teamAbbr: "CHC",
          slot: 3,
          batSide: "R",
          vs: "PIT",
          vsHand: "R",
          flags: [],
          proj: { tb: 1.9 },
          props: [
            {
              market: "batter_total_bases",
              short: "TB",
              label: "Total Bases",
              distKey: "tb",
              line: 1.5,
              book: "DK",
              overBook: "DK",
              underBook: "DK",
              nBooks: 3,
              over: 120,
              under: -140,
              proj: 1.9,
              edge: {
                modelOver: 0.6,
                usedOver: 0.56,
                fairOver: 0.5,
                vig: 0.038,
                twoSided: true,
                nBooks: 3,
                sharp: false,
                edge: 0.1,
                side: "over",
                sideEdge: 0.1,
                ev: 5.1,
                odds: 120,
                verdict: "SOLID",
                kelly: 0.014,
              },
              venue: {
                key: "draftkings",
                label: "DraftKings",
                kind: "book",
                link: "https://sportsbook.draftkings.com/event/777?outcome=zzz",
                exact: true,
                granularity: "outcome",
              },
              venues: [
                venue({
                  key: "draftkings",
                  label: "DraftKings",
                  short: "DK",
                  kind: "book",
                  link: "https://sportsbook.draftkings.com/event/777?outcome=zzz",
                  exact: true,
                  granularity: "outcome",
                  line: 1.5,
                  side: "over",
                  over: 120,
                  under: -140,
                }),
                venue({
                  key: "kalshi",
                  label: "Kalshi",
                  short: "KAL",
                  kind: "exchange",
                  link: KALSHI_URL,
                  exact: false,
                  granularity: "event",
                  line: 1.5,
                  side: "over",
                  over: 132,
                  under: -150,
                  consensus: false,
                }),
                venue({
                  key: "novig",
                  label: "Novig",
                  short: "NVG",
                  kind: "exchange",
                  link: null,
                  exact: false,
                  granularity: null,
                  line: 1.5,
                  side: "over",
                  over: 128,
                  under: -138,
                  consensus: false,
                }),
                venue({
                  key: "prizepicks",
                  label: "PrizePicks",
                  short: "PP",
                  kind: "dfs",
                  link: "https://app.prizepicks.com",
                  exact: false,
                  granularity: "brand",
                  line: 1.5,
                  side: "over",
                  multiplier: 1.9,
                  consensus: false,
                }),
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ── run ─────────────────────────────────────────────────────────────────────

const problems = [];
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) problems.push(label);
};

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(`CONSOLE: ${m.text()}`);
});

const base = `http://127.0.0.1:${PORT}/`;
await page.goto(base);
await page.evaluate((payload) => {
  localStorage.clear();
  localStorage.setItem("slateCacheV19", JSON.stringify(payload));
}, slate);
await page.goto(base, { waitUntil: "networkidle" });
await page.waitForSelector(".tabs .tab");

// 1 ── the DFS tab renders ---------------------------------------------------
const dfsTab = page.locator(".tab", { hasText: "DFS" }).first();
check((await dfsTab.count()) === 1, "DFS tab exists");
await dfsTab.click();
await page.waitForSelector(".dfscard");
const cards = page.locator(".dfscard");
check((await cards.count()) >= 1, "DFS board renders cards", `${await cards.count()} card(s)`);

const first = cards.first();
const playText = (await first.locator(".dfsplay").innerText()).trim();
const sitesText = (await first.locator(".dfssites").innerText()).replace(/\n+/g, " · ");
const whyText = (await first.locator(".dfswhy").innerText()).replace(/\n+/g, " ");
console.log(`      play  : ${playText}`);
console.log(`      sites : ${sitesText}`);
console.log(`      why   : ${whyText}`);
check(playText === "Paul Skenes OVER 6.5 K", "play reads in plain words", playText);
check(/½ point softer than Pick6/.test(whyText), "softest line explained in one phrase");
check(/indicative/i.test(whyText), "multiplier is marked indicative");
const bestSites = await first.locator(".dfssite.best").allInnerTexts();
const dimSites = await first.locator(".dfssite.off").allInnerTexts();
check(
  bestSites.length === 2 && dimSites.length === 1,
  "softest sites highlighted, the rest dimmed",
  `best=${JSON.stringify(bestSites)} dim=${JSON.stringify(dimSites)}`,
);
// The single-site row is labelled as such rather than implying a comparison.
const singleCard = page.locator(".dfscard", { hasText: "Pedro Ramirez" });
const singleWhy = (await singleCard.locator(".dfswhy").innerText()).trim();
console.log(`      single: ${singleWhy}`);
check(
  /Only PrizePicks lists this prop/.test(singleWhy) &&
    (await singleCard.locator(".flag", { hasText: "1 SITE ONLY" }).count()) === 1,
  "one-site row says so",
);
// Clutter stays behind the click.
check(
  (await first.locator(".dfsdetail").count()) === 0,
  "detail is hidden until asked for",
);
await first.locator(".dfsmore").click();
check(
  (await first.locator(".dfsdetail").count()) === 1,
  "detail opens on click",
);

await page.screenshot({ path: "shot-dfs.png" });

// 2 ── venue click-through on the main board ---------------------------------
await page.locator(".tab", { hasText: "BEST BETS" }).first().click();
await page.waitForSelector(".card .venues");
const skenes = page.locator(".card", { hasText: "Paul Skenes" }).first();
const chips = await skenes.locator(".vchip.v-venue").allInnerTexts();
console.log(`      venue chips: ${JSON.stringify(chips.map((c) => c.replace(/\n/g, " ")))}`);
check(chips.length === 6, "every venue at the line is listed", `${chips.length} chips`);

const novig = skenes.locator(".vchip.v-venue", { hasText: "NVG" }).first();
const novigText = (await novig.innerText()).replace(/\n/g, " ");
const novigTag = await novig.evaluate((el) => el.tagName);
const novigHref = await novig.evaluate((el) => el.getAttribute("href"));
console.log(`      novig: <${novigTag}> ${novigText} href=${novigHref}`);
check(/-104/.test(novigText), "novig price is shown", novigText);
check(novigTag === "SPAN" && novigHref === null, "novig is not a link");
check(/app only/i.test(novigText), "novig says why in one word");
check(
  (await skenes.locator("a.vchip.v-venue").count()) === 5,
  "the linkable venues are anchors",
);
const fd = skenes.locator("a.vchip.v-venue", { hasText: "FD" }).first();
check(
  (await fd.getAttribute("target")) === "_blank" &&
    (await fd.getAttribute("rel")) === "noopener noreferrer",
  "links open in a new tab with rel=noopener noreferrer",
);
check(
  /market page/.test(await fd.innerText()),
  "an inexact link says what it opens",
  (await fd.innerText()).replace(/\n/g, " "),
);

const ramirez = page.locator(".card", { hasText: "Pedro Ramirez" }).first();
const kal = ramirez.locator("a.vchip.v-venue", { hasText: "KAL" }).first();
const kalHref = await kal.getAttribute("href");
const kalText = (await kal.innerText()).replace(/\n/g, " ");
const kalTitle = await kal.getAttribute("title");
console.log(`      kalshi: ${kalText} -> ${kalHref}`);
console.log(`      kalshi title: ${kalTitle}`);
check(
  /^https:\/\/kalshi\.com\/markets\/[a-z0-9]+\/-\/[a-z0-9-]+$/.test(kalHref),
  "kalshi link carries the documented URL shape",
  kalHref,
);
check(/game page/.test(kalText), "kalshi chip says it opens the game page");
const note = (await ramirez.locator(".vnote").allInnerTexts()).join(" | ");
console.log(`      notes : ${note}`);
check(
  /opens the game page, find the player row/.test(note),
  "the non-exact wording is spelled out under the chips",
);
check(/app-only/.test(note), "novig's missing link is explained");

await page.screenshot({ path: "shot-venues.png" });

// 3 ── maker / taker ---------------------------------------------------------
const takerChip = page.locator(".modeswitch .chip", { hasText: "Taker" }).first();
const makerChip = page.locator(".modeswitch .chip", { hasText: "Maker" }).first();
check(
  (await takerChip.getAttribute("class")).includes("on") &&
    !(await makerChip.getAttribute("class")).includes("on"),
  "taker is the default",
);
await makerChip.click();
await page.waitForSelector(".maker");
check(
  (await page.evaluate(() => localStorage.getItem("priceModeV1"))) === "maker",
  "maker mode persists under priceModeV1",
);
const makerBlock = page.locator(".card", { hasText: "Pedro Ramirez" }).locator(".maker");
await page.waitForFunction(
  () => !/Loading the Kalshi book/.test(document.body.innerText),
  null,
  { timeout: 10000 },
);
const makerText = (await makerBlock.innerText()).replace(/\n+/g, " · ");
console.log(`      maker : ${makerText}`);
check(/43¢ \/ 47¢/.test(makerText), "the live bid/ask is shown", makerText);
check(/model fair/.test(makerText), "fair value is placed against the book");
check(/rest a bid at/.test(makerText), "a resting price is quoted");
check(/Display only/.test(makerText), "the panel says it is display only");
check(
  (await makerBlock.locator("button").count()) === 0,
  "the maker view has no control that could place an order",
);
const noBook = page.locator(".card", { hasText: "Paul Skenes" }).locator(".maker");
const noBookText = (await noBook.innerText()).replace(/\n+/g, " ");
console.log(`      no-book: ${noBookText}`);
check(
  /No order book/.test(noBookText) && /Switch to Taker/.test(noBookText),
  "a row without a book says so rather than inventing a spread",
);

await page.screenshot({ path: "shot-maker.png" });

// 4 ── persistence across a reload -------------------------------------------
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".modeswitch .chip");
const makerAfter = page.locator(".modeswitch .chip", { hasText: "Maker" }).first();
check(
  (await makerAfter.getAttribute("class")).includes("on"),
  "the toggle survives a reload",
);
await page.locator(".modeswitch .chip", { hasText: "Taker" }).first().click();
await page.reload({ waitUntil: "networkidle" });
await page.waitForSelector(".modeswitch .chip");
check(
  (await page.locator(".modeswitch .chip", { hasText: "Taker" }).first().getAttribute("class")).includes("on") &&
    (await page.evaluate(() => localStorage.getItem("priceModeV1"))) === "taker",
  "switching back persists too",
);

// 5 ── the prop table also carries venues ------------------------------------
await page.locator(".tab", { hasText: "PITCHERS" }).first().click();
await page.waitForSelector("td.venuecell");
const cellText = (await page.locator("td.venuecell").first().innerText()).replace(/\n+/g, " · ");
console.log(`      table cell: ${cellText}`);
check(/DK/.test(cellText) && /NVG/.test(cellText), "the table row is line-shoppable");
check(
  (await page.locator("td.venuecell span.vchip.v-venue.dead").count()) >= 1,
  "novig is un-clickable in the table too",
);

// 6 ── console --------------------------------------------------------------
check(consoleErrors.length === 0, "zero console errors", consoleErrors.join(" | "));

await browser.close();
server.close();

console.log(
  problems.length ? `\n${problems.length} FAILED: ${problems.join(", ")}` : "\nall checks passed",
);
process.exit(problems.length ? 1 : 0);
