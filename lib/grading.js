// Shared grading math (moved from components/Predictor.jsx, Nov 12, 2026).
// Pure functions, no React, no browser APIs — so the server-side cron
// route can grade finals with the exact same rules the UI uses.
// Do not change these without changing both callers together.
export function marketMarginHome(spreadOdds, homeAbbr) {
  if (!spreadOdds || spreadOdds.fav == null || spreadOdds.line == null) return null;
  return spreadOdds.fav === homeAbbr ? -spreadOdds.line : spreadOdds.line;
}

// Accurate per-market grading (Oct 31, 2026): ATS by actual margin vs
// the LOCKED spread line, with pushes as pushes — not by winner alone.
// Old locks without a spread line grade ATS as null (can't grade),
// never as a guessed win/loss.
export function gradeTotal(actualTotal, line, call) {
  if (actualTotal == null || !line || !call) return null;
  if (actualTotal === line) return "push";
  return call === "OVER" ? actualTotal > line : actualTotal < line;
}

export function gradeSpread(actualMarginHome, spreadOdds, spreadCall, homeAbbr, awayAbbr) {
  if (actualMarginHome == null || !spreadCall) return null;
  const mkt = marketMarginHome(spreadOdds, homeAbbr);
  if (mkt == null) return null;
  if (spreadCall === homeAbbr) return actualMarginHome === mkt ? "push" : actualMarginHome > mkt;
  if (spreadCall === awayAbbr) return (-actualMarginHome) === (-mkt) ? "push" : (-actualMarginHome) > (-mkt);
  return null;
}

export function gradeML(actualWinner, pick) {
  if (!actualWinner || !pick) return null;
  return actualWinner === pick;
}
