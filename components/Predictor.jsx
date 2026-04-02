"use client";
import { useState, useEffect, useCallback, useRef } from "react";

// No more hardcoded games - everything loads dynamically from ESPN
// --- SELF-LEARNING WEIGHTS ---
const DEFAULT_WEIGHTS = {
  defAdjElite: 0.4, defAdjNormal: 0.25, offEffMod: 0.06,
  shootFG: 5, shoot3P: 3, rebMod: 0.1, toMod: 0.25,
  tourneyFactor: 0.965, hca: 2.0,  // Learned: tourney games even lower scoring than 0.97
  fatiguePenalty: 4.0, injuryMajor: 3.0, injuryMinor: 2.0,
  totalBias: -1.5, spreadBias: 0,  // Learned: model over-predicts totals by ~1.5 on avg
};

// --- STORAGE: API-backed with localStorage fallback ---
async function loadUserData() {
  try {
    const resp = await fetch("/api/settings");
    if (resp.ok) {
      const data = await resp.json();
      return {
        weights: { ...DEFAULT_WEIGHTS, ...(data.settings?.model_weights || {}) },
        teamCal: data.settings?.team_calibrations || {},
        history: (data.predictions || []).map(p => ({
          gameId: p.game_id, away: p.away_team, home: p.home_team,
          predictedTotal: +p.predicted_total, actualTotal: +p.actual_total,
          totalCall: p.total_call, line: +p.line, totalCorrect: p.total_correct,
          spreadCorrect: p.spread_correct, totalError: +p.total_error, date: p.game_date
        }))
      };
    }
  } catch(e) { console.error("API load failed, using defaults:", e); }
  return { weights: { ...DEFAULT_WEIGHTS }, teamCal: {}, history: [] };
}

async function saveSettings(weights, teamCal) {
  try {
    await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "settings", weights, teamCal })
    });
  } catch(e) { console.error("Save settings failed:", e); }
}

async function savePrediction(record) {
  try {
    await fetch("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prediction", ...record })
    });
  } catch(e) { console.error("Save prediction failed:", e); }
}

// --- BACKTESTING DATA: Yesterday's completed games (Fri Mar 13) ---
// Used to validate model before today's picks
const BACKTEST_GAMES = [
  { away:"SBON", home:"DAY", awayPPG:68, homePPG:74, awayPace:66, homePace:68, awayAdjOE:112, homeAdjOE:118, awayAdjDE:104, homeAdjDE:99, awayFGPct:0.44, homeFGPct:0.46, away3Pct:0.34, home3Pct:0.36, actualAway:63, actualHome:68, line:138, spread:{fav:"DAY",line:-5} },
  { away:"WIS", home:"ILL", awayPPG:83, homePPG:80, awayPace:71, homePace:70, awayAdjOE:120, homeAdjOE:118, awayAdjDE:103, homeAdjDE:100, awayFGPct:0.45, homeFGPct:0.46, away3Pct:0.36, home3Pct:0.35, actualAway:91, actualHome:88, line:161, spread:{fav:"ILL",line:-3} },
  { away:"TENN", home:"VAN", awayPPG:72, homePPG:78, awayPace:65, homePace:69, awayAdjOE:115, homeAdjOE:118, awayAdjDE:92, homeAdjDE:101, awayFGPct:0.45, homeFGPct:0.46, away3Pct:0.34, home3Pct:0.35, actualAway:68, actualHome:75, line:140, spread:{fav:"TENN",line:-2} },
  { away:"DUQ", home:"VCU", awayPPG:70, homePPG:76, awayPace:66, homePace:67, awayAdjOE:110, homeAdjOE:118, awayAdjDE:105, homeAdjDE:98, awayFGPct:0.43, homeFGPct:0.46, away3Pct:0.33, home3Pct:0.35, actualAway:66, actualHome:71, line:142, spread:{fav:"VCU",line:-6} },
  { away:"PUR", home:"NEB", awayPPG:77, homePPG:72, awayPace:66, homePace:68, awayAdjOE:119, homeAdjOE:108, awayAdjDE:101, homeAdjDE:106, awayFGPct:0.46, homeFGPct:0.43, away3Pct:0.35, home3Pct:0.33, actualAway:74, actualHome:58, line:140, spread:{fav:"PUR",line:-8} },
  { away:"ISU", home:"ARIZ", awayPPG:76, homePPG:82, awayPace:67, homePace:69, awayAdjOE:122, homeAdjOE:128, awayAdjDE:96, homeAdjDE:92, awayFGPct:0.45, homeFGPct:0.48, away3Pct:0.34, home3Pct:0.37, actualAway:80, actualHome:82, line:143, spread:{fav:"ARIZ",line:-3.5} },
  { away:"MIA", home:"UVA", awayPPG:68, homePPG:72, awayPace:67, homePace:62, awayAdjOE:108, homeAdjOE:116, awayAdjDE:105, homeAdjDE:92, awayFGPct:0.43, homeFGPct:0.45, away3Pct:0.33, home3Pct:0.35, actualAway:62, actualHome:84, line:132, spread:{fav:"UVA",line:-8} },
  { away:"MISS", home:"ALA", awayPPG:74, homePPG:81, awayPace:68, homePace:72, awayAdjOE:108, homeAdjOE:122, awayAdjDE:110, homeAdjDE:100, awayFGPct:0.43, homeFGPct:0.47, away3Pct:0.32, home3Pct:0.36, actualAway:80, actualHome:79, line:155, spread:{fav:"ALA",line:-7} },
  { away:"GTWN", home:"CONN", awayPPG:65, homePPG:80, awayPace:64, homePace:67, awayAdjOE:105, homeAdjOE:124, awayAdjDE:108, homeAdjDE:94, awayFGPct:0.42, homeFGPct:0.49, away3Pct:0.32, home3Pct:0.36, actualAway:51, actualHome:67, line:138, spread:{fav:"CONN",line:-14} },
  { away:"CLEM", home:"DUKE", awayPPG:75, homePPG:81, awayPace:68, homePace:68, awayAdjOE:116, homeAdjOE:126, awayAdjDE:100, homeAdjDE:91, awayFGPct:0.45, homeFGPct:0.48, away3Pct:0.35, home3Pct:0.37, actualAway:61, actualHome:73, line:135, spread:{fav:"DUKE",line:-10.5} },
  { away:"KU", home:"HOU", awayPPG:78, homePPG:76, awayPace:69, homePace:65, awayAdjOE:120, homeAdjOE:125, awayAdjDE:101, homeAdjDE:93, awayFGPct:0.45, homeFGPct:0.45, away3Pct:0.35, home3Pct:0.34, actualAway:47, actualHome:69, line:138, spread:{fav:"HOU",line:-3} },
  { away:"OKLA", home:"ARK", awayPPG:72, homePPG:82, awayPace:67, homePace:72, awayAdjOE:112, homeAdjOE:121, awayAdjDE:104, homeAdjDE:99, awayFGPct:0.44, homeFGPct:0.47, away3Pct:0.34, home3Pct:0.35, actualAway:79, actualHome:82, line:154, spread:{fav:"ARK",line:-7} },
  { away:"UCLA", home:"MSU", awayPPG:74, homePPG:78, awayPace:67, homePace:70, awayAdjOE:113, homeAdjOE:119, awayAdjDE:103, homeAdjDE:99, awayFGPct:0.44, homeFGPct:0.46, away3Pct:0.33, home3Pct:0.35, actualAway:88, actualHome:84, line:148, spread:{fav:"MSU",line:-4} },
];

