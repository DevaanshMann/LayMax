"""LayMax planner: a two-call prompt chain with server-side math in between.

Flow:
  1. Stage 1 (time check): Claude estimates, in minutes, how long immigration,
     transit and security take at this airport, and whether this passport
     can leave the airport. No clock times, no plan.
  2. The server turns those minutes into exact clock times and a minimum
     verdict. The model never does clock arithmetic.
  3. Stage 2 (plan): Claude receives the fixed times and builds the verdict
     and itinerary inside them. It may make the verdict stricter, never looser.
  4. The server validates the itinerary against the deadline. If anything is
     off, the draft and its exact problems go back to stage 2 (iterative
     refinement) and are validated again.

Both prompts live in LayoverMaximizer-Prompt.txt.
"""

import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Literal

import anthropic
from pydantic import BaseModel

MODEL = "claude-opus-5-5"
PROMPT_FILE = Path(__file__).parent / "LayoverMaximizer-Prompt.txt"
TIME_FMT = "%Y-%m-%dT%H:%M"
MAX_REFINEMENTS = 1

SAFETY_MARGINS = {"relaxed": 15, "balanced": 30, "cautious": 45}
VERDICT_RANK = {"GO": 0, "CAUTION": 1, "NO_GO": 2}
CITY_STOP_TYPES = {"food", "sight", "activity"}
STAGE_SECTIONS = {1: "STAGE 1: TIME CHECK", 2: "STAGE 2: PLAN"}


# ---------- Output schemas (what Claude must return) ----------

class EntryRequirements(BaseModel):
    status: Literal["visa_free", "visa_on_arrival", "transit_exemption", "visa_required", "uncertain"]
    can_exit_airport: bool
    summary: str


class TimeCheck(BaseModel):
    """Stage 1: minutes only, no clock times."""
    airport_name: str
    city: str
    deplane_and_immigration_min: int
    transit_to_city_min: int
    transit_mode: str
    transit_cost_estimate: str
    transit_back_min: int
    reentry_security_min: int
    boarding_buffer_min: int
    assumptions: List[str]
    entry_requirements: EntryRequirements


class Stop(BaseModel):
    start: str
    end: str
    type: Literal["transit", "food", "sight", "activity", "airport", "rest"]
    title: str
    location: str
    description: str
    cost_estimate: str
    tip: str


class LayoverPlan(BaseModel):
    """Stage 2: the verdict and itinerary, built inside the server's fixed times."""
    verdict: Literal["GO", "CAUTION", "NO_GO"]
    verdict_reason: str
    itinerary: List[Stop]
    estimated_total_spend: str
    running_late_plan: List[str]
    practical_tips: List[str]
    airport_fallback: List[str]


class PlannerError(Exception):
    pass


# ---------- Prompt file ----------

def _prompt_sections() -> dict:
    text = PROMPT_FILE.read_text(encoding="utf-8")
    parts = re.split(r"^===== (.+?) =====\n", text, flags=re.M)
    return {parts[i].strip(): parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}


def load_system_prompt(stage: int) -> str:
    sections = _prompt_sections()
    return sections["PERSONA"] + "\n\n" + sections[STAGE_SECTIONS[stage]]


def example_output(stage: int) -> str:
    """The worked example's JSON output for a stage (used by demo mode)."""
    return _prompt_sections()[STAGE_SECTIONS[stage]].rsplit("Output:\n", 1)[1].strip()


# ---------- Helpers ----------

def parse_time(value: str) -> datetime:
    return datetime.strptime(value[:16], TIME_FMT)


def fmt(dt: datetime) -> str:
    return dt.strftime(TIME_FMT)


