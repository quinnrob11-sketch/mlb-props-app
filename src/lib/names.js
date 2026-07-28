/**
 * Player identity and stat-payload plumbing.
 *
 * Reconstructed from the minified bundle (`/tmp/work/app.js`, lines 622-673).
 * Minified origins: `Ri` = normalizeName, `Zp` = chunk (see the warning below),
 * `rr` = pickSplit, `Jp` = pickGameLogSplits, `rl` = fetchPlayerStats.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GLOSSARY DISCREPANCY - `Zp` is NOT `nameMatches`.
 *
 * The glossary maps `Zp` to `nameMatches`. The actual body of `Zp` at line 632
 * is a generic array chunker with no name handling in it whatsoever, and its
 * only call site (`fetchPlayerStats`) uses it to split person-id lists into
 * batches of 35. It has been reconstructed under its real name, `chunk`.
 *
 * There is no `nameMatches` function anywhere in the bundle. In the original,
 * odds-feed names were reconciled with MLB records by exact equality of
 * `normalizeName` output used as an object key - which merged two players who
 * share a full name and silently returned nothing for any spelling divergence
 * (LINES-ANALYSIS.md section 1).
 *
 * FIXED: this module now carries a real identity layer - `nameVariants` /
 * `matchName` (tiered, symmetric matching) plus `teamKey` / `playerIdKey` for
 * id- and team-based disambiguation. `matchName` never picks a winner out of a
 * tie: an ambiguous name is reported as such so `attachLines` can drop it and
 * hand the name back to the caller instead of pricing the wrong player.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mlbFetch } from "./api.js";

/** Generational suffixes dropped from the end of a name. */
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * Letters NFD cannot decompose (the diacritic is part of the glyph, not a
 * combining mark). Without these, "Jurickson Profar" style names are fine but
 * "Kevin Gausman" vs "Ødegaard"-shaped strings diverge between feeds.
 */
const TRANSLITERATE = {
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  þ: "th",
  ŋ: "n",
};

/**
 * Canonicalise a player name so that the odds feed and the MLB roster agree.
 *
 * Steps, in order:
 *   1. `Last, First` is re-ordered to `First Last` (single comma only, both
 *      sides non-empty). The MLB roster and several odds feeds disagree on
 *      this, and the old implementation turned "Smith, Will" into the key
 *      "smith will", which matched nothing.
 *   2. NFKD-decompose, strip combining marks ("Peña" -> "Pena") and
 *      transliterate the glyphs NFKD cannot split (ø, đ, ł, æ, ß, ...).
 *   3. Lowercase.
 *   4. Apostrophes are deleted ("O'Neill" -> "oneill"); every other
 *      non-letter (periods, hyphens, commas, digits) becomes a space, so
 *      "Jung-hoo Lee" -> "jung hoo lee" and "Michael A. Taylor" ->
 *      "michael a taylor". Hyphen-as-space is a deliberate change from the
 *      original hyphen-as-nothing: it makes the hyphenated and spaced
 *      spellings of the same name agree.
 *   5. Trailing generational suffixes are popped token-by-token, so they are
 *      removed no matter how they are punctuated or how much trailing
 *      whitespace follows them ("Acuna Jr. ", "Tatis Jr", "Robert Jr. II").
 *
 * The function is idempotent: `normalizeName(normalizeName(x)) === normalizeName(x)`.
 *
 * @param {string|null|undefined} name - Raw display name from either feed.
 * @returns {string} Normalised key. Empty string for null/undefined input.
 */
