import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export async function GET() {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("user_settings")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (error && error.code !== "PGRST116") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Also fetch prediction history
  const { data: predictions } = await supabase
    .from("predictions")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);

  return NextResponse.json({
    settings: data || { model_weights: {}, team_calibrations: {} },
    predictions: predictions || []
  });
}

export async function POST(req) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();

  if (body.type === "settings") {
    const { data, error } = await supabase
      .from("user_settings")
      .upsert({
        user_id: userId,
        model_weights: body.weights || {},
        team_calibrations: body.teamCal || {},
        updated_at: new Date().toISOString()
      }, { onConflict: "user_id" });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.type === "prediction") {
    const { data, error } = await supabase
      .from("predictions")
      .insert({
        user_id: userId,
        game_id: body.gameId,
        away_team: body.away,
        home_team: body.home,
        predicted_total: body.predictedTotal,
        actual_total: body.actualTotal,
        total_call: body.totalCall,
        line: body.line,
        total_correct: body.totalCorrect,
        spread_correct: body.spreadCorrect,
        total_error: body.totalError,
        game_date: body.date
      });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown type" }, { status: 400 });
}
