import { useState } from "react";
import {
  DEFAULT_NOVIG_STAKE,
  loadLinkPrefs,
  saveLinkPrefs,
} from "../lib/venues.js";

/**
 * Settings dialog (bundle: `gh`). Local draft state; nothing is persisted
 * until Save, which hands the three values back to the App.
 */
export default function SettingsModal({
  oddsKey,
  bankroll,
  sharp,
  onSave,
  onClose,
}) {
  const [keyDraft, setKeyDraft] = useState(oddsKey);
  const [bankrollDraft, setBankrollDraft] = useState(bankroll);
  const [sharpDraft, setSharpDraft] = useState(sharp);
  const prefs = loadLinkPrefs();
  const [novigStakeDraft, setNovigStakeDraft] = useState(
    prefs.novigStake ?? DEFAULT_NOVIG_STAKE,
  );
  const [mgmStateDraft, setMgmStateDraft] = useState(prefs.mgmState ?? "");

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>

        <label>Bankroll (units) — used for ¼-Kelly stake suggestions</label>
        <input
          type="number"
          min="1"
          value={bankrollDraft}
          onChange={(e) => setBankrollDraft(Number(e.target.value) || 100)}
        />

        <label>Novig prefilled stake ($) — the ↗ chip loads the order slip with this amount; nothing is placed</label>
        <input
          type="number"
          min="1"
          value={novigStakeDraft}
          onChange={(e) => setNovigStakeDraft(Number(e.target.value) || DEFAULT_NOVIG_STAKE)}
        />

        <label>BetMGM state code (e.g. oh, az) — needed for MGM exact-bet links; leave blank to use the game page</label>
        <input
          type="text"
          maxLength={2}
          placeholder="oh"
          value={mgmStateDraft}
          onChange={(e) => setMgmStateDraft(e.target.value)}
        />

        <label className="check">
          <input
            type="checkbox"
            checked={sharpDraft}
            onChange={(e) => setSharpDraft(e.target.checked)}
          />
          <span>
            Sharp mode — Pinnacle anchor + alternate lines (≈2–3× odds credits
            per refresh)
          </span>
        </label>

        <label>The Odds API key override (optional)</label>
        <input
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder="Uses the server's configured key when blank"
        />
        <p className="hint">
          The server already has a key configured. Paste a key here only if you
          rotate keys or hit quota — it's stored in this browser only and sent
          per-request, never published.
        </p>

        <div className="row">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              saveLinkPrefs({
                novigStake: novigStakeDraft,
                mgmState: mgmStateDraft.trim().toLowerCase(),
              });
              onSave(keyDraft.trim(), bankrollDraft, sharpDraft);
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
