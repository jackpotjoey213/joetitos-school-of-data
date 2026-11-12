import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { marketMarginHome, gradeTotal, gradeSpread, gradeML } from "../../../lib/grading.js";
import { perBetPcts } from "../../../lib/pcts.js";

// Server-side auto-locking + grading (Nov 12, 2026).
//
// WHY: locks live only in each browser's localStorage, so a pick exists
// only in the browser that was open and refreshed before tipoff. Joey
// doesn't open the site every day, so his phone's record stays empty.
// This route locks picks and grades finals on the SERVER every day, so
// the record is identical in every browser. The frontend syncs server
// locks into its local store on load (see Predictor.jsx loadHistory).
//
// WHAT IT DOES, per sport (nba, nfl, ncaab):
//  1. Fetches ESPN scores (free) — finals to grade, scheduled games to lock.
//  2. Grades finals from stored server locks (no odds needed) and upserts
//     the graded record into `predictions` (same row shape as the
//     frontend POST, so the tracker reads it unchanged).
//  3. Calls that sport's refresh route with EMPTY lockedPredictions, so
//     every scheduled game gets a FRESH prediction built with the same
//     consensus / shrinkage / edge rules as a manual Refresh — no
//     duplicated model code. Valid fresh picks are inserted as locks, or
//     replace an existing lock when the market moved (stale-lock rule:
//     while scheduled, the lock tracks the market; once live/final it
//     freezes and is never touched). A fresh no-pick (no odds) never
//     deletes an existing lock.
//  4. Quota guard: the Odds API free plan is 500 credits/month and each
//     refresh costs ~3 credits per sport call. After each sport, the
//     remaining credits are parsed from the refresh response; below 20,
//     later sports skip the refresh call (grading still runs — it needs
//     no odds) so the cron never burns the last credits.
//
// CALL IT: POST /api/cron-lock?sport=nba (or omit ?sport for all three).
// Auth: Authorization: Bearer <CRON_SECRET> — CRON_SECRET is a Vercel
// env var. Without it the route answers 401. The scheduled job (a
// runtime cron) calls it twice a day: 7:00 AM PT (grade yesterday,
// lock today) and 11:00 PM PT (grade today). Grading is idempotent
// (upsert by game_id), so overlapping runs are safe.
//
// SETUP IT NEEDS (Joey): the `locks` table in Supabase (SQL supplied
// separately), SUPABASE_SERVICE_ROLE_KEY in Vercel env vars (server-only,
// bypasses RLS so writes can't fail silently the way anon writes did),
// and CRON_SECRET in Vercel env vars. Until the table exists, the route
// returns per-sport errors in its summary instead of crashing.

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) return null;
  try { return createClient(url, key); } catch { return null; }
}

function ptDateStr(offsetDays = 0) {
  const d = new Date(); d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
function ptDateFromIso(iso) {
  try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); } catch { return ptDateStr(0); }
}