export function normalizeName(name) {
  let text = String(name ?? "");
  if (!text) return "";

  // 1. "Last, First" -> "First Last".
  const commaParts = text.split(",");
  if (
    commaParts.length === 2 &&
    commaParts[0].trim() &&
    commaParts[1].trim()
  ) {
    text = `${commaParts[1].trim()} ${commaParts[0].trim()}`;
  }

  // 2-3. decompose, transliterate, lowercase.
  text = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[øđðłæœßþŋ]/g, (ch) => TRANSLITERATE[ch] || ch);

  // 4. apostrophes vanish, everything else non-alphabetic becomes a gap.
  text = text.replace(/['’`´ʼ]/g, "").replace(/[^a-z]+/g, " ");

  // 5. pop trailing suffixes.
  const tokens = text.split(" ").filter(Boolean);
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/**
 * @typedef {object} NameVariants
 * @property {string} exact - `normalizeName` output.
 * @property {string} noMiddle - Single-letter interior tokens dropped, so
 *   "luis l ortiz" and "luis ortiz" agree.
 * @property {string} squashed - All spaces removed, so "jung hoo lee" and
 *   "junghoo lee" agree.
 * @property {string} initialLast - First name reduced to its initial, so
 *   "w smith" and "will smith" agree. This is the loosest tier and is the one
 *   most likely to report an ambiguity rather than a match.
 */

/**
 * Every key a name is allowed to match on, weakest last.
 *
 * Matching is symmetric: two names match at a tier when *both* sides produce
 * the same string for that tier, so the tiers can be compared field by field
 * without caring which side is the query.
 *
 * @param {string|null|undefined} name
 * @returns {NameVariants|null} null when the name normalises to nothing.
 */
export function nameVariants(name) {
  const exact = normalizeName(name);
  if (!exact) return null;
  const tokens = exact.split(" ");
  const interior = tokens.slice(1, -1).filter((t) => t.length > 1);
  const noMiddle =
    tokens.length > 2
      ? [tokens[0], ...interior, tokens[tokens.length - 1]].join(" ")
      : exact;
  return {
    exact,
    noMiddle,
    squashed: noMiddle.split(" ").join(""),
    initialLast:
      tokens.length > 1
        ? `${tokens[0][0]} ${tokens[tokens.length - 1]}`
        : exact,
  };
}

/** Tier order used by `matchName`, strongest first. */
export const MATCH_TIERS = ["exact", "noMiddle", "squashed", "initialLast"];

/**
 * @typedef {object} NameMatch
 * @property {"matched"|"ambiguous"|"missing"} status
 * @property {string|null} key - The single winning candidate, when matched.
 * @property {string|null} tier - Which tier produced the decision.
 * @property {string[]} candidates - Every candidate that tied at `tier`.
 *   Length > 1 exactly when `status` is "ambiguous".
 */

/**
 * Resolve a name against a pool of already-canonical candidate keys.
 *
 * Tiers are tried strongest-first and the first tier that produces any hit
 * decides the outcome. A tier that produces more than one hit is reported as
 * AMBIGUOUS rather than silently resolved - the caller is expected to
 * disambiguate with a team or an MLB id, or to drop the player and report it.
 *
 * @param {string|null|undefined} name - Raw or canonical name to look up.
 * @param {Iterable<string>} candidateKeys - Canonical keys present in the index.
 * @returns {NameMatch}
 */
export function matchName(name, candidateKeys) {
  const query = nameVariants(name);
  const miss = { status: "missing", key: null, tier: null, candidates: [] };
  if (!query) return miss;

  const candidates = [];
  for (const key of candidateKeys || []) {
    const variants = nameVariants(key);
    if (variants) candidates.push({ key, variants });
  }

  for (const tier of MATCH_TIERS) {
    const hits = candidates.filter((c) => c.variants[tier] === query[tier]);
    if (!hits.length) continue;
    const keys = [...new Set(hits.map((h) => h.key))];
    return keys.length === 1
      ? { status: "matched", key: keys[0], tier, candidates: keys }
      : { status: "ambiguous", key: null, tier, candidates: keys.sort() };
  }
  return miss;
}

/**
 * Canonicalise a team hint. Accepts an id, an abbreviation or a full name;
 * two hints only ever *narrow* a candidate set when they compare equal, so a
 * mismatch of representation (id vs abbreviation) never drops a player, it
 * just fails to disambiguate.
 *
 * @param {string|number|null|undefined} team
 * @returns {string} Empty string when there is no usable hint.
 */
export function teamKey(team) {
  if (team == null) return "";
  if (typeof team === "object") {
    return teamKey(team.abbreviation ?? team.name ?? team.id);
  }
  return String(team).trim().toLowerCase();
}

/**
 * Stable identity key for an MLB person id. Used as the primary join whenever
 * both feeds can supply an id - it is the only join that cannot collide.
 *
 * @param {string|number|null|undefined} id
 * @returns {string|null}
 */
export function playerIdKey(id) {
  return id == null || id === "" ? null : `mlb:${id}`;
}

/**
 * Split an array into consecutive fixed-size chunks.
 *
 * The glossary calls this `nameMatches`; it is not. See the file header.
 *
 * @template T
 * @param {T[]} items - Source array.
 * @param {number} size - Maximum chunk length.
 * @returns {T[][]} Chunks, the last of which may be shorter than `size`.
 */
export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Pull one season's stat line out of a hydrated MLB `people` record.
 *
 * The hydration returns an array of stat blocks; the one we want has a matching
 * group displayName ("pitching" / "hitting") and type displayName "season".
 * Inside it, prefer the split whose `season` equals the requested year, and
 * otherwise fall back to the first split.
 *
 * TODO(recon): the fallback is immediately re-checked by the guard
 * `if (split && String(split.season) === String(season))`, so a first-split
 * fallback for a *different* season is discarded and the function returns null.
 * The `|| splits[0]` branch is therefore dead for any purpose other than
 * avoiding an undefined dereference - the effective behaviour is "exact season
 * match or nothing".
 *
 * Note also the `return` inside the loop only fires on a successful match, so a
 * record with two blocks of the same group/type falls through to the second.
 *
 * @param {object|null|undefined} person - Hydrated `people[]` entry.
 * @param {"pitching"|"hitting"} group - Stat group display name.
 * @param {number|string} season - Season to extract.
 * @returns {object|null} The raw `stat` object, or null if not present.
 */
export function pickSplit(person, group, season) {
  for (const block of person?.stats || []) {
    if (
      block.group?.displayName === group &&
      block.type?.displayName === "season"
    ) {
      const split =
        block.splits?.find((s) => String(s.season) === String(season)) ||
        block.splits?.[0];
      if (split && String(split.season) === String(season)) return split.stat;
    }
  }
  return null;
}

/**
 * Pull the per-game log splits out of a hydrated MLB `people` record.
 *
 * This is the `Jp` the glossary asks to be identified. It is the gameLog
 * sibling of `pickSplit`: same group filter, but `type.displayName === "gameLog"`,
 * and it returns the whole splits array rather than a single `stat`.
 *
 * Callers use it for recent-form work (`projectPitcher` filters it down to
 * splits with `gamesStarted > 0` to derive innings, pitch count, batters faced
 * and strikeouts per start).
 *
 * Unlike `pickSplit` there is no season check here at all - the gameLog is only
 * ever hydrated for the current season, so whatever comes back is trusted.
 *
 * @param {object|null|undefined} person - Hydrated `people[]` entry.
 * @param {"pitching"|"hitting"} group - Stat group display name.
 * @returns {object[]} Game-log splits, or an empty array when absent.
 */
export function pickGameLogSplits(person, group) {
  for (const block of person?.stats || []) {
    if (
      block.group?.displayName === group &&
      block.type?.displayName === "gameLog"
    )
      return block.splits || [];
  }
  return [];
}

/** Person ids per `people` request. Keeps the upstream URL under its length cap. */
const PEOPLE_CHUNK_SIZE = 35;

/**
 * Fetch hydrated stats for a set of player ids, in batches.
 *
 * Ids are de-duplicated and falsy entries dropped before chunking, so a lineup
 * that repeats a player (or a slot with no id) costs nothing.
 *
 * TODO(recon): the batches are awaited sequentially inside the loop rather than
 * issued in parallel, so a 4-batch lookup serialises 4 round trips. The four
 * top-level `fetchPlayerStats` calls in `loadSlate` *are* parallelised against
 * each other via `Promise.all`, so this only costs latency within one call.
 *
 * @param {Array<number|string>} ids - MLB person ids.
 * @param {"pitching"|"hitting"} group - Stat group to hydrate.
 * @param {number} season - Season to hydrate.
 * @param {boolean} includeGameLog - Also hydrate per-game splits. Much larger
 *   payload; only requested for current-season pitchers.
 * @returns {Promise<Map<number, object>>} personId -> hydrated person record.
 *   Ids the upstream does not return are simply absent from the map.
 */
export async function fetchPlayerStats(ids, group, season, includeGameLog) {
  const byId = new Map();
  for (const batch of chunk([...new Set(ids)].filter(Boolean), PEOPLE_CHUNK_SIZE)) {
    const types = includeGameLog ? "season,gameLog" : "season";
    const payload = await mlbFetch(
      `/api/v1/people?personIds=${batch.join(",")}` +
        `&hydrate=stats(group=[${group}],type=[${types}],season=${season})`,
    );
    for (const person of payload.people || []) byId.set(person.id, person);
  }
  return byId;
}
