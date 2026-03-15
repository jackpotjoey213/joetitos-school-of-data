import { NextResponse } from "next/server";

export async function POST(req) {
  const { games } = await req.json();
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) return NextResponse.json({ error: "No API key configured" }, { status: 500 });

  const gameList = games.map(g =>
    `Game ${g.id}: ${g.awayAbbr} vs ${g.homeAbbr} (${g.conference}), spread: ${g.spread.fav} ${g.spread.line}, O/U: ${g.total}`
  ).join("\n");

  try {
    let messages = [{
      role: "user",
      content: `Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Search for live college basketball scores, betting lines, and injury news for these games:\n\n${gameList}\n\nRespond with ONLY a valid JSON array. Each element:\n{"id":<number>,"status":"scheduled"|"live"|"final","awayScore":<number or null>,"homeScore":<number or null>,"clock":"<string or null>","currentTotal":<number or null>,"currentSpread":"<string or null>","injuries":"<string or null>","trend":"<string or null>","awayScoreAdj":<number>,"homeScoreAdj":<number>}\n\nReturn ONLY the JSON array, no markdown, no backticks.`
    }];

    let allText = "";
    let attempts = 0;

    while (attempts < 5) {
      attempts++;
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
          messages: messages
        })
      });

      const data = await resp.json();

      if (data.error) {
        return NextResponse.json({ error: data.error.message || JSON.stringify(data.error) }, { status: 500 });
      }

      for (const block of (data.content || [])) {
        if (block.type === "text") {
          allText += block.text;
        }
      }

      if (data.stop_reason === "end_turn") {
        break;
      }

      if (data.stop_reason === "pause_turn") {
        messages = [
          ...messages,
          { role: "assistant", content: data.content },
          { role: "user", content: "Continue and provide the complete JSON array." }
        ];
        continue;
      }

      break;
    }

    const m = allText.match(/\[[\s\S]*?\]/);
    if (m) {
      return NextResponse.json({ updates: JSON.parse(m[0]) });
    }
    return NextResponse.json({ error: "Could not parse response", raw: allText.slice(0, 300) }, { status: 500 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
