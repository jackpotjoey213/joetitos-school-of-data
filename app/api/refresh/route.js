import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

export async function POST(req) {
  const { userId } = auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { games } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return NextResponse.json({ error: "No API key configured" }, { status: 500 });

  const gameList = games.map(g =>
    `Game ${g.id}: ${g.awayAbbr} vs ${g.homeAbbr} (${g.conference}), spread: ${g.spread.fav} ${g.spread.line}, O/U: ${g.total}`
  ).join("\n");

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. You are a sports data assistant. Search for live scores, betting lines, and injury news for these college basketball games:

${gameList}

For EACH game, search and find:
1. Current live score OR final score
2. Current live betting O/U total line
3. Current live spread
4. Any injury news from TODAY
5. Notable in-game trends

Respond with ONLY a valid JSON array. Each element:
{"id":<number>,"status":"scheduled"|"live"|"final","awayScore":<number or null>,"homeScore":<number or null>,"clock":"<string or null>","currentTotal":<number or null>,"currentSpread":"<e.g. MICH -10.5 or null>","injuries":"<string or null>","trend":"<string or null>","awayScoreAdj":<number>,"homeScoreAdj":<number>}

Return ONLY the JSON array, no markdown, no backticks.`
        }]
      })
    });

    const data = await resp.json();
    const text = data.content?.map(c => c.type === "text" ? c.text : "").join("") || "";
    const m = text.match(/\[[\s\S]*?\]/);
    if (m) {
      return NextResponse.json({ updates: JSON.parse(m[0]) });
    }
    return NextResponse.json({ error: "Could not parse response", raw: text.slice(0, 200) }, { status: 500 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
