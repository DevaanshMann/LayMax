"""Run the LayMax prompt against several layover scenarios and summarize the results.

Usage:
    python test_prompt.py            # all scenarios
    python test_prompt.py 2          # just scenario #2

Each run makes real Claude API calls. Full JSON results are saved to test_results/.
"""

import json
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

import planner

load_dotenv()

SCENARIOS = [
    {
        "name": "Long daytime layover, easy entry (expect GO)",
        "airport": "SIN", "arrival_local": "2026-11-10T07:30", "departure_local": "2026-11-10T19:45",
        "passport": "United States", "visa_status": "not_needed", "interests": ["local food", "nature and parks"],
        "budget": "moderate", "pace": "balanced", "visited_before": False, "risk_tolerance": "balanced",
    },
    {
        "name": "Short layover at a busy hub (expect NO_GO)",
        "airport": "LHR", "arrival_local": "2026-11-12T06:50", "departure_local": "2026-11-12T10:20",
        "passport": "Canada", "visa_status": "not_needed", "interests": ["architecture"],
        "budget": "moderate", "pace": "packed", "visited_before": False, "risk_tolerance": "balanced",
    },
    {
        "name": "Needs a visa they don't have (expect NO_GO, airport plan)",
        "airport": "JFK", "arrival_local": "2026-11-14T09:00", "departure_local": "2026-11-14T21:00",
        "passport": "India", "visa_status": "need_but_dont_have", "interests": ["art and museums"],
        "budget": "splurge", "pace": "relaxed", "visited_before": False, "risk_tolerance": "cautious",
    },
    {
        "name": "Borderline layover, bags not checked through, returning visitor (CAUTION or NO_GO)",
        "airport": "IST", "arrival_local": "2026-11-16T13:15", "departure_local": "2026-11-16T19:30",
        "passport": "Germany", "visa_status": "not_needed", "interests": ["local food", "markets and shopping"],
        "budget": "shoestring", "pace": "balanced", "visited_before": True, "risk_tolerance": "balanced",
        "bags_checked_through": False,
    },
    {
        "name": "Overnight layover crossing midnight",
        "airport": "NRT", "arrival_local": "2026-11-18T17:40", "departure_local": "2026-11-19T10:55",
        "passport": "Australia", "visa_status": "not_needed", "interests": ["nightlife", "local food", "photography spots"],
        "budget": "moderate", "pace": "packed", "visited_before": False, "risk_tolerance": "relaxed",
    },
    {
        "name": "Returning visitor with things already seen + tight SGD cap",
        "airport": "SIN", "arrival_local": "2026-11-20T08:00", "departure_local": "2026-11-20T18:30",
        "passport": "United Kingdom", "visa_status": "not_needed", "interests": ["local food", "nature and parks"],
        "budget": "shoestring", "budget_amount": 50, "budget_currency": "SGD", "pace": "balanced",
        "visited_before": True, "already_seen": "Gardens by the Bay, Marina Bay Sands, Chinatown", "risk_tolerance": "balanced",
    },
    {
        "name": "First-timer on a EUR 30 shoestring cap",
        "airport": "AMS", "arrival_local": "2026-11-22T09:15", "departure_local": "2026-11-22T17:45",
        "passport": "United States", "visa_status": "not_needed", "interests": ["art and museums", "architecture"],
        "budget": "shoestring", "budget_amount": 30, "budget_currency": "EUR", "pace": "balanced",
        "visited_before": False, "risk_tolerance": "balanced",
    },
    {
        "name": "Short but doable layover at an efficient airport (expect CAUTION)",
        "airport": "ZRH", "arrival_local": "2026-11-24T10:00", "departure_local": "2026-11-24T14:30",
        "passport": "United States", "visa_status": "not_needed", "interests": ["local food", "architecture"],
        "budget": "moderate", "pace": "balanced", "visited_before": False, "risk_tolerance": "balanced",
    },
]


def run(index: int, scenario: dict, out_dir: Path) -> None:
    name = scenario.pop("name")
    print(f"\n=== {index}. {name} ===")
    t0 = time.time()
    result = planner.plan_layover(scenario)
    m, q = result["math"], result["quality_check"]
    print(f"Verdict: {result['verdict']}  ({time.time() - t0:.0f}s)")
    print(f"Reason:  {result['verdict_reason']}")
    print(f"Usable city time: {m['usable_city_min']} min | leave city by {m['leave_city_by']} | at gate by {m['at_gate_by']}")
    print(f"Estimated spend: {result['estimated_total_spend']}")
    print(f"Stops: {len(result['itinerary'])} | refinement rounds: {q['refinement_rounds']} | remaining issues: {len(q['remaining_issues'])}")
    for stop in result["itinerary"]:
        print(f"  {stop['start'][11:]}-{stop['end'][11:]}  [{stop['type']}] {stop['title']}  ({stop['cost_estimate']})")
    (out_dir / f"scenario_{index}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    out = Path(__file__).parent / "test_results"
    out.mkdir(exist_ok=True)
    picks = [int(a) for a in sys.argv[1:]] or range(1, len(SCENARIOS) + 1)
    for i in picks:
        run(i, dict(SCENARIOS[i - 1]), out)