export async function POST(req) {
  const secret = process.env.CRON_SECRET || "";
  const auth = req.headers.get("authorization") || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const supabase = getClient();
  if (!supabase) return NextResponse.json({ ok: false, error: "supabase not configured" }, { status: 500 });

  const url = new URL(req.url);
  const onlySport = url.searchParams.get("sport");
  const sports = onlySport ? [onlySport] : ["nba", "nfl", "ncaab"];
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const base = `${proto}://${req.headers.get("host")}`;

  const summary = { ok: true, locked: 0, updated: 0, graded: 0, skippedNoPick: 0, skippedQuota: 0, errors: [], quotaLeft: null };
  let quotaLow = false;

  for (const sport of sports) {
    try {
      // 1. Scores (free) — finals to grade, scheduled games to lock.
      const scoresResp = await fetch(`${base}/api/${sport}-scores?days=1`, { cache: "no-store" });
      const scores = await scoresResp.json().catch(() => ({}));
      const games = scores.games || [];
      const byId = new Map(games.map((g) => [String(g.espnId || g.id), g]));

      // 2. Existing server locks for this sport.
      const { data: lockRows, error: lockErr } = await supabase.from("locks").select("*").eq("user_id", "default").eq("sport", sport);
      if (lockErr) { summary.errors.push(`${sport} locks read: ${lockErr.message}`); continue; }
      const serverLocks = {};
      for (const r of lockRows || []) serverLocks[String(r.game_id)] = r;

      // 3. Grade finals from scores + stored locks (needs no odds, so it
      //    runs even when the quota guard below skips the refresh).
      for (const g of games) {
        if (g.status !== "final" || g.liveScore == null) continue;
        const key = String(g.espnId || g.id);
        const lock = serverLocks[key]?.lock || null;
        if (!lock || !(lock.line > 0)) continue;
        const at = g.liveScore.away + g.liveScore.home;
        const actualMarginHome = g.liveScore.home - g.liveScore.away;
        const predTotal = lock.modelTotal || ((lock.predAway || 0) + (lock.predHome || 0));
        const actualWinner = g.liveScore.away > g.liveScore.home ? g.awayAbbr : g.liveScore.home > g.liveScore.away ? g.homeAbbr : "draw";
        const tGrade = gradeTotal(at, lock.line, lock.totalCall);
        const sGrade = gradeSpread(actualMarginHome, lock.spreadOdds || null, lock.spreadCall, g.homeAbbr, g.awayAbbr);
        const mlGrade = gradeML(actualWinner === "draw" ? null : actualWinner, lock.moneylinePick);
        const row = {
          user_id: "default", game_id: key, away_team: g.awayAbbr, home_team: g.homeAbbr,
          predicted_total: predTotal || 0, actual_total: at, total_call: lock.totalCall,
          line: lock.line, total_correct: tGrade === true ? true : tGrade === false ? false : null,
          spread_correct: sGrade === true ? true : sGrade === false ? false : null,
          moneyline_correct: mlGrade === true ? true : mlGrade === false ? false : null,
          moneyline_pick: lock.moneylinePick || null, spread_call: lock.spreadCall || null,
          total_error: at - (predTotal || at),
          game_date: g.startTime ? ptDateFromIso(g.startTime) : ptDateStr(0), sport,
        };
        const { data: existing, error: selErr } = await supabase.from("predictions").select("id").eq("user_id", "default").eq("game_id", key).limit(1);
        if (selErr) { summary.errors.push(`${sport} ${key} grade lookup: ${selErr.message}`); continue; }
        let upErr = null;
        if (existing?.length) upErr = (await supabase.from("predictions").update(row).eq("id", existing[0].id)).error;
        else upErr = (await supabase.from("predictions").insert(row)).error;
        if (upErr) summary.errors.push(`${sport} ${key} grade: ${upErr.message}`);
        else summary.graded++;
      }

      // 4. Fresh predictions for scheduled games (spends Odds credits).
      if (quotaLow) { summary.skippedQuota++; continue; }
      const refreshResp = await fetch(`${base}/api/${sport}-refresh`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ games, lockedPredictions: {} }),
      });
      const refresh = await refreshResp.json().catch(() => ({}));
      const m = /\((\d+) left\)/.exec(refresh.sources?.oddsAPI || "");
      if (m) {
        summary.quotaLeft = parseInt(m[1], 10);
        if (summary.quotaLeft < 20) quotaLow = true;
      }
      for (const u of refresh.updates || []) {
        const g = byId.get(String(u.espnId || u.id));
        if (!g || u.status !== "scheduled") continue;
        if (!u.consensus || u.consensus.noPick || !((u.currentTotal || g.total) > 0)) { summary.skippedNoPick++; continue; }
        // Build the lock record — same shape, same >=2pt spread gate,
        // same percentages as the frontend lock creation (Predictor.jsx).
        const lockTotalLine = u.currentTotal || g.total;
        const lockMkt = u.oddsSpread ? marketMarginHome(u.oddsSpread, g.homeAbbr) : null;
        const lockSpreadCall = (u.consensus.modelSpread != null && lockMkt != null && Math.abs(u.consensus.modelSpread - lockMkt) < 2) ? null : u.consensus.spreadCall;
        const lockCons = lockSpreadCall === u.consensus.spreadCall ? u.consensus : { ...u.consensus, spreadCall: lockSpreadCall };
        const lockPcts = perBetPcts(lockCons, sport, lockTotalLine, u.oddsSpread || null, g.homeAbbr, g.awayAbbr);
        const lock = {
          totalCall: u.consensus.totalCall, strength: u.consensus.strength,
          spreadCall: lockSpreadCall, moneylinePick: u.consensus.moneylinePick || null,
          predAway: u.consensus.awayPts || 0, predHome: u.consensus.homePts || 0,
          line: lockTotalLine, modelTotal: u.consensus.modelTotal || 0, modelSpread: u.consensus.modelSpread ?? null,
          consensus: lockCons, spreadOdds: u.oddsSpread || null, mlOdds: u.oddsML || null,
          totalPct: lockPcts.totalPct, spreadPct: lockPcts.spreadPct, mlPct: lockPcts.mlPct,
          gameInfo: { away: g.awayAbbr, home: g.homeAbbr }, gameStartTime: g.startTime || null,
          lockedAt: new Date().toISOString(), sport,
        };
        const key = String(g.espnId || g.id);
        const prev = serverLocks[key];
        const moved = !prev || prev.lock?.line !== lock.line
          || JSON.stringify(prev.lock?.spreadOdds || null) !== JSON.stringify(lock.spreadOdds || null)
          || JSON.stringify(prev.lock?.mlOdds || null) !== JSON.stringify(lock.mlOdds || null);
        const gameDate = g.startTime ? ptDateFromIso(g.startTime) : ptDateStr(0);
        if (!prev) {
          const { error } = await supabase.from("locks").insert({
            user_id: "default", game_id: key, sport, game_date: gameDate, start_time: g.startTime || null,
            away_abbr: g.awayAbbr, home_abbr: g.homeAbbr, line: lock.line,
            spread_call: lock.spreadCall, total_call: lock.totalCall,
            moneyline_pick: lock.moneylinePick, lock, locked_at: lock.lockedAt, updated_at: lock.lockedAt,
          });
          if (error) summary.errors.push(`${sport} ${key} lock: ${error.message}`);
          else summary.locked++;
        } else if (moved) {
          const { error } = await supabase.from("locks").update({
            line: lock.line, spread_call: lock.spreadCall, total_call: lock.totalCall,
            moneyline_pick: lock.moneylinePick, lock, updated_at: lock.lockedAt,
          }).eq("id", prev.id);
          if (error) summary.errors.push(`${sport} ${key} lock update: ${error.message}`);
          else summary.updated++;
        }
      }
    } catch (e) {
      summary.errors.push(`${sport}: ${e.message}`);
    }
  }
  return NextResponse.json(summary);
}
