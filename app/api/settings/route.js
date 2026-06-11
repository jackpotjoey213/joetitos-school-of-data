import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

export async function GET(req) {
  const userId = req.headers.get("x-user-id") || "default";
  const { data } = await supabase.from("user_settings").select("*").eq("user_id", userId).single();
  const { data: predictions } = await supabase.from("predictions").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(200);
  return NextResponse.json({ settings: data || { model_weights: {}, team_calibrations: {} }, predictions: predictions || [] });
}

export async function POST(req) {
  const body = await req.json();
  const userId = body.userId || "default";
  if (body.type === "settings") {
    await supabase.from("user_settings").upsert({ user_id: userId, model_weights: body.weights || {}, team_calibrations: body.teamCal || {}, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    return NextResponse.json({ ok: true });
  }
  if (body.type === "prediction") {
    await supabase.from("predictions").insert({ user_id: userId, game_id: body.gameId, away_team: body.away, home_team: body.home, predicted_total: body.predictedTotal, actual_total: body.actualTotal, total_call: body.totalCall, line: body.line, total_correct: body.totalCorrect, spread_correct: body.spreadCorrect, total_error: body.totalError, game_date: body.date });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unknown type" }, { status: 400 });
}
