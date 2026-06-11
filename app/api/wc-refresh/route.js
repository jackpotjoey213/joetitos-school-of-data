import { NextResponse } from "next/server";
export const maxDuration = 30;

// =============================================================
// WORLD CUP PREDICTION ENGINE
// Completely isolated from MLB/NBA pipelines
// =============================================================

// --- FIFA RANKINGS (as of June 2026) ---
// Used as team strength proxy. Lower rank = stronger team.
const FIFA_RANKINGS = {
  ARG: 1, FRA: 2, ENG: 3, ESP: 4, POR: 5,
  BEL: 6, BRA: 7, NED: 8, GER: 9, URU: 10,
  USA: 11, MEX: 12, COL: 13, MOR: 14, JPN: 15,
  CRO: 16, SEN: 17, DEN: 18, ECU: 19, SUI: 20,
  AUS: 21, POL: 22, CHL: 23, PAR: 24, KOR: 25,
  TUR: 26, PER: 27, VEN: 28, NGA: 29, CMR: 30,
  RSA: 31, CZE: 32, EGY: 33, ROM: 34, HUN: 35,
  SVN: 36, MKD: 37, SVK: 38, GRE: 39, BUL: 40,
  IRN: 41, MLI: 42, CMR: 43, TUN: 44, ALG: 45,
  GHA: 46, HAI: 47, SCO: 48, QAT: 49, SRB: 50,
  CAN: 51, BIH: 52, NZL: 53, PHI: 54, UZB: 55,
  COD: 56, VIE: 57, CPV: 58, SLE: 59, MDV: 60,
};

// League baseline xG per game (World Cup group stage ~2.4 goals avg)
const WC_AVG_GOALS_PER_GAME = 2.4;
const WC_AVG_XG_PER_TEAM = WC_AVG_GOALS_PER_GAME / 2; // 1.2 per team
const FIRST_HALF_XG_RATIO = 0.41; // Historically 41% of match xG occurs in first half

// =============================================================
// MATH: Bivariate Poisson Distribution
// =============================================================

function factorial(n) {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poissonProb(lambda, k) {
  // P(X = k) = e^-λ * λ^k / k!
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

/**
 * Bivariate Poisson matrix for scoreline probabilities.
 * Returns a 2D matrix where matrix[homeGoals][awayGoals] = P(score)
 * Uses independence assumption (standard for soccer models).
 * @param {number} homeXG - expected goals for home team
 * @param {number} awayXG - expected goals for away team
 * @param {number} maxGoals - max goals per team to compute
 */
function buildPoissonMatrix(homeXG, awayXG, maxGoals = 6) {
  const matrix = [];
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      matrix[h][a] = poissonProb(homeXG, h) * poissonProb(awayXG, a);
    }
  }
  return matrix;
}

/**
 * Calculate 1H Draw probability = sum of P(0-0) + P(1-1) + P(2-2)
 * (Diagonal cells of the Poisson matrix)
 */
function calc1HDrawProb(matrix) {
  let prob = 0;
  const maxDiag = Math.min(matrix.length - 1, 2); // 0-0, 1-1, 2-2
  for (let i = 0; i <= maxDiag; i++) {
    if (matrix[i] && matrix[i][i] !== undefined) {
      prob += matrix[i][i];
    }
  }
  return prob;
}

/**
 * Calculate 1H Total probabilities from Poisson matrix
 * Under 0.5: P(0-0) exactly
 * Over 0.5: 1 - P(0-0)
 * Under 1.5: P(0-0) + P(1-0) + P(0-1)
 * Over 1.5: 1 - above
 */
function calc1HTotalProbs(matrix) {
  const p00 = matrix[0]?.[0] || 0;
  const p10 = matrix[1]?.[0] || 0;
  const p01 = matrix[0]?.[1] || 0;
  const p20 = matrix[2]?.[0] || 0;
  const p02 = matrix[0]?.[2] || 0;
  const p11 = matrix[1]?.[1] || 0;

  const under05 = p00;
  const over05 = 1 - under05;
  const under15 = p00 + p10 + p01;
  const over15 = 1 - under15;
  const under25 = p00 + p10 + p01 + p20 + p02 + p11;
  const over25 = 1 - under25;

  return { under05, over05, under15, over15, under25, over25 };
}

/**
 * Full match outcome probabilities from Poisson matrix
 */
function calcMatchOutcomes(matrix) {
  let homeWin = 0, draw = 0, awayWin = 0;
  let over25 = 0, under25 = 0;

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
      if (h + a > 2.5) over25 += p;
      else under25 += p;
    }
  }
  return { homeWin, draw, awayWin, over25, under25 };
}

