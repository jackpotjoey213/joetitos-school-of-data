import { NextResponse } from "next/server";

// ─── DATA SOURCES ───

async function fetchOddsAPI() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No Odds API key", games: [] };
  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/?apiKey=${key}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`,
      { next: { revalidate: 120 } }
    );
    if (!resp.ok) return { error: `Odds API ${resp.status}`, games: [] };
    const data = await resp.json();
    return { games: data, remaining: resp.headers.get("x-requests-remaining") };
  } catch (e) { return { error: e.message, games: [] }; }
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

async function askClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: "No Anthropic key" };
  try {
    let messages = [{ role: "user", content: prompt }];
    let allText = "";
    let attempts = 0;
    while (attempts < 4) {
      attempts++;
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 3000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages
        })
      });
      const data = await resp.json();
      if (data.error) return { error: data.error.message };
      for (const block of (data.content || [])) {
        if (block.type === "text") allText += block.text;
      }
      if (data.stop_reason === "end_turn") break;
      if (data.stop_reason === "pause_turn") {
        messages = [...messages, { role: "assistant", content: data.content }, { role: "user", content: "Continue." }];
      } else break;
    }
    return { text: allText };
  } catch (e) { return { error: e.message }; }
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: "No Gemini key" };
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 }
        })
      }
    );
    if (!resp.ok) return { error: `Gemini ${resp.status}` };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { text };
  } catch (e) { return { error: e.message }; }
}

// ─── PARSE ODDS DATA ───
function parseOddsForGame(oddsGames, awayTeam, homeTeam) {
  if (!oddsGames?.length) return null;
  // Try to match by team name substring
  const game = oddsGames.find(g => {
    const away = g.away_team?.toLowerCase() || "";
    const home = g.home_team?.toLowerCase() || "";
    return (away.includes(awayTeam.toLowerCase()) || awayTeam.toLowerCase().includes(away.split(" ").pop())) &&
           (home.includes(homeTeam.toLowerCase()) || homeTeam.toLowerCase().includes(home.split(" ").pop()));
  });
  if (!game) return null;

  const result = { bookmakers: [], consensusTotal: null, consensusSpread: null, commence: game.commence_time };
  const totals = [];
  const spreads = [];

  for (const bm of (game.bookmakers || [])) {
    const totalMkt = bm.markets?.find(m => m.key === "totals");
    const spreadMkt = bm.markets?.find(m => m.key === "spreads");
    if (totalMkt?.outcomes?.[0]) {
      totals.push(totalMkt.outcomes[0].point);
      result.bookmakers.push({ name: bm.title, total: totalMkt.outcomes[0].point });
    }
    if (spreadMkt?.outcomes) {
      const homeSpread = spreadMkt.outcomes.find(o => o.name?.toLowerCase().includes(homeTeam.toLowerCase().split(" ").pop()));
      if (homeSpread) spreads.push(homeSpread.point);
    }
  }

  if (totals.length > 0) result.consensusTotal = Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 10) / 10;
  if (spreads.length > 0) result.consensusSpread = Math.round((spreads.reduce((a, b) => a + b, 0) / spreads.length) * 10) / 10;
  result.totalRange = totals.length > 0 ? { min: Math.min(...totals), max: Math.max(...totals) } : null;
  result.numBooks = totals.length;

  return result;
}

// ─── PARSE ESPN SCORES ───
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

// ─── MAIN HANDLER ───
export async function POST(req) {
  const { games } = await req.json();

  // Fetch all data sources in parallel
  const [oddsData, espnData] = await Promise.all([
    fetchOddsAPI(),
    fetchESPNScores()
  ]);

  // Build game summaries for AI analysis
  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home);
    const espn = parseESPNForGame(espnData.events, g.awayAbbr, g.homeAbbr);
    return { ...g, liveOdds: odds, espnScore: espn };
  });

  // Only ask AI about games that aren't final
  const activeGames = gameSummaries.filter(g => {
    const status = g.espnScore?.status || g.status;
    return status !== "final";
  });

  // Build AI prompts with real data
  const aiGameList = gameSummaries.map(g => {
    let line = `Game ${g.id}: ${g.awayAbbr} vs ${g.homeAbbr} (${g.conference})`;
    if (g.liveOdds) {
      line += ` | Consensus O/U: ${g.liveOdds.consensusTotal} (${g.liveOdds.numBooks} books, range: ${g.liveOdds.totalRange?.min}-${g.liveOdds.totalRange?.max})`;
      if (g.liveOdds.consensusSpread) line += ` | Spread: ${g.liveOdds.consensusSpread}`;
    } else {
      line += ` | Pregame O/U: ${g.total}, Spread: ${g.spread.fav} ${g.spread.line}`;
    }
    if (g.espnScore) {
      line += ` | Score: ${g.awayAbbr} ${g.espnScore.awayScore} - ${g.homeAbbr} ${g.espnScore.homeScore} (${g.espnScore.detail})`;
    }
    line += ` | ${g.awayAbbr} stats: ${g.stats.awayPPG} PPG, ${g.stats.awayAdjOE} AdjOE, ${g.stats.awayAdjDE} AdjDE, ${g.stats.awayPace} pace`;
    line += ` | ${g.homeAbbr} stats: ${g.stats.homePPG} PPG, ${g.stats.homeAdjOE} AdjOE, ${g.stats.homeAdjDE} AdjDE, ${g.stats.homePace} pace`;
    return line;
  }).join("\n");

  const analysisPrompt = `You are an expert college basketball analyst and sports bettor. Analyze these games and predict outcomes.