// --- PER-TEAM CALIBRATION STORAGE ---
// teamCal storage is now handled by saveSettings() above

// --- PACE PROJECTION MODEL ---
// Instead of just averaging season pace, project the actual game pace
// based on how each team's pace interacts with their opponent's style
function projectGamePace(awayPace, homePace, awayAdjDE, homeAdjDE) {
  const D1_AVG_PACE = 68;
  // Teams facing elite defense play slower; teams facing weak defense play faster
  const awayPaceVsD = awayPace + (homeAdjDE - 100) * 0.15; // Good D slows you
  const homePaceVsD = homePace + (awayAdjDE - 100) * 0.15;
  // Weighted: both teams contribute to actual pace, but the slower team has more pull
  const slower = Math.min(awayPaceVsD, homePaceVsD);
  const faster = Math.max(awayPaceVsD, homePaceVsD);
  // Slower team controls pace ~60% (they dictate tempo more)
  return slower * 0.6 + faster * 0.4;
}

// --- UPGRADED PREDICTION ENGINE ---
function predictGame(game, weights, liveAdj, teamCal) {
  const s = game.stats;
  const w = weights || DEFAULT_WEIGHTS;
  const cal = teamCal || {};

  // UPGRADE 1: Pace projection (not just averaging)
  const projPace = projectGamePace(s.awayPace, s.homePace, s.awayAdjDE, s.homeAdjDE);
  const awayPaceAdj = s.awayPPG * (projPace / s.awayPace);
  const homePaceAdj = s.homePPG * (projPace / s.homePace);

  // Opponent defense adjustment (non-linear for elite D)
  const D1_AVG_DE = 100;
  const defA = (d) => { const x = d - D1_AVG_DE; return x < -5 ? x * w.defAdjElite : x * w.defAdjNormal; };
  const awayOppAdj = awayPaceAdj + defA(s.homeAdjDE);
  const homeOppAdj = homePaceAdj + defA(s.awayAdjDE);

  // Efficiency modifiers
  const D1_AVG_OE = 110;
  const awayEffMod = (s.awayAdjOE - D1_AVG_OE) * w.offEffMod;
  const homeEffMod = (s.homeAdjOE - D1_AVG_OE) * w.offEffMod;
  const awayShootMod = ((s.awayFGPct - 0.45) * w.shootFG) + ((s.away3Pct - 0.35) * w.shoot3P);
  const homeShootMod = ((s.homeFGPct - 0.45) * w.shootFG) + ((s.home3Pct - 0.35) * w.shoot3P);
  const rebM = (s.homeRebPG - s.awayRebPG) * w.rebMod;
  const toM = (s.awayTOPG - s.homeTOPG) * w.toMod;

  let awayScore = (awayOppAdj + awayEffMod + awayShootMod - toM * 0.5 - rebM * 0.5) * w.tourneyFactor;
  let homeScore = (homeOppAdj + homeEffMod + homeShootMod + toM * 0.5 + rebM * 0.5) * w.tourneyFactor + w.hca;

  // Situational adjustments
  const chk = (str, kw) => str?.toLowerCase().includes(kw.toLowerCase());
  if (chk(s.awayATS, "3OT") || chk(s.awayATS, "triple")) awayScore -= w.fatiguePenalty;
  if (chk(s.homeATS, "3OT") || chk(s.homeATS, "triple")) homeScore -= w.fatiguePenalty;
  if (chk(s.homeATS, "Missing")) homeScore -= w.injuryMajor;
  if (chk(s.awayATS, "Missing")) awayScore -= w.injuryMajor;
  if (chk(s.homeATS, "Lost")) homeScore -= w.injuryMinor;
  if (chk(s.awayATS, "Lost")) awayScore -= w.injuryMinor;

  // Live adjustments from AI refresh
  if (liveAdj) {
    awayScore += (liveAdj.awayScoreAdj || 0);
    homeScore += (liveAdj.homeScoreAdj || 0);
  }

  // UPGRADE 2: Per-team calibration
  // If we've learned we consistently over/under-predict a specific team, apply correction
  const awayCal = cal[game.awayAbbr]?.bias || 0;
  const homeCal = cal[game.homeAbbr]?.bias || 0;
  awayScore += awayCal;
  homeScore += homeCal;

  // Learned global bias
  awayScore += w.totalBias / 2;
  homeScore += w.totalBias / 2;

  awayScore = Math.round(awayScore * 10) / 10;
  homeScore = Math.round(homeScore * 10) / 10;
  const predictedTotal = Math.round((awayScore + homeScore) * 10) / 10;
  const predictedSpread = Math.round((homeScore - awayScore) * 10) / 10;
  const totalDiff = predictedTotal - game.total;
  const spreadDiff = predictedSpread - Math.abs(game.spread.line) * (game.spread.fav === game.homeAbbr ? 1 : -1);
  const defMatchup = (s.awayAdjDE + s.homeAdjDE) / 2;
  const paceAvg = projPace;

  // Confidence with moderate threshold (3+ pts = flagged edge)
  const EDGE_THRESHOLD = 3;
  const hasEdge = Math.abs(totalDiff) >= EDGE_THRESHOLD || Math.abs(spreadDiff) >= EDGE_THRESHOLD;
  const totalEdge = Math.min(Math.abs(totalDiff) * 1.2, 8);
  const spreadEdge = Math.min(Math.abs(spreadDiff) * 0.8, 6);
  const closePenalty = Math.abs(game.spread.line) < 3 ? -3 : 0;
  const effGap = Math.abs(s.awayAdjOE - s.homeAdjOE) + Math.abs(s.awayAdjDE - s.homeAdjDE);
  const effBonus = Math.min(effGap * 0.15, 5);
  const conf = Math.min(74, Math.max(52, 52 + totalEdge + spreadEdge + closePenalty + effBonus));

  return {
    awayScore, homeScore, predictedTotal, predictedSpread, totalDiff, spreadDiff,
    totalCall: totalDiff > 0 ? "OVER" : "UNDER",
    spreadCall: predictedSpread > 0
      ? (game.spread.fav === game.homeAbbr ? (predictedSpread > Math.abs(game.spread.line) ? game.homeAbbr : game.awayAbbr) : game.homeAbbr)
      : game.awayAbbr,
    confidence: Math.round(conf), defMatchup, paceAvg, projPace, hasEdge
  };
}

