import { NextResponse } from "next/server";

export async function GET() {
  const results = {};
  
  // Test 1: Odds API
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) {
    results.oddsAPI = { status: "FAIL", error: "ODDS_API_KEY not set in environment variables" };
  } else {
    try {
      const resp = await fetch(
        `https://api.the-odds-api.com/v4/sports/basketball_ncaab/odds/?apiKey=${oddsKey}&regions=us&markets=totals,spreads,h2h&oddsFormat=american`
      );
      const remaining = resp.headers.get("x-requests-remaining");
      const used = resp.headers.get("x-requests-used");
      if (!resp.ok) {
        const errText = await resp.text();
        results.oddsAPI = { status: "FAIL", httpStatus: resp.status, error: errText.slice(0, 500), remaining, used };
      } else {
        const data = await resp.json();
        results.oddsAPI = {
          status: "OK",
          gamesFound: data.length,
          remaining,
          used,
          sampleTeams: data.slice(0, 3).map(g => `${g.away_team} vs ${g.home_team} (${g.bookmakers?.length} books)`)
        };
      }
    } catch (e) {
      results.oddsAPI = { status: "FAIL", error: e.message };
    }
  }

  // Test 2: Gemini API
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    results.gemini = { status: "FAIL", error: "GEMINI_API_KEY not set in environment variables" };
  } else {
    for (const model of ["gemini-2.5-flash"]) {
      try {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: "Reply with exactly: GEMINI_OK" }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 20 }
            })
          }
        );
        const data = await resp.json();
        if (data.error) {
          results[`gemini_${model}`] = { status: "FAIL", error: data.error.message, code: data.error.code };
        } else {
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
          results[`gemini_${model}`] = { status: "OK", response: text.slice(0, 50) };
          break; // First working model is enough
        }
      } catch (e) {
        results[`gemini_${model}`] = { status: "FAIL", error: e.message };
      }
    }
  }

  // Test 3: ESPN API
  try {
    const resp = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
    );
    if (!resp.ok) {
      results.espn = { status: "FAIL", httpStatus: resp.status };
    } else {
      const data = await resp.json();
      results.espn = {
        status: "OK",
        eventsFound: data.events?.length || 0,
        sampleGames: (data.events || []).slice(0, 3).map(e => {
          const c = e.competitions?.[0]?.competitors || [];
          return `${c[1]?.team?.abbreviation || "?"} vs ${c[0]?.team?.abbreviation || "?"} (${e.status?.type?.name})`;
        })
      };
    }
  } catch (e) {
    results.espn = { status: "FAIL", error: e.message };
  }

  // Test 4: API-SPORTS
  const apiSportsKey = process.env.API_SPORTS_KEY;
  if (!apiSportsKey) {
    results.apiSports = { status: "FAIL", error: "API_SPORTS_KEY not set" };
  } else {
    try {
      const resp = await fetch("https://v1.baseball.api-sports.io/status", { headers: { "x-apisports-key": apiSportsKey } });
      const data = await resp.json();
      results.apiSports = { status: "OK", account: data.response?.account?.firstname || "connected", requests: data.response?.requests || {}, subscription: data.response?.subscription?.plan || "unknown" };
    } catch (e) {
      results.apiSports = { status: "FAIL", error: e.message };
    }
  }

  // Test 5: MLB Stats API (free, no key)
  try {
    const today = new Date().toISOString().split("T")[0];
    const resp = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${today}&hydrate=probablePitcher`);
    if (resp.ok) {
      const data = await resp.json();
      const games = data.dates?.[0]?.games || [];
      const withPitchers = games.filter(g => g.teams?.away?.probablePitcher || g.teams?.home?.probablePitcher).length;
      results.mlbStatsAPI = { status: "OK", gamesFound: games.length, gamesWithPitchers: withPitchers };
    } else {
      results.mlbStatsAPI = { status: "FAIL", error: `${resp.status}` };
    }
  } catch (e) {
    results.mlbStatsAPI = { status: "FAIL", error: e.message };
  }

  // Environment variable check
  results.envVars = {
    ODDS_API_KEY: oddsKey ? `Set (${oddsKey.slice(0, 6)}...)` : "NOT SET",
    GEMINI_API_KEY: geminiKey ? `Set (${geminiKey.slice(0, 10)}...)` : "NOT SET",
    API_SPORTS_KEY: apiSportsKey ? `Set (${apiSportsKey.slice(0, 6)}...)` : "NOT SET",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ? "Set" : "NOT SET",
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ? "Set" : "NOT SET",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? "Set" : "NOT SET"
  };

  return NextResponse.json(results, { status: 200 });
}
