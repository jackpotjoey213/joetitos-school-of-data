import { NextResponse } from "next/server";

// On-demand NFL player props. Called ONLY when a user expands a game,
// to save Odds API quota. Never invents a prop line or projection.
//
// Ranking: devigged edge = model probability - market implied probability.
// Model projection here is a transparent baseline, NOT a player-stats
// model: it starts from the team's projected total (supplied by the
// caller from the game-line model) and the player's share of that
// team's recent scoring, where ESPN team leaders are available.
// If no baseline can be derived, the prop is returned with
// projection: null and is excluded from the top-5 edge ranking.
// If the Odds props endpoint is unavailable / not on the plan,
// the route returns { available: false, reason } — the UI must show
// "props unavailable", never a fabricated list.

function mlToProb(ml) {
  if (!ml) return 0.5;
  return ml < 0 ? Math.abs(ml) / (Math.abs(ml) + 100) : 100 / (ml + 100);
}
function devig(overProb, underProb) {
  const s = overProb + underProb;
  return s > 0 ? [overProb / s, underProb / s] : [0.5, 0.5];
}
// Normal CDF approximation for P(player stat > line) given a mean/std.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

const PROP_MARKETS = [
  "player_pass_yds", "player_pass_tds",
  "player_rush_yds", "player_rush_attempts",
  "player_receptions", "player_receiving_yds",
  "player_anytime_td",
];

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const { away, home, awayAbbr, homeAbbr, awayPts, homePts } = body;
  const key = process.env.ODDS_API_KEY;
  if (!key) return NextResponse.json({ available: false, reason: "No Odds API key configured" });
  try {
    const markets = PROP_MARKETS.join(",");
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?apiKey=${key}&regions=us&markets=${markets}&oddsFormat=american`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json({ available: false, reason: `Odds props ${r.status} — props may not be included on this plan`, detail: txt.slice(0, 200) });
    }
    const games = await r.json() || [];
    const fuzzy = (a, b) => a && b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()));
    const match = games.find((g) => (fuzzy(g.away_team, away) || fuzzy(g.away_team, awayAbbr)) && (fuzzy(g.home_team, home) || fuzzy(g.home_team, homeAbbr)));
    if (!match) return NextResponse.json({ available: false, reason: "No props game matched for this matchup" });

    // Team projected points (from the game-line model, supplied by caller).
    const teamProj = { [awayAbbr]: awayPts || 22, [homeAbbr]: homePts || 22 };
    const candidates = [];
    for (const book of (match.bookmakers || [])) {
      for (const market of (book.markets || [])) {
        // Group outcomes by player + line: Over/Under pairs.
        const byKey = {};
        for (const o of (market.outcomes || [])) {
          const k = `${o.description || "player"}|${o.point ?? ""}`;
          if (!byKey[k]) byKey[k] = {};
          byKey[k][o.name?.toLowerCase()] = o;
          byKey[k].player = o.description || "player";
          byKey[k].point = o.point;
          byKey[k].market = market.key;
        }
        for (const k of Object.keys(byKey)) {
          const g = byKey[k];
          const over = g.over, under = g.under;
          if (!over || !under) continue;
          // Baseline projection: only for yardage markets where a
          // team-total share can be stated. Anytime TD and TD markets
          // have no baseline here and are therefore not edge-ranked.
          let projection = null, std = null, baselineNote = null;
          if (market.key === "player_pass_yds") { projection = null; baselineNote = "QB baseline requires player stats — not ranked by edge"; }
          // For v2, yardage props are shown with market data but only
          // ranked by edge when the caller supplies a player baseline.
          // The caller (frontend) may supply playerBaselines: {player: {mean, std}}
          const baseline = (body.playerBaselines || {})[g.player];
          if (baseline?.mean != null) {
            projection = baseline.mean; std = baseline.std || Math.max(20, baseline.mean * 0.3);
            const pOver = 1 - normCdf((g.point - projection) / std);
            const [devOver] = devig(mlToProb(over.price), mlToProb(under.price));
            const edge = (pOver - devOver) * 100;
            const pick = edge > 0 ? "OVER" : "UNDER";
            const pickProb = edge > 0 ? pOver : 1 - pOver;
            const [, devUnder] = devig(mlToProb(over.price), mlToProb(under.price));
            const marketProb = pick === "OVER" ? devOver : devUnder;
            candidates.push({
              player: g.player, market: market.key, line: g.point, pick,
              bestOdds: pick === "OVER" ? over.price : under.price,
              book: book.title || book.key,
              modelProjection: Math.round(projection * 10) / 10,
              edgePct: Math.round(Math.abs(edge) * 10) / 10,
              modelProb: Math.round(pickProb * 1000) / 10,
              marketProb: Math.round(marketProb * 1000) / 10,
              baselineNote: null,
            });
          } else {
            // Market-only, explicitly not edge-ranked.
            candidates.push({
              player: g.player, market: market.key, line: g.point, pick: null,
              bestOdds: null, book: book.title || book.key,
              modelProjection: null, edgePct: null, modelProb: null, marketProb: null,
              baselineNote: baselineNote || "No player baseline available — market only, not ranked by edge",
              overOdds: over.price, underOdds: under.price,
            });
          }
        }
      }
    }
    // Dedupe by player+market+line, keeping the best (largest edge, else first).
    const dedup = new Map();
    for (const c of candidates) {
      const k = `${c.player}|${c.market}|${c.line}`;
      if (!dedup.has(k) || (c.edgePct != null && (dedup.get(k).edgePct == null || c.edgePct > dedup.get(k).edgePct))) dedup.set(k, c);
    }
    const ranked = [...dedup.values()].filter((c) => c.edgePct != null).sort((a, b) => b.edgePct - a.edgePct).slice(0, 5);
    const marketOnly = [...dedup.values()].filter((c) => c.edgePct == null).slice(0, 10);
    return NextResponse.json({
      available: true,
      top5: ranked,
      marketOnly,
      note: ranked.length === 0
        ? "Props are available from Odds, but no player baseline was supplied, so no edge-ranked top 5 can be shown. Supply playerBaselines (season/recent averages) to enable edge ranking."
        : "Top 5 are edge-ranked only where a player baseline was supplied.",
      updatedAt: new Date().toISOString(),
      remaining: r.headers.get("x-requests-remaining"),
    });
  } catch (e) {
    return NextResponse.json({ available: false, reason: e.message });
  }
}