// --- UPGRADED LEARNING: Per-team calibration + global ---
function learnFromResult(weights, pred, actualTotal, teamCal, awayAbbr, homeAbbr, actualAway, actualHome) {
  const w = { ...weights };
  const cal = { ...teamCal };
  const lr = 0.05;

  // Global total bias
  const totalError = actualTotal - pred.predictedTotal;
  w.totalBias = Math.max(-8, Math.min(8, w.totalBias + totalError * lr));

  // Tournament factor
  if (totalError > 5) w.tourneyFactor = Math.min(1.02, w.tourneyFactor + 0.002);
  else if (totalError < -5) w.tourneyFactor = Math.max(0.93, w.tourneyFactor - 0.002);

  // Elite D calibration
  if (pred.defMatchup < 96 && totalError > 4) w.defAdjElite = Math.max(0.2, w.defAdjElite - 0.01);
  else if (pred.defMatchup < 96 && totalError < -4) w.defAdjElite = Math.min(0.6, w.defAdjElite + 0.01);

  // UPGRADE: Per-team calibration
  if (actualAway != null) {
    const awayError = actualAway - pred.awayScore;
    if (!cal[awayAbbr]) cal[awayAbbr] = { bias: 0, n: 0 };
    cal[awayAbbr].bias = Math.max(-6, Math.min(6, cal[awayAbbr].bias + awayError * lr));
    cal[awayAbbr].n++;
  }
  if (actualHome != null) {
    const homeError = actualHome - pred.homeScore;
    if (!cal[homeAbbr]) cal[homeAbbr] = { bias: 0, n: 0 };
    cal[homeAbbr].bias = Math.max(-6, Math.min(6, cal[homeAbbr].bias + homeError * lr));
    cal[homeAbbr].n++;
  }

  return { weights: w, teamCal: cal };
}

// --- BACKTESTING ENGINE ---
function runBacktest(weights, teamCal) {
  let totalCorrect = 0, spreadCorrect = 0, totalError = 0;
  const results = BACKTEST_GAMES.map(g => {
    const fakeGame = {
      awayAbbr: g.away, homeAbbr: g.home, total: g.line,
      spread: g.spread, moneyline: { away: 0, home: 0 },
      stats: {
        awayPPG: g.awayPPG, homePPG: g.homePPG, awayPace: g.awayPace, homePace: g.homePace,
        awayAdjOE: g.awayAdjOE, homeAdjOE: g.homeAdjOE, awayAdjDE: g.awayAdjDE, homeAdjDE: g.homeAdjDE,
        awayFGPct: g.awayFGPct, homeFGPct: g.homeFGPct, away3Pct: g.away3Pct, home3Pct: g.home3Pct,
        awayRebPG: 35, homeRebPG: 36, awayTOPG: 11, homeTOPG: 11,
        awayATS: "", homeATS: "", awayHomeRec: "", homeHomeRec: "", h2hTrend: "", overTrend: ""
      }
    };
    const pred = predictGame(fakeGame, weights, null, teamCal);
    const actualTotal = g.actualAway + g.actualHome;
    const actualSpread = g.actualHome - g.actualAway;
    const tOk = (pred.totalCall === "OVER" && actualTotal > g.line) || (pred.totalCall === "UNDER" && actualTotal < g.line);
    const sOk = (actualSpread > Math.abs(g.spread.line)) === (pred.spreadCall === g.home);
    if (tOk) totalCorrect++;
    if (sOk) spreadCorrect++;
    totalError += Math.abs(actualTotal - pred.predictedTotal);
    return { away: g.away, home: g.home, predTotal: pred.predictedTotal, actual: actualTotal, line: g.line, tOk, sOk, diff: actualTotal - pred.predictedTotal };
  });
  const n = BACKTEST_GAMES.length;
  return {
    results, n,
    totalPct: ((totalCorrect / n) * 100).toFixed(0),
    spreadPct: ((spreadCorrect / n) * 100).toFixed(0),
    avgError: (totalError / n).toFixed(1),
    totalCorrect, spreadCorrect
  };
}

function getExplanation(game, pred) {
  const reasons = [];
  const s = game.stats;
  if (pred.totalCall === "OVER") {
    if (pred.paceAvg > 70) reasons.push(`Fast tempo (${pred.paceAvg.toFixed(1)} avg pace) creates more scoring chances.`);
    if (s.awayFGPct > 0.46 && s.homeFGPct > 0.46) reasons.push(`Both teams shoot well (${(s.awayFGPct*100).toFixed(1)}% / ${(s.homeFGPct*100).toFixed(1)}% FG).`);
    if (pred.defMatchup > 100) reasons.push(`Neither defense is elite (avg adj DE: ${pred.defMatchup.toFixed(1)}).`);
  } else {
    if (pred.paceAvg < 67) reasons.push(`Slow combined pace (${pred.paceAvg.toFixed(1)}) limits possessions.`);
    if (pred.defMatchup < 97) reasons.push(`Elite defenses in this matchup (avg adj DE: ${pred.defMatchup.toFixed(1)}).`);
    if (s.awayFGPct < 0.45 || s.homeFGPct < 0.45) reasons.push("At least one team has poor shooting efficiency.");
  }
  if (s.awayATS?.includes("3OT")) reasons.push("⚠️ Fatigue: away team played triple OT yesterday.");
  if (s.homeATS?.includes("Missing")) reasons.push("⚠️ Home team missing key player(s).");
  if (s.homeATS?.includes("Lost") || s.awayATS?.includes("Lost")) reasons.push("⚠️ Key player injury affects projections.");
  if (Math.abs(Math.abs(pred.predictedSpread) - Math.abs(game.spread.line)) > 3) {
    reasons.push(`Model diverges ${Math.abs(Math.abs(pred.predictedSpread) - Math.abs(game.spread.line)).toFixed(1)} pts from Vegas - potential edge.`);
  }
  if (!reasons.length) reasons.push("Balanced matchup - marginal edge from efficiency differentials.");
  return reasons;
}

// --- AI REFRESH (calls our secure server-side API route) ---
async function fetchLiveUpdates(games, lockedPredictions, sport) {
  const endpoint = sport === "mlb" ? "/api/mlb-refresh" : "/api/refresh";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ games, lockedPredictions: lockedPredictions || {} })
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error);
  return { updates: data.updates || null, sources: data.sources || null, analyzedCount: data.analyzedCount, skippedFinal: data.skippedFinal };
}

