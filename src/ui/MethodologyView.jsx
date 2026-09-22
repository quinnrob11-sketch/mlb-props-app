/**
 * METHOD tab (bundle: `yh`) — static prose describing the engine. No props,
 * no state; every number quoted here is documented in the model modules.
 */
export default function MethodologyView() {
  return (
    <div className="doc">
      <h3>Game lines: moneyline, run line, total, first inning</h3>
      <p>
        The game model plays the game out inning by inning and returns the chance of every
        possible final score, so the moneyline, run line, total and NRFI all come from one
        consistent picture rather than four separate guesses. Each half-inning's scoring is
        set by the batting team's offence (season runs per game, park-neutral, adjusted for
        tonight's lineup), the pitcher on the mound (the starter for his projected innings,
        then the bullpen — both ERA/FIP blends shrunk toward league average) and the park and
        temperature.
      </p>
      <p>
        It handles the parts of baseball that simple run models get wrong: the home team skips
        the bottom of the ninth when it leads, walk-offs end the game on the winning run,
        extra innings start with a runner on second, and the bottom of the first scores about
        a third more than the top. Fitted to 2,271 completed 2026 games, two average teams come
        out at a 52.9% home win rate (actual 52.9%), 36.0% home −1.5 cover (36.0%), 49.7% over
        8.5 (49.1%) and 50.1% NRFI (49.5%).
      </p>
      <p>
        <b>How far to trust it:</b> matching league averages is the easy part. Against live
        Kalshi prices on 2026-09-16 the model was a median 3.1 points away on moneylines and
        3.2 on totals, with no lean in either direction — close to the market, but not sharper
        than it. So game lines carry a low market weight, and any disagreement bigger than 8
        points is treated as the model being wrong. Prices come from DraftKings, FanDuel,
        BetMGM, Caesars and Pinnacle when the Odds API key works, and from Kalshi (fees
        included) always.
      </p>

      <h3>Does any of this beat the market?</h3>
      <p>
        Not so far, and this is the most important thing on the page. Every settled Kalshi
        contract between 10 July and 15 September 2026 was replayed with the model's own
        probabilities, the same filters this board uses, and the price actually available two
        hours before first pitch — then scored against how each game really ended, after fees.
      </p>
      <p>
        <b>Pitcher props:</b> 623 trades, <code>−4.0%</code> return (strikeouts alone{' '}
        <code>−7.8%</code>). <b>Batter props:</b> 609 trades, <code>−3.4%</code>. In all seven
        markets the exchange's price forecast results better than the model, measured by Brier
        score, and mixing the model into the price never helped: the best mix gave the model
        0–25% of the say. As of v36.2 that is what the board gives it: the
        per-market weights are now the measured ones, 0 for strikeouts and home
        runs, 0.15 for total bases and RBIs, 0.10 everywhere else.
      </p>
      <p>
        <b>What that changes.</b> At a weight of 0.10 the model can move a price by at most 1.5
        points, and the smallest call on the board needs 3. So the model can no longer call a bet
        by disagreeing with the market — on a typical slate this takes the board from ~95 plays
        to about 3. What is left are the rows where <i>one book's price is out of line with the
        other books</i>. That is a real edge and it is not the model's opinion; it is the only
        kind these tests found support for. The Kalshi bot, which has one venue and so nothing to
        shop against, now places nothing at all.
      </p>
      <p>
        The projections themselves are sound — they match real outcomes closely, and this round
        fixed a bug that had openers projected as full starts. Matching outcomes is not the same
        as beating a price. The fair reading is that the market already knows what this model
        knows. Use the board to see where the model and the market disagree and why, not as a
        list of profitable bets, and let <b>Results</b> decide before you risk money.
      </p>
      <p>
        Game lines (moneyline, run line, total) are marked information only for the same reason,
        and the Kalshi bot in the repo paper-trades every market by default: it records what it
        would have done and grades it later, without placing an order.
      </p>

      <h3>Then is it just paying too much to trade?</h3>
      <p>
        No — that was measured too, because it is the obvious escape hatch. Crossing the
        spread costs about <code>1.13c</code> per contract and the exchange fee another{' '}
        <code>1.53c</code>, so resting an order instead of taking the price is worth at most{' '}
        <code>2.66c</code>. The trades lose <code>1.73c</code>. Perfect execution would not
        cover it, and execution is never perfect: re-running 1,040 real decisions as resting
        orders, the ones that <i>would</i> have filled returned −6.2% when taken at the ask
        while the ones that would not have filled returned +1.6%. You get filled when the
        market is moving against you. Leaving orders out two hours into the game returns
        −7.7%, the single clearest result in any of these tests, and it is clearly bad.
      </p>
      <p>
        The pitcher <b>outs</b> market got the same treatment, with the test written down
        before the profits were computed. It fails: +3.8% over 145 trades with an interval
        from −11.9% to +19.1%, positive in one half of the sample and negative in the other.
        One honest curiosity survived — on those same contracts every simple rule lost
        money, including taking the market's own side — but separating that from luck needs
        about 2,300 trades, which is five seasons at this rate. It stays on paper.
      </p>

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
        a blend: <code>p = fair + w × (model − fair)</code>, keeping only{' '}
        <b>0–15%</b> of the model's disagreement with the market — the weight measured on
        155,000 settled contracts, not a judgement about how well each market is modelled. It
        used to be 30–55%, which the same measurement showed was about four times too much.
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
