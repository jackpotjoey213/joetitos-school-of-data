#!/usr/bin/env python3
"""
Joetito's MLB Value Bet Engine v2.0
====================================
Accepts JSON of today's matchups + odds, applies sabermetric weights,
outputs a Value Bet table with Kelly Criterion unit sizing.

Usage:
    python3 mlb_value_bets.py --input games.json
    python3 mlb_value_bets.py --demo   # Run with built-in demo data

Logic:
    1. 0.85x League Environment Modifier (2026 scoring suppression)
    2. Log5 win probability weighted 60% pitching / 40% market
    3. Pitching Hard-Cap: both xERA < 3.50 → total capped at 8.5
    4. Edge Flag: model prob vs market implied > 5%
    5. Fractional Kelly (0.25x) for unit sizing
"""

import json
import sys
import argparse
from typing import Optional

# ============================================================
# CONSTANTS
# ============================================================
ERA_REGRESSION_WEIGHT = 0.70
LEAGUE_AVG_ERA = 4.10
LEAGUE_SCORING_MODIFIER = 0.85  # 2026 season-wide scoring suppression
PARK_DAMPENER = 0.50            # Park factor influence reduced by 50%
ELITE_ERA_THRESHOLD = 3.50      # Hard-cap trigger
HARD_CAP_TOTAL = 8.50           # Max total when both starters are elite
PITCHING_WEIGHT = 0.60          # Log5 pitching weight
MARKET_WEIGHT = 0.40            # Market ML implied weight
EDGE_THRESHOLD = 0.05           # 5% minimum edge for value bet flag
FRACTIONAL_KELLY = 0.25         # Conservative Kelly multiplier
BULLPEN_RUNS = 1.20             # Average bullpen contribution per team


# ============================================================
# CORE MATH
# ============================================================

def regress_era(raw_era: float) -> float:
    """Regress ERA toward league average (70% raw / 30% league avg)."""
    return raw_era * ERA_REGRESSION_WEIGHT + LEAGUE_AVG_ERA * (1 - ERA_REGRESSION_WEIGHT)


def ml_to_prob(american_odds: float) -> float:
    """Convert American moneyline odds to implied probability."""
    if not american_odds:
        return 0.50
    if american_odds < 0:
        return abs(american_odds) / (abs(american_odds) + 100)
    return 100 / (american_odds + 100)


def log5(p_a: float, p_b: float) -> float:
    """
    Log5 formula: true head-to-head win probability.
    pA = team A's true talent win rate
    pB = team B's true talent win rate
    Returns: probability of team A winning vs team B
    """
    if p_a + p_b == 0:
        return 0.50
    return (p_a * (1 - p_b)) / ((p_a * (1 - p_b)) + (p_b * (1 - p_a)))


def pitching_win_prob(away_era: float, home_era: float) -> float:
    """
    Estimate win probability from pitcher quality (ERA-based).
    Better pitcher = higher quality (1/ERA ratio).
    Returns: home team win probability.
    """
    away_quality = 1 / max(away_era, 0.5)
    home_quality = 1 / max(home_era, 0.5)
    return home_quality / (away_quality + home_quality)


def fractional_kelly(model_prob: float, american_odds: float) -> float:
    """
    Fractional Kelly Criterion (25%) for unit sizing.
    f* = (b*p - q) / b
    b = decimal odds - 1
    p = model probability
    q = 1 - p
    """
    if american_odds > 0:
        b = american_odds / 100
    else:
        b = 100 / abs(american_odds)

    p = model_prob
    q = 1 - p
    full_kelly = (b * p - q) / b
    return max(0.0, full_kelly * FRACTIONAL_KELLY)


