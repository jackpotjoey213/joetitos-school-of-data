import { NextResponse } from "next/server";

// Copy core functions from mlb-refresh
const PARK_FACTORS = {
  COL:1.18,CIN:1.08,TEX:1.06,BOS:1.05,CHC:1.04,PHI:1.03,BAL:1.03,MIL:1.02,
  ATL:1.02,MIN:1.01,ARI:1.01,LAA:1.00,DET:1.00,CLE:1.00,TOR:0.99,WSH:0.99,
  PIT:0.99,KC:0.98,SEA:0.98,STL:0.98,SF:0.97,SD:0.97,HOU:0.97,NYY:0.97,
  CHW:0.96,CWS:0.96,TB:0.96,NYM:0.96,OAK:0.95,MIA:0.95,LAD:0.96
};
const TM={ARI:"ARI",AZ:"ARI",ATL:"ATL",BAL:"BAL",BOS:"BOS",CHC:"CHC",CUB:"CHC",CHW:"CWS",CWS:"CWS",CIN:"CIN",CLE:"CLE",COL:"COL",DET:"DET",HOU:"HOU",KC:"KC",KCR:"KC",LAA:"LAA",ANA:"LAA",LAD:"LAD",MIA:"MIA",FLA:"MIA",MIL:"MIL",MIN:"MIN",NYM:"NYM",NYY:"NYY",OAK:"OAK",ATH:"OAK",PHI:"PHI",PIT:"PIT",SD:"SD",SDP:"SD",SF:"SF",SFG:"SF",SEA:"SEA",STL:"STL",TB:"TB",TBR:"TB",TEX:"TEX",TOR:"TOR",WSH:"WSH",WAS:"WSH"};
function norm(a){return a?TM[a.toUpperCase()]||a.toUpperCase():"";}

function pythagWinPct(rs, ra) {
  if (!rs || !ra || ra === 0) return 0.5;
  const exp = 1.83;
  return Math.pow(rs, exp) / (Math.pow(rs, exp) + Math.pow(ra, exp));
}

function log5WinProb(pA, pB) {
  if (!pA || !pB) return 0.5;
  return (pA * (1 - pB)) / (pA * (1 - pB) + pB * (1 - pA));
}

function mlToProb(ml) { if (!ml) return 0.5; return ml < 0 ? Math.abs(ml)/(Math.abs(ml)+100) : 100/(ml+100); }
function probToAmericanOdds(p) { if (p >= 0.5) return Math.round(-100 * p / (1 - p)); return Math.round(100 * (1 - p) / p); }

// Fetch completed games from last 7 days via MLB Stats API
async function fetchRecentGames(days = 7) {
  const games = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];
    try {
      const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team,linescore`, { cache: "no-store" });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const dt of (data.dates || [])) {
        for (const g of (dt.games || [])) {
          if (g.status?.abstractGameState !== "Final") continue;
          const away = g.teams?.away, home = g.teams?.home;
          const ls = g.linescore;
          games.push({
            date: dateStr,
            gamePk: g.gamePk,
            awayAbbr: norm(away?.team?.abbreviation || ""),
            homeAbbr: norm(home?.team?.abbreviation || ""),
            awayName: away?.team?.name || "",
            homeName: home?.team?.name || "",
            awayScore: ls?.teams?.away?.runs ?? away?.score ?? 0,
            homeScore: ls?.teams?.home?.runs ?? home?.score ?? 0,
            awayPitcher: away?.probablePitcher ? { name: away.probablePitcher.fullName, id: away.probablePitcher.id } : null,
            homePitcher: home?.probablePitcher ? { name: home.probablePitcher.fullName, id: home.probablePitcher.id } : null,
            awayRecord: `${away?.leagueRecord?.wins||0}-${away?.leagueRecord?.losses||0}`,
            homeRecord: `${home?.leagueRecord?.wins||0}-${home?.leagueRecord?.losses||0}`,
          });
        }
      }
    } catch (e) { console.log(`Failed to fetch ${dateStr}:`, e.message); }
  }
  return games;
}

// Fetch standings (RS/RA for Pythagorean)
async function fetchStandings() {
  try {
    const resp = await fetch("https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2026&standingsTypes=regularSeason&hydrate=team", { cache: "no-store" });
    if (!resp.ok) return {};
    const data = await resp.json();
    const teams = {};
    for (const rec of (data.records || [])) {
      for (const tr of (rec.teamRecords || [])) {
        const abbr = norm(tr.team?.abbreviation || "");
        const rs = tr.runsScored || 0, ra = tr.runsAllowed || 0;
        const gp = (tr.wins || 0) + (tr.losses || 0) || 1;
        teams[abbr] = { rs, ra, gp, rpg: +(rs/gp).toFixed(2), rapg: +(ra/gp).toFixed(2), pyth: pythagWinPct(rs, ra) };
      }
    }
    return teams;
  } catch { return {}; }
}

// Fetch pitcher season stats (lightweight - just ERA/WHIP)
async function fetchPitcherERA(pid) {
  if (!pid) return null;
  try {
    let resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2026&group=pitching`);
    let s = (await resp.json()).stats?.[0]?.splits?.[0]?.stat;
    if (!s || !s.inningsPitched || s.inningsPitched === "0.0") {
      resp = await fetch(`https://statsapi.mlb.com/api/v1/people/${pid}/stats?stats=season&season=2025&group=pitching`);
      s = (await resp.json()).stats?.[0]?.splits?.[0]?.stat;
    }
    if (!s) return null;
    return { era: parseFloat(s.era) || 4.50, whip: parseFloat(s.whip) || 1.35 };
  } catch { return null; }
}

