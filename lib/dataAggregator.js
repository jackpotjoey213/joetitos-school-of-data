/**
 * dataAggregator.js
 * Ingests raw MLB stats and outputs a weighted matchup profile for both teams.
 * Implements: 60/40 starter/bullpen blend, last-3-starts weighting, park calibration.
 * All values normalized to per-game run equivalents.
 */

const LEAGUE_AVG_ERA = 4.10;
const ERA_REGRESSION = 0.70; // 70% raw, 30% league avg
const PARK_DAMPENER = 0.50; // Park factor influence at 50%
const LEAGUE_SCORING_MODIFIER = 0.85;
const BULLPEN_RUNS_BASE = 1.20;

// Park factors for all 30 stadiums
export const PARK_FACTORS = {
  COL:1.18,CIN:1.08,TEX:1.06,BOS:1.05,CHC:1.04,PHI:1.03,BAL:1.03,MIL:1.02,
  ATL:1.02,MIN:1.01,ARI:1.01,LAA:1.00,DET:1.00,CLE:1.00,TOR:0.99,WSH:0.99,
  PIT:0.99,KC:0.98,SEA:0.98,STL:0.98,SF:0.97,SD:0.97,HOU:0.97,NYY:0.97,
  CHW:0.96,CWS:0.96,TB:0.96,NYM:0.96,OAK:0.95,MIA:0.95,LAD:0.96
};

/**
 * Regress ERA toward league average to prevent outlier swings.
 * A 2.10 ERA becomes 2.10*0.70 + 4.10*0.30 = 2.70 (still elite but not extreme)
 */
export function regressERA(rawERA) {
  if (!rawERA || rawERA <= 0) return LEAGUE_AVG_ERA;
  return rawERA * ERA_REGRESSION + LEAGUE_AVG_ERA * (1 - ERA_REGRESSION);
}

/**
 * Build effective ERA using 60% last-3-starts + 40% season.
 * Implements the "Split Pitcher Evaluation" from the spec.
 * If no recent start data, falls back to season ERA only.
 */
export function buildEffectiveERA(seasonERA, recentERA) {
  const season = regressERA(seasonERA);
  if (recentERA == null || isNaN(recentERA)) return season;
  const recent = regressERA(recentERA);
  return recent * 0.60 + season * 0.40;
}

/**
 * Build the 60/40 starter + bullpen composite pitching score.
 * starterEffERA: effective ERA of the starting pitcher (innings 1-5)
 * bullpenERA: team bullpen ERA (innings 6-9)
 * Returns: composite ERA weighted 60% starter / 40% bullpen
 */
export function buildCompositePitchingScore(starterEffERA, bullpenERA) {
  const starterReg = regressERA(starterEffERA);
  const bullpenReg = regressERA(bullpenERA || LEAGUE_AVG_ERA);
  return starterReg * 0.60 + bullpenReg * 0.40;
}

/**
 * Project runs allowed by a pitcher in this matchup.
 * Uses: composite pitching score, opponent offensive strength (rpg), park factor.
 * 
 * Formula:
 * - Starter phase (inn 1-5): compositePitch ERA / 9 * 5.5 innings
 * - Bullpen phase (inn 6-9): bullpen ERA / 9 * 3.5 innings (approximated via BULLPEN_RUNS_BASE)
 * - Park factor: dampened 50% to avoid over-weighting stadium
 * - League scoring modifier: 0.85x for 2026 season suppression
 */
export function projectRunsAllowed(compositeERA, parkFactor = 1.0, isHomeTeam = false) {
  const regERA = regressERA(compositeERA);
  const starterRuns = (regERA / 9) * 5.5;
  const bullpenRuns = BULLPEN_RUNS_BASE;
  const dampenedPF = isHomeTeam ? (1.0 + (parkFactor - 1.0) * PARK_DAMPENER) : 1.0;
  return (starterRuns + bullpenRuns) * dampenedPF * LEAGUE_SCORING_MODIFIER;
}

/**
 * Build a complete matchup profile for both teams.
 * Input: raw data objects for each team's pitcher and team stats.
 * Output: normalized matchup object ready for predictionEngine.
 */
export function buildMatchupProfile({
  // Away team
  awayAbbr, awayName,
  awayStarterERA, awayStarterRecentERA, awayStarterWHIP, awayStarterK, awayStarterBB,
  awayBullpenERA, awayRPG,
  awayML,
  // Home team
  homeAbbr, homeName,
  homeStarterERA, homeStarterRecentERA, homeStarterWHIP, homeStarterK, homeStarterBB,
  homeBullpenERA, homeRPG,
  homeML,
  // Game context
  parkFactor,
  vegasTotal,
}) {
  const pf = parkFactor || PARK_FACTORS[homeAbbr] || 1.0;

  // Build effective ERAs
  const awayEffERA = buildEffectiveERA(awayStarterERA, awayStarterRecentERA);
  const homeEffERA = buildEffectiveERA(homeStarterERA, homeStarterRecentERA);

  // Build composite pitching scores
  const awayComposite = buildCompositePitchingScore(awayEffERA, awayBullpenERA);
  const homeComposite = buildCompositePitchingScore(homeEffERA, homeBullpenERA);

  // K/BB ratio (command metric)
  const awayKBB = awayStarterBB > 0 ? awayStarterK / awayStarterBB : 3.0;
  const homeKBB = homeStarterBB > 0 ? homeStarterK / homeStarterBB : 3.0;
  const awayBlowupRisk = awayKBB < 2.0; // Poor command = higher variance
  const homeBlowupRisk = homeKBB < 2.0;

  // Pitching hard cap: both starters have raw ERA < 3.50
  const bothElite = (awayStarterERA || 99) < 3.50 && (homeStarterERA || 99) < 3.50;

  // Offensive quality (rpg relative to league avg of 4.5)
  const awayOffQ = (awayRPG || 4.5) / 4.5;
  const homeOffQ = (homeRPG || 4.5) / 4.5;

  return {
    // Identifiers
    awayAbbr, awayName, homeAbbr, homeName,
    // Effective pitcher stats
    awayEffERA, homeEffERA,
    awayComposite, homeComposite,
    // Command metrics
    awayKBB: +awayKBB.toFixed(2),
    homeKBB: +homeKBB.toFixed(2),
    awayBlowupRisk, homeBlowupRisk,
    // Park and environment
    parkFactor: pf,
    bothElite,
    // Offensive context
    awayOffQ, homeOffQ,
    awayRPG: awayRPG || 4.5,
    homeRPG: homeRPG || 4.5,
    // Market context
    awayML: awayML || 0,
    homeML: homeML || 0,
    vegasTotal: vegasTotal || 8.5,
    // Raw for display
    awayWHIP: awayStarterWHIP,
    homeWHIP: homeStarterWHIP,
  };
}