def project_total(
    away_era: float,
    home_era: float,
    park_factor: float = 1.00,
    apply_hard_cap: Optional[bool] = None
) -> tuple[float, bool]:
    """
    Project game total using ERA model with:
    - ERA regression toward league average
    - Dampened park factor (50% influence)
    - 0.85x League Environment Modifier
    - Pitching hard-cap when both starters are elite
    
    Returns: (model_total, hard_cap_applied)
    """
    away_reg = regress_era(away_era)
    home_reg = regress_era(home_era)

    away_runs_allowed = (away_reg / 9) * 5.5 + BULLPEN_RUNS
    home_runs_allowed = (home_reg / 9) * 5.5 + BULLPEN_RUNS

    dampened_pf = 1.0 + (park_factor - 1.0) * PARK_DAMPENER

    # Home team scores vs away pitcher at home park
    home_scores = away_runs_allowed * dampened_pf
    # Away team scores vs home pitcher (no park boost for visitors)
    away_scores = home_runs_allowed

    raw_total = (home_scores + away_scores) * LEAGUE_SCORING_MODIFIER

    # Pitching hard-cap check
    both_elite = away_era < ELITE_ERA_THRESHOLD and home_era < ELITE_ERA_THRESHOLD
    if apply_hard_cap is None:
        apply_hard_cap = both_elite

    hard_cap_applied = False
    if apply_hard_cap and raw_total > HARD_CAP_TOTAL:
        raw_total = HARD_CAP_TOTAL
        hard_cap_applied = True

    return round(raw_total, 1), hard_cap_applied


def calculate_model_win_prob(
    away_era: float,
    home_era: float,
    away_ml: float,
    home_ml: float
) -> tuple[float, float]:
    """
    Blended win probability:
    - 60% weight: pitching quality (Log5 derived from ERA)
    - 40% weight: market implied probability

    Returns: (away_win_prob, home_win_prob)
    """
    # Pitching-based component
    pitch_home_wp = pitching_win_prob(away_era, home_era)
    pitch_away_wp = 1 - pitch_home_wp

    # Market implied component
    market_home_wp = ml_to_prob(home_ml)
    market_away_wp = ml_to_prob(away_ml)

    # Blend: Log5 of pitching WP vs market WP
    # Use Log5 to combine pitching talent and market signal
    log5_home = log5(pitch_home_wp, 1 - market_home_wp) if market_home_wp < 1 else pitch_home_wp
    log5_away = 1 - log5_home

    # Apply weights
    final_home = (log5_home * PITCHING_WEIGHT) + (market_home_wp * MARKET_WEIGHT)
    final_away = (log5_away * PITCHING_WEIGHT) + (market_away_wp * MARKET_WEIGHT)

    # Normalize
    total = final_home + final_away
    return final_away / total, final_home / total


def detect_edge(model_prob: float, market_prob: float) -> tuple[float, str]:
    """
    Compare model probability to market implied probability.
    Returns: (edge_pct, tier)
    """
    edge = model_prob - market_prob
    edge_pct = edge * 100

    if abs(edge_pct) > 15:
        tier = "⚠️  CHECK INJURIES (>15% — model may miss news)"
    elif abs(edge_pct) > 5:
        tier = "🟢 VALUE BET"
    elif abs(edge_pct) > 3:
        tier = "🟡 LEAN"
    else:
        tier = "🔴 NO EDGE"

    return edge_pct, tier


# ============================================================
# MAIN PROCESSING
# ============================================================

