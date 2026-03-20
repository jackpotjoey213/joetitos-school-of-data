import { NextResponse } from "next/server";
import { getTeamStats, kenpomPredict } from "@/lib/teamStats";

// --- DATA SOURCES ---

async function fetchOddsAPI() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No Odds API key configured", games: [] };
  try {
    // Try odds endpoint first
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`
    );
    const remaining = resp.headers.get("x-requests-remaining");
    
    if (!resp.ok) {
      const errText = await resp.text();
      return { error: `Odds API ${resp.status}: ${errText.slice(0, 100)}`, games: [], remaining };
    }
    
    const data = await resp.json();
    
    // If no games with odds, try scores endpoint to at least get game list
    if (!data || data.length === 0) {
      const scoresResp = await fetch(
        `https://api.the-odds-api.com/v4/sports/basketball_ncaab/scores/?apiKey=${key}&daysFrom=1`
      );
      if (scoresResp.ok) {
        const scores = await scoresResp.json();
        return { error: "No active odds (between tournaments?)", games: [], scores, remaining };
      }
      return { error: "No active NCAAB odds available right now", games: [], remaining };
    }
    
    return { games: data, remaining };
  } catch (e) { return { error: `Odds API exception: ${e.message}`, games: [] }; }
}

async function fetchESPNScores() {
  try {
    const resp = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard",
      { next: { revalidate: 60 } }
    );
    if (!resp.ok) return { error: `ESPN ${resp.status}`, events: [] };
    const data = await resp.json();
    return { events: data.events || [] };
  } catch (e) { return { error: e.message, events: [] }; }
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "No Gemini key configured" };
  
  // Try gemini-2.5-flash first, fallback to 2.0-flash
  const models = ["gemini-2.0-flash-lite", "gemini-2.0-flash"];
  
  for (const model of models) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
          })
        }
      );
      
      const data = await resp.json();
      
      if (data.error) {
        console.log(`Gemini ${model} error:`, data.error.message);
        continue; // Try next model
      }
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
      if (text) return { text, model };
    } catch (e) {
      console.log(`Gemini ${model} exception:`, e.message);
      continue;
    }
  }
  
  return { error: "All Gemini models failed" };
}

// --- PARSE ODDS DATA ---
function fuzzyMatch(str1, str2) {
  if (!str1 || !str2) return false;
  const a = str1.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  const b = str2.toLowerCase().replace(/[^a-z0-9]/g, " ").trim();
  if (a.includes(b) || b.includes(a)) return true;
  // Check if any word > 3 chars is shared
  const aWords = a.split(/\s+/).filter(w => w.length > 3);
  const bWords = b.split(/\s+/).filter(w => w.length > 3);
  return aWords.some(w => bWords.includes(w) || b.includes(w));
}