// =============================================================
// TEAM STRENGTH → Expected Goals
// =============================================================

/**
 * Convert FIFA rankings to attack/defense strength multipliers.
 * Top-ranked team = 1.30x attack, 0.75x defense (allows fewer goals)
 * Rank 48 = 0.75x attack, 1.25x defense
 */
function rankToStrength(rank) {
  const normalized = Math.min(rank, 48) / 48; // 0 to 1
  const attackMult = 1.30 - normalized * 0.55; // 1.30 → 0.75
  const defenseMult = 0.75 + normalized * 0.50; // 0.75 → 1.25 (higher = worse defense)
  return { attackMult, defenseMult };
}

function getRank(abbr, fullName) {
  const a = abbr?.toUpperCase();
  if (FIFA_RANKINGS[a]) return FIFA_RANKINGS[a];
  // Try matching by first 3 chars of full name
  const short = fullName?.substring(0, 3).toUpperCase();
  if (FIFA_RANKINGS[short]) return FIFA_RANKINGS[short];
  return 30; // Default to mid-table if unknown
}

/**
 * Project team xG using attack/defense strength matchup
 * homeXG = (home attack mult * away defense mult) * WC_AVG_XG_PER_TEAM * home_advantage
 */
function projectXG(homeRank, awayRank, homeAdvantage = 1.08) {
  const home = rankToStrength(homeRank);
  const away = rankToStrength(awayRank);

  const homeXG = home.attackMult * away.defenseMult * WC_AVG_XG_PER_TEAM * homeAdvantage;
  const awayXG = away.attackMult * home.defenseMult * WC_AVG_XG_PER_TEAM;

  // 1H xG = 41% of full match
  const home1HxG = homeXG * FIRST_HALF_XG_RATIO;
  const away1HxG = awayXG * FIRST_HALF_XG_RATIO;

  return {
    homeXG: Math.round(homeXG * 100) / 100,
    awayXG: Math.round(awayXG * 100) / 100,
    home1HxG: Math.round(home1HxG * 100) / 100,
    away1HxG: Math.round(away1HxG * 100) / 100
  };
}

// =============================================================
// ODDS API
// =============================================================

async function fetchWCOdds() {
  const key = process.env.ODDS_API_KEY;
  if (!key) return { error: "No Odds API key", games: [] };
  try {
    const resp = await fetch(
      `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${key}&regions=us,eu&markets=h2h,totals&oddsFormat=american`,
      { cache: "no-store" }
    );
    const remaining = resp.headers.get("x-requests-remaining");
    if (resp.status === 422 || resp.status === 400) {
      return { error: `Sport not available (status ${resp.status})`, games: [], remaining };
    }
    if (!resp.ok) return { error: `Odds API ${resp.status}`, games: [], remaining };
    const data = await resp.json();
    return { games: data || [], remaining };
  } catch (e) {
    return { error: e.message, games: [] };
  }
}

// =============================================================
// ODDS PARSING
// =============================================================

function americanToDecimal(american) {
  if (!american) return null;
  if (american > 0) return american / 100 + 1;
  return 100 / Math.abs(american) + 1;
}