def process_games(games: list[dict]) -> dict:
    """
    Process a list of games and return value bet analysis.
    
    Each game dict should have:
    {
        "game": "NYM @ ARI",
        "away_team": "NYM",
        "home_team": "ARI",
        "away_era": 4.20,        # Starting pitcher ERA
        "home_era": 3.10,
        "away_ml": 185,          # American odds (+ for underdog)
        "home_ml": -220,
        "vegas_total": 8.5,
        "park_factor": 1.01,     # Optional, default 1.0
        "notes": "Freeman OUT"   # Optional
    }
    """
    results = []
    value_bets = []

    for g in games:
        away_era = g.get("away_era", 4.50)
        home_era = g.get("home_era", 4.50)
        away_ml = g.get("away_ml", 100)
        home_ml = g.get("home_ml", -120)
        vegas_total = g.get("vegas_total", 8.5)
        park_factor = g.get("park_factor", 1.00)

        # 1. Project total
        model_total, hard_capped = project_total(away_era, home_era, park_factor)

        # 2. O/U call
        ou_call = "OVER" if model_total > vegas_total else "UNDER" if model_total < vegas_total else "PUSH"
        ou_edge = model_total - vegas_total

        # 3. Win probability (60% pitching / 40% market)
        away_wp, home_wp = calculate_model_win_prob(away_era, home_era, away_ml, home_ml)

        # 4. Market implied probabilities
        market_away_wp = ml_to_prob(away_ml)
        market_home_wp = ml_to_prob(home_ml)

        # 5. Detect edge
        fav_is_home = home_wp > away_wp
        model_fav_wp = home_wp if fav_is_home else away_wp
        market_fav_wp = market_home_wp if fav_is_home else market_away_wp
        fav_team = g.get("home_team") if fav_is_home else g.get("away_team")
        fav_odds = home_ml if fav_is_home else away_ml

        edge_pct, edge_tier = detect_edge(model_fav_wp, market_fav_wp)

        # 6. Kelly sizing
        kelly_pct = 0.0
        if abs(edge_pct) > 5 and model_fav_wp > market_fav_wp:
            kelly_pct = fractional_kelly(model_fav_wp, fav_odds)

        result = {
            "game": g.get("game", f"{g.get('away_team')} @ {g.get('home_team')}"),
            "away": g.get("away_team", "AWY"),
            "home": g.get("home_team", "HME"),
            "away_era": away_era,
            "home_era": home_era,
            "notes": g.get("notes", ""),
            "model_total": model_total,
            "vegas_total": vegas_total,
            "hard_capped": hard_capped,
            "ou_call": ou_call,
            "ou_edge": round(ou_edge, 1),
            "away_model_wp": round(away_wp * 100, 1),
            "home_model_wp": round(home_wp * 100, 1),
            "away_market_wp": round(market_away_wp * 100, 1),
            "home_market_wp": round(market_home_wp * 100, 1),
            "ml_pick": fav_team,
            "ml_pick_odds": fav_odds,
            "edge_pct": round(edge_pct, 1),
            "edge_tier": edge_tier,
            "kelly_pct": round(kelly_pct * 100, 1),
            "kelly_units": round(kelly_pct, 3),
        }
        results.append(result)

        if "VALUE BET" in edge_tier or "CHECK" in edge_tier:
            value_bets.append(result)

    return {"games": results, "value_bets": value_bets}


def print_report(analysis: dict):
    """Print formatted value bet report."""
    games = analysis["games"]
    value_bets = analysis["value_bets"]

    print("\n" + "="*90)
    print("  JOETITO'S MLB VALUE BET ENGINE v2.0")
    print(f"  Logic: 0.85x Scoring Mod | 60% Pitching / 40% Market | Elite SP Hard-Cap @ 8.5")
    print("="*90)

    # Full game table
    print(f"\n{'GAME':<22} {'MODEL':>6} {'LINE':>6} {'O/U':>5} {'EDGE':>5} {'MODEL WP':>10} {'MKT WP':>8} {'ML PICK':>8} {'EDGE%':>7} {'KELLY':>6}")
    print("-"*90)

    for g in games:
        cap_flag = "⚡" if g["hard_capped"] else "  "
        print(
            f"{cap_flag}{g['game']:<20} "
            f"{g['model_total']:>6.1f} "
            f"{g['vegas_total']:>6.1f} "
            f"{g['ou_call']:>5} "
            f"{g['ou_edge']:>+5.1f} "
            f"  {g['away_model_wp']:>4.1f}%/{g['home_model_wp']:<4.1f}% "
            f"{g['away_market_wp']:>3.0f}%/{g['home_market_wp']:<3.0f}% "
            f"{g['ml_pick']:>8} "
            f"{g['edge_pct']:>+6.1f}% "
            f"{g['kelly_pct']:>5.1f}%"
        )
        if g["notes"]:
            print(f"  {'':22} ⚠️  {g['notes']}")

    # Value bets table
    print(f"\n{'='*90}")
    print("  VALUE BET TABLE (edge > 5%)")
    print(f"{'='*90}")

    if not value_bets:
        print("  No value bets found today.")
    else:
        print(f"\n  {'GAME':<22} {'MKT ODDS':>9} {'MKT IMPL':>9} {'MODEL WP':>9} {'EDGE':>7} {'KELLY%':>7} {'VERDICT'}")
        print("  " + "-"*80)
        for v in value_bets:
            odds_str = f"+{v['ml_pick_odds']}" if v['ml_pick_odds'] > 0 else str(v['ml_pick_odds'])
            mkt_pct = v['home_market_wp'] if v['ml_pick'] == v['home'] else v['away_market_wp']
            model_pct = v['home_model_wp'] if v['ml_pick'] == v['home'] else v['away_model_wp']
            print(
                f"  {v['game']:<22} "
                f"{v['ml_pick']:>4} {odds_str:>6} "
                f"{mkt_pct:>8.1f}% "
                f"{model_pct:>8.1f}% "
                f"{v['edge_pct']:>+6.1f}% "
                f"{v['kelly_pct']:>6.1f}% "
                f"  {v['edge_tier']}"
            )

    print(f"\n  Fractional Kelly (0.25x): Bet Kelly% of your bankroll per game")
    print(f"  Hard-cap (⚡): Both starters xERA < 3.50 → total capped at 8.5")
    print(f"  ⚠️  Edge > 15%: Large divergence — check injuries/lineup changes\n")