def validate_input(form: dict) -> dict:
    """Normalize and sanity-check the form before spending tokens."""
    airport = (form.get("airport") or "").strip()
    if not airport:
        raise PlannerError("Please enter the layover airport.")
    try:
        arrival = parse_time(form["arrival_local"])
        departure = parse_time(form["departure_local"])
    except (KeyError, ValueError):
        raise PlannerError("Please enter both arrival and departure times.")
    layover_min = int((departure - arrival).total_seconds() // 60)
    if layover_min <= 0:
        raise PlannerError("Departure must be after arrival.")
    if layover_min > 72 * 60:
        raise PlannerError("That is a stopover, not a layover. LayMax handles layovers up to 72 hours.")

    risk = form.get("risk_tolerance", "balanced")
    try:
        budget_amount = float(form["budget_amount"]) if form.get("budget_amount") not in (None, "") else None
    except (TypeError, ValueError):
        raise PlannerError("Budget amount must be a number.")
    if budget_amount is not None and budget_amount <= 0:
        raise PlannerError("Budget amount must be more than zero.")
    return {
        "airport": airport,
        "arrival_local": fmt(arrival),
        "departure_local": fmt(departure),
        "layover_min": layover_min,
        "passport": (form.get("passport") or "").strip() or "not specified",
        "visa_status": form.get("visa_status", "unsure"),
        "bags_checked_through": bool(form.get("bags_checked_through", True)),
        "terminal_change": bool(form.get("terminal_change", False)),
        "interests": form.get("interests") or ["anything iconic"],
        "budget": form.get("budget", "moderate"),
        "pace": form.get("pace", "balanced"),
        "mobility": (form.get("mobility") or "").strip() or "no limitations",
        "visited_before": bool(form.get("visited_before", False)),
        "already_seen": (form.get("already_seen") or "").strip() if form.get("visited_before") else "",
        "budget_amount": budget_amount,
        "budget_currency": (form.get("budget_currency") or "USD").strip().upper()[:3],
        "risk_tolerance": risk,
        "safety_margin_min": SAFETY_MARGINS.get(risk, 30),
        "notes": (form.get("notes") or "").strip(),
    }


def build_check_message(trip: dict) -> str:
    return "Do the time check for this layover.\n\nTraveler input:\n" + json.dumps(trip, indent=2)


def build_plan_message(trip: dict, check: TimeCheck, math: dict, minimum_verdict: str) -> str:
    fixed_times = {k: math[k] for k in ("exit_airport_at", "arrive_city_at", "leave_city_by", "at_gate_by", "usable_city_min")}
    fixed_times["minimum_verdict"] = minimum_verdict
    payload = {"traveler": trip, "time_check": check.model_dump(), "fixed_times": fixed_times}
    return "Give the verdict and build the plan inside these fixed times.\n\nInput:\n" + json.dumps(payload, indent=2)


def compute_math(trip: dict, check: TimeCheck) -> dict:
    """Turn the stage 1 estimates into clock times. Server-side truth."""
    arrival = parse_time(trip["arrival_local"])
    departure = parse_time(trip["departure_local"])
    margin = trip["safety_margin_min"]

    exit_at = arrival + timedelta(minutes=check.deplane_and_immigration_min)
    city_at = exit_at + timedelta(minutes=check.transit_to_city_min)
    gate_by = departure - timedelta(minutes=check.boarding_buffer_min)
    leave_by = gate_by - timedelta(minutes=check.reentry_security_min + check.transit_back_min + margin)
    usable = int((leave_by - city_at).total_seconds() // 60)

    return {
        "layover_min": trip["layover_min"],
        "safety_margin_min": margin,
        "exit_airport_at": fmt(exit_at),
        "arrive_city_at": fmt(city_at),
        "leave_city_by": fmt(leave_by),
        "at_gate_by": fmt(gate_by),
        "usable_city_min": usable,
        "deadline_math": (
            f"{gate_by:%H:%M} at gate - {check.reentry_security_min} security - {check.transit_back_min} transit back"
            f" - {margin} safety margin = {leave_by:%H:%M}"
        ),
        "segments": [
            {"key": "immigration", "label": "Deplane + immigration", "min": check.deplane_and_immigration_min},
            {"key": "transit", "label": "Transit to city", "min": check.transit_to_city_min},
            {"key": "city", "label": "Time in city", "min": max(usable, 0)},
            {"key": "margin", "label": "Safety margin", "min": margin},
            {"key": "transit", "label": "Transit back", "min": check.transit_back_min},
            {"key": "security", "label": "Security + exit immigration", "min": check.reentry_security_min},
            {"key": "boarding", "label": "At gate before departure", "min": check.boarding_buffer_min},
        ],
    }


def minimum_verdict(check: TimeCheck, math: dict) -> str:
    """The verdict floor from the math and entry rules. Stage 2 may only make it stricter."""
    if not check.entry_requirements.can_exit_airport or math["usable_city_min"] < 60:
        return "NO_GO"
    if math["usable_city_min"] < 150 or check.entry_requirements.status == "uncertain":
        return "CAUTION"
    return "GO"


def stricter(a: str, b: str) -> str:
    return max(a, b, key=VERDICT_RANK.get)


def find_problems(trip: dict, plan: LayoverPlan, math: dict, floor: str) -> List[str]:
    """Return a list of concrete timeline violations (empty list = plan is valid)."""
    problems = []
    verdict = stricter(plan.verdict, floor)
    arrival = parse_time(trip["arrival_local"])
    gate_by = parse_time(math["at_gate_by"])
    city_at = parse_time(math["arrive_city_at"])
    leave_by = parse_time(math["leave_city_by"])

    if verdict != plan.verdict:
        problems.append(
            f"The verdict cannot be {plan.verdict}; the minimum is {floor}, given {math['usable_city_min']} "
            "usable city minutes and the entry rules. Plan for that verdict."
        )
    if not plan.itinerary:
        problems.append("The itinerary is empty.")

    previous_end = arrival
    for i, stop in enumerate(plan.itinerary, 1):
        try:
            start, end = parse_time(stop.start), parse_time(stop.end)
        except ValueError:
            problems.append(f"Stop {i} ('{stop.title}') has a malformed timestamp.")
            continue
        if end < start:
            problems.append(f"Stop {i} ('{stop.title}') ends before it starts.")
        if start < arrival:
            problems.append(f"Stop {i} ('{stop.title}') starts at {stop.start}, before the traveler lands at {trip['arrival_local']}.")
        elif start < previous_end:
            problems.append(f"Stop {i} ('{stop.title}') starts at {stop.start}, overlapping the previous stop.")
        if end > gate_by:
            problems.append(f"Stop {i} ('{stop.title}') ends at {stop.end}, after the at-gate time {math['at_gate_by']}.")
        if verdict != "NO_GO" and stop.type in CITY_STOP_TYPES:
            if start < city_at:
                problems.append(f"Stop {i} ('{stop.title}') starts at {stop.start}, before arriving in the city at {math['arrive_city_at']}.")
            if end > leave_by:
                problems.append(f"Stop {i} ('{stop.title}') ends at {stop.end}, after the hard deadline {math['leave_city_by']}.")
        previous_end = max(previous_end, end)

    if verdict != "NO_GO" and plan.itinerary:
        last = plan.itinerary[-1]
        if last.type != "transit" or last.start[:16] > math["leave_city_by"]:
            problems.append(
                f"The final stop must be the transit back to the airport, starting no later than {math['leave_city_by']}."
            )
    return problems


# ---------- Claude calls ----------

def get_client() -> anthropic.Anthropic:
    return anthropic.Anthropic(max_retries=3)


def call_claude(client: anthropic.Anthropic, stage: int, user_message: str, schema: type[BaseModel], effort: str):
    extra = {}
    if os.getenv("LAYMAX_FALLBACKS", "1") == "1":
        # If Opus declines a request, the API re-runs it on Anthropic's recommended fallback model.
        extra = {
            "extra_headers": {"anthropic-beta": "server-side-fallback-2026-07-01"},
            "extra_body": {"fallbacks": "default"},
        }
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        system=[{"type": "text", "text": load_system_prompt(stage), "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": user_message}],
        output_config={"effort": effort},
        output_format=schema,
        **extra,
    )
    if response.stop_reason == "refusal":
        raise PlannerError("Claude declined to plan this layover. Try rephrasing your notes.")
    if response.stop_reason == "max_tokens" or response.parsed_output is None:
        raise PlannerError("The plan came back incomplete. Please try again.")
    return response.parsed_output


def plan_layover(form: dict, client: anthropic.Anthropic | None = None) -> dict:
    trip = validate_input(form)
    client = client or get_client()

    # Stage 1: estimates in minutes.
    t0 = time.monotonic()
    check = call_claude(client, 1, build_check_message(trip), TimeCheck, os.getenv("LAYMAX_EFFORT_CHECK", "medium"))
    t1 = time.monotonic()

    # Server: the math, done first and done once.
    math = compute_math(trip, check)
    floor = minimum_verdict(check, math)

    # Stage 2: the plan, inside fixed times.
    plan_effort = os.getenv("LAYMAX_EFFORT", "medium")
    plan_message = build_plan_message(trip, check, math, floor)
    plan = call_claude(client, 2, plan_message, LayoverPlan, plan_effort)
    problems = find_problems(trip, plan, math, floor)

    refinements = []
    for _ in range(MAX_REFINEMENTS):
        if not problems:
            break
        refinements.append(problems)
        # Iterative refinement: hand the draft and its exact faults back to stage 2.
        fix_message = (
            plan_message
            + "\n\nYour previous draft:\n" + plan.model_dump_json()
            + "\n\nThe server's check found these problems:\n- " + "\n- ".join(problems)
            + "\n\nReturn the complete corrected plan. The fixed times do not change."
        )
        plan = call_claude(client, 2, fix_message, LayoverPlan, plan_effort)
        problems = find_problems(trip, plan, math, floor)
    t2 = time.monotonic()

    time_budget = {
        **check.model_dump(exclude={"airport_name", "city", "entry_requirements", "assumptions"}),
        **{k: math[k] for k in ("safety_margin_min", "exit_airport_at", "arrive_city_at", "at_gate_by",
                                "deadline_math", "leave_city_by", "usable_city_min")},
        "assumptions": check.assumptions,
    }
    return {
        "airport_name": check.airport_name,
        "city": check.city,
        "time_budget": time_budget,
        "entry_requirements": check.entry_requirements.model_dump(),
        **plan.model_dump(),
        "verdict": stricter(plan.verdict, floor),
        "math": math,
        "trip": trip,
        "quality_check": {
            "minimum_verdict": floor,
            "refinement_rounds": len(refinements),
            "issues_found": refinements,
            "remaining_issues": problems,
            "stage_seconds": {"time_check": round(t1 - t0, 1), "plan": round(t2 - t1, 1)},
        },
    }
