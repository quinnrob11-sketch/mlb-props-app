import { fmt } from "../lib/format.js";
import VerdictChip from "./VerdictChip.jsx";

/**
 * NRFI board (bundle: `fh`) — one card per game that has a first-inning model.
 * A game only makes the list once both probable starters are known, which is
 * what `game.nrfi` being present encodes.
 */
export default function SlateView({ slate }) {
  const games = slate.games.filter((g) => g.nrfi);

  return games.length ? (
    <div className="cards">
      {games.map((g) => {
        const nrfi = g.nrfi;
        const edge = g.nrfiEdge;
        return (
          <div className="card" key={g.gamePk}>
            <div className="card-top">
              <div>
                <div className="card-title">
                  {g.away.abbr} @ {g.home.abbr}
                </div>
                <div className="card-sub">
                  {fmt.time(g.gameDate)} · {g.venue}
                  {g.wx?.indoor
                    ? " · dome"
                    : g.wx?.tempF != null
                      ? ` · ${g.wx.tempF}°F · ${g.wx.windMph}mph wind`
                      : ""}
                </div>
                <div className="card-sub">
                  {g.pitchers.map((p) => p.name).join(" vs ")}
                </div>
              </div>
              {edge ? <VerdictChip edge={edge} /> : null}
            </div>

            <div className="card-nums">
              <div className="stat">
                <span className="v pos">{fmt.pct(nrfi.nrfiProb)}</span>
                <span className="l">NRFI model</span>
              </div>
              <div className="stat">
                <span className="v">{fmt.odds(nrfi.fairNrfiOdds)}</span>
                <span className="l">Fair NRFI odds</span>
              </div>
              <div className="stat">
                <span className="v">{fmt.pct(nrfi.yrfiProb)}</span>
                <span className="l">YRFI model</span>
              </div>
              {g.nrfiLine && (
                <div className="stat">
                  <span className="v">{fmt.odds(g.nrfiLine.nrfiOdds)}</span>
                  <span className="l">
                    {g.nrfiLine.nrfiBook || g.nrfiLine.book} NRFI
                    {(g.nrfiLine.nBooks ?? 0) > 1
                      ? ` · best of ${g.nrfiLine.nBooks}`
                      : ""}
                  </span>
                </div>
              )}
            </div>

            {edge && edge.verdict !== "PASS" && (
              <div className="psub">
                Model edge on{" "}
                {edge.side === "under" ? "NRFI (under 0.5)" : "YRFI (over 0.5)"}
                : EV {fmt.ev(edge.ev)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  ) : (
    <div className="notice">
      <b>No NRFI models yet.</b>
      <div className="sub">
        NRFI needs both probable starters — check back when probables are
        posted.
      </div>
    </div>
  );
}