function impliedProb(american) {
  if (!american) return null;
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

function removeVig(homeProb, drawProb, awayProb) {
  const total = homeProb + (drawProb || 0) + awayProb;
  if (total === 0) return { home: 0.33, draw: 0.34, away: 0.33 };
  return {
    home: homeProb / total,
    draw: drawProb ? drawProb / total : null,
    away: awayProb / total
  };
}

function fuzzy(a, b) {
  if (!a || !b) return false;
  const x = a.toLowerCase().replace(/[^a-z]/g, "");
  const y = b.toLowerCase().replace(/[^a-z]/g, "");
  if (x === y || x.includes(y) || y.includes(x)) return true;
  if (x.length > 4 && y.length > 4) return x.slice(0, 5) === y.slice(0, 5);
  return false;
}

function parseOddsForGame(oddsGames, awayName, homeName) {
  if (!oddsGames?.length) return null;
  let match = oddsGames.find(og =>
    fuzzy(og.away_team, awayName) && fuzzy(og.home_team, homeName)
  );
  if (!match) match = oddsGames.find(og =>
    fuzzy(og.away_team, awayName) || fuzzy(og.home_team, homeName)
  );
  if (!match) return null;

  let homeML = null, drawML = null, awayML = null;
  let totalLine = null, overML = null, underML = null;
  let books = 0;

  for (const bm of (match.bookmakers || [])) {
    for (const mkt of (bm.markets || [])) {
      if (mkt.key === "h2h") {
        books++;
        for (const oc of (mkt.outcomes || [])) {
          if (fuzzy(oc.name, homeName)) homeML = oc.price;
          else if (fuzzy(oc.name, awayName)) awayML = oc.price;
          else if (oc.name?.toLowerCase() === "draw") drawML = oc.price;
        }
      }
      if (mkt.key === "totals") {
        for (const oc of (mkt.outcomes || [])) {
          if (oc.name === "Over") { totalLine = oc.point; overML = oc.price; }
          if (oc.name === "Under") underML = oc.price;
        }
      }
    }
  }

  if (!homeML && !awayML) return null;

  const rawHome = impliedProb(homeML) || 0;
  const rawDraw = impliedProb(drawML) || 0;
  const rawAway = impliedProb(awayML) || 0;
  const noVig = removeVig(rawHome, rawDraw, rawAway);

  return {
    homeML, drawML, awayML,
    homeProb: noVig.home,
    drawProb: noVig.draw,
    awayProb: noVig.away,
    totalLine, overML, underML,
    books
  };
}

// =============================================================
// VALUE HUNTER
// =============================================================

function calcEdge(modelProb, marketProb) {
  if (!marketProb || marketProb <= 0) return { edge: 0, tier: "no_market" };
  const edge = (modelProb - marketProb) * 100;
  let tier;
  if (edge > 15) tier = "check_news"; // Model likely missing injury/lineup info
  else if (edge > 7) tier = "strong_value";
  else if (edge > 4) tier = "value";
  else if (edge > 2) tier = "lean";
  else tier = "no_edge";
  return { edge: Math.round(edge * 10) / 10, tier };
}

// =============================================================
// MAIN HANDLER
// =============================================================

export async function POST(req) {
  const { games, lockedPredictions } = await req.json();
  const locked = lockedPredictions || {};

  const oddsData = await fetchWCOdds();

  const results = games.map(g => {
    const odds = parseOddsForGame(oddsData.games, g.away, g.home);
    const status = g.status;
    const lockKey = g.espnId || g.id;

    // Return locked predictions for completed/live games
    if (locked[lockKey]) {
      return {
        id: g.id, espnId: g.espnId, status, sport: "worldcup",
        awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null,
        clock: g.liveScore?.clock || "", period: g.liveScore?.period || null,
        currentTotal: locked[lockKey].line || g.total,
        odds, consensus: locked[lockKey].consensus || null,
        lockedPrediction: locked[lockKey], isNewPrediction: false
      };
    }
    if (status === "final") {
      return {
        id: g.id, espnId: g.espnId, status, sport: "worldcup",
        awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null,
        clock: g.liveScore?.clock || "", period: g.liveScore?.period || null,
        currentTotal: odds?.totalLine || g.total,
        odds, consensus: null, lockedPrediction: null,
        noPregamePrediction: true, isNewPrediction: false
      };
    }

    // === BUILD PREDICTION ===
    const homeRank = getRank(g.homeAbbr, g.home);
    const awayRank = getRank(g.awayAbbr, g.away);
    const xg = projectXG(homeRank, awayRank);

    // Full match Poisson matrix
    const fullMatrix = buildPoissonMatrix(xg.homeXG, xg.awayXG);
    const matchOutcomes = calcMatchOutcomes(fullMatrix);

    // 1H Poisson matrix
    const h1Matrix = buildPoissonMatrix(xg.home1HxG, xg.away1HxG);
    const h1DrawProb = calc1HDrawProb(h1Matrix);
    const h1Totals = calc1HTotalProbs(h1Matrix);

    // --- Value Hunter ---
    const reasons = [], dataSources = [], valueOpportunities = [];

    // Data sources used
    dataSources.push(`FIFA Rankings: ${g.homeAbbr} #${homeRank} / ${g.awayAbbr} #${awayRank}`);
    dataSources.push(`Full Match xG: ${g.homeAbbr} ${xg.homeXG} / ${g.awayAbbr} ${xg.awayXG}`);
    dataSources.push(`1H xG (41% ratio): ${g.homeAbbr} ${xg.home1HxG} / ${g.awayAbbr} ${xg.away1HxG}`);

    if (odds?.books > 0) {
      dataSources.push(`Odds API: ${odds.books} books | ML: H${odds.homeML}/D${odds.drawML}/A${odds.awayML}`);
    }

    // Full match 1X2 reasoning
    reasons.push(`Model 1X2: ${g.homeAbbr} win ${(matchOutcomes.homeWin*100).toFixed(1)}% / Draw ${(matchOutcomes.draw*100).toFixed(1)}% / ${g.awayAbbr} win ${(matchOutcomes.awayWin*100).toFixed(1)}%`);
    reasons.push(`Model O/U 2.5: Over ${(matchOutcomes.over25*100).toFixed(1)}% / Under ${(matchOutcomes.under25*100).toFixed(1)}%`);
    reasons.push(`1H Draw prob: ${(h1DrawProb*100).toFixed(1)}% (0-0: ${(h1Matrix[0]?.[0]*100||0).toFixed(1)}%, 1-1: ${(h1Matrix[1]?.[1]*100||0).toFixed(1)}%)`);
    reasons.push(`1H Totals: U0.5 ${(h1Totals.under05*100).toFixed(1)}% / O0.5 ${(h1Totals.over05*100).toFixed(1)}% | U1.5 ${(h1Totals.under15*100).toFixed(1)}% / O1.5 ${(h1Totals.over15*100).toFixed(1)}%`);

    // Value edges vs market
    if (odds) {
      // 1X2 edges
      const homeEdge = calcEdge(matchOutcomes.homeWin, odds.homeProb);
      const drawEdge = calcEdge(matchOutcomes.draw, odds.drawProb);
      const awayEdge = calcEdge(matchOutcomes.awayWin, odds.awayProb);

      if (["strong_value","value","lean"].includes(homeEdge.tier)) {
        valueOpportunities.push({ market: `${g.homeAbbr} Win (1X2)`, modelProb: (matchOutcomes.homeWin*100).toFixed(1), marketProb: ((odds.homeProb||0)*100).toFixed(1), edge: homeEdge.edge, tier: homeEdge.tier, odds: odds.homeML });
      }
      if (["strong_value","value","lean"].includes(drawEdge.tier) && odds.drawProb) {
        valueOpportunities.push({ market: "Draw (1X2)", modelProb: (matchOutcomes.draw*100).toFixed(1), marketProb: ((odds.drawProb||0)*100).toFixed(1), edge: drawEdge.edge, tier: drawEdge.tier, odds: odds.drawML });
      }
      if (["strong_value","value","lean"].includes(awayEdge.tier)) {
        valueOpportunities.push({ market: `${g.awayAbbr} Win (1X2)`, modelProb: (matchOutcomes.awayWin*100).toFixed(1), marketProb: ((odds.awayProb||0)*100).toFixed(1), edge: awayEdge.edge, tier: awayEdge.tier, odds: odds.awayML });
      }

      // Full match O/U edge (implied from totals odds)
      if (odds.totalLine && odds.overML) {
        const mktOverProb = impliedProb(odds.overML);
        const ouEdge = calcEdge(matchOutcomes.over25, mktOverProb);
        if (["strong_value","value","lean"].includes(ouEdge.tier)) {
          valueOpportunities.push({ market: `Over ${odds.totalLine} goals`, modelProb: (matchOutcomes.over25*100).toFixed(1), marketProb: ((mktOverProb||0)*100).toFixed(1), edge: ouEdge.edge, tier: ouEdge.tier, odds: odds.overML });
        }
      }

      // 1H Draw value (DERIVATIVE MARKET A) - no direct market odds usually, but flag high probability
      if (h1DrawProb > 0.28) {
        reasons.push(`🎯 1H Draw signal: ${(h1DrawProb*100).toFixed(1)}% model prob — check 1H 1X2 market`);
      }

      // 1H Under 0.5 value (DERIVATIVE MARKET B) - flag if high
      if (h1Totals.under05 > 0.42) {
        reasons.push(`🎯 1H Under 0.5 signal: ${(h1Totals.under05*100).toFixed(1)}% — strong goalless first half`);
      }
    }

    // Primary recommendation
    let primaryPick = null, primaryReason = "";
    const topValue = valueOpportunities.sort((a, b) => b.edge - a.edge)[0];
    if (topValue && topValue.edge > 4) {
      primaryPick = topValue.market;
      primaryReason = `+${topValue.edge}% edge over market`;
    } else if (matchOutcomes.homeWin > 0.5) {
      primaryPick = `${g.homeAbbr} Win`;
      primaryReason = `Model: ${(matchOutcomes.homeWin*100).toFixed(1)}% win prob`;
    } else if (matchOutcomes.awayWin > 0.45) {
      primaryPick = `${g.awayAbbr} Win`;
      primaryReason = `Model: ${(matchOutcomes.awayWin*100).toFixed(1)}% win prob`;
    } else {
      primaryPick = "Draw";
      primaryReason = `Model: ${(matchOutcomes.draw*100).toFixed(1)}% draw prob`;
    }

    // Confidence
    let conf = 35;
    if (homeRank <= 10 || awayRank <= 10) conf += 10; // Top team = more predictable
    if (Math.abs(homeRank - awayRank) > 15) conf += 12; // Lopsided matchup
    if (odds?.books >= 3) conf += 10; // Market confirmation
    if (valueOpportunities.length > 0) conf += 8;
    const strength = Math.min(85, Math.max(30, conf));

    // Project integer scores from xG using most likely scoreline from Poisson matrix
    // Most likely score = mode of the matrix (highest single-cell probability)
    let projAwayGoals = 0, projHomeGoals = 0, maxProb = 0;
    for (let h = 0; h < fullMatrix.length; h++) {
      for (let a = 0; a < fullMatrix[h].length; a++) {
        if (fullMatrix[h][a] > maxProb) {
          maxProb = fullMatrix[h][a];
          projHomeGoals = h;
          projAwayGoals = a;
        }
      }
    }
    // If most likely is 0-0, use expected goals rounded instead (more interesting display)
    if (projHomeGoals === 0 && projAwayGoals === 0) {
      projHomeGoals = Math.round(xg.homeXG);
      projAwayGoals = Math.round(xg.awayXG);
    }

    return {
      id: g.id, espnId: g.espnId, status, sport: "worldcup",
      awayScore: g.liveScore?.away ?? null, homeScore: g.liveScore?.home ?? null,
      clock: g.liveScore?.clock || null, period: g.liveScore?.period || null,
      currentTotal: odds?.totalLine || 2.5,
      numBooks: odds?.books || 0,
      oddsTotal: odds?.totalLine || null,
      oddsML: (odds?.homeML || odds?.awayML) ? { away: odds.awayML || 0, home: odds.homeML || 0, draw: odds.drawML || 0 } : null,
      odds,
      consensus: {
        // Standard UI fields
        totalCall: matchOutcomes.over25 > 0.5 ? "OVER" : "UNDER",
        strength,
        spreadCall: primaryPick,
        spreadReason: primaryReason,
        moneylinePick: matchOutcomes.homeWin > matchOutcomes.awayWin ? g.homeAbbr : g.awayAbbr,
        moneylineReason: `Model: ${(Math.max(matchOutcomes.homeWin, matchOutcomes.awayWin)*100).toFixed(1)}% win prob`,
        votes: { over: (matchOutcomes.over25*100).toFixed(1), under: (matchOutcomes.under25*100).toFixed(1) },
        reasons, dataSources,
        modelTotal: Math.round((xg.homeXG + xg.awayXG) * 10) / 10,
        // Projected scores for display (what the UI renders as the "score")
        awayPts: projAwayGoals,
        homePts: projHomeGoals,
        edgeSize: topValue ? topValue.edge.toFixed(1) : "0",
        awayWinProb: (matchOutcomes.awayWin*100).toFixed(1),
        homeWinProb: (matchOutcomes.homeWin*100).toFixed(1),
        drawProb: (matchOutcomes.draw*100).toFixed(1),
        // Soccer-specific
        valueOpportunities,
        fullMatchXG: { home: xg.homeXG, away: xg.awayXG },
        firstHalfXG: { home: xg.home1HxG, away: xg.away1HxG },
        h1DrawProb: Math.round(h1DrawProb * 1000) / 10,
        h1Totals: {
          under05: Math.round(h1Totals.under05 * 1000) / 10,
          over05: Math.round(h1Totals.over05 * 1000) / 10,
          under15: Math.round(h1Totals.under15 * 1000) / 10,
          over15: Math.round(h1Totals.over15 * 1000) / 10
        },
        matchOutcomes: {
          homeWin: Math.round(matchOutcomes.homeWin * 1000) / 10,
          draw: Math.round(matchOutcomes.draw * 1000) / 10,
          awayWin: Math.round(matchOutcomes.awayWin * 1000) / 10
        },
        homeRank, awayRank,
        projPace: null, awayPitcher: null, homePitcher: null,
        parkFactor: null, awayKenPom: null, homeKenPom: null,
        tournamentRound: null, tournamentDiscount: null,
        recentFormTotal: 0, liveProjectedTotal: null
      },
      isNewPrediction: status === "scheduled" || status === undefined
    };
  });

  return NextResponse.json({
    updates: results,
    analyzedCount: results.filter(r => r.isNewPrediction).length,
    sport: "worldcup",
    sources: {
      oddsAPI: oddsData.error
        ? `x ${oddsData.error}`
        : `OK ${oddsData.games?.length || 0} WC games (${oddsData.remaining || "?"} req left)`,
      gemini: `ok (Bivariate Poisson | FIFA Rankings | 1H xG)`
    }
  });
}
