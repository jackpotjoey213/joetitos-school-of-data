import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Supabase ledger for pregame predictions + model settings.
// v2: if env vars are absent, the API must NOT crash — it returns
// { trackerAvailable: false, settings: {}, predictions: [] } so the
// frontend can show "tracker unavailable" instead of "0 games tracked"
// as if that were a real record.
function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  if (!url || !key) return null;
  try { return createClient(url, key); } catch { return null; }
}

export async function GET(req) {
  const supabase = getClient();
  if (!supabase) return NextResponse.json({ trackerAvailable: false, settings: { model_weights: {}, team_calibrations: {} }, predictions: [] });
  try {
    const userId = req.headers.get("x-user-id") || "default";
    const { data } = await supabase.from("user_settings").select("*").eq("user_id", userId).single();
    const { data: predictions } = await supabase.from("predictions").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(500);
    return NextResponse.json({ trackerAvailable: true, settings: data || { model_weights: {}, team_calibrations: {} }, predictions: predictions || [] });
  } catch (e) {
    return NextResponse.json({ trackerAvailable: false, settings: { model_weights: {}, team_calibrations: {} }, predictions: [], error: e.message });
  }
}

export async function POST(req) {
  const supabase = getClient();
  const body = await req.json().catch(() => ({}));
  if (!supabase) return NextResponse.json({ ok: false, trackerAvailable: false });
  const userId = body.userId || "default";
  try {
    if (body.type === "settings") {
      await supabase.from("user_settings").upsert({ user_id: userId, model_weights: body.weights || {}, team_calibrations: body.teamCal || {}, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      return NextResponse.json({ ok: true, trackerAvailable: true });
    }
    if (body.type === "prediction") {
      const { data: existing } = await supabase.from("predictions").select("id").eq("user_id", userId).eq("game_id", body.gameId).limit(1);
      if (existing?.length) return NextResponse.json({ ok: true, trackerAvailable: true, duplicate: true });
      await supabase.from("predictions").insert({
        user_id: userId, game_id: body.gameId, away_team: body.away, home_team: body.home,
        predicted_total: body.predictedTotal, actual_total: body.actualTotal, total_call: body.totalCall,
        line: body.line, total_correct: body.totalCorrect, spread_correct: body.spreadCorrect,
        moneyline_correct: body.moneylineCorrect ?? null, moneyline_pick: body.moneylinePick || null,
        spread_call: body.spreadCall || null, total_error: body.totalError, game_date: body.date,
        sport: body.sport || "nba",
      });
      return NextResponse.json({ ok: true, trackerAvailable: true });
    }
    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, trackerAvailable: false, error: e.message });
  }
}