function parseOddsForGame(oddsGames, awayTeam, homeTeam, awayAbbr, homeAbbr, gameStartTime) {
  if (!oddsGames?.length) return null;

  // Strategy 1: Match by start time (most reliable - within 10 min window)
  let game = null;
  if (gameStartTime) {
    const gTime = new Date(gameStartTime).getTime();
    const timeMatches = oddsGames.filter(g => {
      const oTime = new Date(g.commence_time).getTime();
      return Math.abs(gTime - oTime) < 10 * 60 * 1000; // 10 min window
    });
    if (timeMatches.length === 1) {
      game = timeMatches[0]; // Only one game at this time - guaranteed match
    } else if (timeMatches.length > 1) {
      // Multiple games at same time - use name matching to pick the right one
      game = timeMatches.find(g =>
        (fuzzyMatch(g.away_team, awayTeam) || fuzzyMatch(g.away_team, awayAbbr)) &&
        (fuzzyMatch(g.home_team, homeTeam) || fuzzyMatch(g.home_team, homeAbbr))
      ) || timeMatches.find(g =>
        fuzzyMatch(g.away_team, awayTeam) || fuzzyMatch(g.away_team, awayAbbr) ||
        fuzzyMatch(g.home_team, homeTeam) || fuzzyMatch(g.home_team, homeAbbr)
      );
    }
  }

  // Strategy 2: Fallback to pure name matching if time didn't work
  if (!game) {
    game = oddsGames.find(g =>
      (fuzzyMatch(g.away_team, awayTeam) || fuzzyMatch(g.away_team, awayAbbr)) &&
      (fuzzyMatch(g.home_team, homeTeam) || fuzzyMatch(g.home_team, homeAbbr))
    ) || oddsGames.find(g =>
      (fuzzyMatch(g.away_team, awayTeam) || fuzzyMatch(g.away_team, awayAbbr) ||
       fuzzyMatch(g.home_team, awayTeam) || fuzzyMatch(g.home_team, awayAbbr)) &&
      (fuzzyMatch(g.home_team, homeTeam) || fuzzyMatch(g.home_team, homeAbbr) ||
       fuzzyMatch(g.away_team, homeTeam) || fuzzyMatch(g.away_team, homeAbbr))
    );
  }

  if (!game) return null;

  const result = { bookmakers: [], consensusTotal: null, consensusSpread: null, commence: game.commence_time, awayTeamOdds: game.away_team, homeTeamOdds: game.home_team };
  const totals = [];
  const spreads = [];
  const awayMLs = [];
  const homeMLs = [];

  for (const bm of (game.bookmakers || [])) {
    const totalMkt = bm.markets?.find(m => m.key === "totals");
    const spreadMkt = bm.markets?.find(m => m.key === "spreads");
    const h2hMkt = bm.markets?.find(m => m.key === "h2h");

    if (totalMkt?.outcomes?.[0]) {
      totals.push(totalMkt.outcomes[0].point);
      result.bookmakers.push({ name: bm.title, total: totalMkt.outcomes[0].point });
    }
    if (spreadMkt?.outcomes) {
      for (const o of spreadMkt.outcomes) {
        if (fuzzyMatch(o.name, awayTeam) || fuzzyMatch(o.name, awayAbbr)) {
          spreads.push({ team: awayAbbr, point: o.point });
        }
      }
      // If no match on away, take the first outcome and figure out who
      if (spreads.length === 0 && spreadMkt.outcomes.length >= 2) {
        spreads.push({ team: awayAbbr, point: spreadMkt.outcomes[0].point });
      }
    }
    if (h2hMkt?.outcomes) {
      for (const o of h2hMkt.outcomes) {
        if (fuzzyMatch(o.name, awayTeam) || fuzzyMatch(o.name, awayAbbr)) awayMLs.push(o.price);
        else homeMLs.push(o.price);
      }
    }
  }

  if (totals.length > 0) result.consensusTotal = Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 10) / 10;
  if (spreads.length > 0) {
    const avgSpread = spreads.reduce((a, b) => a + b.point, 0) / spreads.length;
    result.consensusSpread = Math.round(avgSpread * 10) / 10;
    result.favTeam = avgSpread < 0 ? awayAbbr : homeAbbr;
    result.spreadLine = Math.round(Math.abs(avgSpread) * 10) / 10;
  }
  if (awayMLs.length > 0) result.awayML = Math.round(awayMLs.reduce((a,b) => a+b, 0) / awayMLs.length);
  if (homeMLs.length > 0) result.homeML = Math.round(homeMLs.reduce((a,b) => a+b, 0) / homeMLs.length);
  result.totalRange = totals.length > 0 ? { min: Math.min(...totals), max: Math.max(...totals) } : null;
  result.numBooks = totals.length;

  return result;
}

// --- PARSE ESPN SCORES ---
function parseESPNForGame(events, awayAbbr, homeAbbr) {
  if (!events?.length) return null;
  for (const ev of events) {
    const teams = ev.competitions?.[0]?.competitors || [];
    const away = teams.find(t => t.homeAway === "away");
    const home = teams.find(t => t.homeAway === "home");
    if (!away || !home) continue;
    const awayAbbrESPN = away.team?.abbreviation?.toUpperCase();
    const homeAbbrESPN = home.team?.abbreviation?.toUpperCase();
    if ((awayAbbrESPN === awayAbbr || away.team?.shortDisplayName?.toUpperCase().includes(awayAbbr)) &&
        (homeAbbrESPN === homeAbbr || home.team?.shortDisplayName?.toUpperCase().includes(homeAbbr))) {
      const status = ev.status?.type?.name;
      return {
        awayScore: parseInt(away.score) || 0,
        homeScore: parseInt(home.score) || 0,
        status: status === "STATUS_FINAL" ? "final" : status === "STATUS_IN_PROGRESS" ? "live" : "scheduled",
        clock: ev.status?.displayClock || "",
        period: ev.status?.period || 0,
        detail: ev.status?.type?.shortDetail || ""
      };
    }
  }
  return null;
}