DATA:
${aiGameList}

For each game, provide:
1. Your predicted final score
2. OVER or UNDER the total, with reasoning
3. Which team covers the spread, with reasoning
4. Confidence level (1-10)
5. Key factors driving your prediction

Respond with ONLY a JSON array:
[{"id":<num>,"predAway":<score>,"predHome":<score>,"totalCall":"OVER"|"UNDER","totalReason":"<brief>","spreadCall":"<team abbr>","spreadReason":"<brief>","confidence":<1-10>,"keyFactor":"<brief>"}]

Return ONLY the JSON array.`;

  // Ask both AIs in parallel
  const [claudeResp, geminiResp] = await Promise.all([
    askClaude(analysisPrompt),
    askGemini(analysisPrompt)
  ]);

  // Parse AI responses
  function parseAIResponse(text) {
    if (!text) return [];
    const m = text.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    try { return JSON.parse(m[0]); } catch { return []; }
  }

  const claudePicks = parseAIResponse(claudeResp.text);
  const geminiPicks = parseAIResponse(geminiResp.text);

  // Build consensus for each game
  // WEIGHTED VOTES: Odds API=3, Our Model=2.5, Line Movement=2, Gemini=1.5, Claude=1
  const WEIGHTS = { oddsLine: 3, model: 2.5, lineMove: 2, gemini: 1.5, claude: 1 };

  const results = gameSummaries.map(g => {
    const espn = g.espnScore;
    const odds = g.liveOdds;
    const claude = claudePicks.find(p => p.id === g.id) || {};
    const gemini = geminiPicks.find(p => p.id === g.id) || {};
    const s = g.stats || {};

    // Determine current best total line
    const currentTotal = odds?.consensusTotal || g.total;
    const currentSpread = odds?.consensusSpread != null ? `${g.homeAbbr} ${odds.consensusSpread}` : null;

    // ─── PACE MULTIPLIER MODEL ───
    // Project game pace from each team's possessions/game
    const awayPace = s.awayPace || 68;
    const homePace = s.homePace || 68;
    const awayDE = s.awayAdjDE || 100;
    const homeDE = s.homeAdjDE || 100;
    // Slower team controls pace ~60%. Defense affects opponent pace.
    const awayPaceVsD = awayPace + (homeDE - 100) * 0.15;
    const homePaceVsD = homePace + (awayDE - 100) * 0.15;
    const projPace = Math.min(awayPaceVsD, homePaceVsD) * 0.6 + Math.max(awayPaceVsD, homePaceVsD) * 0.4;
    // Pace-adjusted PPG
    const awayPPGadj = (s.awayPPG || 75) * (projPace / (awayPace || 68));
    const homePPGadj = (s.homePPG || 75) * (projPace / (homePace || 68));
    // Model predicted total
    const modelTotal = Math.round((awayPPGadj + homePPGadj) * 0.97); // 3% tournament discount

    // ─── LIVE FIRST-HALF PROJECTION ───
    let liveProjectedTotal = null;
    if (espn && espn.status === "live" && espn.period >= 1) {
      const currentScore = espn.awayScore + espn.homeScore;
      if (espn.period === 1 && espn.clock) {
        // First half: project full game from current pace
        // CBB halves are 20 min. Estimate time elapsed.
        const clockParts = espn.clock.split(":");
        const minLeft = parseInt(clockParts[0]) || 0;
        const elapsed = 20 - minLeft;
        if (elapsed > 3) { // Need at least 3 min of data
          const pacePerMin = currentScore / elapsed;
          liveProjectedTotal = Math.round(pacePerMin * 40 * 1.03); // 3% bump for 2H fouls
        }
      } else if (espn.period === 2) {
        // Second half: more accurate projection
        const clockParts = espn.clock.split(":");
        const minLeft = parseInt(clockParts[0]) || 0;
        const totalMinPlayed = 20 + (20 - minLeft);
        if (totalMinPlayed > 25) {
          const pacePerMin = currentScore / totalMinPlayed;
          liveProjectedTotal = Math.round(pacePerMin * 40);
        }
      }
    }

    // ─── WEIGHTED CONSENSUS VOTING ───
    let overWeight = 0, underWeight = 0;
    const reasons = [];

    // Vote 1: Odds API line vs pregame (WEIGHT: 3)
    // If sportsbooks moved the line, that's the strongest signal
    if (odds?.consensusTotal) {
      if (odds.numBooks >= 3) {
        // Tight consensus across many books = very reliable
        reasons.push(`📊 Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (range ${odds.totalRange?.min}-${odds.totalRange?.max})`);
      }
    }

    // Vote 2: Our statistical model with pace multiplier (WEIGHT: 2.5)
    if (modelTotal > 0 && Math.abs(modelTotal - currentTotal) >= 2) {
      if (modelTotal > currentTotal) {
        overWeight += WEIGHTS.model;
        reasons.push(`📐 Model: pace-adj total ${modelTotal} > line ${currentTotal} (proj pace: ${projPace.toFixed(1)})`);
      } else {
        underWeight += WEIGHTS.model;
        reasons.push(`📐 Model: pace-adj total ${modelTotal} < line ${currentTotal} (proj pace: ${projPace.toFixed(1)})`);
      }
    }

    // Vote 3: Line movement (WEIGHT: 2)
    if (odds?.consensusTotal && Math.abs(odds.consensusTotal - g.total) >= 1.5) {
      if (odds.consensusTotal < g.total) {
        underWeight += WEIGHTS.lineMove;
        reasons.push(`📉 Line moved DOWN ${g.total}→${odds.consensusTotal} (sharp money on UNDER)`);
      } else {
        overWeight += WEIGHTS.lineMove;
        reasons.push(`📈 Line moved UP ${g.total}→${odds.consensusTotal} (sharp money on OVER)`);
      }
    }

    // Vote 4: Gemini (WEIGHT: 1.5)
    if (gemini.totalCall === "OVER") { overWeight += WEIGHTS.gemini; reasons.push(`🔵 Gemini: OVER (${gemini.totalReason || gemini.keyFactor || ""})`); }
    else if (gemini.totalCall === "UNDER") { underWeight += WEIGHTS.gemini; reasons.push(`🔵 Gemini: UNDER (${gemini.totalReason || gemini.keyFactor || ""})`); }

    // Vote 5: Claude (WEIGHT: 1)
    if (claude.totalCall === "OVER") { overWeight += WEIGHTS.claude; reasons.push(`🟣 Claude: OVER (${claude.totalReason || claude.keyFactor || ""})`); }
    else if (claude.totalCall === "UNDER") { underWeight += WEIGHTS.claude; reasons.push(`🟣 Claude: UNDER (${claude.totalReason || claude.keyFactor || ""})`); }

    // Bonus: Live first-half projection (WEIGHT: 2 when available)
    if (liveProjectedTotal && Math.abs(liveProjectedTotal - currentTotal) >= 3) {
      if (liveProjectedTotal > currentTotal) {
        overWeight += 2;
        reasons.push(`🔴 LIVE pace projects ${liveProjectedTotal} total (${liveProjectedTotal > currentTotal ? "above" : "below"} ${currentTotal} line)`);
      } else {
        underWeight += 2;
        reasons.push(`🔴 LIVE pace projects ${liveProjectedTotal} total (below ${currentTotal} line)`);
      }
    }

    const totalWeight = overWeight + underWeight;
    const consensusCall = overWeight > underWeight ? "OVER" : underWeight > overWeight ? "UNDER" : "TOSS-UP";
    const consensusStrength = totalWeight > 0 ? Math.round((Math.max(overWeight, underWeight) / totalWeight) * 100) : 50;

    // Spread consensus (weighted)
    let homeSpreadW = 0, awaySpreadW = 0;
    if (claude.spreadCall === g.homeAbbr) homeSpreadW += WEIGHTS.claude;
    else if (claude.spreadCall) awaySpreadW += WEIGHTS.claude;
    if (gemini.spreadCall === g.homeAbbr) homeSpreadW += WEIGHTS.gemini;
    else if (gemini.spreadCall) awaySpreadW += WEIGHTS.gemini;
    const spreadCall = homeSpreadW > awaySpreadW ? g.homeAbbr : homeSpreadW < awaySpreadW ? g.awayAbbr : null;

    // Confidence based on consensus strength and number of agreeing sources
    const avgConf = Math.min(9, Math.max(3, Math.round(consensusStrength / 12 + (totalWeight > 6 ? 2 : 0))));

    return {
      id: g.id,
      status: espn?.status || g.status,
      awayScore: espn?.awayScore ?? null,
      homeScore: espn?.homeScore ?? null,
      clock: espn?.detail || espn?.clock || null,
      currentTotal,
      currentSpread,
      oddsRange: odds?.totalRange || null,
      numBooks: odds?.numBooks || 0,
      claudePred: { away: claude.predAway, home: claude.predHome, call: claude.totalCall, reason: claude.totalReason, spread: claude.spreadCall, confidence: claude.confidence, keyFactor: claude.keyFactor },
      geminiPred: { away: gemini.predAway, home: gemini.predHome, call: gemini.totalCall, reason: gemini.totalReason, spread: gemini.spreadCall, confidence: gemini.confidence, keyFactor: gemini.keyFactor },
      // Enhanced consensus
      consensus: {
        totalCall: consensusCall,
        strength: consensusStrength,
        spreadCall,
        confidence: avgConf,
        votes: { over: overWeight.toFixed(1), under: underWeight.toFixed(1) },
        reasons,
        modelTotal,
        projPace: projPace.toFixed(1),
        liveProjectedTotal
      },
      awayScoreAdj: 0,
      homeScoreAdj: 0,
      injuries: null,
      trend: liveProjectedTotal ? `Live pace projects ${liveProjectedTotal} total` : null,
      lineMove: odds?.consensusTotal && odds.consensusTotal !== g.total ? `O/U: ${g.total} → ${odds.consensusTotal}` : null
    };
  });

  return NextResponse.json({
    updates: results,
    sources: {
      oddsAPI: oddsData.error ? `Error: ${oddsData.error}` : `OK (${oddsData.remaining} requests remaining)`,
      espn: espnData.error ? `Error: ${espnData.error}` : `OK (${espnData.events?.length} events)`,
      claude: claudeResp.error ? `Error: ${claudeResp.error}` : "OK",
      gemini: geminiResp.error ? `Error: ${geminiResp.error}` : "OK"
    }
  });
}