// Fetch historical odds for a specific date (we can't get historical odds from free API, so we'll estimate from the scores/standings)
// For the backtest, we'll use the current standings Pythagorean as a proxy for what the model would have predicted

export async function GET(req) {
  const startTime = Date.now();
  
  try {
    // Step 1: Fetch recent completed games + standings
    const [games, standings] = await Promise.all([
      fetchRecentGames(7),
      fetchStandings()
    ]);

    if (games.length === 0) {
      return NextResponse.json({ error: "No completed games found in last 7 days", games: [] });
    }

    // Step 2: For each game, get pitcher ERA (limit to avoid timeout)
    const gamesToProcess = games.slice(0, 30); // Cap at 30 games to stay in timeout
    
    // Fetch pitcher stats in parallel (batch of 30 max = 60 API calls)
    const pitcherPromises = [];
    for (const g of gamesToProcess) {
      if (g.awayPitcher?.id) pitcherPromises.push(fetchPitcherERA(g.awayPitcher.id).then(s => ({ gamePk: g.gamePk, side: "away", stats: s })));
      if (g.homePitcher?.id) pitcherPromises.push(fetchPitcherERA(g.homePitcher.id).then(s => ({ gamePk: g.gamePk, side: "home", stats: s })));
    }
    const pitcherResults = await Promise.all(pitcherPromises);
    const pitcherMap = {};
    for (const p of pitcherResults) {
      if (!pitcherMap[p.gamePk]) pitcherMap[p.gamePk] = {};
      pitcherMap[p.gamePk][p.side] = p.stats;
    }

    // Step 3: Generate theoretical predictions for each game
    const analyzed = [];
    let ouCorrect = 0, ouTotal = 0;
    let mlCorrect = 0, mlTotal = 0;
    let valueBets = [], valueWins = 0, valuePL = 0;
    let totalDivergence = 0;

    for (const g of gamesToProcess) {
      const awayTeam = standings[g.awayAbbr];
      const homeTeam = standings[g.homeAbbr];
      const pm = pitcherMap[g.gamePk] || {};
      const awayERA = pm.away?.era || 4.50;
      const homeERA = pm.home?.era || 4.50;
      const parkFactor = PARK_FACTORS[g.homeAbbr] || 1.0;
      const actualTotal = g.awayScore + g.homeScore;
      const awayWon = g.awayScore > g.homeScore;

      // Pythagorean
      const awayPyth = awayTeam?.pyth || 0.5;
      const homePyth = homeTeam?.pyth || 0.5;

      // Log-5 win probability
      const log5Away = log5WinProb(awayPyth, homePyth);
      const log5Home = 1 - log5Away;

      // Pitcher model total
      const awayStRuns = (awayERA / 9) * 5.5;
      const homeStRuns = (homeERA / 9) * 5.5;
      const bpRuns = 1.8;
      const earlySzn = Math.max(1, Math.floor((new Date(g.date).getTime() - new Date("2026-03-27").getTime()) / 86400000));
      const earlyFactor = earlySzn <= 14 ? 0.95 : 1.0;

      const homeScores = (awayStRuns + bpRuns * 0.9) * parkFactor * earlyFactor;
      const awayScores = (homeStRuns + bpRuns) * earlyFactor;
      const modelTotal = Math.round((homeScores + awayScores) * 10) / 10;

      // Estimate what Vegas line would have been (use actual total as proxy for now, adjust by 0.5 for standard deviation)
      // In a real backtest, we'd have historical odds. Since we don't, we'll use a rough estimate.
      const estimatedLine = Math.round((modelTotal + actualTotal) / 2 * 10) / 10; // midpoint between model and actual as line proxy
      
      // O/U prediction
      const ouCall = modelTotal > estimatedLine ? "OVER" : modelTotal < estimatedLine ? "UNDER" : "PUSH";
      const ouActual = actualTotal > estimatedLine ? "OVER" : actualTotal < estimatedLine ? "UNDER" : "PUSH";
      const ouHit = ouCall === ouActual;
      if (ouCall !== "PUSH") { ouTotal++; if (ouHit) ouCorrect++; }

      // ML prediction (Log-5)
      const mlPick = log5Home > log5Away ? g.homeAbbr : g.awayAbbr;
      const mlActual = awayWon ? g.awayAbbr : g.homeAbbr;
      const mlHit = mlPick === mlActual;
      mlTotal++;
      if (mlHit) mlCorrect++;

      // Divergence
      const divergence = modelTotal - actualTotal;
      totalDivergence += Math.abs(divergence);

      // Value bet check: Compare our model probability to implied odds
      // We use Log-5 as our model probability
      const modelFavProb = Math.max(log5Away, log5Home);
      const modelFavAbbr = log5Home > log5Away ? g.homeAbbr : g.awayAbbr;
      const modelOdds = probToAmericanOdds(modelFavProb);
      // Rough market line estimation based on team records
      const marketFavProb = Math.max(awayPyth, homePyth); // Simplified
      const marketOdds = probToAmericanOdds(marketFavProb);
      
      // Value = our model thinks team is better than market implies
      const isValueBet = Math.abs(modelFavProb - marketFavProb) > 0.05 && modelFavProb > marketFavProb;
      if (isValueBet) {
        const valueWon = modelFavAbbr === mlActual;
        valueBets.push({
          date: g.date,
          game: `${g.awayAbbr} @ ${g.homeAbbr}`,
          pick: modelFavAbbr,
          modelProb: `${(modelFavProb * 100).toFixed(1)}%`,
          marketProb: `${(marketFavProb * 100).toFixed(1)}%`,
          edge: `${((modelFavProb - marketFavProb) * 100).toFixed(1)}%`,
          result: valueWon ? "WIN" : "LOSS",
          payout: valueWon ? (modelOdds > 0 ? modelOdds : Math.round(10000 / Math.abs(modelOdds))) : -100
        });
        if (valueWon) valueWins++;
        valuePL += valueWon ? (modelOdds > 0 ? modelOdds : Math.round(10000 / Math.abs(modelOdds))) : -100;
      }

      analyzed.push({
        date: g.date,
        game: `${g.awayAbbr} @ ${g.homeAbbr}`,
        score: `${g.awayScore}-${g.homeScore}`,
        actualTotal,
        modelTotal,
        divergence: divergence.toFixed(1),
        estimatedLine,
        ouCall,
        ouActual,
        ouHit,
        log5: `${g.awayAbbr} ${(log5Away*100).toFixed(0)}% / ${g.homeAbbr} ${(log5Home*100).toFixed(0)}%`,
        mlPick,
        mlActual,
        mlHit,
        awayPyth: (awayPyth * 100).toFixed(0) + "%",
        homePyth: (homePyth * 100).toFixed(0) + "%",
        awayERA,
        homeERA,
        parkFactor,
        awayPitcher: g.awayPitcher?.name || "Unknown",
        homePitcher: g.homePitcher?.name || "Unknown"
      });
    }

    const elapsed = Date.now() - startTime;

    return NextResponse.json({
      backtest: {
        period: "Last 7 days",
        sampleSize: analyzed.length,
        executionTime: `${elapsed}ms`,
        
        // O/U Performance
        ouRecord: `${ouCorrect}-${ouTotal - ouCorrect}`,
        ouWinRate: ouTotal > 0 ? `${(ouCorrect / ouTotal * 100).toFixed(1)}%` : "N/A",
        ouNote: "Using midpoint of model+actual as estimated line (no historical odds available)",
        
        // ML Performance (Log-5)
        mlRecord: `${mlCorrect}-${mlTotal - mlCorrect}`,
        mlWinRate: mlTotal > 0 ? `${(mlCorrect / mlTotal * 100).toFixed(1)}%` : "N/A",
        
        // Divergence
        avgDivergence: analyzed.length > 0 ? `${(totalDivergence / analyzed.length).toFixed(1)} runs` : "N/A",
        avgDivergenceNote: "Average absolute difference between model total and actual total",

        // Value Bets
        valueBets: {
          total: valueBets.length,
          wins: valueWins,
          losses: valueBets.length - valueWins,
          winRate: valueBets.length > 0 ? `${(valueWins / valueBets.length * 100).toFixed(1)}%` : "N/A",
          profitLoss: `$${valuePL}`,
          profitLossNote: "Based on flat $100 bet on each value opportunity",
          bets: valueBets
        },

        // Model insights
        modelInsights: {
          avgModelTotal: analyzed.length > 0 ? (analyzed.reduce((a, g) => a + g.modelTotal, 0) / analyzed.length).toFixed(1) : "N/A",
          avgActualTotal: analyzed.length > 0 ? (analyzed.reduce((a, g) => a + g.actualTotal, 0) / analyzed.length).toFixed(1) : "N/A",
          modelBias: analyzed.length > 0 ? `${(analyzed.reduce((a, g) => a + parseFloat(g.divergence), 0) / analyzed.length).toFixed(2)} runs (${analyzed.reduce((a, g) => a + parseFloat(g.divergence), 0) > 0 ? "model runs HIGH" : "model runs LOW"})` : "N/A",
          gamesWithPitcherData: analyzed.filter(g => g.awayPitcher !== "Unknown" || g.homePitcher !== "Unknown").length,
          gamesWithoutPitcherData: analyzed.filter(g => g.awayPitcher === "Unknown" && g.homePitcher === "Unknown").length,
        }
      },
      games: analyzed
    });

  } catch (e) {
    return NextResponse.json({ error: e.message, stack: e.stack?.split("\n").slice(0, 3) }, { status: 500 });
  }
}
