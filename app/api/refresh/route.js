import { NextResponse } from "next/server";

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
  const { games } = await req.json();

  // Fetch all data sources in parallel
  const [oddsData, espnData] = await Promise.all([
    fetchOddsAPI(),
    fetchESPNScores()
  ]);

  // Build game summaries for AI analysis
  const gameSummaries = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home, g.awayAbbr, g.homeAbbr, g.startTime);
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
    let line = `Game ${g.id}: ${g.awayAbbr} (${g.away}) vs ${g.homeAbbr} (${g.home}) - ${g.conference}`;
    if (g.liveOdds) {
      line += ` | Odds API: O/U ${g.liveOdds.consensusTotal} (${g.liveOdds.numBooks} books, range ${g.liveOdds.totalRange?.min}-${g.liveOdds.totalRange?.max})`;
      if (g.liveOdds.favTeam) line += `, Spread: ${g.liveOdds.favTeam} -${g.liveOdds.spreadLine}`;
      if (g.liveOdds.awayML) line += `, ML: ${g.awayAbbr} ${g.liveOdds.awayML}/${g.homeAbbr} ${g.liveOdds.homeML}`;
    } else if (g.total > 0) {
      line += ` | Pregame O/U: ${g.total}, Spread: ${g.spread.fav} ${g.spread.line}`;
    }
    if (g.espnScore && (g.espnScore.status === "live" || g.espnScore.status === "final")) {
      line += ` | Score: ${g.awayAbbr} ${g.espnScore.awayScore} - ${g.homeAbbr} ${g.espnScore.homeScore} (${g.espnScore.detail})`;
    }
    return line;
  }).join("\n");

  // Claude gets the deep research prompt with web search
  const claudePrompt = `You are an elite college basketball analyst and sharp sports bettor. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

GAMES TO ANALYZE:
${aiGameList}

RESEARCH INSTRUCTIONS - Search the web for each game and find:
1. **KenPom ratings**: Search "kenpom [team name] 2026" or "kenpom rankings 2026". For each team find: AdjOE (adjusted offensive efficiency), AdjDE (adjusted defensive efficiency), AdjTempo (possessions per game), and overall KenPom ranking. These are the most predictive stats in college basketball.
2. **Last 5 games**: Search "[team] basketball schedule results 2026". Find each team's scores in their last 5 games (opponent, score, W/L). Calculate their recent PPG average.
3. **Opening lines vs current**: Search "opening line [team1] [team2]" or "[team1] [team2] line movement". Note if the line has moved from the opener and in which direction. If public betting % is available (e.g., "80% of bets on the over"), note it.
4. **Key injuries or suspensions** for today's games.

Using ALL of this research, for each game provide:
- Predicted final score based on KenPom efficiency + tempo matchup
- OVER or UNDER call with reasoning referencing specific KenPom data
- Spread pick with reasoning referencing recent form
- Note any reverse line movement (line moving opposite to public money)
- Confidence 1-10

Respond with ONLY a valid JSON array:
[{"id":<num>,"predAway":<score>,"predHome":<score>,"totalCall":"OVER"|"UNDER","totalReason":"<specific reasoning with KenPom data>","spreadCall":"<team abbr>","spreadReason":"<reasoning with recent form>","confidence":<1-10>,"keyFactor":"<most important factor>","awayKenPom":{"adjOE":<num>,"adjDE":<num>,"tempo":<num>,"rank":<num>},"homeKenPom":{"adjOE":<num>,"adjDE":<num>,"tempo":<num>,"rank":<num>},"awayLast5PPG":<num>,"homeLast5PPG":<num>,"openingTotal":<num or null>,"openingSpread":<num or null>,"lineDirection":"<e.g. total dropped 2 pts, sharps on under>","injuries":"<brief or null>"}]

Return ONLY the JSON array.`;

  // Gemini gets a simpler prompt (no web search capability) with the data we already have
  const geminiPrompt = `You are an expert college basketball analyst. Analyze these ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })} games and predict outcomes.

GAMES:
${aiGameList}

For each game, predict the final score and whether the total goes OVER or UNDER the line. Consider:
- Tournament games typically score 3-5% lower than regular season pace
- 16-seeds in the NCAA tournament average about 60-65 points
- Teams on winning streaks tend to cover early tournament games
- Home/away designation is less meaningful in neutral-site tournament games

Respond with ONLY a valid JSON array:
[{"id":<num>,"predAway":<score>,"predHome":<score>,"totalCall":"OVER"|"UNDER","totalReason":"<brief>","spreadCall":"<team abbr>","spreadReason":"<brief>","confidence":<1-10>,"keyFactor":"<brief>"}]

Return ONLY the JSON array.`;

  // Ask both AIs in parallel
  const [claudeResp, geminiResp] = await Promise.all([
    askClaude(claudePrompt),
    askGemini(geminiPrompt)
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
  // WEIGHTED VOTES: Odds API=3, KenPom Model=2.5, Line Movement=2, Reverse Line Move=2.5, Gemini=1.5, Claude=1, Live Pace=2
  const WEIGHTS = { oddsLine: 3, model: 2.5, lineMove: 2, reverseLineMove: 2.5, recentForm: 1.5, gemini: 1.5, claude: 1, livePace: 2 };

  const results = gameSummaries.map(g => {
    const espn = g.espnScore;
    const odds = g.liveOdds;
    const claude = claudePicks.find(p => p.id === g.id) || {};
    const gemini = geminiPicks.find(p => p.id === g.id) || {};
    const s = g.stats || {};

    // Determine current best total line
    const currentTotal = odds?.consensusTotal || g.total;
    const currentSpread = odds?.consensusSpread != null ? `${g.homeAbbr} ${odds.consensusSpread}` : null;

    // --- KENPOM-POWERED MODEL ---
    // Use KenPom data from Claude's research if available, otherwise fall back to basic stats
    const awayKP = claude.awayKenPom || {};
    const homeKP = claude.homeKenPom || {};
    const awayAdjOE = awayKP.adjOE || s.awayAdjOE || 105;
    const awayAdjDE = awayKP.adjDE || s.awayAdjDE || 100;
    const homeAdjOE = homeKP.adjOE || s.homeAdjOE || 105;
    const homeAdjDE = homeKP.adjDE || s.homeAdjDE || 100;
    const awayTempo = awayKP.tempo || s.awayPace || 68;
    const homeTempo = homeKP.tempo || s.homePace || 68;
    
    // KenPom-style total projection:
    // Expected PPP (points per possession) = team's OE vs opponent's DE, averaged with D1 average (100)
    const avgEfficiency = 100; // D1 average
    const awayExpPPP = (awayAdjOE + (avgEfficiency * 2 - homeAdjDE)) / 200; // How well away offense does vs home defense
    const homeExpPPP = (homeAdjOE + (avgEfficiency * 2 - awayAdjDE)) / 200;
    
    // Projected pace (slower team controls ~60%)
    const projPace = Math.min(awayTempo, homeTempo) * 0.6 + Math.max(awayTempo, homeTempo) * 0.4;
    
    // KenPom projected total
    const awayProjPts = awayExpPPP * projPace;
    const homeProjPts = homeExpPPP * projPace;
    const modelTotal = Math.round((awayProjPts + homeProjPts) * 0.97); // 3% tournament discount
    const modelSpread = Math.round((homeProjPts - awayProjPts) * 10) / 10;

    // --- RECENT FORM ADJUSTMENT ---
    const awayLast5 = claude.awayLast5PPG || s.awayPPG || 72;
    const homeLast5 = claude.homeLast5PPG || s.homePPG || 72;
    const awaySeasonPPG = s.awayPPG || 72;
    const homeSeasonPPG = s.homePPG || 72;
    // Recency-weighted PPG: 40% last 5, 60% season
    const awayWeightedPPG = awayLast5 * 0.4 + awaySeasonPPG * 0.6;
    const homeWeightedPPG = homeLast5 * 0.4 + homeSeasonPPG * 0.6;
    const recentFormTotal = Math.round(awayWeightedPPG + homeWeightedPPG);

    // --- LIVE FIRST-HALF PROJECTION ---
    let liveProjectedTotal = null;
    if (espn && espn.status === "live" && espn.period >= 1) {
      const currentScore = espn.awayScore + espn.homeScore;
      if (espn.period === 1 && espn.clock) {
        const clockParts = espn.clock.split(":");
        const minLeft = parseInt(clockParts[0]) || 0;
        const elapsed = 20 - minLeft;
        if (elapsed > 3) {
          const pacePerMin = currentScore / elapsed;
          liveProjectedTotal = Math.round(pacePerMin * 40 * 1.03);
        }
      } else if (espn.period === 2) {
        const clockParts = espn.clock.split(":");
        const minLeft = parseInt(clockParts[0]) || 0;
        const totalMinPlayed = 20 + (20 - minLeft);
        if (totalMinPlayed > 25) {
          const pacePerMin = currentScore / totalMinPlayed;
          liveProjectedTotal = Math.round(pacePerMin * 40);
        }
      }
    }

    // --- WEIGHTED CONSENSUS VOTING ---
    let overWeight = 0, underWeight = 0;
    const reasons = [];

    // Vote 1: Odds API consensus (WEIGHT: 3) - informational, anchors the line
    if (odds?.consensusTotal && odds.numBooks >= 2) {
      reasons.push(`📊 Odds API: ${odds.numBooks} books avg ${odds.consensusTotal} (range ${odds.totalRange?.min}-${odds.totalRange?.max})`);
    }

    // Vote 2: KenPom-powered model (WEIGHT: 2.5)
    if (modelTotal > 0 && currentTotal > 0 && Math.abs(modelTotal - currentTotal) >= 2) {
      if (modelTotal > currentTotal) {
        overWeight += WEIGHTS.model;
        reasons.push(`📐 KenPom Model: ${modelTotal} total > line ${currentTotal} (pace ${projPace.toFixed(1)}, ${g.awayAbbr} OE:${awayAdjOE} DE:${awayAdjDE} | ${g.homeAbbr} OE:${homeAdjOE} DE:${homeAdjDE})`);
      } else {
        underWeight += WEIGHTS.model;
        reasons.push(`📐 KenPom Model: ${modelTotal} total < line ${currentTotal} (pace ${projPace.toFixed(1)}, ${g.awayAbbr} OE:${awayAdjOE} DE:${awayAdjDE} | ${g.homeAbbr} OE:${homeAdjOE} DE:${homeAdjDE})`);
      }
    }

    // Vote 3: Reverse Line Movement (WEIGHT: 2.5) - strongest sharp signal
    if (claude.lineDirection && claude.openingTotal) {
      const lineMoved = claude.openingTotal && currentTotal ? currentTotal - claude.openingTotal : 0;
      if (claude.lineDirection.toLowerCase().includes("sharp") || claude.lineDirection.toLowerCase().includes("reverse")) {
        if (claude.lineDirection.toLowerCase().includes("under") || lineMoved < -1) {
          underWeight += WEIGHTS.reverseLineMove;
          reasons.push(`🦈 Reverse Line Move: ${claude.lineDirection} (opening ${claude.openingTotal} -> current ${currentTotal})`);
        } else if (claude.lineDirection.toLowerCase().includes("over") || lineMoved > 1) {
          overWeight += WEIGHTS.reverseLineMove;
          reasons.push(`🦈 Reverse Line Move: ${claude.lineDirection} (opening ${claude.openingTotal} -> current ${currentTotal})`);
        }
      } else if (Math.abs(lineMoved) >= 1.5) {
        // Regular line movement (WEIGHT: 2)
        if (lineMoved < 0) {
          underWeight += WEIGHTS.lineMove;
          reasons.push(`📉 Line moved DOWN: opening ${claude.openingTotal} -> ${currentTotal} (sharp money on UNDER)`);
        } else {
          overWeight += WEIGHTS.lineMove;
          reasons.push(`📈 Line moved UP: opening ${claude.openingTotal} -> ${currentTotal} (sharp money on OVER)`);
        }
      }
    } else if (odds?.consensusTotal && g.total > 0 && Math.abs(odds.consensusTotal - g.total) >= 1.5) {
      // Fallback: compare Odds API current vs our stored pregame line
      if (odds.consensusTotal < g.total) {
        underWeight += WEIGHTS.lineMove;
        reasons.push(`📉 Line dropped: ${g.total} -> ${odds.consensusTotal}`);
      } else {
        overWeight += WEIGHTS.lineMove;
        reasons.push(`📈 Line rose: ${g.total} -> ${odds.consensusTotal}`);
      }
    }

    // Vote 4: Recent form adjustment (WEIGHT: 1.5)
    if (recentFormTotal > 0 && currentTotal > 0 && Math.abs(recentFormTotal - currentTotal) >= 4) {
      if (recentFormTotal > currentTotal) {
        overWeight += WEIGHTS.recentForm;
        reasons.push(`🔥 Recent form: combined last-5 avg ${recentFormTotal} > line ${currentTotal} (${g.awayAbbr} ${awayLast5.toFixed?.(0) || awayLast5} + ${g.homeAbbr} ${homeLast5.toFixed?.(0) || homeLast5} PPG)`);
      } else {
        underWeight += WEIGHTS.recentForm;
        reasons.push(`❄️ Recent form: combined last-5 avg ${recentFormTotal} < line ${currentTotal}`);
      }
    }

    // Vote 5: Gemini (WEIGHT: 1.5)
    if (gemini.totalCall === "OVER") { overWeight += WEIGHTS.gemini; reasons.push(`🔵 Gemini: OVER (${gemini.totalReason || gemini.keyFactor || ""})`); }
    else if (gemini.totalCall === "UNDER") { underWeight += WEIGHTS.gemini; reasons.push(`🔵 Gemini: UNDER (${gemini.totalReason || gemini.keyFactor || ""})`); }

    // Vote 6: Claude (WEIGHT: 1)
    if (claude.totalCall === "OVER") { overWeight += WEIGHTS.claude; reasons.push(`🟣 Claude: OVER (${claude.totalReason || claude.keyFactor || ""})`); }
    else if (claude.totalCall === "UNDER") { underWeight += WEIGHTS.claude; reasons.push(`🟣 Claude: UNDER (${claude.totalReason || claude.keyFactor || ""})`); }

    // Vote 7: Live first-half projection (WEIGHT: 2 when available)
    if (liveProjectedTotal && currentTotal > 0 && Math.abs(liveProjectedTotal - currentTotal) >= 3) {
      if (liveProjectedTotal > currentTotal) {
        overWeight += WEIGHTS.livePace;
        reasons.push(`🔴 LIVE pace: projects ${liveProjectedTotal} total (above ${currentTotal} line)`);
      } else {
        underWeight += WEIGHTS.livePace;
        reasons.push(`🔴 LIVE pace: projects ${liveProjectedTotal} total (below ${currentTotal} line)`);
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
      currentSpread: odds?.favTeam ? `${odds.favTeam} -${odds.spreadLine}` : currentSpread,
      oddsRange: odds?.totalRange || null,
      numBooks: odds?.numBooks || 0,
      // Betting lines from Odds API
      oddsSpread: odds?.favTeam ? { fav: odds.favTeam, line: -odds.spreadLine } : null,
      oddsTotal: odds?.consensusTotal || null,
      oddsML: (odds?.awayML || odds?.homeML) ? { away: odds.awayML || 0, home: odds.homeML || 0 } : null,
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
        modelSpread,
        projPace: projPace.toFixed(1),
        liveProjectedTotal,
        // KenPom data
        awayKenPom: { adjOE: awayAdjOE, adjDE: awayAdjDE, tempo: awayTempo, rank: awayKP.rank || null },
        homeKenPom: { adjOE: homeAdjOE, adjDE: homeAdjDE, tempo: homeTempo, rank: homeKP.rank || null },
        // Recent form
        awayLast5PPG: awayLast5,
        homeLast5PPG: homeLast5,
        recentFormTotal,
        // Line movement
        openingTotal: claude.openingTotal || null,
        lineDirection: claude.lineDirection || null,
        injuries: claude.injuries || null
      },
      awayScoreAdj: 0,
      homeScoreAdj: 0,
      injuries: null,
      trend: liveProjectedTotal ? `Live pace projects ${liveProjectedTotal} total` : null,
      lineMove: odds?.consensusTotal && odds.consensusTotal !== g.total ? `O/U: ${g.total} -> ${odds.consensusTotal}` : null
    };
  });

  return NextResponse.json({
    updates: results,
    sources: {
      oddsAPI: oddsData.error ? `❌ ${oddsData.error}` : `✅ ${oddsData.games.length} games (${oddsData.remaining} req left)`,
      espn: espnData.error ? `❌ ${espnData.error}` : `✅ ${espnData.events?.length} events`,
      claude: claudeResp.error ? `❌ ${claudeResp.error}` : `✅ OK`,
      gemini: geminiResp.error ? `❌ ${geminiResp.error}` : `✅ OK (${geminiResp.model || ""})`
    }
  });
}
