# Joetito's School of Data — v2 (NBA + NFL only)

Local-only revamp branch: `revamp-nba-nfl-v2`. Nothing here has been
pushed to GitHub or deployed to Vercel by the agent — the owner repushes
manually.

## What changed in v2
- Removed World Cup, MLB, and NCAAB from the UI and production code,
  including their API routes, MLB-only libraries, and `mlb_value_bets.py`.
- Production data sources only: ESPN (scores, standings, team stats),
  Odds API (game lines, and player props on demand), and Open-Meteo
  weather for NFL stadiums. No API-SPORTS, KenPom, Gemini, or LLM injury data.
- No placeholder 0 odds/lines. Missing ESPN or Odds data shows the game
  with an amber flag and no locked pick — the game is not hidden and no
  fake line is used.
- Pregame picks only are locked and graded. Live projections are a
  separate, untracked module (spread + total only, no moneyline lean).

## Models
### NBA — kept pace/PPG model, improved
- ESPN standings PPG/OPPG, blended 70% season / 30% last-7-days recent
  form when a team has >=3 recent finals.
- Pace = PPG / league PPP, offense adjusted by opponent defense,
  back-to-back (-2.5) and 3-in-4 (-4.0) penalties, +3 home court,
  playoff pace/intensity dampeners.
- Win probability: 60% market moneyline + 40% model spread.
- Hardcoded 2025-26 fallback stats were REMOVED. If ESPN has no stats
  for a team, that game gets "Stats unavailable — no pick locked".

### NFL — new, analogous not copied
- Opponent-adjusted PPG: expected points = average of own offense and
  opponent's points allowed, +2.0 home field (not basketball's +3).
- Rest: short week (<5 days) -1.5, bye +1.0. Long travel (>=2000 mi) -0.5.
- Weather via Open-Meteo at the home stadium: wind >=15 mph -3 total,
  >=25 mph -5, cold <20F -1. Domes skip weather entirely.
- Win probability: same 60% market / 40% model-spread blend as NBA.
- Limits: no player-level, injury, or depth-chart data; no EPA model
  yet. A precomputed nflverse/EPA rating set is a documented future
  improvement — it is NOT invented here.

## Trackers (pregame only)
- Ledger: Supabase `predictions` + `user_settings` via `/api/settings`.
  If Supabase env vars are absent, the API returns
  `trackerAvailable: false` and the UI shows "tracker unavailable"
  instead of a fake "0 games tracked".
- Grading: O/U, ATS, and ML are graded separately. A total exactly
  equal to the line is a push (null, not a win/loss).
- UI per league: Yesterday / Last 7 Days / Season, with record, win %,
  sample size n, average total error, per-market streak, and an
  expandable per-game log (locked line, model projection, actual, result).
  Small samples (<20 games) carry an explicit warning.

## NFL top 5 props (on-demand)
- Fetched only when a user expands an NFL game, via `/api/nfl-props`
  (Odds API player-prop markets).
- Ranked by devigged edge ONLY where a player baseline is supplied.
  In v2, no player baseline is invented from team stats, so if Odds
  props are available but no baseline exists, the UI shows market
  props with "not edge-ranked" and explains why — it does not show a
  fake top 5.
- If the Odds props endpoint is unavailable or not on the plan
  (props are a higher Odds tier than basic game lines), the UI shows
  "props unavailable" with the reason.

## Parlay builder (ladder, total back)
- Inputs: starting stake, goal total back including stake, number of
  steps, reinvest %.
- Outputs: required total multiplier, per-step multiplier and American
  odds, a step-by-step ladder table, implied probability, and a
  model probability from selected legs where available.
- Correlated same-game legs trigger a warning. A ladder resets on a
  losing step. No auto-betting, no stake advice beyond the entered math.

## Live bets (separate, untracked)
- Spread + total only. No moneyline lean, no tracking, no ledger writes.
- Anchor: the locked pregame model total/margin. Projected final =
  points scored so far + expected remaining points, where remaining
  points use time remaining and actual scoring pace vs expected pace,
  clamped to 0.7–1.3 to avoid blowout distortion.
- Withheld when: overtime, clock/period missing, or no locked pregame
  model. If no real live line is available, the UI shows
  "projection only — no live line available" — it never presents a
  stale pregame line as a live line.
- Last-updated timestamp is shown; data older than 2 minutes is flagged
  as stale.

## Run locally
```bash
npm install
npm run build
npm run dev
```

## Env vars (names only — never commit values)
- `ODDS_API_KEY` — Odds API. Game lines need at least the main-markets
  plan; player props need a props-included plan. Without a key,
  Odds-dependent features correctly show as unavailable.
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  — Supabase ledger. Without these, the tracker shows "unavailable"
  and pregame picks still lock locally in the browser, but are not
  persisted server-side.

## What is stubbed / flagged as unavailable
- NFL player-prop edge ranking without a player baseline (see above).
- Live lines: v2 has no live-odds source wired in, so live output is
  projection-only by design.
- nflverse/EPA ratings: not included; would need a precomputed weekly
  file, not a live API call.
- ESPN is unofficial and can change without notice — every ESPN/Odds
  failure is surfaced in the source-health line, not hidden.