# ============================================================
# DEMO DATA
# ============================================================

DEMO_GAMES = [
    {
        "game": "NYM @ ARI",
        "away_team": "NYM", "home_team": "ARI",
        "away_era": 4.20, "home_era": 3.10,
        "away_ml": 115, "home_ml": -135,
        "vegas_total": 8.5, "park_factor": 1.01,
        "notes": ""
    },
    {
        "game": "ATL @ LAD",
        "away_team": "ATL", "home_team": "LAD",
        "away_era": 3.80, "home_era": 2.80,
        "away_ml": 145, "home_ml": -170,
        "vegas_total": 8.0, "park_factor": 0.96,
        "notes": "Freeman OUT (-0.5 runs LAD)"
    },
    {
        "game": "KC @ DET",
        "away_team": "KC", "home_team": "DET",
        "away_era": 3.78, "home_era": 3.75,
        "away_ml": -130, "home_ml": 110,
        "vegas_total": 8.0, "park_factor": 1.00,
        "notes": ""
    },
    {
        "game": "NYY @ MIL (Holmes v Kelly)",
        "away_team": "NYY", "home_team": "MIL",
        "away_era": 2.85, "home_era": 2.90,
        "away_ml": -115, "home_ml": -105,
        "vegas_total": 8.5, "park_factor": 1.02,
        "notes": "BOTH ELITE: Clay Holmes 2.85 xERA vs Merrill Kelly 2.90 xERA"
    },
    {
        "game": "LAD @ COL",
        "away_team": "LAD", "home_team": "COL",
        "away_era": 2.10, "home_era": 5.40,
        "away_ml": -235, "home_ml": 195,
        "vegas_total": 11.0, "park_factor": 1.18,
        "notes": "Coors Field"
    },
    {
        "game": "SF @ CIN",
        "away_team": "SF", "home_team": "CIN",
        "away_era": 2.42, "home_era": 5.60,
        "away_ml": -120, "home_ml": 100,
        "vegas_total": 7.5, "park_factor": 1.08,
        "notes": ""
    },
]


# ============================================================
# ENTRY POINT
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Joetito MLB Value Bet Engine")
    parser.add_argument("--input", "-i", help="JSON file with today's games")
    parser.add_argument("--demo", action="store_true", help="Run with demo data")
    parser.add_argument("--output", "-o", help="Output JSON file (optional)")
    args = parser.parse_args()

    if args.demo or not args.input:
        print("Running with demo data...")
        games = DEMO_GAMES
    else:
        with open(args.input, "r") as f:
            data = json.load(f)
            games = data if isinstance(data, list) else data.get("games", [])

    analysis = process_games(games)
    print_report(analysis)

    if args.output:
        with open(args.output, "w") as f:
            json.dump(analysis, f, indent=2)
        print(f"Results saved to {args.output}")

    return analysis


if __name__ == "__main__":
    main()
