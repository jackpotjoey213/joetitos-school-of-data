# 🎓 Joetito's School of Data

College basketball AI prediction engine with self-learning capabilities.

## Quick Start (3 minutes)

### Prerequisites
- **Node.js** 18+ installed → [download here](https://nodejs.org)
- **Anthropic API key** (for the Refresh feature) → [get one here](https://console.anthropic.com)

### Setup

```bash
# 1. Open terminal, navigate to this folder
cd joetitos-school-of-data

# 2. Install dependencies
npm install

# 3. Start the app
npm run dev
```

The app opens at **http://localhost:3000** 🏀

### Enter Your API Key
1. Click the ⚙️ gear icon next to the Refresh button
2. Paste your Anthropic API key (starts with `sk-ant-...`)
3. Click Save — it's stored in your browser's localStorage only, never sent anywhere except Anthropic

### Using the App
- **Refresh** → Pulls live scores, updated betting lines, injury news via AI
- **Tap any game** → See full analysis, stats, and "Why This Prediction" breakdown
- **Yesterday's Backtest** → Expandable panel showing model accuracy on prior games
- **⚡ 3+ PT EDGE** badge → Games where the model disagrees with Vegas by 3+ points
- After games finish, the model **auto-learns** from its errors

## How the Model Works

1. **Pace Projection** — Projects actual game tempo based on opponent defensive interaction
2. **Efficiency Matchup** — Pits offensive efficiency vs opponent defensive efficiency (non-linear for elite D)
3. **Shooting Composite** — FG% and 3P% modifiers
4. **Situational Factors** — Fatigue, injuries, tournament round
5. **Per-Team Calibration** — Learns team-specific biases over time
6. **Global Bias Correction** — Adjusts systematic over/under-prediction
7. **Tournament Factor** — Conference tournament games score ~3% lower

## Data Persistence

Everything is stored in your browser's localStorage:
- `jsd-weights-v2` — Model coefficients (evolve as it learns)
- `jsd-history-v2` — Prediction results history
- `jsd-teamcal-v1` — Per-team calibration biases
- `jsd-anthropic-key` — Your API key (local only)

Clear localStorage to reset the model to defaults.

## Cost

- Running locally: **$0**
- Anthropic API per refresh: **~$0.01-0.03** (uses Claude Sonnet with web search)
- Typical day of usage (20 refreshes): **~$0.20-0.60**
