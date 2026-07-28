/**
 * METHOD tab (bundle: `yh`) — static prose describing the engine. No props,
 * no state; every number quoted here is documented in the model modules.
 */
export default function MethodologyView() {
  return (
    <div className="doc">
      <h3>What the engine does</h3>
      <p>
        Every projection is built from live MLB Stats API data at load time — no
        stale hardcoded stats. For each probable starter it pulls the 2026
        season line, the full 2026 game log, and the 2025 season as a prior; for
        each batter in a posted lineup it pulls 2026 + 2025 batting lines; for
        each opponent it pulls the team's actual K/BB/AVG/OBP rates; and league
        averages are recomputed from all 30 teams on every load.
      </p>

      <h3>Rates: empirical-Bayes blending</h3>
      <p>
        Small samples are the #1 way prop models embarrass themselves. Every
        rate (K%, BB%, H/BF, HR/BF, per-PA hitting rates) is blended:{" "}
        <code>2026 data + 0.6 × 2025 data + league-average prior</code>. A
        rookie with 20 great innings gets pulled toward league average; a
        veteran's full season dominates the prior.
      </p>

      <h3>Workload: real pitch budgets</h3>
      <p>
        Innings and pitch counts come from the pitcher's actual recent usage: a
        recency-weighted average of the last five starts' real pitch counts sets
        the budget, real pitches-per-batter and on-base-rate-allowed convert
        that into batters faced and innings:{" "}
        <code>BF/IP = 3 ÷ P(out per PA)</code>,{" "}
        <code>IP = budget ÷ (pitches/BF × BF/IP)</code>, blended 60/40 with
        recent actual IP. This is what fixes overcooked pitch counts and outs
        projections.
      </p>

      <h3>Adjustments</h3>
      <p>
        Opponent K% (40% weight), opponent BB tendency (30%), opponent AVG
        (35%), platoon splits (±5%), and Statcast-style park factors applied at
        70% of their deviation (K factors at 50%). Batters get an
        opposing-starter quality adjustment weighted by the ~60% of PAs that
        come against the starter.
      </p>

      <h3>Probabilities, not gut feel</h3>
      <p>
        Each prop is priced with a real distribution: strikeouts are a binomial{" "}
        <b>mixed over batters-faced uncertainty</b> (a single binomial
        understates K variance — measured on 433 real starts), outs recorded are
        normal around projected IP (σ = 3.8 outs, matching the measured
        residual), hits/walks are Poisson, ER/RBI/H+R+RBI/steals are
        negative-binomial with audit-tuned dispersion, runs are Poisson
        (verified against 2,025 real batter-games), and total bases uses an
        exact dynamic-programming distribution.
      </p>

      <h3>Market-respecting pricing — Pinnacle-anchored consensus</h3>
      <p>
        Every book quoting the prop (DraftKings, FanDuel, BetMGM, Caesars,{" "}
        <b>Pinnacle</b>) is <b>devigged independently</b> at the consensus line,
        and the fair probability is a weighted average — Pinnacle, the sharpest
        book in the market, carries <b>3× weight</b>, so fair value is anchored
        on the sharp price and retail quirks wash out. The bet is then priced on
        a blend: <code>p = fair + w × (model − fair)</code>, keeping only 30–55%
        of the model's disagreement with the market (per-market weights re-tuned
        from the calibration audit). This is what separates a real edge finder
        from a fake +90% EV machine.
      </p>

      <h3>Best-price EV + alternate lines</h3>
      <p>
        EV is computed at the{" "}
        <b>best available price per side across all books</b> — the card tells
        you which book has it. Alternate-line ladders (K 4.5/5.5/6.5…) are
        priced too, but the board stays clean: at most{" "}
        <b>one ALT rung per market</b>, only when it actually grades as
        callable, and only when the <b>ALT lines toggle</b> is on. Toggled off,
        alts still get snapshotted and graded in RESULTS.
      </p>

      <h3>CLV — the real scoreboard</h3>
      <p>
        The first time a prop appears, its call and price are frozen as your
        bet-time record; every later refresh updates the closing-line store.
        RESULTS then shows <b>closing line value</b>: how your price compares to
        the last pre-game price. Beating the close consistently predicts
        long-term profit better than any short-term win rate. Tip: refresh once
        when you bet (morning) and once near first pitch — that's what makes the
        CLV number sharp.
      </p>

      <h3>Weather</h3>
      <p>
        Game-time temperature and wind are pulled per park (domes excluded). Air
        temperature moves fly-ball carry ≈0.6% HR probability per °F vs a 72°F
        baseline — it's applied to HR/TB distributions and the NRFI run
        environment. Wind speed is shown on cards; 12+ mph games deserve a
        manual look at direction.
      </p>

      <h3>¼-Kelly staking</h3>
      <p>
        Each callable edge shows a suggested stake:{" "}
        <code>f* = (p·b − q)/b</code> at quarter strength (full Kelly assumes
        your probabilities are perfect — nobody's are). Set your bankroll in ⚙
        Settings; suggestions scale to it.
      </p>

      <h3>Calls — tightened (v19.2)</h3>
      <p>
        <code>STRONG</code> = EV ≥ 10% and side edge ≥ 7 points, priced
        two-sided by 2+ books. <code>SOLID</code> = EV ≥ 5% and edge ≥ 5.{" "}
        <code>LEAN</code> = EV ≥ 2.5% and edge ≥ 3. Beyond that, four trust
        guards from a 433-start / 15k-prop calibration audit: model-vs-market
        disagreement is <b>clamped at ±15 points</b> (bigger gaps mean the book
        knows something — capped at LEAN), one-sided quotes cap at LEAN,
        single-book STRONGs downgrade, and anything past +250 is untouchable.
        Small samples never exceed LEAN. NRFI is anchored at the league's ~54%
        base rate. OVER calls are green, UNDER calls are red — everywhere.
      </p>

      <h3>Backtested, three times</h3>
      <p>
        Pitchers: 231 real starts replayed with pre-date game logs — the model
        beat the naive baseline on every stat and measured biases were
        corrected. Hitters: 2,025 real batter-games — every quoted probability
        lands within 1 point of observed frequency. Tail audit: 433 starts + 15k
        batter props bucketed by claimed confidence — pooled batter buckets
        calibrate within ±1.7pts; pitcher K/ER overconfidence found and
        corrected via market weights and dispersion. Forward tracking: every
        slate you load is snapshotted and auto-graded in RESULTS.
      </p>

      <h3>Data sources</h3>
      <p>
        MLB Stats API (schedule, probables, lineups, all player/team stats, box
        scores) · The Odds API (DK + FD + MGM + CZR + Pinnacle, both-side prices
        + alternate lines in every refresh; sharp mode ≈2–3× credits, toggle in
        Settings) · Open-Meteo (game-time temp/wind per park) · Statcast-style
        park factor table (refresh each April from Baseball Savant).
      </p>

      <p className="hint" style={{ color: "var(--faint)", fontSize: 12 }}>
        For entertainment/research. Bet responsibly.
      </p>
    </div>
  );
}