// --- MAIN HANDLER ---
export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  // Fetch all data sources in parallel
  const [oddsData, espnData] = await Promise.all([
    fetchOddsAPI(),
    fetchESPNScores()
  ]);

  // Build game summaries
  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr, g.startTime);
    const espn = parseESPNForGame(espnData.events, g.awayAbbr, g.homeAbbr);
    return { ...g, liveOdds: odds, espnScore: espn };
  });

  // ONLY analyze games that are NOT final AND don't have locked predictions
  const gamesToAnalyze = gameSummaries.filter(g => {
    const status = g.espnScore?.status || g.status;
    if (status === "final") return false;
    if (locked[g.id]) return false;
    return true;
  });

  let geminiPicks = [];
  let aiStatus = { gemini: "skipped" };

  if (gamesToAnalyze.length > 0 && gamesToAnalyze.length <= 12) {
    const aiGameList = gamesToAnalyze.slice(0, 10).map(g => {
      let line = `Game ${g.id}: ${g.awayAbbr} vs ${g.homeAbbr}`;
      if (g.liveOdds) {
        line += ` | O/U ${g.liveOdds.consensusTotal}, Spread: ${g.liveOdds.favTeam || "?"} -${g.liveOdds.spreadLine || "?"}`;
      }
      if (g.espnScore && g.espnScore.status === "live") {
        line += ` | LIVE: ${g.espnScore.awayScore}-${g.espnScore.homeScore} (${g.espnScore.detail})`;
      }
      return line;
    }).join("\n");

    const geminiPrompt = `College basketball analyst. UPCOMING games only (NOT finished). For each: predict score, OVER/UNDER total, who covers spread. JSON only:
[{"id":<n>,"predAway":<n>,"predHome":<n>,"totalCall":"OVER"|"UNDER","totalReason":"<brief>","spreadCall":"<abbr>","confidence":<1-10>,"keyFactor":"<brief>"}]

${aiGameList}

JSON array ONLY:`;

    try {
      const geminiResp = await Promise.race([
        askGemini(geminiPrompt).catch(e => ({ error: e.message })),
        new Promise(resolve => setTimeout(() => resolve({ error: "timeout" }), 8000))
      ]);

      function parseAIResponse(text) {
        if (!text) return [];
        const m = text.match(/\[[\s\S]*?\]/);
        if (!m) return [];
        try { return JSON.parse(m[0]); } catch { return []; }
      }
      geminiPicks = parseAIResponse(geminiResp?.text);
      aiStatus.gemini = geminiResp?.error ? `error: ${geminiResp.error}` : (geminiPicks.length > 0 ? "ok" : "no picks");
    } catch (e) {
      aiStatus.gemini = `error: ${e.message}`;
    }
  } else if (gamesToAnalyze.length > 12) {
    aiStatus.gemini = `skipped (${gamesToAnalyze.length} games, too many)`;
  }

  // WEIGHTED VOTES (no more Claude)
  const WEIGHTS = { oddsLine: 3, model: 2.5, lineMove: 2, reverseLineMove: 2.5, recentForm: 1.5, gemini: 1.5, livePace: 2 };

  const results = gameSummaries.map(g => {
    const espn = g.espnScore;
    const odds = g.liveOdds;
    const status = espn?.status || g.status;

    // If game is final and we have a locked prediction, return the locked version
    if (status === "final" && locked[g.id]) {
      return {
        id: g.id,
        status: "final",
        awayScore: espn?.awayScore ?? null,
        homeScore: espn?.homeScore ?? null,
        clock: espn?.detail || "FINAL",
        currentTotal: locked[g.id].line || g.total,
        currentSpread: null,
        oddsRange: null,
        numBooks: 0,
        oddsSpread: null,
        oddsTotal: null,
        oddsML: null,
        
        geminiPred: locked[g.id].geminiPred || null,
        consensus: locked[g.id].consensus || null,
        lockedPrediction: locked[g.id],
        awayScoreAdj: 0,
        homeScoreAdj: 0,
        injuries: null,
        trend: null,
        lineMove: null
      };
    }

    // If game is final but no locked prediction, just return scores (no fake prediction)
    if (status === "final") {
      return {
        id: g.id,
        status: "final",
        awayScore: espn?.awayScore ?? null,
        homeScore: espn?.homeScore ?? null,
        clock: espn?.detail || "FINAL",
        currentTotal: odds?.consensusTotal || g.total,
        currentSpread: null,
        oddsRange: null,
        numBooks: 0,
        oddsSpread: null,
        oddsTotal: null,
        oddsML: null,
        
        geminiPred: null,
        consensus: null,
        lockedPrediction: null,
        awayScoreAdj: 0,
        homeScoreAdj: 0,
        injuries: null,
        trend: null,
        lineMove: null
      };
    }

    // Active game - build consensus from fresh AI analysis
    const gemini = geminiPicks.find(p => p.id === g.id) || {};

    // --- REAL KENPOM STATS from hardcoded database (not AI) ---
    const kpPred = kenpomPredict(g.awayAbbr, g.homeAbbr);
    const awayStats = getTeamStats(g.awayAbbr) || {};
    const homeStats = getTeamStats(g.homeAbbr) || {};
    const modelTotal = kpPred ? kpPred.total : 0;
    const modelSpread = kpPred ? kpPred.spread : 0;
    const projPace = kpPred ? kpPred.pace : 67;
    const awayAdjOE = awayStats.adjOE || 105;
    const awayAdjDE = awayStats.adjDE || 100;
    const homeAdjOE = homeStats.adjOE || 105;
    const homeAdjDE = homeStats.adjDE || 100;
    const awayTempo = awayStats.tempo || 67;
    const homeTempo = homeStats.tempo || 67;

    const currentTotal = odds?.consensusTotal || g.total;

    // Recent form from DB PPG
    const awayLast5 = awayStats.ppg || 72;
    const homeLast5 = homeStats.ppg || 72;
    const recentFormTotal = Math.round((awayLast5 * 0.4 + (awayStats.ppg || 72) * 0.6) + (homeLast5 * 0.4 + (homeStats.ppg || 72) * 0.6));

    // Live projection
    let liveProjectedTotal = null;
    if (espn && espn.status === "live" && espn.period >= 1) {
      const currentScore = espn.awayScore + espn.homeScore;
      if (espn.period === 1 && espn.clock) {
        const minLeft = parseInt(espn.clock.split(":")[0]) || 0;
        const elapsed = 20 - minLeft;
        if (elapsed > 3) liveProjectedTotal = Math.round((currentScore / elapsed) * 40 * 1.03);
      } else if (espn.period === 2 && espn.clock) {
        const minLeft = parseInt(espn.clock.split(":")[0]) || 0;
        const totalMin = 20 + (20 - minLeft);
        if (totalMin > 25) liveProjectedTotal = Math.round((currentScore / totalMin) * 40);
      }
    }

    // Weighted voting
    let overWeight = 0, underWeight = 0;
    const reasons = [];

    if (odds?.consensusTotal && odds.numBooks >= 2) {
      reasons.push(`Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (${odds.totalRange?.min}-${odds.totalRange?.max})`);
    }

    if (modelTotal > 0 && currentTotal > 0 && Math.abs(modelTotal - currentTotal) >= 2) {
      if (modelTotal > currentTotal) { overWeight += WEIGHTS.model; reasons.push(`KenPom Model: ${modelTotal} > line ${currentTotal}`); }
      else { underWeight += WEIGHTS.model; reasons.push(`KenPom Model: ${modelTotal} < line ${currentTotal}`); }
    }

    if (recentFormTotal > 0 && currentTotal > 0 && Math.abs(recentFormTotal - currentTotal) >= 4) {
      if (recentFormTotal > currentTotal) { overWeight += WEIGHTS.recentForm; reasons.push(`Recent form: last-5 avg ${recentFormTotal} > line ${currentTotal}`); }
      else { underWeight += WEIGHTS.recentForm; reasons.push(`Recent form: last-5 avg ${recentFormTotal} < line ${currentTotal}`); }
    }

    if (gemini.totalCall === "OVER") { overWeight += WEIGHTS.gemini; reasons.push(`Gemini: OVER (${gemini.totalReason || ""})`); }
    else if (gemini.totalCall === "UNDER") { underWeight += WEIGHTS.gemini; reasons.push(`Gemini: UNDER (${gemini.totalReason || ""})`); }


    if (liveProjectedTotal && currentTotal > 0 && Math.abs(liveProjectedTotal - currentTotal) >= 3) {
      if (liveProjectedTotal > currentTotal) { overWeight += WEIGHTS.livePace; reasons.push(`LIVE pace: projects ${liveProjectedTotal} (above ${currentTotal})`); }
      else { underWeight += WEIGHTS.livePace; reasons.push(`LIVE pace: projects ${liveProjectedTotal} (below ${currentTotal})`); }
    }

    const totalWeight = overWeight + underWeight;
    const consensusCall = overWeight > underWeight ? "OVER" : underWeight > overWeight ? "UNDER" : "TOSS-UP";
    
    // Strength = agreement ratio * coverage factor
    // Agreement: how lopsided the votes are (100% = all one side, 50% = split)
    const agreement = totalWeight > 0 ? Math.round((Math.max(overWeight, underWeight) / totalWeight) * 100) : 50;
    // Coverage: how many of the possible signals actually voted (max possible ~13 if all vote)
    // 1 signal = low coverage, 3+ signals = good coverage
    const signalCount = reasons.length;
    const coverageFactor = Math.min(1, signalCount / 3); // 3+ signals = full coverage
    // Final strength: high agreement + high coverage = high strength
    // 1 signal at 100% agreement with low coverage = ~55%
    // 3 signals all agreeing = ~90%
    // 3 signals split 2-1 = ~65%
    const consensusStrength = Math.round(agreement * 0.5 + coverageFactor * 50);

    let homeSpreadW = 0, awaySpreadW = 0;
    if (gemini.spreadCall === g.homeAbbr) homeSpreadW += WEIGHTS.gemini;
    else if (gemini.spreadCall) awaySpreadW += WEIGHTS.gemini;
    const spreadCall = homeSpreadW > awaySpreadW ? g.homeAbbr : homeSpreadW < awaySpreadW ? g.awayAbbr : null;

    const avgConf = Math.min(9, Math.max(3, Math.round(consensusStrength / 10)));

    return {
      id: g.id,
      status: espn?.status || g.status,
      awayScore: espn?.awayScore ?? null,
      homeScore: espn?.homeScore ?? null,
      clock: espn?.detail || espn?.clock || null,
      currentTotal,
      currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : null,
      oddsRange: odds?.totalRange || null,
      numBooks: odds?.numBooks || 0,
      oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null,
      oddsTotal: odds?.consensusTotal || null,
      oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML || 0, home: odds.homeML || 0 } : null,
      geminiPred: { away: gemini.predAway, home: gemini.predHome, call: gemini.totalCall, reason: gemini.totalReason, spread: gemini.spreadCall, confidence: gemini.confidence, keyFactor: gemini.keyFactor },
      consensus: {
        totalCall: consensusCall,
        strength: consensusStrength,
        spreadCall,
        confidence: avgConf,
        votes: { over: overWeight.toFixed(1), under: underWeight.toFixed(1) },
        reasons,
        modelTotal,
        modelSpread,
        projPace: projPace.toFixed(1),
        liveProjectedTotal,
        awayKenPom: { adjOE: awayAdjOE, adjDE: awayAdjDE, tempo: awayTempo, rank: awayStats.rank || null },
        homeKenPom: { adjOE: homeAdjOE, adjDE: homeAdjDE, tempo: homeTempo, rank: homeStats.rank || null },
        awayLast5PPG: awayLast5,
        homeLast5PPG: homeLast5,
        recentFormTotal
      },
      // Mark this as a NEW prediction that should be locked
      isNewPrediction: true,
      awayScoreAdj: 0,
      homeScoreAdj: 0,
      injuries: null,
      trend: liveProjectedTotal ? `Live pace projects ${liveProjectedTotal} total` : null,
      lineMove: null
    };
  });

  return NextResponse.json({
    updates: results,
    analyzedCount: gamesToAnalyze.length,
    skippedFinal: gameSummaries.filter(g => (g.espnScore?.status || g.status) === "final").length,
    skippedLocked: Object.keys(locked).length,
    sources: {
      oddsAPI: oddsData.error ? `x ${oddsData.error}` : `OK ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      espn: espnData.error ? `x ${espnData.error}` : `OK ${espnData.events?.length} events`,
      kenpomModel: `OK (${gamesToAnalyze.length} games predicted)`,
      
      gemini: aiStatus.gemini
    }
  });
}