// --- PREDICTION LOCKING (persists to localStorage, separated by sport) ---
function getLockedPredictions(sport) {
  try {
    const key = sport === "mlb" ? "joetito_locked_mlb" : "joetito_locked_ncaab";
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch { return {}; }
}
function lockPrediction(gameId, prediction, sport) {
  const key = sport === "mlb" ? "joetito_locked_mlb" : "joetito_locked_ncaab";
  try {
    const locked = JSON.parse(localStorage.getItem(key) || "{}");
    if (!locked[gameId]) {
      locked[gameId] = { ...prediction, lockedAt: new Date().toISOString(), sport: sport || "ncaab" };
      localStorage.setItem(key, JSON.stringify(locked));
    }
    return locked;
  } catch { return {}; }
}
function getAllLockedPredictions(sport) {
  return getLockedPredictions(sport);
}

// --- UI COMPONENTS ---
const TC = { FLA:"#003087",VAN:"#866D4B",WIS:"#C5050C",MICH:"#00274C",PENN:"#011F5B",HARV:"#A41034",MISS:"#CE1126",ARK:"#9D2235",PUR:"#CEB888",UCLA:"#2D68C4",JOES:"#9E1B34",VCU:"#F8B800",TLSA:"#004B8D",WICH:"#FDB913",HOU:"#C8102E",ARIZ:"#003366",CONN:"#0E1A3B",SJU:"#D41B2C",UVA:"#232D4B",DUKE:"#003087" };

function ConfBadge({ val }) {
  const c = val >= 66 ? "#22c55e" : val >= 58 ? "#eab308" : "#ef4444";
  return <span style={{ background:`${c}18`,color:c,border:`1px solid ${c}40`,padding:"2px 8px",borderRadius:"12px",fontSize:"11px",fontWeight:700 }}>{val}% CONF</span>;
}
function CallBadge({ text, type }) {
  const m = { over:{bg:"#22c55e15",c:"#22c55e",b:"#22c55e30"}, under:{bg:"#3b82f615",c:"#3b82f6",b:"#3b82f630"}, spread:{bg:"#a855f715",c:"#a855f7",b:"#a855f730"} };
  const s = m[type]||m.spread;
  return <span style={{ background:s.bg,color:s.c,border:`1px solid ${s.b}`,padding:"3px 10px",borderRadius:"6px",fontSize:"12px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.5px" }}>{text}</span>;
}

function GameCard({ game, isExpanded, onToggle, weights, liveAdj, teamCal }) {
  const pred = predictGame(game, weights, liveAdj, teamCal);
  const reasons = getExplanation(game, pred);
  const s = game.stats;
  const isLive = game.status === "live", isFinal = game.status === "final";

  return (
    <div style={{ background:"var(--card-bg)",border:`1px solid ${isFinal?"#22c55e30":"var(--border)"}`,borderRadius:"16px",overflow:"hidden",cursor:"pointer" }} onClick={onToggle}>
      <div style={{ padding:"6px 16px",background:"var(--card-header)",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid var(--border)",fontSize:"11px",color:"var(--muted)",fontWeight:600,letterSpacing:"0.8px",textTransform:"uppercase" }}>
        <span>{game.conference}</span>
        <span style={{ display:"flex",alignItems:"center",gap:"6px" }}>
          {isLive && <span style={{ width:6,height:6,borderRadius:"50%",background:"#ef4444",animation:"pulse 1.5s infinite" }} />}
          {isFinal ? <span style={{color:"#22c55e",fontWeight:700}}>FINAL</span> : isLive ? game.liveScore?.clock||"" : game.time}
        </span>
      </div>
      <div style={{ padding:"16px" }}>
        <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"12px" }}>
          <div style={{ flex:1 }}>
            {[{t:game.away,a:game.awayAbbr,r:game.awayRecord,s:s.awayHomeRec},{t:game.home,a:game.homeAbbr,r:game.homeRecord,s:s.homeHomeRec}].map((x,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",gap:"8px",marginBottom:i===0?"6px":0 }}>
                <span style={{ width:4,height:24,borderRadius:2,background:TC[x.a]||"#666" }} />
                <div><div style={{ fontWeight:700,fontSize:"15px",color:"var(--text)" }}>{x.t}</div><div style={{ fontSize:"11px",color:"var(--muted)" }}>{x.r} • {x.s}</div></div>
              </div>
            ))}
          </div>
          {(isLive||isFinal)&&game.liveScore&&(
            <div style={{ textAlign:"right" }}>{[game.liveScore.away,game.liveScore.home].map((sc,i)=>(<div key={i} style={{ fontSize:"22px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{sc}</div>))}</div>
          )}
        </div>

        {liveAdj && (liveAdj.injuries||liveAdj.trend||(liveAdj.lineMove && !liveAdj.lineMove.includes("? ->"))) && (
          <div style={{ background:"#f59e0b10",border:"1px solid #f59e0b30",borderRadius:"8px",padding:"8px 10px",marginBottom:"10px",fontSize:"11px",color:"#f59e0b",lineHeight:1.5 }}>
            <div style={{ fontWeight:700,marginBottom:"2px",fontSize:"10px",letterSpacing:"0.5px" }}>📡 LIVE INTEL</div>
            {liveAdj.injuries && <div>🏥 {liveAdj.injuries}</div>}
            {liveAdj.trend && <div>📈 {liveAdj.trend}</div>}
            {liveAdj.lineMove && !liveAdj.lineMove.includes("?") && !liveAdj.lineMove.includes("0 ->") && <div>📊 {liveAdj.lineMove}</div>}
          </div>
        )}

        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",padding:"10px",borderRadius:"10px",background:"var(--lines-bg)",marginBottom:"12px" }}>
          {[{l:"Spread",v:`${game.spread.fav} ${game.spread.line}`},{l:"O/U",v:game.total},{l:"ML",v:`${game.moneyline.away>0?"+":""}${game.moneyline.away} / ${game.moneyline.home>0?"+":""}${game.moneyline.home}`}].map((x,i)=>(
            <div key={i} style={{ textAlign:"center",borderLeft:i>0?"1px solid var(--border)":"none" }}>
              <div style={{ fontSize:"10px",color:"var(--muted)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:"2px" }}>{x.l}</div>
              <div style={{ fontSize:i===2?"12px":"14px",fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{x.v}</div>
            </div>
          ))}
        </div>

        {/* PRIMARY PREDICTION - KenPom Model + Consensus */}
        {liveAdj?.consensus ? (
          <div style={{ background:"#10b98110",border:"1px solid #10b98130",borderRadius:"10px",padding:"12px" }}>
            <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"8px" }}>
              <span style={{ fontSize:"10px",fontWeight:700,color:"#10b981",textTransform:"uppercase",letterSpacing:"1px" }}>
                KenPom Prediction {liveAdj.consensus.tournamentRound && liveAdj.consensus.tournamentRound !== "tournament" ? `(${liveAdj.consensus.tournamentRound})` : ""}
              </span>
              <span style={{ fontSize:"11px",fontWeight:800,color:liveAdj.consensus.strength>=70?"#22c55e":liveAdj.consensus.strength>=55?"#eab308":"#ef4444",fontFamily:"'JetBrains Mono',monospace" }}>{liveAdj.consensus.strength}%</span>
            </div>
            {/* Projected score */}
            {liveAdj.consensus.modelTotal > 0 && (
              <div style={{ display:"flex",alignItems:"center",justifyContent:"center",gap:"12px",marginBottom:"10px" }}>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:"9px",color:"var(--muted)",marginBottom:"2px" }}>{game.awayAbbr}</div>
                  <span style={{ fontSize:"22px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{liveAdj.consensus.awayPts || "?"}</span>
                </div>
                <span style={{ fontSize:"12px",color:"var(--muted)",fontWeight:600 }}>vs</span>
                <div style={{ textAlign:"center" }}>
                  <div style={{ fontSize:"9px",color:"var(--muted)",marginBottom:"2px" }}>{game.homeAbbr}</div>
                  <span style={{ fontSize:"22px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{liveAdj.consensus.homePts || "?"}</span>
                </div>
              </div>
            )}
            {/* O/U and Spread calls */}
            <div style={{ display:"flex",gap:"6px",flexWrap:"wrap",justifyContent:"center",marginBottom:"10px" }}>
              <CallBadge text={`${liveAdj.consensus.totalCall} ${game.total > 0 ? game.total : ""} (${liveAdj.consensus.votes?.over} vs ${liveAdj.consensus.votes?.under})`} type={liveAdj.consensus.totalCall?.includes("OVER")?"over":"under"} />
              {liveAdj.consensus.spreadCall && <CallBadge text={`${liveAdj.consensus.spreadCall} covers`} type="spread" />}
              {liveAdj.consensus.edgeSize && parseFloat(liveAdj.consensus.edgeSize) >= 3 && parseFloat(liveAdj.consensus.edgeSize) <= 8 && (
                <span style={{ background:"#f59e0b18",color:"#f59e0b",border:"1px solid #f59e0b40",padding:"3px 8px",borderRadius:"6px",fontSize:"10px",fontWeight:700 }}>{liveAdj.consensus.edgeSize}pt edge</span>
              )}
              {liveAdj.consensus.edgeSize && parseFloat(liveAdj.consensus.edgeSize) > 8 && (
                <span style={{ background:"#ef444418",color:"#ef4444",border:"1px solid #ef444440",padding:"3px 8px",borderRadius:"6px",fontSize:"10px",fontWeight:700 }}>Caution: {liveAdj.consensus.edgeSize}pt divergence</span>
              )}
            </div>
            {/* Spread reasoning */}
            {liveAdj.consensus.spreadReason && (
              <div style={{ fontSize:"10px",color:"#a855f7",marginBottom:"8px",textAlign:"center",fontStyle:"italic" }}>{liveAdj.consensus.spreadReason}</div>
            )}
            {/* Key data */}
            <div style={{ display:"flex",gap:"8px",justifyContent:"center",marginBottom:"8px",fontSize:"10px",flexWrap:"wrap" }}>
              {liveAdj.consensus.modelTotal > 0 && <span style={{ background:"var(--card-bg)",padding:"3px 8px",borderRadius:"4px",color:"var(--text)" }}>Model: {liveAdj.consensus.modelTotal}</span>}
              {liveAdj.consensus.projPace && <span style={{ background:"var(--card-bg)",padding:"3px 8px",borderRadius:"4px",color:"var(--text)" }}>Pace: {liveAdj.consensus.projPace}</span>}
              {liveAdj.numBooks > 0 && <span style={{ background:"var(--card-bg)",padding:"3px 8px",borderRadius:"4px",color:"var(--text)" }}>{liveAdj.numBooks} books</span>}
              {liveAdj.consensus.tournamentDiscount && <span style={{ background:"var(--card-bg)",padding:"3px 8px",borderRadius:"4px",color:"var(--text)" }}>Tourney adj: {(liveAdj.consensus.tournamentDiscount * 100).toFixed(0)}%</span>}
            </div>
            {/* Reasoning */}
            {liveAdj.consensus.reasons?.length > 0 && (
              <div style={{ fontSize:"10px",color:"var(--text-secondary)",lineHeight:1.6,borderTop:"1px solid #10b98120",paddingTop:"6px" }}>
                {liveAdj.consensus.reasons.map((r,i) => <div key={i} style={{ padding:"2px 0",color: r.startsWith("Injuries:") ? "#ef4444" : r.startsWith("Fatigue:") ? "#f59e0b" : "var(--text-secondary)" }}>{r}</div>)}
              </div>
            )}
          </div>
        ) : liveAdj?.noPregamePrediction ? (
          <div style={{ background:"#ef444410",border:"1px solid #ef444430",borderRadius:"10px",padding:"12px",textAlign:"center" }}>
            <span style={{ fontSize:"11px",color:"#ef4444" }}>No pre-game prediction was locked for this game</span>
          </div>
        ) : (
          <div style={{ background:"var(--pred-bg)",border:"1px solid var(--pred-border)",borderRadius:"10px",padding:"12px",textAlign:"center" }}>
            <span style={{ fontSize:"11px",color:"var(--muted)" }}>Hit <strong style={{color:"var(--accent)"}}>Refresh</strong> to load predictions</span>
          </div>
        )}

        {/* COMPLETED GAME COMPARISON - uses locked prediction or consensus */}
        {isFinal && game.liveScore && (
          <div style={{ background:"var(--lines-bg)",border:"1px solid var(--border)",borderRadius:"10px",padding:"12px",marginTop:"10px" }}>
            <div style={{ fontSize:"10px",fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:"1px",marginBottom:"8px" }}>Prediction vs Result</div>
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"8px" }}>
              <div style={{ textAlign:"center",padding:"8px",borderRadius:"8px",background:"var(--card-bg)" }}>
                <div style={{ fontSize:"9px",color:"var(--muted)",textTransform:"uppercase",marginBottom:"2px" }}>Model Predicted</div>
                <div style={{ fontSize:"16px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{liveAdj?.consensus?.modelTotal || liveAdj?.lockedPrediction?.line || "?"}</div>
                <div style={{ fontSize:"10px",color:"var(--muted)" }}>total points</div>
              </div>
              <div style={{ textAlign:"center",padding:"8px",borderRadius:"8px",background:"var(--card-bg)" }}>
                <div style={{ fontSize:"9px",color:"var(--muted)",textTransform:"uppercase",marginBottom:"2px" }}>Actual</div>
                <div style={{ fontSize:"16px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:"var(--text)" }}>{game.liveScore.away + game.liveScore.home}</div>
                <div style={{ fontSize:"10px",color:"var(--muted)" }}>{game.liveScore.away} - {game.liveScore.home}</div>
              </div>
            </div>
            {(() => {
              const actualTotal = game.liveScore.away + game.liveScore.home;
              const lockedCall = liveAdj?.lockedPrediction?.totalCall || liveAdj?.consensus?.totalCall;
              const lockedLine = liveAdj?.lockedPrediction?.line || game.total;
              if (!lockedCall || !lockedLine || lockedLine === 0) return <div style={{ marginTop:"8px",fontSize:"11px",color:"var(--muted)",textAlign:"center" }}>No pre-game prediction was locked for this game</div>;
              const ouCorrect = (lockedCall === "OVER" && actualTotal > lockedLine) || (lockedCall === "UNDER" && actualTotal < lockedLine);
              return (
                <div style={{ marginTop:"8px",display:"flex",gap:"8px",justifyContent:"center",flexWrap:"wrap" }}>
                  <span style={{ padding:"4px 10px",borderRadius:"6px",fontSize:"11px",fontWeight:700,background:ouCorrect?"#22c55e20":"#ef444420",color:ouCorrect?"#22c55e":"#ef4444" }}>
                    O/U: {ouCorrect?"CORRECT":"WRONG"} (called {lockedCall} {lockedLine})
                  </span>
                </div>
              );
            })()}
          </div>
        )}

        {isExpanded && liveAdj?.consensus && (
          <div style={{ marginTop:"12px",animation:"fadeIn 0.3s ease" }}>
            {liveAdj.consensus.modelTotal > 0 && game.total > 0 && Math.abs(liveAdj.consensus.modelTotal - game.total) >= 3 && (
              <div style={{ background:"var(--lines-bg)",borderRadius:"10px",padding:"12px",marginBottom:"10px" }}>
                <div style={{ fontSize:"11px",fontWeight:700,color:"#f59e0b",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:"6px" }}>Why This Prediction</div>
                <div style={{ fontSize:"12px",color:"var(--text-secondary)",lineHeight:1.5,padding:"4px 0" }}>
                  <span style={{ color:"var(--accent)" }}>{">"}</span> Model diverges {Math.abs(liveAdj.consensus.modelTotal - game.total).toFixed(1)} pts from Vegas - potential edge.
                </div>
              </div>
            )}
            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px" }}>
              {[
                {l:"Adj Off Eff", a: liveAdj.consensus.awayKenPom?.adjOE || "?", h: liveAdj.consensus.homeKenPom?.adjOE || "?"},
                {l:"Adj Def Eff", a: liveAdj.consensus.awayKenPom?.adjDE || "?", h: liveAdj.consensus.homeKenPom?.adjDE || "?"},
                {l:"Pace", a: liveAdj.consensus.awayKenPom?.tempo || "?", h: liveAdj.consensus.homeKenPom?.tempo || "?"},
                {l:"KenPom Rank", a: liveAdj.consensus.awayKenPom?.rank || "?", h: liveAdj.consensus.homeKenPom?.rank || "?"},
              ].map((x,i)=>(
                <div key={i} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",background:"var(--lines-bg)",borderRadius:"6px",padding:"6px 10px",fontSize:"11px" }}>
                  <span style={{ fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:"var(--text)" }}>{x.a}</span>
                  <span style={{ color:"var(--muted)",fontSize:"10px",fontWeight:600,textTransform:"uppercase" }}>{x.l}</span>
                  <span style={{ fontFamily:"'JetBrains Mono',monospace",fontWeight:600,color:"var(--text)" }}>{x.h}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ textAlign:"center",marginTop:"8px",fontSize:"10px",color:"var(--muted)",fontWeight:600,letterSpacing:"0.5px" }}>
          {isExpanded ? "TAP TO COLLAPSE" : "TAP FOR DEEP ANALYSIS"}
        </div>
      </div>
    </div>
  );
}

function RecordTracker({ history, weights }) {
  if (!history.length) return null;
  const n = history.length;
  const tc = history.filter(h=>h.totalCorrect).length;
  const sc = history.filter(h=>h.spreadCorrect).length;
  const tPct = ((tc/n)*100).toFixed(1);
  const sPct = ((sc/n)*100).toFixed(1);
  const avgE = (history.reduce((a,h)=>a+Math.abs(h.totalError),0)/n).toFixed(1);
  let streak=0, st="";
  for(let i=n-1;i>=0;i--){if(i===n-1){st=history[i].totalCorrect?"W":"L";streak=1;}else if((history[i].totalCorrect&&st==="W")||(!history[i].totalCorrect&&st==="L"))streak++;else break;}
  return (
    <div style={{ margin:"0 12px 10px",padding:"14px",borderRadius:"12px",background:"var(--card-bg)",border:"1px solid var(--border)" }}>
      <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"10px" }}>
        <span style={{ fontSize:"11px",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:"1px" }}>Model Track Record</span>
        <span style={{ fontSize:"10px",color:"var(--muted)" }}>{n} games tracked</span>
      </div>
      <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:"8px" }}>
        {[
          {l:"O/U Record",v:`${tc}-${n-tc}`,s:`${tPct}%`,c:+tPct>=55?"#22c55e":+tPct>=50?"#eab308":"#ef4444"},
          {l:"ATS Record",v:`${sc}-${n-sc}`,s:`${sPct}%`,c:+sPct>=55?"#22c55e":+sPct>=50?"#eab308":"#ef4444"},
          {l:"Avg Error",v:avgE,s:"pts",c:+avgE<6?"#22c55e":+avgE<10?"#eab308":"#ef4444"},
          {l:"Streak",v:`${streak}${st}`,s:st==="W"?"🔥":"❄️",c:st==="W"?"#22c55e":"#ef4444"},
        ].map((x,i)=>(
          <div key={i} style={{ textAlign:"center",padding:"8px 4px",borderRadius:"8px",background:"var(--lines-bg)" }}>
            <div style={{ fontSize:"15px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace",color:x.c }}>{x.v}</div>
            <div style={{ fontSize:"10px",color:x.c,marginBottom:"1px" }}>{x.s}</div>
            <div style={{ fontSize:"8px",color:"var(--muted)",textTransform:"uppercase",fontWeight:600,letterSpacing:"0.3px" }}>{x.l}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop:"10px",display:"flex",gap:"3px",flexWrap:"wrap",justifyContent:"center" }}>
        {history.slice(-30).map((h,i)=>(
          <span key={i} title={`${h.away}@${h.home}: Pred ${h.predictedTotal?.toFixed(0)} / Actual ${h.actualTotal} (${h.totalCorrect?"✓":"✗"})`}
            style={{ width:14,height:14,borderRadius:"3px",display:"inline-flex",alignItems:"center",justifyContent:"center",background:h.totalCorrect?"#22c55e25":"#ef444425",color:h.totalCorrect?"#22c55e":"#ef4444",fontSize:"8px",fontWeight:800 }}>
            {h.totalCorrect?"✓":"✗"}
          </span>
        ))}
      </div>
      {weights.totalBias !== 0 && (
        <div style={{ marginTop:"8px",textAlign:"center",fontSize:"10px",color:"#a855f7" }}>
          🧠 Learned bias: {weights.totalBias>0?"+":""}{weights.totalBias.toFixed(2)} pts | Tourney factor: {weights.tourneyFactor.toFixed(3)} | Elite D weight: {weights.defAdjElite.toFixed(2)}
        </div>
      )}
    </div>
  );
}

// --- APP ---
export default function App() {
  const [sport, setSport] = useState("ncaab");
  const [games, setGames] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState("upcoming");
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [liveAdj, setLiveAdj] = useState({});
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);
  const [history, setHistory] = useState([]);
  const [log, setLog] = useState("Loading games...");
  const [teamCal, setTeamCal] = useState({});
  const [showBacktest, setShowBacktest] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load games when sport changes
  useEffect(()=>{
    setLoading(true); setGames([]); setLiveAdj({}); setLastRefresh(null); setLog("Loading games...");
    (async()=>{
    try {
      const endpoint = sport === "mlb" ? "/api/mlb-scores?days=1" : "/api/scores?days=2";
      const gamesResp = await fetch(endpoint);
      if (gamesResp.ok) {
        const gamesData = await gamesResp.json();
        if (gamesData.games?.length > 0) {
          setGames(gamesData.games);
          setLog(`Loaded ${gamesData.games.length} ${sport.toUpperCase()} games`);
        } else {
          setLog(`No ${sport.toUpperCase()} games found`);
        }
      }
      // Load user data from Supabase
      const userData = await loadUserData();
      setWeights(userData.weights);
      setTeamCal(userData.teamCal);
      if (userData.history.length > 0) setHistory(userData.history);
    } catch(e) { console.error("Load failed:", e); setLog("Error loading: " + e.message); }
    setDataLoaded(true);
    setLoading(false);
  })();},[sport]);

  // Reset auto-refresh when sport changes
  const autoRefreshed = useRef(false);
  useEffect(() => {
    autoRefreshed.current = false;
  }, [sport]);
  
  useEffect(() => {
    if (dataLoaded && games.length > 0 && !autoRefreshed.current) {
      autoRefreshed.current = true;
      const timer = setTimeout(() => { handleRefresh(); }, 2000);
      return () => clearTimeout(timer);
    }
  }, [dataLoaded, games.length, sport]);

  const handleRefresh = useCallback(async()=>{
    setRefreshing(true); setLog("Fetching scores, odds, and AI analysis...");
    try {
      const currentLocked = getAllLockedPredictions(sport);
      const result = await fetchLiveUpdates(games, currentLocked, sport);
      const updates = result.updates;
      const sources = result.sources;
      if(updates&&Array.isArray(updates)){
        const adj={};
        let newWeights = weights;
        let newTeamCal = teamCal;
        const ug=games.map(g=>{
          const u=updates.find(x=>x.id===g.id); if(!u)return g;
          const ng={...g};
          if(u.status)ng.status=u.status;
          if(u.awayScore!=null&&u.homeScore!=null)ng.liveScore={away:u.awayScore,home:u.homeScore,clock:u.clock||""};

          // Apply Odds API lines to the game card
          if(u.oddsSpread) ng.spread = u.oddsSpread;
          if(u.oddsTotal && u.oddsTotal > 0) ng.total = u.oddsTotal;
          if(u.oddsML) ng.moneyline = u.oddsML;

          let lineNote = null;
          if(u.currentTotal!=null && u.currentTotal > 0 && u.currentTotal!==g.total){
            // Only show line movement if we had a real previous value
            if (g.total > 0) {
              lineNote = `O/U moved: ${g.total} -> ${u.currentTotal}`;
            }
            ng.total = u.currentTotal;
          }
          if(u.currentSpread && u.currentSpread !== "null"){
            const sp = u.currentSpread.match(/([A-Z]+)\s*-?([0-9]+\.?[0-9]*)/);
            if(sp){
              const newLine = parseFloat(sp[2]);
              const newFav = sp[1];
              // Only show spread movement if we had a real previous value
              if(g.spread.line !== 0 && (Math.abs(newLine) !== Math.abs(g.spread.line) || newFav !== g.spread.fav)){
                lineNote = (lineNote ? lineNote + " | " : "") + `Spread moved: ${g.spread.fav} ${g.spread.line} -> ${newFav} -${newLine}`;
              }
              ng.spread = { fav: newFav, line: -newLine };
            }
          }

          adj[g.id]={
            awayScoreAdj:u.awayScoreAdj||0, homeScoreAdj:u.homeScoreAdj||0,
            injuries:u.injuries||null, trend:u.trend||null,
            lineMove: lineNote || u.lineMove || null,
            consensus: u.consensus || u.lockedPrediction?.consensus || null,
            
            geminiPred: u.geminiPred || u.lockedPrediction?.geminiPred || null,
            numBooks: u.numBooks || 0,
            oddsRange: u.oddsRange || null,
            lockedPrediction: u.lockedPrediction || null
          };

          // LOCK new predictions ONLY for scheduled games (pre-game)
          // Once a game is live, we never create or modify predictions
          if (u.isNewPrediction && u.consensus && u.status !== "live" && u.status !== "final") {
            const lineToLock = u.currentTotal || ng.total;
            if (lineToLock > 0) { // Only lock if we have a real line
              lockPrediction(g.id, {
                totalCall: u.consensus.totalCall,
                strength: u.consensus.strength,
                spreadCall: u.consensus.spreadCall,
                predAway: u.geminiPred?.away || 0,
                predHome: u.geminiPred?.home || 0,
                line: lineToLock,
                modelTotal: u.consensus.modelTotal || 0,
                consensus: u.consensus,
                geminiPred: u.geminiPred,
                gameInfo: { away: g.awayAbbr, home: g.homeAbbr }
              }, sport);
            }
          }

          // If game is final, record result using LOCKED prediction (not current AI)
          // Only count if we had a real pre-game prediction with a real line
          if(u.status==="final"&&u.awayScore!=null&&u.homeScore!=null){
            const lockedPred = getLockedPredictions(sport)[g.id];
            if(lockedPred && lockedPred.line > 0 && !history.find(h=>h.gameId===g.id)){
              const at=u.awayScore+u.homeScore;
              const tOk=(lockedPred.totalCall==="OVER"&&at>lockedPred.line)||(lockedPred.totalCall==="UNDER"&&at<lockedPred.line);
              const predTotal = lockedPred.modelTotal || ((lockedPred.predAway || 0) + (lockedPred.predHome || 0));
              const rec={gameId:g.id,sport:sport,away:g.awayAbbr,home:g.homeAbbr,predictedTotal:predTotal||0,actualTotal:at,totalCall:lockedPred.totalCall,line:lockedPred.line,totalCorrect:tOk,spreadCorrect:false,totalError:at-(predTotal||at),date:new Date().toISOString().split("T")[0]};
              const nh=[...history,rec]; setHistory(nh);
              savePrediction(rec);
            }
          }
          return ng;
        });
        setGames(ug); setLiveAdj(adj); setLastRefresh(new Date());
        // Save learned weights if they changed
        if (newWeights !== weights || newTeamCal !== teamCal) {
          setWeights(newWeights); setTeamCal(newTeamCal);
          saveSettings(newWeights, newTeamCal);
        }
        const finals=updates.filter(u=>u.status==="final").length;
        const live=updates.filter(u=>u.status==="live").length;
        const newPreds=updates.filter(u=>u.isNewPrediction).length;
        const srcList = sources ? Object.entries(sources).map(([k,v])=>{
          const ok = v && (v.startsWith("OK") || v.startsWith("Skipped"));
          return `${k}: ${ok?"✅":"❌"}`;
        }).join(" | ") : "";
        setLog(`${live} live, ${finals} final, ${newPreds} new predictions${result.analyzedCount===0?" (all games locked or final)":""}\n${srcList}`);
        // If errors exist, show full details
        if (sources) {
          const errs = Object.entries(sources).filter(([k,v]) => v.startsWith("❌")).map(([k,v]) => `${k}: ${v}`);
          if (errs.length > 0) console.log("API errors:", errs);
        }
      } else { setLog("Couldn't parse response - try again"); }
    } catch(e){ setLog("Error: "+e.message); }
    setRefreshing(false);
  },[games,weights,history,teamCal]);

  const fg = filter==="all"?games:filter==="upcoming"?games.filter(g=>g.status==="scheduled"||g.status==="live"):filter==="completed"?games.filter(g=>g.status==="final"):filter==="live"?games.filter(g=>g.status==="live"):games;
  const scheduledGames = games.filter(g=>g.status==="scheduled"||g.status==="live");
  const oc=scheduledGames.length>0?scheduledGames.filter(g=>predictGame(g,weights,liveAdj[g.id],teamCal).totalCall==="OVER").length:0;
  const edgeCount=scheduledGames.filter(g=>predictGame(g,weights,liveAdj[g.id],teamCal).hasEdge).length;
  const liveCount=games.filter(g=>g.status==="live").length;
  const finalCount=games.filter(g=>g.status==="final").length;

  return (
    <div style={{"--bg":"#0a0a0f","--card-bg":"#12121a","--card-header":"#0e0e16","--border":"#1e1e2e","--text":"#e8e8f0","--text-secondary":"#a0a0b8","--muted":"#5a5a78","--accent":"#6366f1","--pred-bg":"#6366f108","--pred-border":"#6366f120","--lines-bg":"#0a0a12","--pill-bg":"#1a1a28","--pill-active":"#6366f1",minHeight:"100vh",background:"var(--bg)",fontFamily:"'Inter',-apple-system,sans-serif",color:"var(--text)",maxWidth:"520px",margin:"0 auto",padding:"0"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@500;600;700;800&display=swap');@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}@keyframes fadeIn{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{display:none}`}</style>

      <div style={{ padding:"28px 20px 20px",background:"linear-gradient(180deg,#12121f 0%,#0a0a0f 100%)",borderBottom:"1px solid var(--border)" }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"4px" }}>
          <div style={{ display:"flex",alignItems:"center",gap:"10px" }}>
            <span style={{ fontSize:"22px" }}>🎓</span>
            <h1 style={{ fontSize:"17px",fontWeight:900,letterSpacing:"-0.5px",background:"linear-gradient(135deg,#6366f1,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent" }}>JOETITO'S SCHOOL OF DATA</h1>
          </div>
          <div style={{ display:"flex",alignItems:"center",gap:"8px" }}>
            <button onClick={handleRefresh} disabled={refreshing} style={{ background:refreshing?"var(--pill-bg)":"linear-gradient(135deg,#6366f1,#a855f7)",color:"#fff",border:"none",borderRadius:"10px",padding:"8px 14px",fontSize:"11px",fontWeight:700,cursor:refreshing?"wait":"pointer",display:"flex",alignItems:"center",gap:"6px",opacity:refreshing?0.7:1 }}>
              <span style={{ display:"inline-block",animation:refreshing?"spin 1s linear infinite":"none" }}>↻</span>
              {refreshing?"Updating...":"Refresh"}
            </button>
          </div>
        </div>
        <div style={{ display:"flex",alignItems:"center",gap:"8px",marginBottom:"16px" }}>
          <select value={sport} onChange={e=>setSport(e.target.value)} style={{ background:"var(--pill-bg)",color:"var(--text)",border:"1px solid var(--border)",borderRadius:"8px",padding:"4px 8px",fontSize:"12px",fontWeight:700,cursor:"pointer",fontFamily:"'Inter',sans-serif" }}>
            <option value="ncaab">NCAAB</option>
            <option value="mlb">MLB</option>
          </select>
          <span style={{ fontSize:"11px",color:"var(--muted)" }}>{sport === "mlb" ? "Baseball" : "College Basketball"}</span>
          <span style={{ fontSize:"11px",color:"var(--muted)" }}>{new Date().toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric"})}</span>
          {lastRefresh&&<span style={{ fontSize:"9px",color:"#6366f1",background:"#6366f115",padding:"2px 6px",borderRadius:"4px",fontWeight:600 }}>Updated {lastRefresh.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
        </div>
        {log&&(
          <div style={{ marginBottom:"12px",padding:"8px 10px",borderRadius:"8px",background:"#6366f110",border:"1px solid #6366f125",fontSize:"11px",color:"#a0a0d0",display:"flex",justifyContent:"space-between",alignItems:"center" }}>
            <span>📡 {log}</span>
            <button onClick={()=>setLog(null)} style={{ background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:"14px" }}>×</button>
          </div>
        )}
        <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:"8px",marginBottom:"16px" }}>
          {[{l:"Games",v:games.length,i:"📊"},{l:"Live",v:liveCount,i:liveCount>0?"🔴":"⚪"},{l:"Final",v:finalCount,i:"✅"}].map((x,i)=>(
            <div key={i} style={{ background:"var(--card-bg)",border:"1px solid var(--border)",borderRadius:"10px",padding:"10px",textAlign:"center" }}>
              <div style={{ fontSize:"14px",marginBottom:"2px" }}>{x.i}</div>
              <div style={{ fontSize:"16px",fontWeight:800,fontFamily:"'JetBrains Mono',monospace" }}>{x.v}</div>
              <div style={{ fontSize:"9px",color:"var(--muted)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.5px" }}>{x.l}</div>
            </div>
          ))}
        </div>
        {loading ? (
          <div style={{ textAlign:"center",padding:"40px 20px",color:"var(--muted)" }}>
            <div style={{ fontSize:"24px",marginBottom:"8px",animation:"spin 1s linear infinite",display:"inline-block" }}>↻</div>
            <div style={{ fontSize:"13px",fontWeight:600 }}>Loading games from ESPN...</div>
          </div>
        ) : (
        <div style={{ display:"flex",gap:"6px",flexWrap:"wrap" }}>
          {[{k:"upcoming",l:`Upcoming (${scheduledGames.length})`},{k:"live",l:`Live (${liveCount})`},{k:"completed",l:`Completed (${finalCount})`},{k:"all",l:"All"}].map(f=>(
            <button key={f.k} onClick={e=>{e.stopPropagation();setFilter(f.k);}} style={{ background:filter===f.k?"var(--pill-active)":"var(--pill-bg)",color:filter===f.k?"#fff":"var(--muted)",border:"none",borderRadius:"8px",padding:"6px 14px",fontSize:"11px",fontWeight:700,cursor:"pointer",letterSpacing:"0.3px" }}>{f.l}</button>
          ))}
        </div>
        )}
      </div>

      {!loading && (
      <>
      <div style={{ marginTop:"12px" }}><RecordTracker history={history.filter(h => (h.sport || "ncaab") === sport)} weights={weights} /></div>

      {/* Model Info */}
      <div style={{ margin:"0 12px",padding:"12px 14px",borderRadius:"10px",background:"var(--pred-bg)",border:"1px solid var(--pred-border)" }}>
        <div style={{ fontSize:"10px",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:"1px",marginBottom:"6px" }}>{sport === "mlb" ? "MLB Prediction Engine" : "Consensus Model v4"}</div>
        <div style={{ fontSize:"11px",color:"var(--text-secondary)",lineHeight:1.6 }}>
          {sport === "mlb" ? (
            <><strong style={{color:"var(--text)"}}>3 data sources</strong> - Odds API (lines from 15+ sportsbooks), ESPN (scores + schedules), and Gemini AI (starting pitcher research, park factors, weather, injuries). Hit <strong style={{color:"var(--accent)"}}>Refresh</strong> to load predictions.</>
          ) : (
            <><strong style={{color:"var(--text)"}}>4 data sources</strong> - Odds API (live lines from 15+ sportsbooks), ESPN (scores), KenPom math model (tournament-adjusted), and Gemini AI (injury research + matchup analysis). Hit <strong style={{color:"var(--accent)"}}>Refresh</strong> to pull all sources.</>
          )}
          {weights.totalBias !== 0 && <span style={{ display:"block",marginTop:"4px",color:"#a855f7" }}>🧠 Learned: {weights.totalBias>0?"+":""}{weights.totalBias.toFixed(2)} total bias | Tourney: {weights.tourneyFactor.toFixed(3)}</span>}
        </div>
      </div>

      <div style={{ padding:"12px",display:"flex",flexDirection:"column",gap:"10px" }}>
        {fg.map(g=>(
          <GameCard key={g.id} game={g} isExpanded={expandedId===g.id} onToggle={()=>setExpandedId(expandedId===g.id?null:g.id)} weights={weights} liveAdj={liveAdj[g.id]} teamCal={teamCal} />
        ))}
        {!fg.length&&<div style={{ textAlign:"center",padding:"40px 20px",color:"var(--muted)" }}><div style={{ fontSize:"24px",marginBottom:"8px" }}>🏀</div><div style={{ fontSize:"13px",fontWeight:600 }}>No  games match this filter</div></div>}
      </div>
      </>
      )}

      <div style={{ margin:"8px 12px 20px",padding:"12px",borderRadius:"8px",background:"var(--card-bg)",border:"1px solid var(--border)",textAlign:"center" }}>
        <div style={{ fontSize:"9px",color:"var(--muted)",lineHeight:1.5,fontWeight:500 }}>For entertainment purposes only. Not financial advice. Please gamble responsibly.</div>
      </div>
    </div>
  );
}
