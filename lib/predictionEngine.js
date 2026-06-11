/**
 * predictionEngine.js
 * Runs the Log-5 moneyline and adjusted Pythagorean totals calculations.
 * Outputs explicit moneyline probabilities and projected run totals.
 */

import { projectRunsAllowed } from "./dataAggregator.js";

const PITCHING_HARD_CAP = 8.50; // Applied when both starters are elite

// ============================================================
// MONEYLINE: Log-5 Formula
// ============================================================

/**
 * Convert American moneyline odds to implied probability.
 */
export function mlToProb(american) {
  if (!american) return 0.5;
  return american < 0
    ? Math.abs(american) / (Math.abs(american) + 100)
    : 100 / (american + 100);
}

/**
 * Convert probability to American odds (for display).
 */
export function probToAmerican(p) {
  if (p >= 1.0) return -9999;
  if (p <= 0.0) return 9999;
  if (p >= 0.5) return Math.round(-100 * p / (1 - p));
  return Math.round(100 * (1 - p) / p);
}

/**
 * Log-5 formula (Bill James):
 * P(A beats B) = A(1-B) / [A(1-B) + B(1-A)]
 * 
 * where A and B are "true talent" win percentages derived from
 * pitching composite ERA (60% starter / 40% bullpen), team offensive
 * quality, and ML market implied probability.
 * 
 * We blend: 60% pitching quality signal + 40% market implied probability.
 * This prevents overconfidence when the market disagrees with the model.
 */
export function log5WinProb(pA, pB) {
  if (pA + pB <= 0) return 0.5;
  const num = pA * (1 - pB);
  return num / (num + pB * (1 - pA));
}

/**
 * Derive team win probability from composite ERA.
 * Better pitcher (lower ERA) = higher win probability.
 * Uses a quality ratio to produce a probability.
 */
function eraToWinProb(awayCompositeERA, homeCompositeERA) {
  const awayQ = 1 / Math.max(awayCompositeERA, 0.5);
  const homeQ = 1 / Math.max(homeCompositeERA, 0.5);
  // Home team gets slight 3% advantage for home field
  const homeAdj = homeQ * 1.06;
  return homeAdj / (awayQ + homeAdj);
}

/**
 * Calculate blended win probability using:
 * - 60% pitching quality (ERA-derived Log-5)
 * - 40% market implied probability
 * 
 * This is the core "Weighted Probability" from the spec.
 */
export function calcWinProbabilities(matchupProfile) {
  const { awayComposite, homeComposite, awayML, homeML } = matchupProfile;

  // Pitching component
  const pitchingHomeWP = eraToWinProb(awayComposite, homeComposite);
  const pitchingAwayWP = 1 - pitchingHomeWP;

  // Market component
  const marketHomeWP = mlToProb(homeML);
  const marketAwayWP = mlToProb(awayML);

  // Log-5 blending of pitching talent vs market signal
  const log5Home = log5WinProb(pitchingHomeWP, 1 - marketHomeWP);
  const log5Away = 1 - log5Home;

  // 60% pitching / 40% market
  const finalHomeWP = log5Home * 0.60 + marketHomeWP * 0.40;
  const finalAwayWP = log5Away * 0.60 + marketAwayWP * 0.40;

  // Normalize to sum to 1
  const total = finalHomeWP + finalAwayWP;
  return {
    homeWP: finalHomeWP / total,
    awayWP: finalAwayWP / total,
    pitchingHomeWP,
    marketHomeWP,
  };
}

// ============================================================
// TOTALS: Pythagorean Run Projection
// ============================================================

/**
 * Project game total using the two-step Pythagorean approach:
 * 1. Each team's expected runs = f(opposing pitcher, park factor)
 * 2. Apply blowup risk adjustment for poor-command pitchers (K/BB < 2.0)
 * 3. Hard-cap at 8.5 when both starters are elite (ERA < 3.50)
 */
export function projectGameTotal(matchupProfile) {
  const {
    awayComposite, homeComposite, parkFactor,
    bothElite, awayBlowupRisk, homeBlowupRisk,
    awayOffQ, homeOffQ, homeWP, awayWP
  } = matchupProfile;

  // Home team runs scored = runs allowed by away pitcher, park-adjusted
  const homeScores = projectRunsAllowed(awayComposite, parkFactor, true) * homeOffQ;
  // Away team runs scored = runs allowed by home pitcher, no park boost
  const awayScores = projectRunsAllowed(homeComposite, 1.0, false) * awayOffQ;

  let modelTotal = homeScores + awayScores;

  // Blowup risk: poor command pitchers increase variance / run expectation
  if (awayBlowupRisk) modelTotal += 0.40;
  if (homeBlowupRisk) modelTotal += 0.40;

  // Pitching hard-cap
  const hardCapped = bothElite && modelTotal > PITCHING_HARD_CAP;
  if (hardCapped) modelTotal = PITCHING_HARD_CAP;

  modelTotal = Math.round(modelTotal * 10) / 10;

  // Split runs between teams (NO TIES)
  // Use ML-derived win probability for the split
  const mhWP = matchupProfile.homeWP || 0.5;
  const homeShare = 0.50 + (mhWP - 0.5) * 0.6;
  const roundedTotal = Math.round(modelTotal);
  const rawHome = roundedTotal * homeShare;
  let projHome = mhWP >= 0.5 ? Math.ceil(rawHome) : Math.floor(rawHome);
  let projAway = roundedTotal - projHome;
  if (projAway < 0) { projAway = 0; projHome = roundedTotal; }

  const ouCall = modelTotal > (matchupProfile.vegasTotal || 8.5) ? "OVER"
    : modelTotal < (matchupProfile.vegasTotal || 8.5) ? "UNDER" : "TOSS-UP";

  return {
    modelTotal,
    projAway,
    projHome,
    ouCall,
    hardCapped,
    homeScores: Math.round(homeScores * 10) / 10,
    awayScores: Math.round(awayScores * 10) / 10,
  };
}

/**
 * Main prediction runner — combines ML and totals into a single output.
 */
export function runPredictions(matchupProfile) {
  const winProbs = calcWinProbabilities(matchupProfile);
  // Attach win probs to profile for use in totals split
  matchupProfile.homeWP = winProbs.homeWP;
  matchupProfile.awayWP = winProbs.awayWP;

  const totals = projectGameTotal(matchupProfile);

  return {
    // Win probabilities
    homeWP: winProbs.homeWP,
    awayWP: winProbs.awayWP,
    modelHomeOdds: probToAmerican(winProbs.homeWP),
    modelAwayOdds: probToAmerican(winProbs.awayWP),
    // Run totals
    ...totals,
    // Spread (run line)
    modelSpread: Math.round((totals.projHome - totals.projAway) * 10) / 10,
  };
}
