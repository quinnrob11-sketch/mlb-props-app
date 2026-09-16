# Kalshi bot

Runs the MLB model against live Kalshi order books and places small orders
within hard limits. It runs on this PC, never on the website, and your Kalshi
key never leaves this machine.

**Nothing here has been shown to make money.** As of 2026-09-16 the model is
measurably noisier than the markets it trades (see CHANGELOG, v35–v35.1). The
limits below are sized so that being wrong is cheap. Read the journal before
you raise any of them.

## What it does on each run

1. Stops at once if `bot/STOP` exists, or if another run is in progress.
2. Projects today's slate. This uses the site's MLB data only and spends no Odds API credits.
3. Lists every open Kalshi MLB contract for today: game winner, run line, total,
   and player strikeouts, outs, hits, total bases, home runs, RBIs and H+R+RBI.
4. Prices each one with the model and blends the result toward the exchange. A
   model more than 12 points (props) or 8 points (game lines) from the market
   is treated as wrong and skipped.
5. Keeps only trades whose edge clears **Kalshi's fee plus 2 points**. It takes
   the best rung of each player's or game's ladder, and skips anything you
   already hold or anything within 10 minutes of first pitch.
6. Sizes with quarter-Kelly, then caps every order by the limits in the config.
7. Places **fill-or-cancel** orders, so nothing is left resting on the book.
   Every order ID is deterministic, so a re-run can't send the same order twice.
8. Writes every decision, placed or skipped with the reason, to `bot/state/<date>.jsonl`.

Batter props only trade once MLB posts the lineup. With the current fee and
safety settings, game lines rarely if ever clear the bar; that's intentional.

## Setup

1. **Config.** Copy `bot/config.example.json` to `bot/config.json`. It starts
   on `"env": "demo"` with `"live": false`.
2. **Dry run.** Run `npm run bot`. It prints the orders it would place and places none.
3. **Demo keys.** Create an account at https://demo.kalshi.co, generate an API
   key, and save the private key file **outside the repo**
   (e.g. `C:\Users\<you>\kalshi\demo-key.pem`). Then set:
   ```
   setx KALSHI_KEY_ID "your-key-id"
   setx KALSHI_PRIVATE_KEY_PATH "C:\Users\<you>\kalshi\demo-key.pem"
   ```
   (or fill `keyId` / `privateKeyPath` in `bot/config.json`, which git ignores).
   Open a new terminal afterwards.
4. **Demo live.** Set `"live": true`, then run `npm run bot:live`. It places real
   orders with fake money. Check them on demo.kalshi.co.
5. **Production.** Generate a production key at kalshi.com (Account → API keys),
   point the two variables at it, and set `"env": "prod"`. Keep `"live": true`
   and run `npm run bot:live` once while watching the output.
6. **Schedule.** From PowerShell in the repo folder:
   ```
   powershell -ExecutionPolicy Bypass -File bot\schedule-task.ps1 -Live
   ```
   This runs six times a day. Output goes to `bot/state/scheduler.log`.

## Limits (`bot/config.json` → `limits`)

| setting | default | meaning |
|---|---|---|
| `bankrollDollars` | 100 | the most of your balance it will size against |
| `maxOrderDollars` | 5 | cap on any single order |
| `maxGameExposureDollars` | 10 | cap across all positions in one game |
| `maxPlayerExposureDollars` | 5 | cap across all bets on one player (hits, total bases, H+R+RBI… count together) |
| `maxBetsPerPlayer` | 1 | how many different bets on one player, including ones already held |
| `maxOpenExposureDollars` | 40 | cap across everything open |
| `maxDailySpendDollars` | 30 | cap on new money per day |
| `maxDailyLossDollars` | 20 | halts for the day once account value is down this much |
| `maxOrdersPerRun` / `maxOrdersPerDay` | 5 / 15 | order-count caps |
| `minPriceCents` / `maxPriceCents` | 15 / 90 | skips longshots and near-certainties, where the model is least reliable |
| `minEdgeAfterFees` | 0.02 | required edge beyond the fee |

`markets.playerProps` and `markets.gameLines` switch each group on or off.

## Stopping

- **Right now:** create an empty file named `STOP` in `bot/`. Every run exits
  immediately until you delete it.
- **For good:** `Unregister-ScheduledTask -TaskName "MLB Kalshi Bot" -Confirm:$false`.
- Positions already open settle normally on Kalshi. The bot never sells.
